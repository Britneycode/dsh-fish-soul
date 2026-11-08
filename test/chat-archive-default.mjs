// 聊天存档默认开 + 「channels 留空 = 全记」（2026-11-08）
//
// 为什么改：它是记忆体系的「原始记录层」。原来 `enabled` 默认 false，而且必须显式列出
// 会话 ID 才会记 —— 两个门槛叠起来，这一层实际上一直是空的，于是 Dream 只能拿
// 「她已经得出的结论」去校验同一个结论（Anthropic 那篇里 Mt. Moon 那个形态：
// 记错一次就一路信下去）。默认开 + 留空全记之后，Dream 才有原文可对照。
//
// 隐私边界（默认开就得守住）：
//  - 只存文本、不抓附件；0600 权限、secure_delete
//  - 按天清理（days）
//  - 随时能关、能按会话删
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-ca-');
process.env.DSH_HOME = home;

const { ChatArchive } = await import('../lib/chat-archive.js');

// ── ① 默认值：开着的，且不要求填会话 ──
// 直接查源码：这里的 z 是宿主注入的 schemastery（带 z.dict 扩展），
// npm 的 zod 造不出来，为了一个默认值搬整套宿主依赖进测试不值得。
{
	const src = readFileSync(new URL('../lib/config-schema.js', import.meta.url), 'utf8');
	// 只认真正的配置行（注释里也提到了 chatArchive）
	const line = src.split('\n').find((l) => /^\s*chatArchive: z\.object/.test(l));
	assert.ok(line, '配置里要有 chatArchive');
	assert.match(line, /enabled: z\.boolean\(\)\.default\(true\)/, '聊天存档默认要开着（Dream 要靠它核对记忆）');
	assert.match(line, /channels: z\.array\(z\.string\(\)\)\.default\(\[\]\)/, '默认不限制会话（留空 = 全记）');
	assert.match(line, /days: z\.number\(\)\.default\(30\)/, '默认留 30 天');
}

// ── ② 留空 channels = 所有会话都记 ──
// 每个块独立 DSH_HOME：共用同一个 chat-archive.db 会让前面的记录漏进后面的断言
{
	process.env.DSH_HOME = tmpHome('dsh-ca2-');
	const archive = new ChatArchive({ getConfig: () => ({ chatArchive: { enabled: true, channels: [], days: 30 } }), log: () => {} });
	archive.add('private:111', { who: '111', text: '随便一个私聊' });
	archive.add('group:222', { who: '222', text: '随便一个群' });
	archive.add('bili:333', { who: '333', text: 'B站 那边' });
	const rows = archive.sample({ since: 0, until: Date.now() + 60_000, limit: 20 });
	assert.equal(rows.length, 3, '留空就该把三个会话都记下来');
	archive.stop();
}

// ── ③ 填了 channels = 只记这些（老行为不变）──
{
	process.env.DSH_HOME = tmpHome('dsh-ca3-');
	const archive = new ChatArchive({ getConfig: () => ({ chatArchive: { enabled: true, channels: ['private:111'], days: 30 } }), log: () => {} });
	archive.add('private:111', { who: '111', text: '要记的' });
	archive.add('group:222', { who: '222', text: '不要记的' });
	const rows = archive.sample({ since: 0, until: Date.now() + 60_000, limit: 20 });
	assert.equal(rows.length, 1, '填了白名单就只记白名单里的');
	assert.equal(rows[0].content, '要记的');
	archive.stop();
}

// ── ④ 关掉就一条都不记 ──
{
	process.env.DSH_HOME = tmpHome('dsh-ca4-');
	const archive = new ChatArchive({ getConfig: () => ({ chatArchive: { enabled: false, channels: [], days: 30 } }), log: () => {} });
	archive.add('private:111', { who: '111', text: '关了不该记' });
	assert.equal(archive.sample({ since: 0, until: Date.now() + 60_000, limit: 20 }).length, 0, '关着就什么都不记');
	archive.stop();
}

console.log('✓ 聊天存档：默认开、留空记全部、填了按白名单、关了不记');
