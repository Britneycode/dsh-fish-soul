/**
 * 抖音适配器（PR2：接口与身份解析）。
 *
 * 只做两件事：
 *   ① 给出「已核实的身份键」（`douyin:<数字uid>`）—— 拿不到就返回 ''，不猜、不退回昵称。
 *   ② 抖音会话相关的纯查询：配置归一、身份反查、候选 / 绑定表、主人身份、会话 ID、认人、会话标题。
 *
 * 不做授权：master / allowList / replyAll 的判定留在网关（onDouyinMessage），
 * 适配器只回答「这条消息的身份键是什么、这个身份键对应谁」。
 *
 * 依赖方向：只 import db.js / douyin-conversation.js / gateway-util.js / channels/onebot.js，
 * 不 import gateway*.js。
 */

import { createHash } from 'node:crypto';
import { getKv, setKv, resolveOrCreatePlatformPerson, cleanupMergedDouyinNames } from './db.js';
import { isIdentityKey } from './douyin-conversation.js';
import { findDouyinRefs } from './douyin-browse.js';
import { douyinVideoIds } from './douyin-delivery.js';
import { splitChannelId, clampReplyWindow } from './gateway-util.js';
import { sanitizeName } from './channels/onebot.js';

/** 抖音 uid 绑定表的 kv key（`douyin.uin.<纯数字uid>`）；uid 不合法返回 ''。 */
function normUidKey(uid) {
	const s = String(uid ?? '').trim().replace(/^uid:/, '').replace(/^douyin:/, '');
	return /^\d+$/.test(s) ? `douyin.uin.${s}` : '';
}

