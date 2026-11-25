// #191：「动态和评论」里的评论条目能点开跳到对应 B站 页面。
//
// 为什么要有这个测试：面板以前只显示文字，用户想看她回的是哪条评论只能自己去 B站 找。
// post_id 里其实一直存着 aid（browse.js 写库时就带了），只是没人拿它拼链接。
// 纯函数抽出来测；「真渲染进面板」那半由 client-panels / client-syntax 守着。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let factory;
const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), Component: class {} };
vm.runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory: f }) => { factory = f; } } }, console });
const plugin = factory((name) => { assert.equal(name, 'react'); return react; });
const { biliPostUrl } = plugin.__test;

const ok = (n) => console.log('✓', n);

// 1. 留一句（comment-<aid>-<时间戳>）→ 落在视频评论区（root=0）
assert.equal(
	biliPostUrl('comment-1700012345-1763980000000'),
	'https://www.bilibili.com/video/av1700012345/?comment_on=1&comment_root_id=0',
	'留一句：跳到该视频评论区'
);

// 2. 回一条（reply-<aid>-<rpid>）→ 定位到那条评论（root=rpid）
assert.equal(
	biliPostUrl('reply-1700012345-987654321'),
	'https://www.bilibili.com/video/av1700012345/?comment_on=1&comment_root_id=987654321',
	'回一条：跳到被回的那条评论'
);

// 3. 动态的 post_id（B站 动态 id，非 aid）→ 空串，不编链接
assert.equal(biliPostUrl('dyn-123456789'), '', '认不出的形状返回空串');
assert.equal(biliPostUrl(''), '', '空串返回空串');
assert.equal(biliPostUrl(null), '', 'null 返回空串');
assert.equal(biliPostUrl(undefined), '', 'undefined 返回空串');

// 4. reply-<aid> 不带第三段 → 空串（browse.js 不写这种形状，但别拼出坏链接）
assert.equal(biliPostUrl('reply-1700012345'), '', 'reply 缺 rpid 不编链接');

// 5. 恶意形状不拼链接（post_id 来自自家数据库，但防御性校验仍要过）
assert.equal(biliPostUrl('comment-<script>alert(1)</script>'), '', '非数字 aid 不编链接');
assert.equal(biliPostUrl('comment-12-34-56'), '', '多段形状不编链接');

ok('biliPostUrl：comment/reply 两条形状拼出正确链接，认不出/恶意形状返回空串');
