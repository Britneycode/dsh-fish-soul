// 抖音评论去重 id：cid 优先（作者改了评论也不重复回）+ 兼容旧记录（部署即回归的防线）。
//
// 背景：commentKey（作品 + 作者 + 评论原文的哈希）当去重 id。作者改了评论 → 原文变了 →
// key 变了 → handled() 查不到 → 下一轮当成新评论又回一遍（同一条评论在真实账号上回两遍）。
// 现在有 cid（抖音给的评论 id，不随正文变）就用 cid：作品:cid:xxx。
//
// ⚠️ 兼容层：库里已有的记录全是文本 key。只查新 key 会把**已经回过**的评论当成新评论
// 再回一遍 —— 所以 handled 判定双查：新 key 或旧文本 key 命中任一个都算已处理。
//
// 这里用真对象复现：真 DouyinSocial.pollComments + 真 db + 假 driver（评论列表 / 回评论）。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const ok = (name) => console.log('✓', name);

// 隔离：HOME / DSH_HOME / TMP 全指到临时目录 —— 不碰真实用户目录、不连外网。
const base = tmpHome('dy-cid-');
process.env.DSH_HOME = base;
process.env.HOME = base;
process.env.USERPROFILE = base;
process.env.TMP = base;
process.env.TEMP = base;
process.env.TMPDIR = base;

const { openDatabase, setKv } = await import('../lib/db.js');
const db = openDatabase();
const { DouyinSocial, commentKey, commentId } = await import('../lib/douyin-social.js');

setKv(db, 'douyin.comments.seeded', true); // 第一次只记位置不回 —— 这里要它真回

const WORK = { id: '7001', kind: 'note', title: '晚饭吃了泡面' };

/** 假 driver：评论列表可改，回评论只记账（api = 有 cid，dom = 没 cid）。 */
function makeSocial() {
	const state = { comments: [], replies: [] };
	const driver = {
		listWorks: async () => [WORK],
		openWork: async () => ({ ok: true }),
		listComments: async () => state.comments,
		replyApi: async ({ cid, text }) => { state.replies.push({ via: 'api', cid, text }); return { ok: true }; },
		reply: async (cm, text) => { state.replies.push({ via: 'dom', cid: cm?.cid ?? '', text }); return { ok: true }; },
	};
	const social = new DouyinSocial({
		db,
		host: { running: true, loggedIn: true, exclusive: async (_label, fn) => fn() },
		driver,
		getConfig: () => ({ enabled: true, comments: { enabled: true, perHour: 30 } }),
		callLlm: async () => '哈哈谢谢',
		log: () => {}, note: () => {},
		replyGapMs: 0,
	});
	return { social, state };
}

/** 这一轮往 social_reply 里记了什么（notify_id 升序）。 */
const rows = () => db.prepare("SELECT notify_id, status FROM social_reply WHERE platform = 'douyin' ORDER BY notify_id").all().map((x) => ({ ...x }));

// ── ① cid 优先：id 用 `作品:cid:xxx`；作者改了评论也不重复回 ────────────────────
{
	db.exec("DELETE FROM social_reply");
	const { social, state } = makeSocial();
	state.comments = [{ author: '路人甲', content: '好可爱', cid: 'CID1', canReply: true }];
	let r = await social.pollComments();
	assert.equal(r.replied, 1, '有新评论就回');
	assert.equal(state.replies.length, 1);
	assert.deepEqual(rows(), [{ notify_id: '7001:cid:CID1', status: 'replied' }], '去重 id 用 cid');
	// 作者改了评论：正文变了，cid 没变 —— 同一条评论，不能再回一遍
	state.comments = [{ author: '路人甲', content: '好可爱呀', cid: 'CID1', canReply: true }];
	r = await social.pollComments();
	assert.equal(r.replied, 0, '同一条评论改了字也不能再回一遍');
	assert.equal(state.replies.length, 1, '没有第二次回');
	ok('① cid 优先：改了字也不重复回');
}

// ── ② 不同 cid 同文本 = 两条评论 = 两个 id ────────────────────────────────────
{
	db.exec("DELETE FROM social_reply");
	const { social, state } = makeSocial();
	state.comments = [
		{ author: '路人甲', content: '好可爱', cid: 'CID1', canReply: true },
		{ author: '路人甲', content: '好可爱', cid: 'CID2', canReply: true },
	];
	const r = await social.pollComments();
	assert.equal(r.replied, 2, '同一个人说了两遍 = 两条评论，都要回');
	assert.equal(state.replies.length, 2);
	assert.deepEqual(rows().map((x) => x.notify_id), ['7001:cid:CID1', '7001:cid:CID2'], '不同 cid = 不同 id');
	ok('② 不同 cid 同文本：两条评论，两个 id');
}

// ── ③ 没有 cid：落回文本 key（老行为不变） ────────────────────────────────────
{
	db.exec("DELETE FROM social_reply");
	const { social, state } = makeSocial();
	state.comments = [{ author: '路人乙', content: '在吗', cid: '', canReply: true }];
	const r = await social.pollComments();
	assert.equal(r.replied, 1);
	assert.equal(state.replies[0].via, 'dom', '没有 cid 走 DOM 点击');
	assert.deepEqual(rows(), [{ notify_id: commentKey('7001', '路人乙', '在吗'), status: 'replied' }], '没有 cid 时还是文本 key');
	ok('③ 没有 cid：文本 key 不变');
}

// ── ④ 兼容旧记录：库里已有文本 key 的记录 → 不能再回一遍（部署即回归的防线） ────
{
	db.exec("DELETE FROM social_reply");
	// 升级前留下的记录：老格式（文本 key）
	db.prepare('INSERT INTO social_reply (platform, notify_id, from_uid, from_name, subject, content, reply, status, created_real_at) VALUES (?,?,?,?,?,?,?,?,?)')
		.run('douyin', commentKey('7001', '路人丙', '早就回过了'), '', '路人丙', WORK.title, '早就回过了', '回过了', 'replied', Date.now());
	const { social, state } = makeSocial();
	state.comments = [{ author: '路人丙', content: '早就回过了', cid: 'CID9', canReply: true }];
	const r = await social.pollComments();
	assert.equal(r.replied, 0, '库里已有的旧记录算数：不能当成新评论再回一遍');
	assert.equal(state.replies.length, 0, '一次都不能回');
	assert.equal(db.prepare("SELECT 1 FROM social_reply WHERE notify_id = '7001:cid:CID9'").get(), undefined, '跳过的评论不落新记录');
	ok('④ 旧记录双查：部署后不会重复回');
}

// ── ⑤ commentId：cid 优先的纯函数 ─────────────────────────────────────────────
{
	assert.equal(typeof commentId, 'function', 'commentId 要导出（cid 优先的纯函数）');
	assert.equal(commentId('7001', 'CID1', '路人甲', '好可爱'), '7001:cid:CID1');
	assert.equal(commentId('7001', 'CID1', '路人甲', '改过的字'), commentId('7001', 'CID1', '路人甲', '好可爱'), '同一条评论改了字，id 不变');
	assert.notEqual(commentId('7001', 'CID1', '路人甲', '好可爱'), commentId('7001', 'CID2', '路人甲', '好可爱'), '不同 cid = 不同 id');
	assert.equal(commentId('7001', '', '路人甲', '好可爱'), commentKey('7001', '路人甲', '好可爱'), '没有 cid 落回文本 key');
	ok('⑤ commentId：cid 优先 / 无 cid 落回文本 key');
}

console.log('douyin-comment-identity-cid ok');
