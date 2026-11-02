// 聊天记录导入预览：超出每人段数上限的较早聊天要算出来，别默默丢掉。
import assert from 'node:assert/strict';
import { parseQqTxt, buildPersonChunks, coverageOf, capChunks } from '../lib/history-import.js';

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
const eras = p.chunks.filter((c) => c.era);
assert.equal(p.chunks.length - eras.length, 12, '最近 12 段逐段');
assert.ok(p.dropped.chunks > 0, '较早的段要记下来');
assert.equal(eras.length, 4, '更早的压成 4 个时间段');
assert.ok(p.chunks.slice(0, 4).every((c) => c.era), '时间段排在最前（额度不够先砍）');
assert.equal(eras.reduce((n, e) => n + e.sourceChunks, 0), p.dropped.chunks, '每段较早的聊天都归到某个时间段');
for (const e of eras) assert.ok(e.text.length <= 3600, '每个时间段抽样到一段的长度');
assert.ok(eras[0].startMs <= eras[1].startMs && eras[3].endMs <= p.chunks[4].startMs, '时间顺序');
assert.ok(eras.some((e) => e.sampled));
assert.equal(p.dropped.fromMs, eras[0].startMs);

const cov = coverageOf(persons);
assert.equal(cov.truncatedPersons, 1);
assert.equal(cov.keptChunks, 16);
assert.equal(cov.eraChunks, 4);
assert.equal(cov.droppedChunks, p.dropped.chunks);
assert.ok(cov.droppedChars > 0);
assert.equal(cov.topTruncated[0].qq, '123456');

// 短的不提示
const short = buildPersonChunks(parseQqTxt(lines.slice(0, 30).join('\n'), { fileName: 'a.txt' }), { selfKeys: [], mapping: {} });
assert.equal(coverageOf(short).droppedChunks, 0);

// 额度不够先砍时间段总结
const capped = capChunks(persons, 13);
assert.equal(capped[0].chunks.length, 13);
assert.equal(capped[0].chunks.filter((c) => c.era).length, 1);

console.log('✓ 导入预览：较早聊天压成时间段总结（抽样、时间顺序、额度不够先砍），短记录不提示');
