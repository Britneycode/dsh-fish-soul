// B站 回评论带表情：表情就是正文里的文字码（实测服务端 content.message 里写的就是 [xxx]）。
// 验证：prepareEmojiHint 用 codesLine 格式化（不是直接把对象数组 join 成 [object Object]）。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const ok = (name) => console.log('✓', name);
process.env.DSH_HOME = tmpHome('bili-comment-emoji-');

const { openDatabase } = await import('../lib/db.js');
const { BiliSocial } = await import('../lib/social.js');
const db = openDatabase(':memory:');

const mk = (emotes) => new BiliSocial({
  db, clock: { now: () => Date.now() }, client: { uid: '1' },
  getConfig: () => ({ comments: { enabled: true } }),
  callLlm: async () => '', log: () => {}, emotes,
});

{
  // 面板给了 [{text,alias,pack}] → hint 是格式化后的码，不是 [object Object]
  const social = mk(() => ({ list: async () => [{ text: '[doge]', alias: '狗头', pack: '小黄脸' }, { text: '[笑哭]', alias: '', pack: '小黄脸' }] }));
  await social.prepareEmojiHint();
  assert.equal(social.emojiHint, '[doge]（狗头） [笑哭]', '码要格式化，别名用括号');
  assert.doesNotMatch(social.emojiHint, /object/, '不能是 [object Object]');
  ok('B站回评论表情：码清单格式化正确');
}

{
  // 只填一次（第二轮不重复拉）
  let calls = 0;
  const social = mk(() => ({ list: async () => { calls++; return [{ text: '[doge]', alias: '', pack: '' }]; } }));
  await social.prepareEmojiHint();
  await social.prepareEmojiHint();
  assert.equal(calls, 1, '拉一次就够了');
  ok('B站回评论表情：只拉一次');
}

{
  // 面板关着 / 没注入 emotes → 不给提示（照旧纯文字），不炸
  const social = mk(null);
  await social.prepareEmojiHint();
  assert.equal(social.emojiHint, undefined, '没面板就不给提示');
  const social2 = mk(() => ({ list: async () => [] }));
  await social2.prepareEmojiHint();
  assert.equal(social2.emojiHint, undefined, '空清单也不给提示');
  ok('B站回评论表情：没有面板时降级（不炸、不给提示）');
}

{
  // 面板抛异常 → 静默降级
  const social = mk(() => ({ list: async () => { throw new Error('接口挂了'); } }));
  let threw = false;
  try { await social.prepareEmojiHint(); } catch { threw = true; }
  assert.equal(threw, false, '拿不到不能抛');
  assert.equal(social.emojiHint, undefined);
  ok('B站回评论表情：面板报错也静默降级');
}

{
  // 提示词里真的带上码（replyPrompt 有 emojiHint 那一行）
  const social = mk(() => ({ list: async () => [{ text: '[吃瓜]', alias: '', pack: '' }] }));
  await social.prepareEmojiHint();
  const prompt = social.replyPrompt({ kind: 'reply', name: '路人', content: '哈哈', type: 1, oid: '1', rpid: '2' }, '');
  assert.match(prompt, /\[吃瓜\]/, '提示词里有码');
  assert.match(prompt, /自动变成表情图/, '提示词说明了会变成表情图');
  ok('B站回评论表情：提示词带上了码');
}

console.log('bili-comment-emoji ok');
