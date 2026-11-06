// QQ 出站兜底单元测试：剥模型模板标签 / 段内复读去重 / 超长单段按空格分条 / 跨条复读守卫
import assert from 'node:assert/strict';
import { splitLongParagraphs, findRepeatedParagraphs, normSentText, dedupeParagraphs, stripModelTags } from '../lib/behavior.js';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; console.log('√ ' + msg); };
const words = (s) => s.split(/\n{2,}/).flatMap((p) => p.trim().split(/ +/)).filter(Boolean);

// QQ 出站兜底单元测试：剥模型模板标签 / 段内复读去重 / 超长单段按空格分条 / 跨条复读守卫
const openTag = ['<', 'think', '>'].join('');
const closeTag = ['</', 'think', '>'].join('');
const tr = ['<', 'tool_response', '></', 'tool_response', '>'].join('');
ok(stripModelTags(`前面${openTag}想一下${closeTag}后面`).text === '前面后面', '成对思考块被剥掉');
ok(stripModelTags(`正文${tr}继续`).text === '正文继续', '成对工具响应块被剥掉');
ok(stripModelTags(`正文${openTag}没写完的思考`).text === '正文', '未闭合思考块整段丢弃');
ok(stripModelTags('干干净净的一句话').changed === false, '干净文本不动');

// QQ 出站兜底单元测试：剥模型模板标签 / 段内复读去重 / 超长单段按空格分条 / 跨条复读守卫
const rep = `第一段草稿 就这样吧\n\n第一段草稿 就这样吧\n\n第一段草稿 就这样`;
const dr = dedupeParagraphs(rep);
ok(dr.dropped >= 1 && dr.text.includes('第一段草稿'), '段内复读被去掉');
ok(dedupeParagraphs('哈哈哈哈\n\n哈哈哈哈哈').dropped === 0, '长短略不同的短句重复不误杀');
ok(dedupeParagraphs('啊？我卡啥了\n\n啊？我卡啥了').dropped === 1, '短段一字不差的复读照样去掉（原始 bug 场景）');

// QQ 出站兜底单元测试：剥模型模板标签 / 段内复读去重 / 超长单段按空格分条 / 跨条复读守卫
const blob1 = '爱你个头 快去批你的卷子 今晚的约我记下了 糖的账没结 我跑不了 本小肥鱼继续跟表格对视去了 你也是 批到差不多就停 别揉着眼睛硬撑';
const r1 = splitLongParagraphs(blob1);
ok(r1.changed, `${[...blob1].length} 字真实长串被拆了`);
const p1 = r1.text.split('\n\n');
ok(p1.length === 2, `拆成 2 条（实际 ${p1.length}：${p1.map((p) => [...p].length).join(' + ')} 字）`);
assert.deepStrictEqual(words(r1.text), words(blob1));
ok(true, '拆完字词不丢、顺序不变');

const blob2 = '这鹅今天怎么这么乖 我都不习惯了 这就是萝卜联盟的组织纪律 到时候萝卜和串一起拍 我要检查作业 上车看好你那爱心书包 别被人顺走了';
const r2 = splitLongParagraphs(blob2);
ok(r2.changed && r2.text.split('\n\n').length === 2, '第二条真实长串也拆成 2 条');

const long = Array.from({ length: 30 }, (_, i) => `词组${i}内容`).join(' ');
const r3 = splitLongParagraphs(long);
ok(r3.changed && r3.text.split('\n\n').length === 3, `超长段（${[...long].length} 字）最多拆 3 条`);
assert.deepStrictEqual(words(r3.text), words(long));

