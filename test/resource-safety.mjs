import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpHome } from './_tmp.mjs';

// 🔴 一批「资源 / 并发 / 泄露」类缺陷。
//
//  ① 语音读响应体无大小上限、且超时保护覆盖不到 body 读取
//     → 服务端慢慢吐字节能永久挂住这一轮；超大 body 会先吃进内存再被检查
//  ② 服务商错误 body 可能回显 API key → 进 lastError → 设置页/日志
//  ③ 共享会话下多个 channelId 落到同一个 session，dispatch 并发
//     → turnState / turnMood 互相覆盖，A 的回复按 B 的通道发出
//  ④ 队列/会话链的清理

process.env.DSH_HOME = tmpHome('resource-safety-');
const { openDatabase } = await import('../lib/db.js');
const { VoiceService, voiceConfig, scrubSecrets } = await import('../lib/voice.js');
const db = openDatabase();

// 🔴 钉住事件循环。
//    这个套件里有几个测试靠 setTimeout 计时（读 body 的超时、会话串行的等待），
//    而 readBodyLimited 里的定时器是 **unref** 的（不能因为它把宿主钉住）。
//    CI 的 4 vCPU 被真启 Chromium 的套件抢满时，事件循环会认为「没事可做」直接结束
//    → 测试里的 await 永不 resolve → 报
//    `Promise resolution is still pending but the event loop has already resolved`
//    （本地串行 / 并行都复现不出来，只能靠「0.1s 就挂 + 这个文案」认）。
//    所以这里挂一个**非 unref** 的 interval，`test.after` 里清掉。
const keepAlive = setInterval(() => {}, 1000);

const MP3 = Buffer.from('fff3840000000000', 'hex');

function svc(cfg, fetchImpl) {
  return new VoiceService({ db, getConfig: () => ({ ...voiceConfig(cfg), enabled: true }), fetchImpl, log: () => {} });
}

// ── ① 大小上限 ──────────────────────────────────────────────────────────────
test('TTS 响应超过上限要拒绝（不能先读进内存再检查）', async () => {
  // 造一个远大于 MAX_AUDIO_BYTES(8MB) 的流
  const big = new Uint8Array(9 * 1024 * 1024);
  let cancelled = false;
  const body = new ReadableStream({
    start(c) {
      c.enqueue(big);
      c.close();
    },
    cancel() { cancelled = true; },
  });
  const s = svc(
    { ttsBaseURL: 'https://x/v1', ttsModel: 'm', ttsVoice: 'v', ttsApiKey: 'sk-abcdefgh1234' },
    async () => new Response(body, { status: 200 }),
  );
  const r = await s.synthesize('念一段');
  assert.equal(r, null, '超大响应要失败，不能返回音频');
  assert.match(String(s.lastError), /太大/, `错误要说清是太大（实际：${s.lastError}）`);
});

test('TTS 正常大小照常返回（别把正常路径搞坏）', async () => {
  const s = svc(
    { ttsBaseURL: 'https://x/v1', ttsModel: 'm', ttsVoice: 'v', ttsApiKey: 'sk-abcdefgh1234' },
    async () => new Response(MP3, { status: 200 }),
  );
  const r = await s.synthesize('念一段');
  assert.ok(r !== null && r.length === MP3.length, '正常音频要能拿到');
});

test('服务端慢速吐字节时读 body 会超时（超时保护覆盖到 body 阶段）', async () => {
  // 永不结束的流：只发一小块，然后一直不 close。
  // 超时后 readBodyLimited 会 cancel 掉它；这里让 cancel 立刻结束，
  // 避免测试结束后还挂着未消费的 chunk（会变成 unhandledRejection）。
  let stopped = false;
  const body = new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(4)); /* 故意不 close */ },
    cancel() { stopped = true; },
  });
  const s = svc(
    { ttsBaseURL: 'https://x/v1', ttsModel: 'm', ttsVoice: 'v', ttsApiKey: 'sk-abcdefgh1234' },
    async () => new Response(body, { status: 200 }),
  );
  // 直接调 readBodyLimited，给一个很短的超时
  const res = await s.fetchImpl('x');
  const started = Date.now();
  await assert.rejects(
    () => s.readBodyLimited(res, { timeoutMs: 120 }),
    /读音频超时/,
    'body 阶段也要有超时（以前 post() 的 timer 在 finally 就 clear 了）',
  );
  assert.ok(Date.now() - started < 2000, '要及时放弃，不能一直挂着');
});

// ── ② 凭据打码 ──────────────────────────────────────────────────────────────
test('错误信息里的 API key 要打码（不能进设置页 / 日志）', () => {
  const key = 'sk-live-abcdefghijklmnop';
  const text = `{"error":{"message":"Incorrect API key provided: ${key}"}}`;
  const out = scrubSecrets(text, key);
  assert.ok(!out.includes(key), '完整 key 不能出现');
  assert.match(out, /sk-l\*\*\*mnop/, '要保留可辨认的前后几位');
});

