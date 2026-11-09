/**
 * qq-group-admin.js —— 群管理：发版公告 + 入群申请。
 *
 *  - 发版公告：npm 上出现新版本 → 取 GitHub Release 正文（= CHANGELOG 里那一段）→ 发到指定群。
 *    每个版本只发一次（kv 记 lastAnnounced）；第一次跑只做基线（把当前版本记下来，不发），
 *    之后每出现更高的版本就公告一次。插件升级后自己也会把"当前版本"报一遍。
 *  - 入群申请：OneBot 11 的 request 事件（request_type=group）→ set_group_add_request 同意/拒绝；
 *    事件没推过来的用 get_group_system_msg(only_pending) 兜底轮询。
 *    自动同意（默认）/ 交给主人拍板（autoApprove=false → 私聊通知主人，回"/鱼 同意"或"/鱼 拒绝"）。
 *
 * 只发 GET + 明确的写操作（同意/拒绝入群、发公告），不做别的。
 */
import { getKv, setKv } from './db.js';
import { compareVersions, pluginVersion } from './update-check.js';

export const PACKAGE_NAME = 'dsh-fish-soul';
export const REPO = 'Britneycode/dsh-fish-soul';

const NPM_LATEST_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const RAW_CHANGELOG_URL = (version) => `https://raw.githubusercontent.com/${REPO}/v${version}/CHANGELOG.md`;
const GH_RELEASE_URL = (version) => `https://api.github.com/repos/${REPO}/releases/tags/v${version}`;
const FIRST_DELAY_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_NOTE_CHARS = 600;
const MAX_MEMBERS = 500;

/** kv 键：公告发到哪个版本了 / 待主人拍板的申请 / 最近入群的人 / 处理过的申请（防重复） */
export const KV_ANNOUNCED = 'qq.groupAdmin.announced';
export const KV_PENDING = 'qq.groupAdmin.pending';
export const KV_MEMBERS = 'qq.groupAdmin.members';
export const KV_HANDLED = 'qq.groupAdmin.handled';

