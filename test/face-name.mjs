// QQ 经典小黄脸：face 段只有 id，要把 id 翻成中文名，别给模型一句空话「【表情】」。
import assert from 'node:assert/strict';

const { segmentsToText, faceLabel, FACE_NAMES } = await import('../lib/channels/onebot.js');

// 1. 常用 id 认得出来
assert.equal(faceLabel(13), '呲牙');
assert.equal(faceLabel('14'), '微笑');
assert.equal(faceLabel(21), '白眼');
assert.equal(faceLabel(0), '惊讶');
assert.ok(FACE_NAMES[49] === '便便', '49 是便便');

// 2. 不认识的 id 也要有信息量，不能退化成空话
assert.equal(faceLabel(128), '表情(128)');
assert.equal(faceLabel(''), '表情');
assert.equal(faceLabel(undefined), '表情');

// 3. 消息段整条翻译：她看到的正文带名字
{
	const { text } = segmentsToText([
		{ type: 'text', data: { text: '你看这个' } },
		{ type: 'face', data: { id: 13 } }
	]);
	assert.ok(text.includes('【表情：呲牙】'), '正文里要有名字：' + text);
	assert.ok(!text.includes('【表情】'), '不能还是旧的那种空话');
}

// 4. 认不出的 id 在整条消息里也能看出来
{
	const { text } = segmentsToText([{ type: 'face', data: { id: 251 } }]);
	assert.ok(text.includes('【表情：表情(251)】'), text);
}

// 5. 老行为不受影响：图片/大表情/文本
{
	const { text, images } = segmentsToText([
		{ type: 'image', data: { sub_type: 1, url: 'https://x/a.gif' } },
		{ type: 'mface', data: { summary: '柴犬', url: 'https://x/b.gif' } }
	]);
	assert.ok(text.includes('【表情图】') && text.includes('【表情：柴犬】'), text);
	assert.equal(images.length, 2);
}

console.log('小黄脸识别测试全部通过');
