/**
 * group-list.js —— 她在哪些群里（私聊提示词用）。
 *
 * 提示词是同步拼的，所以群列表也得同步能读：QQ 连上时拉一次、之后按 TTL 续，
 * 提示词那边只读缓存（不每轮调接口）。拉不到就静默跳过，别的提示词一个字不动。
 *
 * 数据来源（按顺序）：
 *  - 宿主 OneBot 的 get_group_list（标准接口，有群名）
 *  - chat_session 里她说过话的 QQ 群（兜底：群名从会话标题里抠）
 */
import { sanitizeName } from './channels/onebot.js';

/** 群列表缓存多久算新鲜。 */
export const GROUP_LIST_TTL_MS = 5 * 60_000;

/** 提示词里最多列几个群（再多这一行就太长了）。 */
const MAX_GROUPS = 20;

/** OneBot get_group_list 的返回 → [{id, name}]（有的实现把列表包在 group 里）。 */
export function parseGroupList(data) {
	const rows = Array.isArray(data) ? data : Array.isArray(data?.group) ? data.group : [];
	const out = [];
	const seen = new Set();
	for (const row of rows) {
		const id = String(row?.group_id ?? row?.groupId ?? '').trim();
		if (id === '' || seen.has(id)) continue;
		seen.add(id);
		out.push({ id, name: String(row?.group_name ?? row?.groupName ?? '') });
	}
	return out;
}

/**
 * [{id, name}] → 提示词里那一行；没有群就返回 ''（静默跳过）。
 *
 * 群名是外部数据，进提示词前先洗一遍（方括号换全角、去掉换行）——不然群名能伪造
 * 插件自己的 [xxx] 提示段。
 */
export function groupListLine(groups, { max = MAX_GROUPS } = {}) {
	const list = (Array.isArray(groups) ? groups : []).filter((g) => String(g?.id ?? '') !== '');
	if (list.length === 0) return '';
	const shown = list.slice(0, max).map((g) => {
		const name = sanitizeName(g?.name ?? '', '');
		return name === '' ? String(g.id) : `${name}（${g.id}）`;
	});
	if (list.length > max) shown.push(`等 ${list.length} 个群`);
	return `[你在这些群里] ${shown.join('、')}`;
}

/**
 * 这个会话要不要带群列表。
 *
 * 群里不给：她就在群里，不需要一份「她在哪些群」的清单。私聊给：不然她不知道自己在
 * 哪个群，被问一句「你在群里吗」就会瞎猜（嘴硬说不在）。
 */
export function groupListPromptLine(channel, groups) {
	if (String(channel ?? '').endsWith('-group')) return '';
	return groupListLine(groups);
}

/** 兜底：chat_session 里她说过话的 QQ 群（群名从会话标题里抠：QQ群·xxx）。 */
export function groupsFromSessions(db) {
	try {
		const rows = db.prepare(`
			SELECT channel_id, title FROM chat_session
			WHERE channel = 'qq' AND channel_id LIKE 'group:%'
		`).all();
		const out = [];
		const seen = new Set();
		for (const row of rows) {
			const id = String(row?.channel_id ?? '').replace(/^group:/, '').trim();
			if (id === '' || seen.has(id)) continue;
			seen.add(id);
			const title = String(row?.title ?? '').replace(/^QQ群·/, '').trim();
			out.push({ id, name: title });
		}
		return out;
	} catch {
		return [];
	}
}

export class GroupList {
	/**
	 * @param {object} deps
	 * @param {(action: string, params?: object) => Promise<any>} deps.call OneBot 调用
	 * @param {object|null} [deps.db] soul.db（兜底查群用）
	 * @param {(level: string, msg: string) => void} [deps.log]
	 * @param {number} [deps.ttlMs] 缓存多久算新鲜
	 * @param {() => number} [deps.now]
	 */
	constructor({ call, db = null, log = () => {}, ttlMs = GROUP_LIST_TTL_MS, now = () => Date.now() }) {
		this.call = call;
		this.db = db;
		this.log = log;
		this.ttlMs = ttlMs;
		this.now = now;
		/** @type {Array<{id: string, name: string}>} */
		this.groups = [];
		/** 接口成功拉过没有（拉过就以接口为准，哪怕是个空列表） */
		this.fetched = false;
		/** 上次尝试的时间（成功失败都算）—— TTL 按它算，失败也别每轮重试 */
		this.at = -Infinity;
		this.pending = null;
	}

	/** 同步：上次拿到的（可能是空的）。 */
	snapshot() {
		return this.groups;
	}

	/**
	 * 异步：缓存还新鲜就不调接口；拉失败保留上一次的结果。
	 *
	 * force：忽略 TTL 强制拉一次 —— QQ 刚连上 / 重连时用。插件启动时 QQ 还没连上，
	 * 第一次拉必然失败，那次失败不能把后面 5 分钟都堵死。
	 */
	async refresh({ force = false } = {}) {
		if (this.pending !== null) return this.pending;
		// TTL 按「上次尝试」算：拉失败也一样别每轮都去打扰宿主（它可能压根没这个接口）
		if (!force && this.now() - this.at < this.ttlMs) return this.groups;
		this.at = this.now();
		this.pending = (async () => {
			try {
				this.groups = parseGroupList(await this.call('get_group_list', {}));
				this.fetched = true;
			} catch (error) {
				this.log('warn', `[fish-soul] 拉群列表失败（私聊里就不带群列表了）：${String(error instanceof Error ? error.message : error)}`);
			} finally {
				this.pending = null;
			}
			return this.groups;
		})();
		return this.pending;
	}

	/** 提示词用的群列表：接口拿到的优先；没拉成功过才从 chat_session 兜底。 */
	promptGroups() {
		if (this.fetched) return this.groups;
		return groupsFromSessions(this.db);
	}
}