export class DouyinAdapter {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync | (() => import('node:sqlite').DatabaseSync)} deps.db
	 *   库句柄，或返回句柄的函数。**推荐传函数**：网关允许 `gw.db = 新库` 换库（老测试就这么用），
	 *   快照下来的句柄会指向已关闭的旧库。
	 * @param {() => object} deps.getConfig 整个插件配置（读 douyin.* 与 masterQqUin）
	 * @param {(kind: string, info: object) => void} [deps.note] 记动态（候选提示用）
	 * @param {(level: string, msg: string) => void} [deps.log]
	 * @param {Function} [deps.diag]
	 * @param {() => object | null} [deps.inbox] 抖音收件箱（结算用）；传函数以便换通道实例
	 */
	constructor({ db, getConfig, note = () => {}, log = () => {}, diag = () => {}, inbox = null }) {
		this.platform = 'douyin';
		// 库里可能被整体替换（`gw.db = fresh`），所以每次用的时候再取
		const dbOf = typeof db === 'function' ? db : () => db;
		Object.defineProperty(this, 'db', { get: dbOf, configurable: true });
		this.getConfig = getConfig;
		/** 抖音收件箱（PR3：结算走这里）。用函数以便通道实例被替换时跟着换。 */
		this.inbox = typeof inbox === 'function' ? inbox : () => inbox;
		this.note = note;
		this.log = log;
		this.diag = diag;
		/** 仅声明能力；读取并做判定的仍是网关。 */
		this.capabilities = { proactive: 'share-only', crossPlatformReply: false, hostTools: false };
	}

	/** 抖音通道配置（与 ChatGateway.douyinConfig 同形）。 */
	douyinConfig() {
		const d = this.getConfig().douyin ?? {};
		const num = (v, def) => (Number.isFinite(Number(v)) ? Number(v) : def);
		return {
			enabled: d.enabled === true,
			autoReply: d.autoReply === true,
			masterName: String(d.masterName ?? '').trim(),
			// 主人身份：只认会话身份（`douyin:<uid>`）。昵称 `masterName` 只用于显示，
			// 不再授予任何权限 —— 同名可冒充，改名又会对不上。
			masterUid: String(d.masterUid ?? '').trim(),
			// 原生视频卡片分享（默认关）
			shareCard: d.shareCard === true,
			allowList: Array.isArray(d.allowList) ? d.allowList.map((x) => String(x).trim()).filter(Boolean) : [],
			replyAll: d.replyAll === true,
			groups: Array.isArray(d.groups) ? d.groups.map((x) => String(x).trim()).filter(Boolean) : [],
			groupReply: d.groupReply === true,
			callNames: Array.isArray(d.callNames) ? d.callNames.map((x) => String(x).trim()).filter(Boolean) : [],
			batchMs: num(d.batchMs, 3000),
			replyWindowMinutes: clampReplyWindow(d.replyWindowMinutes)
		};
	}

	/**
	 * 入站消息的「身份核验」：挡掉自身回声和不合法的身份键。只给结论，不做授权。
	 *
	 * @param {{userId?: string, senderId?: string}} m
	 * @param {string[]} selfUids 通道自己已知的 uid 列表（回声判定用）
	 * @returns {{ok: true, identity: string} | {ok: false, done: boolean, review: string}}
	 */
	verifyInbound(m, selfUids = []) {
		if (selfUids.includes(String(m?.senderId ?? '').trim())) {
			return { ok: false, done: true, review: '自身消息，不回复' };
		}
		if (!isIdentityKey(m?.userId)) {
			return { ok: false, done: false, review: '抖音会话身份未确认（缺会话 ID），消息已保留，暂不处理' };
		}
		return { ok: true, identity: String(m.userId) };
	}

	/**
	 * 这个聊天对应的 QQ 号。算不出返回 ''（不共享会话）。昵称绝不当身份。
	 *
	 * 两级：① 数字 uid 对应表直接认；② 昵称对应表只定位候选，
	 * 必须拿到真实 uid 且已被主人确认过绑定（`douyin.uin.<uid>`）才并。
	 * 冒充者改名只能挂出候选，候选不点确认就不生效。
	 */
	douyinUinOf(chat) {
		const [kind] = splitChannelId(chat?.channelId);
		if (kind !== 'douyin') return '';
		const cfg = this.douyinConfig();
		const raw = this.getConfig().douyin ?? {};
		const links = Array.isArray(raw.links) ? raw.links : [];
		const norm = (v) => String(v ?? '').trim().replace(/^uid:/, '').replace(/^douyin:/, '');
		// 真实 uid：优先 chat.userId；没有就从会话游标反查（游标里的 identity 是会话 ID 推出来的，不是昵称）
		let uid = norm(chat?.userId);
		if (!/^\d+$/.test(uid)) uid = norm(this.douyinIdentityOfChannel(chat?.channelId));
		const hasUid = /^\d+$/.test(uid);

		// ① 主人身份（数字 uid）—— 最硬的一条
		const master = norm(cfg.masterUid);
		if (hasUid && /^\d+$/.test(master) && uid === master) return String(this.getConfig().masterQqUin ?? '');

		// ② 数字 uid 对应表
		if (hasUid) {
			for (const line of links) {
				const m = String(line).match(/^\s*(?:douyin:|uid:)?(\d+)\s*[=:：]\s*(\d{5,12})\s*$/);
				if (m && uid === m[1]) return m[2];
			}
		}

		if (!hasUid) return ''; // 只有昵称、拿不到真实 uid ⇒ 不敢并（宁可少并，不可串号）

		// 🔴 绑定表优先，跟昵称无关：主人确认过一次之后，这个人改了昵称也照样认。
		const boundQq = this.douyinUinBinding(uid);
		if (boundQq !== '') return boundQq;

		const name = String(splitChannelId(chat?.channelId)[1] ?? '').trim();
		if (name === '') return '';
		for (const line of links) {
			const m = String(line).match(/^\s*([^\d=:：\s][^=:：]*?)\s*[=:：]\s*(\d{5,12})\s*$/);
			if (!m || m[1] !== name) continue;
			// 走到这里 = 还没被主人确认过：挂一条候选，**不自动绑**
			this.noteDouyinUinCandidate({ name, uid, qq: m[2] });
			return '';
		}
		return '';
	}

	/** 待确认的候选：「这个 uid 是不是你这个昵称对应的人」。不自动绑定，给主人看一眼。 */
	noteDouyinUinCandidate({ name, uid, qq }) {
		const key = `douyin.uinCandidate.${name}`;
		try {
			const old = getKv(this.db, key, null);
			if (old?.uid === uid && old?.qq === qq) return; // 重复的同一条，不再弹
			setKv(this.db, key, { uid, qq, at: Date.now() });
			this.note?.('douyin-uin-candidate', { name, uid, qq });
			this.log?.('info', `[fish-soul] 有一条待确认的抖音身份：「${name}」→ uid ${uid}（配了 QQ ${qq}），等主人确认`);
		} catch { /* 记不下来不影响这一轮 */ }
	}

	/** `person` 表里这个抖音 uid 挂着的 QQ 号（认人阶段写的，是已确认的事实）；没有返回 ''。 */
	douyinPersonQq(uid) {
		const u = String(uid ?? '').trim().replace(/^uid:/, '').replace(/^douyin:/, '');
		if (!/^\d+$/.test(u)) return '';
		try {
			const row = this.db.prepare('SELECT qq_uin FROM person WHERE douyin_uid = ? OR douyin_uid = ? LIMIT 1')
				.get(`douyin:${u}`, `uid:${u}`);
			const qq = String(row?.qq_uin ?? '').trim();
			return /^\d{5,12}$/.test(qq) ? qq : '';
		} catch { return ''; }
	}

	/** 主人确认之后：把「真实 uid → QQ 号」写进绑定表，并清掉那条候选。 */
	confirmDouyinUin(name) {
		const key = `douyin.uinCandidate.${String(name ?? '').trim()}`;
		const c = getKv(this.db, key, null);
		if (!c?.uid || !/^\d+$/.test(String(c.uid)) || !/^\d{5,12}$/.test(String(c.qq))) return { ok: false, error: '没有这条候选（或已被确认过）' };
		this.bindDouyinUin(String(c.uid), String(c.qq));
		// 绑定已写进绑定表，这条候选没用了（留着会误导主人以为还没确认）
		try { setKv(this.db, key, null); } catch { /* 清不掉也不影响 */ }
		this.log?.('info', `[fish-soul] 已确认：「${name}」的抖音 uid ${c.uid} = QQ ${c.qq}`);
		return { ok: true, uid: String(c.uid), qq: String(c.qq) };
	}

	/** 主人要清空某条候选（错认了，或想重配）。 */
	dismissDouyinUinCandidate(name) {
		const key = `douyin.uinCandidate.${String(name ?? '').trim()}`;
		try { setKv(this.db, key, null); return { ok: true }; } catch { return { ok: false }; }
	}

	/** 面板读：有哪些待确认的候选。 */
	douyinUinCandidates() {
		try {
			return this.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'douyin.uinCandidate.%' AND value IS NOT NULL AND value != 'null'")
				.all()
				.map((r) => ({ name: String(r.key).slice('douyin.uinCandidate.'.length), ...(JSON.parse(r.value) ?? {}) }))
				.filter((x) => x.uid && x.qq);
		} catch { return []; }
	}

	/** 抖音真实 uid 绑定的 QQ 号（`douyin.uin.<uid>`）；没绑过返回 ''。 */
	douyinUinBinding(uid) {
		const key = normUidKey(uid);
		if (key === '') return '';
		try {
			const v = String(this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? '').replace(/"/g, '').trim();
			return /^\d{5,12}$/.test(v) ? v : '';
		} catch { return ''; }
	}

	/**
	 * 把「真实 uid → QQ 号」记进绑定表。
	 * 之后一切判断只看这张表：昵称改了不影响，冒充者 uid 不同也进不来。
	 */
	bindDouyinUin(uid, qq) {
		const key = normUidKey(uid);
		if (key === '' || !/^\d{5,12}$/.test(String(qq))) return;
		try {
			this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(String(qq)));
		} catch { /* 记不下来就这轮不并，下一轮再试 */ }
	}

	/**
	 * 抖音通道 id（`douyin:<昵称>`）→ 这个会话**真实的对端 uid**（`douyin:<uid>`）。
	 * 来源是轮询路学出来的游标（`douyin.conv.<sha1(昵称)前16>` 的 identity）。
	 * **不能退回昵称** —— 那正是 PR #96 的冒充洞。
	 */
	douyinIdentityOfChannel(channelId) {
		const [kind, name] = splitChannelId(channelId);
		if (kind !== 'douyin' || !name) return '';
		try {
			const key = `douyin.conv.${createHash('sha1').update(String(name)).digest('hex').slice(0, 16)}`;
			const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
			if (!row?.value) return '';
			const cur = JSON.parse(row.value);
			// 只认 `douyin:<数字uid>`；游标里的 name 是昵称，不能用
			return /^douyin:\d+$/.test(String(cur?.identity ?? '')) ? String(cur.identity) : '';
		} catch { return ''; }
	}

	/**
	 * 主人的抖音身份键（`douyin:<uid>`）。
	 * 优先设置页填的 `masterUid`；没填就退回 person.master 学到的（平台数据比手填更可信）。
	 */
	masterDouyinIdentity() {
		const cfg = this.douyinConfig();
		const configured = String(cfg.masterUid ?? '').trim();
		if (/^douyin:\d+$/.test(configured)) return configured;
		try {
			const row = this.db.prepare("SELECT douyin_uid FROM person WHERE canonical_id = 'master'").get();
			const learned = String(row?.douyin_uid ?? '').trim();
			if (/^douyin:\d+$/.test(learned)) return learned;
		} catch { /* 读不到就当没填，走下面那句提示 */ }
		return '';
	}

	/** 主人那个抖音会话的 ID（转达 / 主动私信要用）。没读过就是空，宁可发不出去也不按昵称猜。 */
	async masterDouyinConvId() {
		const id = this.masterDouyinIdentity();
		if (id === '') return '';
		try {
			return String(getKv(this.db, `douyin.convId.${id}`, '') ?? '').trim();
		} catch { return ''; }
	}

	/** 按会话身份建/找人。`masterUid` 对上就是主人，否则是陌生人（不按昵称合并）。 */
	resolveDouyinPerson(m, cfg) {
		try {
			// 顺手清一次「把几个名字拼一起」的脏身份：好几个人的往来会记在一个人头上。清掉并留痕。
			for (const c of cleanupMergedDouyinNames(this.db)) {
				this.log('info', `[fish-soul] 抖音：清掉一个「把几个名字拼一起」的脏身份「${c.douyinUid}」（连带 ${c.memories} 条小结）`);
			}
			return resolveOrCreatePlatformPerson(this.db, {
				platform: 'douyin',
				platformId: String(m.userId),
				nickname: String(m.nickname ?? ''),
				nowMs: Date.now(),
				masterId: cfg.masterUid || ''
			});
		} catch (error) {
			this.log('warn', `[fish-soul] 抖音认人失败（按陌生人处理）：${String(error instanceof Error ? error.message : error)}`);
			return null;
		}
	}

	/** 抖音会话标题（chatTitle 的抖音分支）。 */
	title(chat) {
		const name = chat.targetId;
		if (chat.chatType === 'group') return `抖音群·${sanitizeName(name, '抖音群')}`;
		return `抖音·${sanitizeName(name, '抖音用户')}`;
	}

	// ───────────── 平台机制（PR5） ─────────────

	/** 文本里的抖音视频引用（作品 ID / 短链）。 */
	refs(text) {
		return findDouyinRefs(text);
	}

	// ───────────── 路由信息（PR3） ─────────────
	//
	// 🔴 字段名与位置**不能动**：`convId` / `inboxIds` 写在宿主保存的消息 `source` 顶层，
	//    插件重启后宿主会重放旧格式的消息。适配器读写同样的字段。

	/**
	 * 这一批消息要带哪些路由信息（写进 followup 的 source）。
	 *
	 * @param {Array<{m: object}>} items 这一轮收到的消息
	 * @param {string} platform 这一轮来自哪个平台（`douyin` 之外的平台不写 convId）
	 *   **没有默认值**：漏传 platform 时宁可不写 convId，也不能给 QQ 批写上抖音会话 ID。
	 * @returns {{convId?: string, inboxIds?: string[]}} 字段名与现在 source 里一致
	 */
	routeOf(items, platform) {
		const inboxIds = (items ?? []).map((x) => x?.m?.inboxId).filter(Boolean);
		const last = (items ?? [])[(items ?? []).length - 1]?.m;
		const convId = platform === 'douyin' && last?.convId ? String(last.convId) : '';
		return {
			...(inboxIds.length ? { inboxIds } : {}),
			...(convId !== '' ? { convId } : {})
		};
	}

	/**
	 * 把 source 里的路由信息吸收进这一轮的 state。
	 *
	 * @param {object} st 这一轮的 turn state
	 * @param {object} source 宿主重放的消息 source
	 */
	absorbRoute(st, source) {
		if (Array.isArray(source?.inboxIds)) {
			st.inboxIds = [...new Set([...(st.inboxIds ?? []), ...source.inboxIds])];
		}
		if (source?.convId) st.convId = String(source.convId);
	}

	/**
	 * 结算这轮处理过的私信（成功 / 不确定）。
	 *
	 * @param {string[]} ids 收件箱记录 id
	 * @param {boolean} ok 这一轮是否正常完成
	 * @param {string} why 不确定时的原因
	 */
	settle(ids, ok, why = '') {
		const inbox = typeof this.inbox === 'function' ? this.inbox() : this.inbox;
		if (inbox === null || inbox === undefined || typeof inbox.settle !== 'function') return;
		inbox.settle(ids, ok, why);
	}
}

