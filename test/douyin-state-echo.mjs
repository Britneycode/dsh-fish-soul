// 配置「写进去」和「读出来」必须对得上。
//
// 为什么要有这个测试：加「允许发表情」开关时，保存侧写了 emoji、
// 但状态回显（douyinState）忘了加 → 界面点一下弹回去，表现成「开关点不动」。
// 写进去但读不出来 = 界面上永远改不了，而且接口返回 ok:true 让人以为成功了。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const ok = (n) => console.log('✓', n);
process.env.DSH_HOME = tmpHome('dy-echo-');

const { douyinState } = await import('../lib/routes-douyin.js');

const st = (douyin) => douyinState({
  getConfig: () => ({ douyin }), life: {}, clock: {},
  douyin: null, douyinHost: null, douyinBrowser: null, douyinSocial: null,
});

{
  // 每一项能在界面上改的配置，都要能从 state 里读回来
  const full = {
    enabled: true, autoReply: true, replyAll: true, groupReply: true,
    masterName: '主人', allowList: ['a'], links: ['x=1'], groups: ['g'], callNames: ['鱼'],
    window: 'visible',
    browser: { kind: 'chrome', customPath: '/x/y.exe' },
    browse: { enabled: true, perDay: 7, videosPerSession: 4, like: true, share: false, shareInDm: false, mode: 'browser' },
    post: { enabled: true, perDay: 3 },
    comments: { enabled: true, perHour: 9, emoji: true },
  };
  const s = st(full);
  assert.equal(s.enabled, true);
  assert.equal(s.autoReply, true);
  assert.equal(s.replyAll, true);
  assert.equal(s.groupReply, true);
  assert.equal(s.masterName, '主人');
  assert.deepEqual(s.allowList, ['a']);
  assert.deepEqual(s.links, ['x=1']);
  assert.deepEqual(s.groups, ['g']);
  assert.deepEqual(s.callNames, ['鱼']);
  assert.equal(s.window, 'visible');
  assert.deepEqual(s.browserPref, { kind: 'chrome', customPath: '/x/y.exe' });
  assert.deepEqual(s.browse.enabled, true);
  assert.equal(s.browse.perDay, 7);
  assert.equal(s.browse.videosPerSession, 4);
  assert.equal(s.browse.like, true);
  assert.equal(s.browse.share, false);
  assert.equal(s.browse.shareInDm, false);
  assert.equal(s.browse.mode, 'browser', '刷视频走哪条路要能读回来（写侧读了但回显漏了 = 开关点不动）');
  assert.equal(s.post.enabled, true);
  assert.equal(s.post.perDay, 3);
  assert.equal(s.comments.enabled, true);
  assert.equal(s.comments.perHour, 9);
  assert.equal(s.comments.emoji, true, '允许发表情必须能读回来（曾经漏过 → 开关点不动）');
  ok('抖音配置：每一项都能从 state 读回来（含 comments.emoji）');
}

{
  // 默认值：没配的时候是明确的 falsy，不是 undefined
  const s = st({});
  assert.equal(s.comments.emoji, false, '没配 = false（不是 undefined）');
  assert.equal(s.comments.enabled, false);
  assert.equal(s.comments.perHour, 4);
  assert.equal(s.browse.share, true, '默认分享');
  assert.equal(s.browse.mode, 'http', '没配过时默认走接口');
  assert.equal(s.window, 'background');
  ok('抖音配置：默认值是明确的 false/undefined 语义');
}

console.log('douyin-state-echo ok');
