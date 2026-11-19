// chat_search 工具的接线（PR1）：检索能力必须真的接到模型手上。
//
// 🔴 为什么要单独一条：本项目同族坑踩过三次（PR3 routeOf / PR4 blocker+deliverShare /
//    #152×#153 的 backlog）。「函数写好了、测试也过了」但生产代码没接进去 = 死代码。
//    这里的断言必须打「模型能用到它」这一层：
//      ① 工具真的注册了（名字在宿主工具表里）
//      ② 它的 execute 真的调了 chatArchive.search（不是自己另写一套查询）
//      ③ 默认限定当前会话（不许翻别人的私聊）
//
// 不加载整个插件（要宿主 @deepseek-ai/* 才能起），走「读源码断言接线 + 直接跑
// 检索层」两段。源码断言抓的是「有没有接」，跑检索层抓的是「接的对不对」。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpHome } from './_tmp.mjs';

const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');

// ── ① 工具注册了 ──
{
	const m = src.match(/name:\s*'chat_search'[\s\S]{0,4000}?\}\)\),\s*'dsh-fish-soul: chat_search'\)/);
	assert.ok(m, 'chat_search 要注册成宿主工具，否则模型根本调不到');
	const body = m[0];
	// ── ② 它真的调了检索层 ──
	assert.match(body, /chatArchive\.search\(/, 'chat_search 必须调 chatArchive.search（别自己另写一套查询）');
	// ── ③ 参数默认落到当前会话（隐私） ──
	assert.match(body, /String\(args\.channel \?\? ''\)\.trim\(\) \|\| session\.channelId/, '不填 channel 时必须回落到当前会话，否则能翻别人的私聊');
	// ── ④ 失败要和「没找到」分开说 ──
	assert.match(body, /if \(!res\.ok\)/, '检索失败必须单独分支，不能当成「没找到」');
}

// ── ⑤ 检索层端到端：工具拿到的东西确实是原文 ──
{
	process.env.DSH_HOME = tmpHome('dsh-cstool-');
	const { ChatArchive } = await import('../lib/chat-archive.js');
	const archive = new ChatArchive({ getConfig: () => ({ chatArchive: { enabled: true, channels: [], days: 30 } }), log: () => {} });
	archive.add('private:111', { who: '111', text: '我说过下周三交实验报告，别忘了' });
	archive.add('private:222', { who: '222', text: '别人的私聊，说到实验报告' });
	const mine = archive.search('实验报告', { channel: 'private:111' });
	assert.equal(mine.ok, true);
	assert.equal(mine.rows.length, 1, '限定会话就查不到别人的');
	assert.match(mine.rows[0].content, /下周三交实验报告/);
	assert.equal(mine.rows[0].self, false);
	archive.stop();
}

console.log('✓ chat-search-tool：工具接线 + 会话隔离 5 组断言全过');
