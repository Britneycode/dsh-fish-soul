// 聊天记录导入断点续传：中途退出 → 重启标「中断」→ 继续从下一段接着跑，不重复写记忆、不重复加互动次数；放弃后不再提示。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'fs-resume-'));
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { HistoryImporter } = await import('../lib/history-import.js');

const db = openDatabase();
const clock = { now: () => Date.parse('2025-01-01T00:00:00Z') };
const worker = { queued: [], enqueueRealtime(id, text) { this.queued.push([id, text]); } };

// 两个人，每人好几段
const lines = [];
const t0 = Date.parse('2024-01-01T08:00:00+08:00');
for (let i = 0; i < 240; i++) {
	const who = i % 2 === 0 ? '阿甲(10001)' : '阿乙(10002)';
	const d = new Date(t0 + i * 3600_000 + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
	lines.push(`${d} ${who}`, `第 ${i} 条：${'今天发生了好多事情，'.repeat(12)}`, '');
}
const text = lines.join('\n');

let n = 0;
let hangAt = 3;
const prompts = [];
const llm = (prompt, opts) => {
	n++;
	prompts.push(prompt);
	// 模拟 DSH 在这一段中途退出（真模型调用会响应 signal）
	if (n === hangAt) return new Promise((_r, reject) => opts?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
	return Promise.resolve(JSON.stringify({ memories: [{ content: `第 ${n} 次提炼出来的一件事`, kind: 'fact', importance: 2 }], relation: 'friend' }));
};
const mk = () => new HistoryImporter({ db, clock, worker, callLlm: (p, o) => llm(p, o), personaName: () => '小鱼', masterQq: () => '', selfQq: () => '' });

const a = mk();
const pv = a.preview({ text, fileName: '两人.txt' });
assert.equal(pv.previous, null);
const job = a.start({ previewId: pv.previewId, maxCalls: 500 });
const total = job.total;
assert.ok(total >= 4);
await new Promise((r) => setTimeout(r, 100));
assert.equal(a.state().done, 2, '前两段做完、第三段卡住');
const memCount = () => db.prepare("SELECT COUNT(*) AS c FROM memory WHERE source_session = 'history-import'").get().c;
assert.equal(memCount(), 2);

// 「重启」：新实例把 running 标成中断
const b = mk();
let st = b.state();
assert.equal(st.status, 'interrupted');
assert.equal(st.resumable, true);
assert.equal(st.done, 2);
// 同一份文件再预览：提示上次没跑完
const pv2 = b.preview({ text, fileName: '两人.txt' });
assert.equal(pv2.previous.status, 'interrupted');
assert.ok(pv2.warnings.some((w) => /没跑完/.test(w)));

hangAt = -1;
const before = prompts.length;
b.resume();
await b.idle();
st = b.state();
assert.equal(st.status, 'done', JSON.stringify(st.errors));
assert.equal(st.done, total);
assert.equal(prompts.length - before, total - 2, '只跑剩下的段');
assert.equal(memCount(), total, '每段一条，没有重复');
const ic = db.prepare("SELECT qq_uin, interaction_count FROM person WHERE qq_uin IN ('10001','10002') ORDER BY qq_uin").all();
assert.deepEqual(ic.map((r) => r.interaction_count), [120, 120], '互动次数每人只加一次');
assert.throws(() => b.resume(), /没有可以继续/);

// 停止 → 可继续；放弃 → 不再提示
const c = mk();
const pv3 = c.preview({ text: text + '\n', fileName: '两人2.txt' });
hangAt = n + 2;
c.start({ previewId: pv3.previewId, maxCalls: 500 });
await new Promise((r) => setTimeout(r, 50));
c.cancel();
await c.idle();
st = c.state();
assert.equal(st.status, 'cancelled');
assert.equal(st.resumable, true);
assert.equal(c.discard(st.id), true);
assert.notEqual(c.state().status, 'cancelled');
assert.equal(c.state().resumable, false);

db.close();
rmSync(home, { recursive: true, force: true });
console.log('✓ 导入断点续传：中断后继续不重复、只跑剩下的、重复文件提示、放弃不再提示');
