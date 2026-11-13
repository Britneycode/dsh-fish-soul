// 抖音「图片表情」被当成普通照片 ⇒ 模型不知道能收藏。
//
// 协议层面确实分不开：decodeMessageNode 解出的 media 只有 {uri,width,height}，
// 没有 sticker/emoji 字段；DOM 路靠 CSS class 区分，而图片表情（柯基狗那种）
// 渲染在 MessageItemImage* 下，typeOf 返回 'image'。
//
// 所以用启发式：小图 / gif / webp 大概率是表情包，标成 sticker:true，
// 文本也从「【图片】」改成「【表情】」—— 后者会命中提示词里的收藏说明
// （lib/index.js 的 /【表情|【图片】|\[...\]/ 正则），而且语义对了。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDouyinMessage } from '../lib/channels/douyin.js';

const opts = { name: '未云', timeMs: 1, messageId: 'm1', identity: 'douyin:123', convId: '0:1:9:123' };

test('小图（≤300px）当表情：标 sticker，文本是【表情】', () => {
  const m = normalizeDouyinMessage(
    { type: 'image', media: { data: 'http://x/a.gif', width: 112, height: 112 } }, opts,
  );
  assert.equal(m.images.length, 1);
  assert.equal(m.images[0].sticker, true, '小图要标 sticker');
  assert.equal(m.text, '【表情】', '文本要说【表情】，模型才知道能收藏');
});

test('大图当普通照片：不标 sticker，文本是【图片】', () => {
  const m = normalizeDouyinMessage(
    { type: 'image', media: { data: 'http://x/big.jpg', width: 1920, height: 1080 } }, opts,
  );
  assert.equal(m.images[0].sticker, undefined, '大图不标 sticker');
  assert.equal(m.text, '【图片】');
});

test('没宽高但格式是 gif / webp：也当表情', () => {
  for (const fmt of ['image/gif', 'image/webp', 'gif']) {
    const m = normalizeDouyinMessage({ type: 'image', media: { data: 'http://x/c', mime: fmt } }, opts);
    assert.equal(m.images[0].sticker, true, `${fmt} 要标 sticker`);
    assert.equal(m.text, '【表情】');
  }
});

test('没宽高、格式也不认识：按普通图片（宁少勿错）', () => {
  const m = normalizeDouyinMessage({ type: 'image', media: { data: 'http://x/d' } }, opts);
  assert.equal(m.images[0].sticker, undefined);
  assert.equal(m.text, '【图片】');
});

test('抖音面板表情（type:emoji）行为不变', () => {
  const m = normalizeDouyinMessage(
    { type: 'emoji', media: { data: 'http://x/e', name: '比心' } }, opts,
  );
  assert.equal(m.images[0].sticker, true);
  assert.equal(m.text, '[比心]');
});