function clampInt(value, min, max, fallback) {
	const n = Math.floor(Number(value));
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/** 配置归一：字段少、默认值稳，外部传什么都先过这一层。 */
export function normalizeConfig(raw) {
	const c = raw ?? {};
	return {
		enabled: c.enabled === true,
		groupId: String(c.groupId ?? '').replace(/^group:/, '').trim(),
		announce: c.announce !== false, // 发版公告
		autoApprove: c.autoApprove !== false, // 入群申请自动同意
		approveReason: String(c.approveReason ?? '').slice(0, 200),
		rejectReason: String(c.rejectReason ?? '').slice(0, 200),
		releasePollMinutes: clampInt(c.releasePollMinutes, 1, 1440, 5),
		requestPollSeconds: clampInt(c.requestPollSeconds, 15, 3600, 60)
	};
}

/**
 * GitHub Release 正文 → QQ 能看的几行。
 * Release 正文就是 CHANGELOG 里「- vX.Y.Z」那一段（缩进、markdown 强调都去掉）。
 */
export function cleanNotes(body, maxChars = MAX_NOTE_CHARS) {
	const lines = [];
	for (const raw of String(body ?? '').split(/\r?\n/)) {
		const line = raw
			.trim()
			.replace(/^[-*+]\s+/, '')
			.replace(/^#+\s*/, '')
			.replace(/\*\*/g, '')
			.trim();
		if (line === '') continue;
		lines.push(line);
	}
	const out = [];
	let used = 0;
	let dropped = false;
	for (const line of lines) {
		// 拼成一条消息时会多一个换行符，预算里得算上，否则每多一行就偷偷超一个字
		const room = maxChars - used - (out.length > 0 ? 1 : 0);
		if (room <= 0) { dropped = true; break; }
		// 一行就超长（CHANGELOG 常常是几百字一整个自然段）：截断它，不能整行丢掉。
		// 以前这里是 break，而 out 还是空的 ⇒ 返回 0 行 ⇒ 公告写「这次没写更新说明」，
		// 把「太长」当成了「没有」（v0.15.25 / .27 / .28 都因此漏了说明）。
		if (line.length > room) {
			// 尽量切在句末（。；！？），别停在半句话上；切不到才硬截。
			const cut = line.slice(0, Math.max(1, room - 1));
			const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('！'), cut.lastIndexOf('？'));
			out.push(end >= cut.length * 0.6 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`);
			dropped = true;
			break;
		}
		out.push(line);
		used += line.length + (out.length > 1 ? 1 : 0);
	}
	// 确实有内容没放下，才补一句指路（没被截断就不该冒出这句）
	if (dropped && out.length > 0) out.push('……（后面还有，见 Release 页面）');
	return out;
}

/**
 * CHANGELOG 里「- vX.Y.Z」那一段（= Release 正文那段）。
 * 规则跟 release.yml 里的 awk 一样：标题行行首是 "- vX.Y.Z"，往后收缩进的那几行，
 * 遇到下一个行首 "- " 就停。
 */
export function changelogSection(text, version) {
	const head = `- v${version}`;
	const out = [];
	let on = false;
	for (const line of String(text ?? '').split(/\r?\n/)) {
		if (!on) {
			if (line.startsWith(head)) { on = true; out.push(line.replace(/——$/, '').trim()); }
			continue;
		}
		if (/^- /.test(line)) break;
		out.push(line.replace(/^ {2}/, ''));
	}
	return out.join('\n');
}

/** 公告正文：标题 + 更新说明 + Release 链接。 */
export function formatAnnouncement({ version, notes }) {
	const lines = cleanNotes(notes);
	const body = lines.length > 0 ? lines.map((l) => `· ${l}`).join('\n') : '· （这次没写更新说明）';
	return `【${PACKAGE_NAME} v${version}】\n${body}\nhttps://github.com/${REPO}/releases/tag/v${version}`;
}

/** 主人看到的入群申请描述。 */
export function describeRequest(info) {
	const who = info.nick ? `${info.nick}（${info.userId}）` : String(info.userId ?? '?');
	const comment = String(info.comment ?? '').trim();
	return comment === '' ? who : `${who}：${comment}`;
}

export class GroupAdmin {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {() => object} deps.getConfig qq.groupAdmin
	 * @param {(level: string, msg: string) => void} [deps.log]
	 * @param {(action: string, params?: object) => Promise<any>} deps.call OneBot 调用
	 * @param {(groupId: string, text: string) => Promise<any>} deps.sendGroup 往群里发一条文字
	 * @param {(text: string) => void} [deps.notifyMaster] 私聊主人（提醒）
	 * @param {typeof fetch} [deps.fetchImpl]
	 * @param {() => number} [deps.now]
	 * @param {string} [deps.current] 插件自己正在跑的版本（比 npm 新的不算新闻）
	 */
	constructor({ db, getConfig, log, call, sendGroup, notifyMaster, fetchImpl, now, current }) {
		this.db = db;
		this.getConfig = getConfig ?? (() => ({}));
		this.log = log ?? (() => {});
		this.call = call ?? (async () => { throw new Error('没给 OneBot 调用'); });
		this.sendGroup = sendGroup ?? (async () => { throw new Error('没给发群消息的通道'); });
		this.notifyMaster = notifyMaster ?? (() => {});
		this.fetchImpl = fetchImpl ?? ((...a) => globalThis.fetch(...a));
		this.now = now ?? (() => Date.now());
		this.current = current ?? pluginVersion();
		this.timer = null;
		this.requestTimer = null;
		this.stopped = true;
		this.running = null;
	}

	config() {
		return normalizeConfig(this.getConfig());
	}

	/** 要管事：开关打开 + 群号填了。 */
	active() {
		const c = this.config();
		return c.enabled && c.groupId !== '';
	}

	start() {
		this.stop();
		this.stopped = false;
		this.armRelease(true);
		this.armRequests();
	}

	stop() {
		this.stopped = true;
		if (this.timer !== null) clearTimeout(this.timer);
		if (this.requestTimer !== null) clearTimeout(this.requestTimer);
		this.timer = null;
		this.requestTimer = null;
	}

	/** 第一次 30 秒后查（启动就能看到），之后按 releasePollMinutes。 */
	armRelease(first = false) {
		if (this.stopped) return;
		const minutes = this.config().releasePollMinutes;
		const delay = first ? FIRST_DELAY_MS : minutes * 60_000;
		this.timer = setTimeout(() => {
			void this.checkRelease().catch((e) => this.log('warn', `[fish-soul] 群管理：查新版本出错：${e instanceof Error ? e.message : e}`))
				.finally(() => this.armRelease());
		}, delay);
		this.timer.unref?.();
	}

	armRequests() {
		if (this.stopped) return;
		const seconds = this.config().requestPollSeconds;
		this.requestTimer = setTimeout(() => {
			void this.pollRequests().catch((e) => this.log('warn', `[fish-soul] 群管理：查入群申请出错：${e instanceof Error ? e.message : e}`))
				.finally(() => this.armRequests());
		}, seconds * 1000);
		this.requestTimer.unref?.();
	}

	// ── 发版公告 ─────────────────────────────────────────────

	async getJson(url) {
		const res = await this.fetchImpl(url, {
			headers: { accept: 'application/json', 'user-agent': `${PACKAGE_NAME}/${Date.now()}` },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	}

	async npmLatest() {
		const data = await this.getJson(NPM_LATEST_URL);
		return String(data?.version ?? '').trim() || null;
	}

	/**
	 * 那个版本的更新说明。
	 * 先取仓库里那个 tag 的 CHANGELOG（raw 不限流，GitHub API 常常 403 限流），
	 * 取不到再退到 Release 正文；都没有就空字符串（公告里写"没写更新说明"）。
	 */
	async releaseNotes(version) {
		try {
			const res = await this.fetchImpl(RAW_CHANGELOG_URL(version), {
				headers: { 'user-agent': `${PACKAGE_NAME}/${Date.now()}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
			if (res.ok) {
				const section = changelogSection(await res.text(), version);
				if (section !== '') return section;
			}
		} catch { /* raw 拿不到就试 API */ }
		try {
			const rel = await this.getJson(GH_RELEASE_URL(version));
			return String(rel?.body ?? '');
		} catch {
			return '';
		}
	}

	/**
	 * 查一次有没有新版本，有就公告。
	 * 第一次见到的版本也会播一次（不然"发版完立刻重启"就会漏掉那条公告）；之后只播比上次新的。
	 */
	async checkRelease() {
		const c = this.config();
		if (!c.enabled || !c.announce || c.groupId === '') return null;
		this.running ??= this.checkReleaseOnce().finally(() => { this.running = null; });
		return this.running;
	}

	async checkReleaseOnce() {
		let version = null;
		try { version = await this.npmLatest(); } catch (e) {
			this.log('warn', `[fish-soul] 群管理：问 npm 出错：${e instanceof Error ? e.message : e}`);
			return null;
		}
		if (version === null) return null;
		// npm 上的版本比本地还老（本地是还没发的开发版）：不是新闻
		if (compareVersions(version, this.current) < 0) return null;
		const last = String(getKv(this.db, KV_ANNOUNCED, '') ?? '');
		if (last !== '' && compareVersions(version, last) <= 0) return null;
		const notes = await this.releaseNotes(version);
		await this.announce(version, notes);
		return version;
	}

	/** 发公告（同一版本只发一次）。 */
	async announce(version, notes) {
		const c = this.config();
		if (!c.enabled || !c.announce || c.groupId === '') return false;
		const last = String(getKv(this.db, KV_ANNOUNCED, '') ?? '');
		if (last === version) return false;
		const text = formatAnnouncement({ version, notes });
		await this.sendGroup(c.groupId, text);
		setKv(this.db, KV_ANNOUNCED, version);
		this.log('info', `[fish-soul] 群管理：已在群里公告 v${version}`);
		return true;
	}

	// ── 入群申请 ─────────────────────────────────────────────

	/** OneBot 推来的群请求事件。 */
	async handleRequestEvent(ev) {
		const c = this.config();
		if (!c.enabled || c.groupId === '') return null;
		if (ev?.post_type !== 'request' || ev.request_type !== 'group') return null;
		const groupId = String(ev.group_id ?? '');
		if (groupId === '' || groupId !== c.groupId) return null;
		const flag = String(ev.flag ?? '');
		if (flag === '') return null;
		const info = {
			flag,
			subType: ev.sub_type === 'invite' ? 'invite' : 'add',
			userId: String(ev.user_id ?? ''),
			nick: String(ev.nickname ?? ev.requester_nick ?? ''),
			comment: String(ev.comment ?? ev.message ?? ''),
			groupId,
			at: this.now()
		};
		return await this.processRequest(info);
	}

	/** 兜底轮询：有些实现不推 request 事件，直接问"还有哪些没处理的入群申请"。 */
	async pollRequests() {
		const c = this.config();
		if (!c.enabled || c.groupId === '') return [];
		let rows = [];
		try {
			const data = await this.call('get_group_system_msg', { group_id: Number(c.groupId), only_pending: true, count: 50 });
			rows = Array.isArray(data) ? data : [];
		} catch (e) {
			this.log('warn', `[fish-soul] 群管理：拉入群申请失败：${e instanceof Error ? e.message : e}`);
			return [];
		}
		const done = new Set([...this.pending().map((p) => p.flag), ...this.handled()]);
		const handled = [];
		for (const row of rows) {
			const flag = String(row?.flag ?? '');
			if (flag === '' || done.has(flag)) continue;
			const info = {
				flag,
				// 记录里有邀请人 = 别人邀请 bot 进群（invite），否则是主动申请（add）
				subType: Number(row?.inviter_uin ?? 0) > 0 ? 'invite' : 'add',
				userId: String(row?.requester_uin ?? ''),
				nick: String(row?.requester_nick ?? ''),
				comment: String(row?.message ?? ''),
				groupId: c.groupId,
				at: this.now()
			};
			handled.push(await this.processRequest(info));
		}
		return handled.filter(Boolean);
	}

	/** 一个申请：自动同意（默认）或记下来等主人拍板。 */
	async processRequest(info) {
		const c = this.config();
		if (c.autoApprove) {
			await this.applyDecision(info, true);
			return { ...info, approved: true };
		}
		const list = this.pending();
		if (!list.some((p) => p.flag === info.flag)) {
			list.unshift(info);
			setKv(this.db, KV_PENDING, list.slice(0, 50));
		}
		this.notifyMaster(`群 ${info.groupId}：${describeRequest(info)} 想入群，回"/鱼 同意"或"/鱼 拒绝"。`);
		return { ...info, approved: false };
	}

	/** 真正调 OneBot 处理（同意/拒绝），并记一笔。 */
	async applyDecision(info, approve) {
		const c = this.config();
		const reason = approve ? c.approveReason : c.rejectReason;
		await this.call('set_group_add_request', {
			flag: info.flag,
			sub_type: info.subType,
			approve,
			reason
		});
		const list = this.pending().filter((p) => p.flag !== info.flag);
		setKv(this.db, KV_PENDING, list);
		const handled = this.handled().filter((f) => f !== info.flag);
		handled.unshift(info.flag);
		setKv(this.db, KV_HANDLED, handled.slice(0, 200));
		if (approve) {
			const members = this.members();
			members.unshift({ userId: info.userId, nick: info.nick, comment: info.comment, at: info.at });
			setKv(this.db, KV_MEMBERS, members.slice(0, MAX_MEMBERS));
		}
		this.notifyMaster(`群 ${info.groupId}：${describeRequest(info)} 已${approve ? '同意' : '拒绝'}入群。`);
		return true;
	}

	pending() {
		const list = getKv(this.db, KV_PENDING, []);
		return Array.isArray(list) ? list : [];
	}

	members() {
		const list = getKv(this.db, KV_MEMBERS, []);
		return Array.isArray(list) ? list : [];
	}

	/** 处理过的申请 flag（同一个不重复处理）。 */
	handled() {
		const list = getKv(this.db, KV_HANDLED, []);
		return Array.isArray(list) ? list.map((f) => String(f)) : [];
	}

	/**
	 * 主人拍板：同意/拒绝最近一条待处理的申请。
	 * @returns {Promise<string>} 回给主人的话
	 */
	async decide(approve) {
		const list = this.pending();
		if (list.length === 0) return '现在没有待处理的入群申请';
		const info = list[0];
		try {
			await this.applyDecision(info, approve);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			this.log('warn', `[fish-soul] 群管理：处理入群申请失败：${msg}`);
			return `处理失败：${msg}`;
		}
		return `已${approve ? '同意' : '拒绝'} ${describeRequest(info)} 的入群申请`;
	}
}