const short = '啧 又偷懒 说的就是你';
ok(!splitLongParagraphs(short).changed && splitLongParagraphs(short).text === short, '短消息不动');
const fine = '短段一 哈哈\n\n短段二 嘿嘿';
ok(!splitLongParagraphs(fine).changed && splitLongParagraphs(fine).text === fine, '本来就分好段的不重组');
const nospace = '这'.repeat(80);
ok(!splitLongParagraphs(nospace).changed, '没有空格的长段不硬拆');
const multiline = '第一行 内容还挺长的 超过六十个字了没有呢 再来一点 再来一点 再来一点点呗\n第二行 也不短啊 加起来肯定超过阈值了 就是不该被拆开';
ok(!splitLongParagraphs(multiline).changed, '带换行的段（有意排版）不动');
const voice = '[语音] ' + '哎呀这话得用说的才够味 文字发出去就没那个意思了 你凑合听吧 听完记得回我 我这边还有点事情没处理完 等下再跟你细说 反正语音听着亲切';
ok(!splitLongParagraphs(voice).changed, '[语音] 段不动（哪怕超长）');
const mixed = '收到\n\n' + blob1;
const p9 = splitLongParagraphs(mixed).text.split('\n\n');
ok(splitLongParagraphs(mixed).changed && p9.length === 3 && p9[0] === '收到', '混合时只拆超长的那段');

const line = (n) => Array.from({ length: n }, () => '词语甲乙丙').join(' ');
ok(!splitLongParagraphs(line(10)).changed, '59 字（≤60）不拆');
ok(splitLongParagraphs(line(11)).changed, '65 字（>60）拆');
const r60 = splitLongParagraphs(Array.from({ length: 20 }, () => '三字词').join(' '));
ok(r60.changed && r60.text.split('\n\n').length === 2, '79 字段落拆成 2 条');

// QQ 出站兜底单元测试：剥模型模板标签 / 段内复读去重 / 超长单段按空格分条 / 跨条复读守卫
const now = Date.now();
const hist = [{ at: now - 30000, norm: normSentText(blob2) }];
ok(JSON.stringify(findRepeatedParagraphs(hist, [blob2], { now })) === '[0]', '30 秒前发过一模一样的 → 拦');
ok(findRepeatedParagraphs([{ at: now - 180000, norm: normSentText(blob2) }], [blob2], { now }).length === 0, '超过 2 分钟窗口 → 放行');
ok(findRepeatedParagraphs(hist, ['哈哈哈哈'], { now }).length === 0, '短句重复不误杀');
ok(findRepeatedParagraphs(hist, ['哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈'], { now }).length === 0, '内容不同的长句不误杀');
ok(JSON.stringify(findRepeatedParagraphs(hist, [blob2 + '！'], { now })) === '[0]', '多个标点也算同一条（规整化生效）');
ok(JSON.stringify(findRepeatedParagraphs(hist, ['[语音] ' + blob2], { now })) === '[0]', '带 [语音] 标记的同内容也拦');
const multi = ['今天真开心啊 出去玩了一趟', blob2, '下次带你一起去玩呀'];
ok(JSON.stringify(findRepeatedParagraphs([{ at: now - 10000, norm: normSentText(blob2) }], multi, { now })) === '[1]', '多段里只拦复读的那一段');
ok(findRepeatedParagraphs(hist, r2.text.split('\n\n'), { now }).length === 0, '整段拆出来的两截不会误判成复读');
ok(dedupeParagraphs(blob1).dropped === 0, 'dedupeParagraphs 对正常长串不误伤');

// QQ 出站兜底单元测试：剥模型模板标签 / 段内复读去重 / 超长单段按空格分条 / 跨条复读守卫
const store = new Map();
const send = (channelId, paras, t) => {
	const h = (store.get(channelId) ?? []).filter((x) => t - x.at <= 120000);
	const dups = new Set(findRepeatedParagraphs(h, paras, { now: t }));
	const kept = paras.filter((_, i) => !dups.has(i));
	for (const p of kept) h.push({ at: t, norm: normSentText(p) });
	store.set(channelId, h);
	return kept;
};
ok(send('private:949850174', [blob2], now).length === 1, '模拟：第一轮正常发出');
ok(send('private:949850174', [blob2], now + 17000).length === 0, '模拟：17 秒后原样复读被整条拦下');
ok(send('private:949850174', ['上车了 到地方说一声啊'], now + 30000).length === 1, '模拟：新内容照常发');
ok(send('private:2974723499', [blob2], now + 40000).length === 1, '模拟：别的频道不受影响');

