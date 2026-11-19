/**
 * chat-archive.js 的 FTS5 检索层（PR1：原文可检索）。
 *
 * 为什么：chat_text 只有按时间的索引，没有任何检索能力 —— Dream / 模型想核对
 * 「他上次到底说没说过这句话」只能按时间窗捞。anima-brain 的 evidence 层证明
 * 了「原文不可变 + 独立 FTS 索引」是可行的形状：原文层永不改写，检索走
 * 预分词的 FTS5，命中返回带片段的行而不是整段。
 *
 * 分词复用 segment.js 的 tokenizeForBm25（Intl.Segmenter，零依赖）——
 * 存「空格分隔的词项串」而不是原文：FTS5 默认 unicode61 分词器对中文按字切，
 * 直接存原文会让查询「考试」对不上存的「考 试」。查询侧用 queryForBm25
 * 出同一套词项（含拆字低权重补项），两边对得上。
 *
 * 🔴 FTS5 的两个硬约束（都真机验过）：
 *   ① 别名不能用 —— `WHERE f MATCH ?` 和 `bm25(f)` 都报 `no such column: f`，
 *      必须写表名 `chat_fts`。副表（chat_text）可以用别名。
 *   ② 查询串必须是「引号包起来的词项 OR 连接」，否则 FTS5 把中文当语法。
 *
 * 断链自愈：老库升级 / 崩溃后 fts 与 chat_text 可能对不齐。rebuildFts() 逐行对账。
 * 不在 open() 时自动跑（大库会卡启动），由调用方按需触发。
 */
import { tokenizeForBm25, queryForBm25 } from './segment.js';

/** 建 fts 表 + DELETE 联动触发器。INSERT 侧分词必须在应用层做（触发器里调不了 JS 分词）。 */
export function ensureFts(db) {
	db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(id UNINDEXED, terms)');
	db.exec(`CREATE TRIGGER IF NOT EXISTS chat_fts_ad AFTER DELETE ON chat_text BEGIN
	 DELETE FROM chat_fts WHERE id = old.id;
	END`);
}

/** 写入一行索引。add() 插完 chat_text 后调，rowid 与 chat_text.id 对齐。 */
export function indexRow(db, id, content) {
	db.prepare('INSERT INTO chat_fts(id, terms) VALUES(?,?)').run(Number(id), tokenizeForBm25(String(content ?? '')));
}

/**
 * 对账：fts 缺的补、多的删。返回 `{ok, fixed}`；库太大（>5 万行）返回 `{ok:false, skipped:true}`。
 * 失败要能说出来 —— 静默 return 0 会让「没修」和「没坏」看起来一样。
 */
export function rebuildFts(db) {
	const count = Number(db.prepare('SELECT COUNT(*) n FROM chat_text').get()?.n ?? 0);
	if (count > 50_000) return { ok: false, skipped: true, reason: '存档太大，跳过重建', fixed: 0 };
	db.exec('BEGIN');
	try {
		let fixed = 0;
		// 缺的补：chat_text 有、chat_fts 没有
		const ins = db.prepare('INSERT INTO chat_fts(id, terms) VALUES(?,?)');
		for (const r of db.prepare('SELECT id, content FROM chat_text WHERE id NOT IN (SELECT id FROM chat_fts)').all()) {
			ins.run(Number(r.id), tokenizeForBm25(String(r.content ?? '')));
			fixed++;
		}
		// 多的删：chat_fts 有、chat_text 没有
		fixed += Number(db.prepare('DELETE FROM chat_fts WHERE id NOT IN (SELECT id FROM chat_text)').run().changes ?? 0);
		db.exec('COMMIT');
		return { ok: true, fixed };
	} catch (e) {
		try { db.exec('ROLLBACK'); } catch { /* 回滚失败就让它带着原始错误抛 */ }
		return { ok: false, fixed: 0, reason: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * 只读检索：词项 OR 匹配 + bm25 排序，返回带命中片段的行。
 *
 * 返回 `{ok, rows, error}` 而不是裸数组：检索失败必须和「确实没有」分开
 * （`.catch(() => [])` 会把超时/语法错和空结果混成同一个值，这是本项目踩过的坑）。
 * 调用方想 fail-open 就自己看 ok。
 *
 * @returns {{ok:boolean, rows:Array<{id:number,who:string,self:boolean,content:string,at:number,snippet:string}>, error?:string}}
 */
export function searchChatText(db, query, { channel = '', limit = 12 } = {}) {
	const { terms } = queryForBm25(String(query ?? ''));
	if (terms.length === 0) return { ok: true, rows: [] };
	const n = Math.min(30, Math.max(1, Math.floor(Number(limit) || 12)));
	const match = terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
	try {
		const sql = `SELECT chat_fts.id AS id, t.who, t.self, t.content, t.at,
		 snippet(chat_fts, 1, '「', '」', '…', 12) AS snip
		 FROM chat_fts JOIN chat_text t ON t.id = chat_fts.id
		 ${channel !== '' ? 'WHERE chat_fts MATCH ? AND t.channel_id = ?' : 'WHERE chat_fts MATCH ?'}
		 ORDER BY bm25(chat_fts) LIMIT ?`;
		const args = channel !== '' ? [match, channel, n] : [match, n];
		const rows = db.prepare(sql).all(...args).map((r) => ({
			id: Number(r.id), who: String(r.who ?? ''), self: r.self === 1,
			content: String(r.content ?? ''), at: Number(r.at) || 0, snippet: String(r.snip ?? '')
		}));
		return { ok: true, rows };
	} catch (e) {
		return { ok: false, rows: [], error: e instanceof Error ? e.message : String(e) };
	}
}