test('换 key 后旧 key 回显也能兜住（按形状打码）', () => {
  const out = scrubSecrets('bad token sk-oldkey1234567890 and Bearer abcdefghijklmnopqrst');
  assert.ok(!out.includes('sk-oldkey1234567890'), 'sk- 形状要打码');
  assert.ok(!out.includes('abcdefghijklmnopqrst'), 'Bearer 后的 token 要打码');
});

test('语音失败时 lastError 里不带完整 key', async () => {
  const key = 'sk-live-abcdefghijklmnop';
  const s = svc(
    { ttsBaseURL: 'https://x/v1', ttsModel: 'm', ttsVoice: 'v', ttsApiKey: key },
    // 服务商把 key 回显在错误 body 里（真实会发生）
    async () => new Response(`{"error":{"message":"Incorrect API key provided: ${key}"}}`, { status: 401 }),
  );
  const r = await s.synthesize('念一段');
  assert.equal(r, null, '应该失败');
  assert.ok(!String(s.lastError).includes(key), `lastError 里不能有完整 key（实际：${s.lastError}）`);
});

// ── ③ 共享会话串行化 ────────────────────────────────────────────────────────
test('同一会话的 dispatch 串行，不会两轮同时跑', async () => {
  const { ChatGateway } = await import('../lib/gateway.js');
  const gw = Object.create(ChatGateway.prototype);
  gw.sessionChains = new Map();
  let running = 0;
  let maxRunning = 0;
  const order = [];

  const task = (name) => async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    order.push(`${name}:start`);
    await new Promise((r) => setTimeout(r, 20));
    order.push(`${name}:end`);
    running--;
  };

  // 同一个 sessionId，三个并发进来
  await Promise.all([
    gw.runExclusiveForSession('sess-1', task('A')),
    gw.runExclusiveForSession('sess-1', task('B')),
    gw.runExclusiveForSession('sess-1', task('C')),
  ]);

  assert.equal(maxRunning, 1, `同一会话不能并发（实测同时跑 ${maxRunning} 个，顺序：${order.join(' → ')}）`);
  assert.deepEqual(order, ['A:start', 'A:end', 'B:start', 'B:end', 'C:start', 'C:end'], '要按到达顺序串行');
});

test('dispatch 真的走了会话串行（不是只把工具函数写好没接进去）', async () => {
  const { ChatGateway } = await import('../lib/gateway.js');
  const gw = Object.create(ChatGateway.prototype);
  gw.sessionChains = new Map();
  gw.stopped = false;
  // 两个不同的 channelId，但 ensureSession 都返回同一个会话（共享会话场景）
  let n = 0;
  gw.ensureSession = async () => ({ id: 'shared-sess' });
  let running = 0;
  let maxRunning = 0;
  gw.dispatchInner = async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 25));
    running--;
    n++;
  };
  const mk = (channelId) => [{ m: { channelId, chatType: 'private', targetId: 't', nickname: 'n', userId: 'u', text: 'x' }, person: null }];
  await Promise.all([
    gw.dispatch('private:1', mk('private:1')),
    gw.dispatch('bili:2', mk('bili:2')),
  ]);
  assert.equal(n, 2, '两批都要跑到');
  assert.equal(maxRunning, 1, `共享会话里两批必须串行（实测同时跑 ${maxRunning} 个）——否则 turnState 会互相覆盖`);
});

test('不同会话之间仍然并行（别用一个全局锁把所有人卡成一条线）', async () => {
  const { ChatGateway } = await import('../lib/gateway.js');
  const gw = Object.create(ChatGateway.prototype);
  gw.sessionChains = new Map();
  let running = 0;
  let maxRunning = 0;
  const task = async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, 30));
    running--;
  };
  await Promise.all([
    gw.runExclusiveForSession('sess-a', task),
    gw.runExclusiveForSession('sess-b', task),
    gw.runExclusiveForSession('sess-c', task),
  ]);
  assert.ok(maxRunning > 1, `不同会话要能并行（实测最多同时 ${maxRunning} 个）`);
});

test('前一轮抛错不堵死这个会话（后面照常跑）', async () => {
  const { ChatGateway } = await import('../lib/gateway.js');
  const gw = Object.create(ChatGateway.prototype);
  gw.sessionChains = new Map();
  await assert.rejects(
    () => gw.runExclusiveForSession('sess-x', async () => { throw new Error('boom'); }),
    /boom/,
    '错误要传给调用方',
  );
  const r = await gw.runExclusiveForSession('sess-x', async () => 'ok');
  assert.equal(r, 'ok', '一次失败不能把这个会话永久堵死');
});

test('会话链用完会清掉（会话多时不泄漏 Map）', async () => {
  const { ChatGateway } = await import('../lib/gateway.js');
  const gw = Object.create(ChatGateway.prototype);
  gw.sessionChains = new Map();
  await gw.runExclusiveForSession('sess-clean', async () => 1);
  assert.equal(gw.sessionChains.size, 0, '跑完要清掉，否则 Map 随会话数无限长');
});

test.after(() => { clearInterval(keepAlive); db.close(); });
console.log('resource-safety ok');
