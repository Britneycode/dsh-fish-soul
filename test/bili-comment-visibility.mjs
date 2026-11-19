// #154：刷视频时她写的评论（留一句 / 回一条评论）要能在「动态和评论」里看到。
// 以前只进 kv 计数，social_post 里没有，面板上完全看不到。
import assert from 'node:assert/strict';

import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-bili-comment-visibility-');
process.env.DSH_HOME = home;

const { openDatabase } = await import('../lib/db.js');
const { BiliBrowser } = await import('../lib/browse.js');
const { registerRoutes } = await import('../lib/routes.js');

const db = openDatabase();
const clock = { getRoleDateParts: () => ({ dateStr: '2026-11-19' }), now: () => Date.now() };

const client = {
	uid: 999,
	async view(bvid) {
		return { bvid, aid: 42, cid: 7, title: '一口气看完 AI 发展史', owner: '小然', desc: 'AI 时间线', tname: '科技' };
	},
	async subtitleText() { return '字幕'; },
	async hotComments() { return []; },
	async danmaku() { return []; },
	async commentList() {
		return [
			{ rpid: '111', mid: '5', name: '阿茶', content: '这个时间线讲得真清楚' }
		];
	},
	async replyComment() { return { rpid: 1 }; },
	async like() {},
	async favorite() {}
};

const llmQueue = [];
const callLlm = async () => (llmQueue.length > 0 ? llmQueue.shift() : '');

const browser = new BiliBrowser({
	db,
	clock,
	client,
	getConfig: () => ({
		browse: {
			enabled: true, perDay: 3, videosPerSession: 3,
			like: false, share: false, favorite: false, danmaku: false,
			comment: true, commentPerDay: 3,
			commentReply: true, commentReplyPerDay: 3, hotComments: 6
		}
	}),
	callLlm,
	persona: () => ({ name: '贪吃鱼', brief: '' }),
	watchDelayMs: [0, 0]
});

// ── 1. 留一句：成功后 social_post 里要有这条评论 ──
llmQueue.push('这段讲得比我想的清楚多了', '涨知识了');
await browser.watch({ bvid: 'BVtest1', source: 'recommend' }, false, false, false);
const c1 = db.prepare("SELECT post_id, content FROM social_post WHERE platform='bili'").all();
assert.equal(c1.length, 1, '留一句要写进 social_post');
assert.ok(c1[0].post_id.startsWith('comment-'), `post_id 要以 comment- 开头，实际 ${c1[0].post_id}`);
assert.ok(c1[0].content.includes('涨知识了'), '正文要包含评论内容');
assert.ok(c1[0].content.includes('一口气看完 AI 发展史'), '正文要带上视频标题');

// ── 2. 回一条评论：成功后 social_post 里要有这条回复 ──
llmQueue.push('这段讲得比我想的清楚多了', '', '1|我也觉得');
await browser.watch({ bvid: 'BVtest2', source: 'recommend' }, false, false, false);
const c2 = db.prepare("SELECT post_id, content FROM social_post WHERE platform='bili' ORDER BY id").all();
assert.equal(c2.length, 2, '回评论也要写进 social_post');
assert.ok(c2[1].post_id.startsWith('reply-'), `post_id 要以 reply- 开头，实际 ${c2[1].post_id}`);
assert.ok(c2[1].content.includes('回了 @阿茶'), '正文要说明回了谁');
assert.ok(c2[1].content.includes('我也觉得'), '正文要包含回复内容');

// ── 3. /bili/social-log 能看到这两条（面板加载更多那条路）──
const deps = {
	db,
	clock,
	embedder: {}, worker: {},
	life: { browseState: () => ({ count: 0 }), stateSnapshot: () => ({ today: {} }) },
	getConfig: () => ({ bili: { enabled: true }, qq: {}, douyin: {}, masterQqUin: '10001' }),
	saveConfig: () => {},
	log: () => {},
	gateway: { workspacePath: () => '/ws', listWorkspaces: () => [], isPaused: () => false },
	channel: { status: () => ({ connected: true }), restart() {} },
	bili: { status: () => ({ loggedIn: false }), restart() {} },
	biliClient: null, browser: null, biliSocial: null,
	douyin: { status: () => ({ running: false }) },
	douyinHost: { browsers: [], status: () => ({ state: 'stopped' }) },
	douyinBrowser: null, douyinSocial: null
};

function mount() {
	let handler = null;
	registerRoutes({ effect: (fn) => { fn(); }, webServer: { register: (o) => { handler = o.handler; } } }, deps);
	return handler;
}

async function call(path) {
	const handler = mount();
	let out = '';
	const req = new (await import('node:stream')).Readable({ read() { this.push(null); } });
	req.url = `/api/plugins/fish-soul${path}`;
	req.method = 'GET';
	req.headers = {};
	const res = { writeHead: () => {}, end: (t) => { out = t; } };
	await handler(req, res);
	return JSON.parse(out);
}

const r = await call('/bili/social-log?limit=10');
assert.equal(r.ok, true);
const posts = r.items.filter((x) => x.kind === 'post');
assert.equal(posts.length, 2, 'social-log 要返回这两条评论');
assert.ok(posts.some((x) => x.text.includes('涨知识了')), '要包含留的那句');
assert.ok(posts.some((x) => x.text.includes('回了 @阿茶')), '要包含回的那条');
assert.ok(posts.every((x) => typeof x.pid === 'string' && x.pid !== ''), '要带上 post_id 供面板区分标签');
assert.ok(posts.some((x) => x.pid.startsWith('comment-')), 'comment- 前缀要在');
assert.ok(posts.some((x) => x.pid.startsWith('reply-')), 'reply- 前缀要在');

console.log('B站评论可见性：测试全部通过');