/**
 * 文本里的抖音作品 ID 列表（分享原生卡片要知道作品 ID）。
 *
 * 导出成独立函数：life.js 的 LifeEngine 在网关之前构造，
 * 让它经适配器实例拿作品 ID 会把「能不能分享」绑在实例时序上。
 */
export function douyinVideoIdsOf(text) {
	return douyinVideoIds(text);
}

/**
 * 拿 this 上的抖音适配器；没有就临时造一个挂上去。
 *
 * 为什么：老测试（douyin-master-uid.mjs 等）用 `Object.create(mediaMethods)` 手搓 this，
 * 没有 douyinAdapter 属性。mediaMethods 上的同名转发函数通过这里拿适配器，
 * 老测试就一行都不用改。
 */
export function adapterOf(self) {
	if (self.douyinAdapter instanceof DouyinAdapter) return self.douyinAdapter;
	// 手搓 this（老测试）经常**自己塞一个 douyinConfig**（有的是 own property），
	// 而不是完整的 getConfig —— 那种情况下它才是这段测试的配置源，
	// 用 getConfig 反而会读到空配置。判据：douyinConfig 是不是 own property。
	const hasOwnConfig = Object.hasOwn(self, 'douyinConfig');
	const getConfig = hasOwnConfig
		? () => ({ douyin: self.douyinConfig(), masterQqUin: self.masterQqUin ?? self.getConfig?.()?.masterQqUin ?? '' })
		: (typeof self.getConfig === 'function' ? self.getConfig : () => ({}));
	self.douyinAdapter = new DouyinAdapter({
		// 传函数而不是快照：`gw.db = 新库` 的用法要跟着换
		db: () => self.db,
		getConfig,
		// 抖音收件箱：结算私信用。手搓 this 上没有 douyin 时就是 null。
		inbox: () => self.douyin?.inbox ?? null,
		note: self.note ? (...a) => self.note(...a) : () => {},
		log: self.log ? (...a) => self.log(...a) : () => {},
		diag: self.diag ? (...a) => self.diag(...a) : () => {}
	});
	return self.douyinAdapter;
}