// ── 审查回归（P1）：真函数覆盖，不再只测手抄的复制品 ──
import { readFileSync } from 'node:fs';
const gwSrc = readFileSync(new URL('../lib/gateway.js', import.meta.url), 'utf8');
ok(gwSrc.includes('this.dropRepeats(row, paragraphs)'), 'sendReply 里接着跨条复读守卫（接线没被摘掉）');
ok(gwSrc.includes('this.recentSent?.delete(m.channelId)'), '收到对方新消息会清该频道的「刚发过」记录（用户再问不误拦）');
ok(gwSrc.includes('this.noteSent(row, paragraphs)'), '发送成功后才记「刚发过」（失败的内容不被拦）');

const { ChatGateway } = await import('../lib/gateway.js');
const notes = [];
const fake = {
	recentSent: new Map(),
	note: (kind, d) => notes.push({ kind, ...d }),
};
const row = { channel_id: 'private:123456', title: '测试' };
const long1 = '今天在阳台上晒了一下午太阳 暖洋洋的差点睡着 你那边天气怎么样呀';
// 第一轮：发出并记进「刚发过」
const first = ChatGateway.prototype.dropRepeats.call(fake, row, [long1]);
ok(first.length === 1, 'dropRepeats：第一轮放行');
ChatGateway.prototype.noteSent.call(fake, row, first);
ok(fake.recentSent.get('private:123456').length === 1, 'noteSent：发过的内容记进了历史');
// 第二轮没新输入：原样重发 → 拦
ok(ChatGateway.prototype.dropRepeats.call(fake, row, [long1]).length === 0, 'dropRepeats：没新输入时原样重发被拦');
ok(notes.some((n) => n.kind === 'filtered' && n.reason.includes('跨条复读')), '拦的时候在动态面板留了 filtered 记录');
// 用户又开口了：记录清空 → 同样的话照常发
fake.recentSent.delete('private:123456');
ok(ChatGateway.prototype.dropRepeats.call(fake, row, [long1]).length === 1, '用户开口后：同样的话再答一遍不被拦');

// ── 审查回归（P1）：同轮短句只差一个字不误杀（minLen 6→12 后）──
ok(dedupeParagraphs('你今天几点睡的\n\n你今天几点睡呀').dropped === 0, '同轮只差一个字的短句不误杀');
ok(dedupeParagraphs('我今天有点累\n\n我今天有点闲').dropped === 0, '同轮改一个字的短句不误杀');
ok(dedupeParagraphs('这鹅今天怎么这么乖\n\n这鹅今天怎么这么怪').dropped === 0, '同轮 9 字改尾字不误杀');
// 真复读（一字不差）照样拦：短段走全等路径
ok(dedupeParagraphs('你今天几点睡的\n\n你今天几点睡的').dropped === 1, '一字不差的短段复读照样拦');
// ≥12 字的草稿复读走 Dice 路径，仍拦
const draft = '第一段草稿就先这样吧 我想想还有啥要补的 没有的话就这么发了';
ok(dedupeParagraphs(draft + '\n\n' + draft).dropped === 1, '12 字以上一字不差的复读拦');
ok(dedupeParagraphs(draft + '\n\n' + draft + ' 好了').dropped === 1, '12 字以上微调的复读也拦');

// ── 审查回归（P2）：stripModelTags 的 changed 只认真标签，空白规整不算 ──
ok(stripModelTags('你好\n\n\n\n再见').changed === false, '没有标签时 changed=false（空白折叠不算剥标签）');
ok(stripModelTags('你好   \n再见').changed === false, '行尾空格清理不误报 changed');
ok(stripModelTags('正文' + openTag + '结束').changed === true, '真剥到标签时 changed=true');

console.log(`\n√ QQ 出站兜底全部通过（${pass} 项断言）`);
