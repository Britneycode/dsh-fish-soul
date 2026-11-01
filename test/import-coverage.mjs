// 聊天记录导入预览：超出每人段数上限的较早聊天要算出来，别默默丢掉。
import assert from 'node:assert/strict';
import { parseQqTxt, buildPersonChunks, coverageOf } from '../lib/history-import.js';

const lines = [];
const t0 = Date.parse('2023-01-01T08:00:00+08:00');
for (let i = 0; i < 2000; i++) {
	const d = new Date(t0 + i * 3600_000 + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
	lines.push(`${d} 老朋友(123456)`, `第 ${i} 条：今天又聊了好多好多好多好多好多好多好多好多好多好多的事情`, '');
}
const parsed = parseQqTxt(lines.join('\n'), { fileName: '老朋友.txt' });
assert.ok(parsed.chats.length > 0);
const persons = buildPersonChunks(parsed, { selfKeys: [], mapping: {} });
assert.equal(persons.length, 1);
const p = persons[0];
assert.equal(p.chunks.length, 12);
assert.ok(p.dropped.chunks > 0, '较早的段要记下来');
assert.ok(p.dropped.fromMs <= p.chunks[0].startMs);

const cov = coverageOf(persons);
assert.equal(cov.truncatedPersons, 1);
assert.equal(cov.keptChunks, 12);
assert.equal(cov.droppedChunks, p.dropped.chunks);
assert.ok(cov.droppedChars > 0);
assert.equal(cov.topTruncated[0].qq, '123456');

// 短的不提示
const short = buildPersonChunks(parseQqTxt(lines.slice(0, 30).join('\n'), { fileName: 'a.txt' }), { selfKeys: [], mapping: {} });
assert.equal(coverageOf(short).droppedChunks, 0);

console.log('✓ 导入预览：算出每人跳过的较早聊天（段数 / 字数 / 时间），短记录不提示');
