// 评论区 @ 她时，可选的「先读一下视频」：开了才去拿简介 + 字幕，关着不多发一次请求。
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'dsh-atread-'));
process.env.DSH_HOME = home;
const { openDatabase } = await import('../lib/db.js');
const { BiliSocial } = await import('../lib/social.js');

const db = openDatabase();
const clock = { now: () => Date.now(), getRoleDateParts: () => ({ dateStr: '2030-01-01' }) };
const nowS = Math.floor(Date.now() / 1000);

let atItems = [];
let viewCalls = 0;
const prompts = [];
const sent = [];

const client = {
	uid: '999',
	loggedIn: true,
	authInvalid: false,
	replyFeed: async () => [],
	atFeed: async () => atItems,
	viewByAid: async (aid) => { viewCalls++; return { bvid: 'BVread', aid: String(aid), cid: '22', title: '四个神级插件', desc: '讲 DSH 的四个插件', tname: '科技' }; },
	subtitleText: async () => '第一个插件是 SurfCore，能看报错截图，第二个是鲸鱼娘捉宠',
	replyComment: async (x) => { sent.push(x); return '1'; }
};

const cfg = { enabled: true, masterUid: '999', comments: { enabled: true, perHour: 5, atMe: true, atReadVideo: false } };
const social = new BiliSocial({ db, clock, client, getConfig: () => cfg, log: () => {}, callLlm: async (p) => { prompts.push(p); return '看完了，读图那个最有用'; }, replyGapMs: 0, postRealGapMs: 0 });

// 和 BiliClient.atFeed() 一样规整过的条目
const at = (id, content, time) => ({
	id: `at:${id}`, kind: 'at', mid: '555', name: '阿锋', type: 1, oid: '9001',
	rpid: String(80 + id), root: '80', title: '四个神级插件', content, target: '', time, uri: '', isComment: true
});
const pushAt = (id, content, time) => { atItems = [at(id, content, time), ...atItems]; };

// 第一次只记位置，不回
pushAt(101, '@鱼 你看看这个', nowS - 30);
await social.pollComments();
assert.equal(sent.length, 0, '第一次只记位置不回');
assert.equal(viewCalls, 0, '第一次连视频都不读');

// 开关关着：会回，但不读视频
pushAt(102, '@鱼 你看这个插件值不值得装', nowS + 5);
await social.pollComments();
assert.equal(sent.length, 1, '关了也会回');
assert.equal(viewCalls, 0, '关着不多发 view 请求');
assert.doesNotMatch(prompts.at(-1), /字幕节选/, '关着不塞字幕');

// 开关打开：先读视频再回
cfg.comments.atReadVideo = true;
pushAt(103, '@鱼 这视频讲了啥', nowS + 10);
await social.pollComments();
assert.equal(viewCalls, 1, '开了才去 view');
assert.equal(sent.length, 2);
const p = prompts.at(-1);
assert.match(p, /四个神级插件/, '标题进提示词');
assert.match(p, /简介：讲 DSH 的四个插件/, '简介进提示词');
assert.match(p, /字幕节选：第一个插件是 SurfCore/, '字幕进提示词');

console.log('✓ @ 时读视频：默认关不发请求，开了才把简介和字幕塞进提示词');
process.exit(0);
