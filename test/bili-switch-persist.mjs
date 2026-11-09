// B站设置页的开关必须「点得动」且「点完不会被下一次保存盖回去」(#77)。
//
// 为什么会坏：这一页有两种保存 —— 开关只把新值发给服务端（save({ browse: { frames: v } })），
// 输入框失焦走整份保存（把 form 里的字段全发一遍）。开关不回写 form 的话，
// 之后任何一次失焦都会带着 form 里的旧值把开关盖回去，表现是「打开以后点别处，自己又关掉了」。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let factory;
const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Component: class {} };
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory: f }) => { factory = f; } } }, console });
const plugin = factory((name) => { assert.equal(name, 'react'); return react; });
const { biliSaveBody } = plugin.__test;

const ok = (n) => console.log('✓', n);

// 面板刚打开时的表单（照 BiliPane 的初始化抄一遍，值故意都是「关」）
const initial = () => ({
	masterUid: '', allowList: '', links: '',
	perDay: 3, videosPerSession: 3, favoritePerDay: 2, searchKeywords: '', searchPerDay: 2,
	frames: false, framesPerDay: 1, framesPerDayChat: 10,
	maxLinks: 3, subtitleChars: 1200, comment: false, commentPerDay: 1, descChars: 300, hotCommentChars: 80,
	postPerDay: 1, commentsPerHour: 6, commentsReplyChars: 40, commentReplyPerDay: 1,
});

{
	// 1. 点「看一眼画面」：请求体里必须是 true
	const { next, body } = biliSaveBody(initial(), { browse: { frames: true } });
	assert.equal(body.browse.frames, true);
	assert.equal(next.frames, true, '覆盖值必须回写 form，否则下一次整份保存会盖回去');
	ok('打开「看一眼画面」：这一次真的发出 frames: true');
}

{
	// 2. 关键回归：打开开关之后，别的输入框失焦触发整份保存（save() 不带覆盖值）
	const afterSwitch = biliSaveBody(initial(), { browse: { frames: true } }).next;
	const later = biliSaveBody(afterSwitch, {});
	assert.equal(later.body.browse.frames, true, '后续整份保存不能再把它关掉（#77 的症状）');
	assert.equal(biliSaveBody(afterSwitch, {}).body.browse.comment, false, '没开的就是没开');
	ok('开关打开后点别处（别的输入框失焦）：不会被旧值盖回去');
}

{
	// 3. 「留一句」同一条路
	const afterComment = biliSaveBody(initial(), { browse: { comment: true } }).next;
	assert.equal(biliSaveBody(afterComment, {}).body.browse.comment, true);
	ok('「留一句」同样是点完就留下');
}

{
	// 4. 一次点两个开关（先后各存一次）不能互相覆盖
	const s1 = biliSaveBody(initial(), { browse: { frames: true } }).next;
	const s2 = biliSaveBody(s1, { browse: { comment: true } }).next;
	const body = biliSaveBody(s2, {}).body;
	assert.equal(body.browse.frames, true, '先开的不能被后开的挤掉');
	assert.equal(body.browse.comment, true);
	ok('先后打开两个开关：两个都留着');
}

{
	// 5. 数字框：回评论的每日上限以前读得到、保存时没带上，改了永远不生效
	const { body } = biliSaveBody({ ...initial(), commentReplyPerDay: 7 }, {});
	assert.equal(body.browse.commentReplyPerDay, 7);
	ok('「回一条评论」的每日上限能存下去');
}

{
	// 6. 不在表单里的开关（点赞 / 分享 / 收藏 / 弹幕 / 接口 / 总开关）不能被整份保存顺手改掉
	const body = biliSaveBody(initial(), {}).body;
	for (const k of ['enabled', 'like', 'share', 'favorite', 'danmaku', 'search', 'commentReply']) {
		assert.equal(k in body.browse, false, `${k} 不在表单里，整份保存就不该带它（服务端保持原值）`);
	}
	ok('表单里没有的开关：整份保存不带，服务端保持原值');
}

console.log('bili-switch-persist ok');
