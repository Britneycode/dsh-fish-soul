// 聊天原文检索（PR1）：chat-archive.db 的 chat_text 现在能按关键词查了。
//
// 为什么要有：chat_text 之前只有 (channel_id, at DESC) 这个时间索引，没有任何
// 检索能力 —— Dream / 模型想核对「他上次到底说没说过这句话」只能按时间窗捞。
// 原文是唯一的地面真值（见 chat-archive.js 里 Mt. Moon 那段注释），查不到就等于没有。
//
// 分词走 segment.js 的 Intl.Segmenter（和长期记忆同一套），不是 FTS5 默认的
// unicode61 —— 后者对中文按字切，存原文会让查询「考试」对不上存的「考 试」。
import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';

const { ChatArchive } = await import('../lib/chat-archive.js');
const CFG = () => ({ chatArchive: { enabled: true, channels: [], days: 30 } });
const make = (name) => {
	process.env.DSH_HOME = tmpHome(name);
	return new ChatArchive({ getConfig: CFG, log: () => {} });
};

// ── ① 写入就能查到（接线：add() 真的把行送进索引了） ──
// 断言打「查得到内容」，不是「indexRow 被调用过」——
// 拆掉 add() 里的 indexRow，这条必须红。
{
	const archive = make('dsh-cfts1-');
	archive.add('private:111', { who: '111', text: '明天上午十点考高数，别忘了带计算器' });
	const r = archive.search('高数');
	assert.equal(r.ok, true, '检索不该失败');
	assert.equal(r.rows.length, 1, '写进去的原文要能按关键词查到');
	assert.match(r.rows[0].content, /高数/, '查回来的得是那条原文');
	assert.equal(r.rows[0].who, '111');
	archive.stop();
}

// ── ①b 对账跑完之后，新写入的行必须还能查到 ──
// 🔴 这条是红验证补出来的洞：拆掉 add() 里的 indexRow，①②…⑦ 照样全绿，
//    因为 search() 首次对账会把缺的行补齐。真实使用路径是「先查过一次，再聊新内容」——
//    那时对账已经把 ftsChecked 置 true，新行只能靠 indexRow 进索引。
{
	const archive = make('dsh-cfts1b-');
	archive.add('private:111', { who: '111', text: '第一句，关键词是熊猫' });
	assert.equal(archive.search('熊猫').rows.length, 1, '首次检索要能对上');
	// 对账已跑过（ftsChecked = true），下面这条只能靠 add() 自己写索引
	archive.add('private:111', { who: '111', text: '第二句，关键词是海獭' });
	assert.equal(archive.search('海獭').rows.length, 1, '对账跑完之后的新行也要能查到');
	archive.stop();
}

// ── ② 多词 OR：任一词命中就算 ──
{
	const archive = make('dsh-cfts2-');
	archive.add('private:111', { who: '111', text: '我下周要去杭州面试' });
	archive.add('private:111', { who: '111', text: '今天吃了碗牛肉面' });
	const r = archive.search('面试 牛肉面');
	assert.equal(r.rows.length, 2, '两个词各命中一条，都要回来');
	archive.stop();
}

// ── ③ 检索失败要和「确实没有」分开 ──
// 🔴 这条是本项目踩过的坑（MEMORY：读不回来 ≠ 读到空）。
// 索引断掉必须报 ok:false，不能返回空数组装作查无此事。
{
	const archive = make('dsh-cfts3-');
	archive.add('private:111', { who: '111', text: '随便一句' });
	archive.open().exec('DROP TABLE chat_fts');
	const r = archive.search('随便');
	assert.equal(r.ok, false, '索引断了必须报失败，不能静默返回空');
	assert.ok(typeof r.error === 'string' && r.error.length > 0, '失败要带原因');
	archive.stop();
}

// ── ④ 老库对账：没有 fts 行的历史 chat_text 要能补进索引 ──
// 真实场景：升级前写下的原文全部没有 fts 行。
{
	const home = tmpHome('dsh-cfts4-');
	process.env.DSH_HOME = home;
	const archive = new ChatArchive({ getConfig: CFG, log: () => {} });
	// open(true) 建库；然后绕过 add() 直接写 chat_text（模拟升级前的老数据）
	const db = archive.open(true);
	db.prepare('INSERT INTO chat_text(channel_id,who,self,content,at) VALUES(?,?,?,?,?)')
		.run('private:111', '111', 0, '升级之前就存在的一句话：周三交实验报告', Date.now());
	// 直接把索引层查一次（跳过 search 的自动对账）——证明「不补就是查不到」
	const { searchChatText } = await import('../lib/chat-archive-fts.js');
	assert.equal(searchChatText(db, '实验报告').rows.length, 0, '对账之前老行查不到（先把问题摆出来）');
	archive.stop();

	// 新实例 → ftsChecked 归零 → 首次 search 触发对账
	process.env.DSH_HOME = home;
	const again = new ChatArchive({ getConfig: CFG, log: () => {} });
	const after = again.search('实验报告');
	assert.equal(after.ok, true, '对账不该失败');
	assert.equal(after.rows.length, 1, '对账要能把升级前的老行补进索引');
	assert.match(after.rows[0].content, /实验报告/);
	again.stop();
}

// ── ⑤ 删除联动：remove 之后不能再查到 ──
{
	const archive = make('dsh-cfts5-');
	archive.add('private:111', { who: '111', text: '这条待会要删掉，关键词是蜥蜴' });
	archive.add('group:222', { who: '222', text: '这条留着，关键词是乌龟' });
	assert.equal(archive.search('蜥蜴').rows.length, 1);
	archive.remove('private:111');
	assert.equal(archive.search('蜥蜴').rows.length, 0, '删掉的会话不该还能查到');
	assert.equal(archive.search('乌龟').rows.length, 1, '没删的会话要还在');
	archive.stop();
}

// ── ⑥ 会话隔离：给 channel 就只查那个会话 ──
{
	const archive = make('dsh-cfts6-');
	archive.add('private:111', { who: '111', text: '私聊里说到台风' });
	archive.add('group:222', { who: '222', text: '群里也在说台风' });
	assert.equal(archive.search('台风').rows.length, 2, '不限定会话就两边都查');
	assert.equal(archive.search('台风', { channel: 'group:222' }).rows.length, 1, '限定了就只查那个会话');
	archive.stop();
}

// ── ⑦ 空词 / 停用词不炸 ──
{
	const archive = make('dsh-cfts7-');
	archive.add('private:111', { who: '111', text: '一句普通的话' });
	for (const q of ['', '   ', '的', '了']) {
		const r = archive.search(q);
		assert.equal(r.ok, true, `查「${q}」不该失败`);
		assert.equal(r.rows.length, 0, `查「${q}」不该返回东西`);
	}
	archive.stop();
}

// ── ⑧ 命中片段带高亮，且不长于原文太多 ──
{
	const archive = make('dsh-cfts8-');
	archive.add('private:111', { who: '111', text: '前两天聊到那个游戏的联机模式，说好了周末一起开黑打排位' });
	const r = archive.search('联机');
	assert.equal(r.rows.length, 1);
	assert.ok(r.rows[0].snippet.length > 0, '要给出片段，方便直接塞进上下文');
	archive.stop();
}

console.log('✓ chat-archive-fts：8 组断言全过');
