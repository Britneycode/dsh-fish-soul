/**
 * 跨条复读守卫：跨话题 / 重发两条边界的回归测试（2026-11-28 用户反馈「鱼有时候会发重复的话」）。
 *
 * 背景：守卫原来在「收到实质新入站消息」时把该频道的「刚发过的话」整份 delete。
 * 正常多轮对话里用户每轮都会说点新东西 ⇒ 守卫永远只有空历史 ⇒ 跨条复读基本没生效。
 * 改成标记 stale（说在旧话题里）：
 *   - 一字不差 → 仍然拦（那才是用户看到的「重复的话」；用户重问同一个问题，
 *     她的回答不会一字不差，所以不会误伤）；
 *   - 换个近义说法 → 旧话题里放行（用户再问不误拦），同一段对话里仍拦。
 *
 * 另一个缺口：QQ 发送失败排队重发成功后，onSent 只记了 rememberOwn / note，
 * 没记 noteSent ⇒ 重发的那段话不在守卫历史里。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { findRepeatedParagraphs, normSentText } = await import('../lib/behavior.js');
const { ChatGateway } = await import('../lib/gateway.js');

const long = '今天加班到现在才回来饿得前胸贴后背';
const paraphrase = '今天加班到现在才回来 饿得前胸贴后背了';
const other = '楼下新开的那家面馆味道还行 下次一起去';

const gwOf = () => Object.assign(Object.create(ChatGateway.prototype), {
  note: () => {},
  recentSent: new Map(),
  lastInbound: new Map()
});
const row = { channel_id: 'private:10001', title: '测试' };

test('一字不差：换了话题也拦（stale 不影响）', () => {
  const now = Date.now();
  const hist = [{ at: now - 60_000, norm: normSentText(long), stale: true }];
  assert.deepEqual(findRepeatedParagraphs(hist, [long], { now }), [0], '旧话题里原样复读也要拦');
});

test('近义换说法：旧话题里放行，同一段对话里拦', () => {
  const now = Date.now();
  const stale = [{ at: now - 60_000, norm: normSentText(long), stale: true }];
  const fresh = [{ at: now - 60_000, norm: normSentText(long), stale: false }];
  assert.deepEqual(findRepeatedParagraphs(stale, [paraphrase], { now }), [], '换话题后再问同一件事，换个说法答不该拦');
  assert.deepEqual(findRepeatedParagraphs(fresh, [paraphrase], { now, threshold: 0.8 }), [0], '同一段对话里近义复读仍拦');
});

test('无关新话不误杀', () => {
  const now = Date.now();
  const hist = [{ at: now - 60_000, norm: normSentText(long), stale: false }];
  assert.deepEqual(findRepeatedParagraphs(hist, [other], { now }), []);
});

test('shouldClearRecentSent：标记 stale，不再清空整份记录', () => {
  const gw = gwOf();
  const ch = row.channel_id;
  gw.noteSent(row, [long]);
  assert.equal(gw.recentSent.get(ch).length, 1, 'noteSent 记了 1 条');
  assert.equal(gw.recentSent.get(ch)[0].stale, false, '刚发出去的话属于当前对话');

  assert.equal(gw.shouldClearRecentSent(ch, '今天上班累不累啊'), true, '实质新消息算换话题');
  assert.equal(gw.recentSent.get(ch).length, 1, '记录还在（不是清空）');
  assert.equal(gw.recentSent.get(ch)[0].stale, true, '旧记录被标成 stale');

  // 敷衍语 / 短时重推不算换话题，也不该动 stale 标记
  gw.noteSent(row, [other]);
  gw.shouldClearRecentSent(ch, '嗯');
  assert.equal(gw.recentSent.get(ch).filter((h) => h.stale === false).length, 1, '「嗯」不清也不标记');
});

test('端到端：用户说了新话题之后，她原样复读仍被拦，换说法放行', () => {
  const gw = gwOf();
  const ch = row.channel_id;
  const first = gw.dropRepeats(row, [long]);
  assert.deepEqual(first, [long], '第一轮放行');
  gw.noteSent(row, first);

  gw.shouldClearRecentSent(ch, '你今天吃什么了');

  assert.deepEqual(gw.dropRepeats(row, [long]), [], '换了话题，一字不差复读照样拦');
  assert.deepEqual(gw.dropRepeats(row, [paraphrase]), [paraphrase], '换说法回答旧问题放行');
});

test('dropRepeats 拦下时留 filtered 记录', () => {
  const noted = [];
  const gw = gwOf();
  gw.note = (kind, ev) => noted.push({ kind, ev });
  gw.noteSent(row, [long]);
  gw.shouldClearRecentSent(row.channel_id, '别的话题来了');
  gw.dropRepeats(row, [long]);
  assert.ok(noted.some((n) => n.kind === 'filtered' && String(n.ev?.reason ?? '').includes('跨条复读')));
});

test('outbox 重发成功后要补记「刚发过的」', () => {
  const src = readFileSync(new URL('../lib/gateway.js', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('onSent: (id,'), src.indexOf('onGiveUp:'));
  assert.ok(block.includes('this.rememberOwn('), 'onSent 仍记自己的 messageId');
  assert.ok(block.includes('this.noteSent('), 'onSent 必须补记守卫历史（重发的也要算说过）');
});
