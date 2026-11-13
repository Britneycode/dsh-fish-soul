/**
 * diag-log.js —— 排查用的结构化日志（系统页「运行日志」）。
 *
 * 和动态页（gateway.decisions）的区别：
 *   - decisions 记的是**对话层面**的事（谁说了什么、想起了几条），给人翻的；
 *   - 这里记的是**装置层面**的事（启动卡在哪、人格段挂不上、会话恢复失败降级新建、
 *     上下文长度趋势），是"她为什么突然不对劲"时第一个要看的地方。
 *
 * 两个视图共用一份数据：
 *   - 中文时间线：给用户看，也方便贴到 issue 里；
 *   - 原始 JSON：给维护者 grep。
 *
 * 设计约束：
 *   - 只在内存里留最近 N 条（默认 200），**不落盘** —— 这是排查快照不是审计日志，
 *     落盘会变成第二个事实来源，也会把日志越攒越大。
 *   - 同样的 key 在短时间窗内重复发生时只累加 count，不刷屏（启动失败那种每秒一次的
 *     情况不会把缓冲冲干净）。
 */
import { getKv, setKv } from './db.js';

/** 内存里最多留多少条。 */
const LIMIT = 200;
/** 同一个 key 在这个窗口内重复出现就合并计数（毫秒）。 */
const DEDUPE_MS = 60_000;

/**
 * 每条日志的中文说法。key 是稳定的机器标识，人话在这里查。
 * 加新 key 时**必须**在这里补一条，否则界面会显示成 key 本身（这是故意的：
 * 宁可露出机器名，也别悄悄显示成空白让人以为没发生）。
 *
 * key 带会话后缀（`基础:会话名`）时回落到基础那条说法（见 labelOf）。
 */
const LABELS = {
	'startup-step': '启动到某一步',
	'startup-failed': '启动失败',
	'mount-failed': '人格卡 / 瞬态块挂不上',
	'mount-no-ctx': '拿不到 agent.ctx',
	'session-create': '新建了会话',
	'session-resume': '恢复了会话',
	'resume-failed': '恢复会话失败，改为新建',
	'session-retired': '会话退役',
	'context-size': '这一轮上下文长度',
	'image-skip': '图片没送进模型',
	'sticker-skip': '表情没收藏成功',
	'turn-no-recall': '这一轮没组装记忆',
	'config-invalid': '配置文件读不懂',
	// 抖音私信的两类提示：设置页那块已经删了（主人嫌吵），落到这里来查。
	'douyin-inbox-gap': '抖音私信可能有遗漏',
	'douyin-inbox-unknown': '抖音私信待核实'
};

/**
 * 人话：key 精确命中就用它；带会话后缀的（`基础:会话名`）回落到基础那条说法。
 * 都没有就显示机器名 —— 宁可露出机器名，也别让人以为没发生。
 */
function labelOf(key) {
	if (LABELS[key]) return LABELS[key];
	const i = key.indexOf(':');
	if (i > 0) {
		const base = key.slice(0, i);
		if (LABELS[base]) return LABELS[base];
	}
	return key;
}

export class DiagLog {
	/**
	 * @param {{ db: object, log?: Function, now?: () => number }} deps
	 */
	constructor({ db, log, now = () => Date.now() }) {
		this.db = db;
		this.log = log ?? (() => {});
		this.now = now;
		/** @type {Array<{at:number,key:string,level:string,detail:object,count:number}>} */
		this.entries = [];
		this.lastKeyAt = new Map();
	}

	/**
	 * 记一条。
	 * @param {string} key LABELS 里的机器标识
	 * @param {object} [detail] 结构化细节（别塞大对象：这里只留 200 条）
	 * @param {'info'|'warn'|'error'} [level]
	 */
	add(key, detail = {}, level = 'info') {
		const at = this.now();
		const k = String(key);
		// 同一个 key 在窗口内重复：合并成一条 + count，别把缓冲冲干净
		const lastAt = this.lastKeyAt.get(k) ?? 0;
		if (at - lastAt < DEDUPE_MS && this.entries.length > 0) {
			const tail = this.entries[this.entries.length - 1];
			if (tail.key === k) {
				tail.count += 1;
				tail.at = at;
				tail.detail = detail;
				this.lastKeyAt.set(k, at);
				return;
			}
		}
		this.lastKeyAt.set(k, at);
		this.entries.push({ at, key: k, level, detail, count: 1 });
		if (this.entries.length > LIMIT) this.entries.splice(0, this.entries.length - LIMIT);
		// 同时打一行到宿主日志：设置页没开着的时候也能在终端看到
		if (level !== 'info') this.log(level, `[fish-soul] ${LABELS[k] ?? k}：${JSON.stringify(detail).slice(0, 200)}`);
	}

	/** 这一轮上下文长度（字符数粗估）。只在明显变化时记，避免每轮刷一条。 */
	noteContextSize(sessionId, chars, budget) {
		const key = `ctx:${String(sessionId)}`;
		const prev = getKv(this.db, key, null);
		const n = Number(chars) || 0;
		// 变化不到 20% 且没跨过 80% 预算线就不记
		const crossed = budget > 0 && n >= budget * 0.8 && !(prev !== null && Number(prev) >= budget * 0.8);
		if (prev !== null && !crossed && Math.abs(n - Number(prev)) < Math.max(200, Number(prev) * 0.2)) return;
		setKv(this.db, key, n);
		this.add('context-size', { sessionId: String(sessionId).slice(0, 24), chars: n, budget: Number(budget) || 0, over80: budget > 0 ? n >= budget * 0.8 : false });
	}

	/** 给界面用：最近的日志，新的在前。 */
	list(limit = LIMIT) {
		return [...this.entries].reverse().slice(0, limit).map((e) => ({
			at: e.at,
			key: e.key,
			label: labelOf(e.key),
			level: e.level,
			detail: e.detail,
			count: e.count
		}));
	}

	/** 清空（设置页「清空日志」按钮）。 */
	clear() {
		this.entries.length = 0;
		this.lastKeyAt.clear();
	}
}

/** 一行中文（时间线视图用）。放在这里而不是前端：格式化逻辑要能测。 */
export function describeEntry(entry) {
	const d = entry.detail ?? {};
	const bits = [];
	if (d.step !== undefined) bits.push(`第 ${d.step} 步${d.name ? `「${d.name}」` : ''}`);
	if (d.sessionId) bits.push(`会话 ${String(d.sessionId).slice(0, 12)}…`);
	if (d.channelId) bits.push(`聊天 ${d.channelId}`);
	if (d.count !== undefined) bits.push(`${d.count} 条`);
	if (d.chars !== undefined) bits.push(`${d.chars} 字${d.budget ? ` / 预算 ${d.budget}` : ''}${d.over80 ? '（超 80%）' : ''}`);
	if (d.reason) bits.push(String(d.reason).slice(0, 120));
	if (d.error) bits.push(String(d.error).slice(0, 120));
	if (entry.count > 1) bits.push(`重复 ${entry.count} 次`);
	return bits.join('，') || '（没有细节）';
}
