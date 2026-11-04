// 分享视频读多细 / 回评论多长：配置项、夹取、真的进提示词（0.13.7）
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';

const { BiliBrowser } = await import('../lib/browse.js');
const { BiliSocial } = await import('../lib/social.js');
const { VirtualClock } = await import('../lib/clock.js');
const { openDatabase } = await import('../lib/db.js');

const home = tmpHome('dsh-detail-');
const prevHome = process.env.DSH_HOME; process.env.DSH_HOME = home;
const db = openDatabase(); process.env.DSH_HOME = prevHome;
const clock = new VirtualClock(db);

const makeBrowser = (cfg) => new BiliBrowser({
	db, clock, client: {}, getConfig: () => cfg, callLlm: async () => null,
	persona: () => ({ name: '鱼', brief: '' }), log: () => {}
});

// 1. 默认值：跟以前写死的数字一样，升级不改变行为
{
	const c = makeBrowser({}).cfg();
	assert.equal(c.maxLinks, 3);
	assert.equal(c.subtitleChars, 1200);
	assert.equal(c.descChars, 300);
	assert.equal(c.hotCommentChars, 80);
}

// 2. 越界夹取
{
	const c = makeBrowser({ browse: { maxLinks: 99, subtitleChars: 99999, descChars: -5, hotCommentChars: 9001 } }).cfg();
	assert.equal(c.maxLinks, 5);
	assert.equal(c.subtitleChars, 3000);
	assert.equal(c.descChars, 0);
	assert.equal(c.hotCommentChars, 500);
	const z = makeBrowser({ browse: { maxLinks: 0 } }).cfg();
	assert.equal(z.maxLinks, 1, '至少 1 条');
}

// 3. describe：按配置截断，并且真的只读 maxLinks 条
{
	const b = makeBrowser({ browse: { maxLinks: 2, subtitleChars: 40, descChars: 10, hotCommentChars: 5 } });
	let calls = 0;
	b.gather = async () => {
		calls++;
		return { title: '标题', owner: 'UP', desc: 'D'.repeat(100), subtitle: 'S'.repeat(100), comments: ['C'.repeat(100)] };
	};
	const notes = await b.describe({ bvids: ['BV1', 'BV2', 'BV3'] });
	assert.equal(notes.length, 2, 'maxLinks = 2 只读两条');
	assert.equal(calls, 2);
	assert.ok(notes[0].includes('简介：' + 'D'.repeat(10) + '…') || notes[0].includes('简介：' + 'D'.repeat(10)), '简介按 descChars 截');
	assert.ok(!notes[0].includes('D'.repeat(11)), '简介不超过 10 字');
	assert.ok(!notes[0].includes('S'.repeat(41)), '字幕不超过 40 字');
	assert.ok(notes[0].includes('C'.repeat(5)), '热评 5 字');
	assert.ok(!notes[0].includes('C'.repeat(6)), '热评不超过 5 字');
}

// 3b. subtitleChars = 0：不打字幕接口
{
	const b = makeBrowser({ browse: { subtitleChars: 0 } });
	let subtitleCalls = 0;
	b.client = { view: async () => ({ bvid: 'BV1', cid: 1, aid: 1, title: 't', owner: 'o', desc: '', tname: '' }),
		subtitleText: async () => { subtitleCalls++; return '字幕'; },
		hotComments: async () => [] };
	const v = await b.gather('BV1', { subtitleChars: b.cfg().subtitleChars, danmaku: false });
	assert.equal(subtitleCalls, 0, 'subtitleChars = 0 不请求字幕');
	assert.equal(v.subtitle, '');
}

// 4. replyPrompt：字数上限来自配置
{
	const make = (replyChars) => new BiliSocial({
		db, clock, getConfig: () => ({ enabled: true, masterUid: '1', comments: { enabled: true, perHour: 6, replyChars } }),
		client: {}, callLlm: async () => null, persona: () => ({ name: '鱼', brief: '小妹妹' }), log: () => {}
	});
	const it = { kind: 'reply', type: 1, id: '1', mid: '2', name: '路人', content: '好看', title: '视频', oid: '9', rpid: '1' };
	assert.ok(make(80).replyPrompt(it, '1').includes('不超过 80 字'));
	assert.ok(make(40).replyPrompt(it, '1').includes('不超过 40 字'));
	const bad = make(99999).replyPrompt(it, '1');
	assert.ok(bad.includes('不超过 300 字'), '上限夹到 300');
}

console.log('  ✓ detail-config：默认值 / 夹取 / describe 截断 / 回评论字数');
