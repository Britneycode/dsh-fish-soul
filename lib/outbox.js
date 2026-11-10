/**
 * outbox.js —— QQ 发送失败的重发队列（v0.11.1）。
 *
 * 模型已经写好的回复，因为 QQ 没连上 / 被接口拒了而没发出去，以前只记一条「发送失败」就丢了。
 * 现在先落到 soul.db 的 outbox 表，按 2s → 10s → 30s → 60s → 120s 退避重发，连上 QQ 时立刻补发；
 * 超过回复时限（replyWindowMinutes）或重试用完就放弃并记进「动态」。
 *
 * 只重发"肯定没发出去"的：QQ 未连接、接口明确拒绝（retcode）。
 * 连接中途断开 / 调用超时时消息可能已经到了对方那里，重发会刷屏，所以不重发，只记一笔。
 * 同一个聊天里有排队的消息时，新的回复也排到后面，保证顺序不乱。
 */
const BACKOFF_MS = [2000, 10_000, 30_000, 60_000, 120_000];
const KEEP_DONE_MS = 24 * 3600_000;
const OFFLINE_RECHECK_MS = 30_000;

export const OUTBOX_SQL = `
CREATE TABLE IF NOT EXISTS outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id  TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '',
  segs        TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'queued',
  last_error  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_outbox_queued ON outbox(status, channel_id, id);
`;

/**
 * 老库补列。
 *
 * `conv_id` 是抖音私信的**目标会话 ID**（`0:1:uidA:uidB`）：重发时可能已经隔了几分钟，
 * 期间用户完全可能在抖音里切过会话。没有这个 ID 就只能靠昵称找会话，
 * 名字一变或撞名就把消息发给了别人。补列失败（比如并发已经补过）不影响使用。
 */
function migrate(db) {
	try { db.exec("ALTER TABLE outbox ADD COLUMN conv_id TEXT NOT NULL DEFAULT ''"); } catch { /* 已经补过 */ }
}

/** 'retry' = 肯定没发出去，可以重发；'unknown' = 可能已经发出去了，不重发。 */
export function classifySendError(error) {
	const msg = String(error instanceof Error ? error.message : error);
	if (/未连接/.test(msg)) return 'retry';
	if (/retcode/.test(msg)) return 'retry';
	return 'unknown';
}

export class Outbox {
	/**
	 * @param {object} deps
	 * @param {import('node:sqlite').DatabaseSync} deps.db
	 * @param {{ connected?: boolean, send: (channelId: string, segs: object[]) => Promise<string> }} deps.channel
	 * @param {() => number} deps.windowMs 超过多久就不再重发（取回复时限）
	 * @param {(id: string, item: object) => void} [deps.onSent]
	 * @param {(item: object, reason: string) => void} [deps.onGiveUp]
	 * @param {(level: string, msg: string) => void} [deps.log]
	 * @param {() => number} [deps.now]
	 */
	constructor({ db, channel, windowMs, onSent, onGiveUp, log, now }) {
		this.db = db;
		this.channel = channel;
		this.windowMs = windowMs;
		this.onSent = onSent ?? (() => {});
		this.onGiveUp = onGiveUp ?? (() => {});
		this.log = log ?? (() => {});
		this.now = now ?? (() => Date.now());
		this.timer = null;
		this.flushing = null;
		this.stopped = false;
		db.exec(OUTBOX_SQL);
		migrate(db);
		// 上次进程可能在远端收到消息后、写入结果前退出：不能猜测是否送达。
		this.interrupted = db.prepare("SELECT * FROM outbox WHERE status = 'sending' ORDER BY id").all();
		db.prepare("UPDATE outbox SET status = 'unknown', last_error = ? WHERE status = 'sending'")
			.run('发送过程中程序中断，结果未知');
		if (this.interrupted.length > 0) {
			this.log('warn', `[fish-soul] ${this.interrupted.length} 条重发在上次退出时状态未知，需核实，不会自动重发`);
			this.schedule(3000); // 构造结束后再通知，避免调用方尚未初始化
		}
	}

	hasQueued(channelId) {
		return this.db.prepare("SELECT 1 FROM outbox WHERE status IN ('queued', 'sending') AND channel_id = ? LIMIT 1").get(channelId) !== undefined;
	}

	/**
	 * 把卡住的 `sending` 收成 `unknown`。
	 *
	 * 构造期只回收「上次进程留下的」那些。运行中也可能卡住：标记 sending 成功后发送成功，
	 * 但把结果写回 sent 时写库失败 —— 这一行既不会被重发（flush 只捞 queued），
	 * 也不会被清理，而 hasQueued 认它，于是这个聊天之后每条回复都被塞进队列干等。
	 * 它没有对应的 interrupted 条目，所以不会自己冒出来，只能在这里扫。
	 */
	reclaimStuck() {
		let rows;
		try {
			rows = this.db.prepare("SELECT * FROM outbox WHERE status = 'sending' ORDER BY id").all();
		} catch (error) { this.log('warn', `[fish-soul] 检查卡住的重发记录失败：${error}`); return; }
		for (const row of rows) {
			let ok = false;
			try {
				ok = Number(this.db.prepare("UPDATE outbox SET status = 'unknown', last_error = ? WHERE id = ? AND status = 'sending'")
					.run('发送结果未能写回，可能已经发出去了，请先核实', row.id).changes) === 1;
			} catch (error) { this.log('warn', `[fish-soul] 回收卡住的重发记录失败：${error}`); continue; }
			if (!ok) continue;
			// onGiveUp 只用 channel_id / title / text，不需要解析 segs
			try { this.onGiveUp(row, '发送结果未能写回，可能已经发出去了，请先核实，不再重发'); }
			catch (error) { this.log('warn', `[fish-soul] 卡住记录的通知失败：${error}`); }
		}
	}

	size() {
		return Number(this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'queued'").get().n);
	}

	enqueue({ channelId, title = '', segs, text = '', error = '', convId = '' }) {
		const now = this.now();
		this.db.prepare(`INSERT INTO outbox (channel_id, title, segs, text, next_at, created_at, last_error, conv_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(channelId, title, JSON.stringify(segs), text, now + BACKOFF_MS[0], now, String(error), String(convId ?? ''));
		this.schedule(BACKOFF_MS[0]);
	}

	schedule(delayMs) {
		if (this.stopped) return;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, Math.max(0, delayMs));
		this.timer.unref?.();
	}

	/** 把到点的排队消息按聊天、按顺序发出去；某个聊天发失败就停在那里，下一轮再试。 */
	flush({ force = false } = {}) {
		this.flushing ??= this.flushOnce({ force }).finally(() => { this.flushing = null; });
		return this.flushing;
	}

	async flushOnce({ force }) {
		if (this.stopped) return;
		const now = this.now();
		for (const item of this.interrupted.splice(0)) {
			try { this.onGiveUp(item, '发送过程中程序中断，可能已经发出去了，请先核实，不再重发'); }
			catch (error) { this.log('warn', `[fish-soul] 重发恢复通知失败：${error}`); }
		}
		// 清理过期记录只是卫生工作：写库失败不该让整轮重发（以及宿主进程）跟着挂。
		try { this.db.prepare("DELETE FROM outbox WHERE status <> 'queued' AND created_at < ?").run(now - KEEP_DONE_MS); }
		catch (error) { this.log('warn', `[fish-soul] 清理重发记录失败：${error}`); }
		this.reclaimStuck();
		const rows = this.db.prepare("SELECT * FROM outbox WHERE status = 'queued' ORDER BY id").all();
		const blocked = new Set();
		const mark = this.db.prepare('UPDATE outbox SET status = ?, attempts = ?, next_at = ?, last_error = ? WHERE id = ?');
		/**
		 * 写库本身失败时不能让异常冒出去：flush 的两个调用点都是 `void`（schedule 的定时器、
		 * 宿主的 onConnected），没有 unhandledRejection 兜底，抛出去就是进程退出。
		 * 返回 false 表示这条这次没动成，调用方按「这个聊天先停手」处理。
		 */
		const markSafe = (status, attempts, nextAt, lastError, id) => {
			try { mark.run(status, attempts, nextAt, lastError, id); return true; }
			catch (error) { this.log('warn', `[fish-soul] 重发状态写入失败（${status}）：${error}`); return false; }
		};
		for (const row of rows) {
			if (blocked.has(row.channel_id)) continue;
			const item = { ...row, segs: JSON.parse(row.segs) };
			if (now - row.created_at > this.windowMs()) {
				if (!markSafe('expired', row.attempts, row.next_at, row.last_error, row.id)) { blocked.add(row.channel_id); continue; }
				this.onGiveUp(item, '超过回复时限，不再重发');
				continue;
			}
			if (!force && row.next_at > now) { blocked.add(row.channel_id); continue; }
			if (this.channel.connected === false) { blocked.add(row.channel_id); continue; }
			// 先持久化发送中，重启后将其视为未知，不作自动重发。
			// 这一步写不进去就别发了：发了之后记不住「可能已发出」，重启就会重发刷屏。
			if (!markSafe('sending', row.attempts, row.next_at, '', row.id)) { blocked.add(row.channel_id); continue; }
			let id;
			try {
				// conv_id 一路带到驱动层：抖音重发前要用它校验「打开的还是那个会话」。
				id = await this.channel.send(row.channel_id, item.segs, row.conv_id ?? '');
			} catch (error) {
				const attempts = row.attempts + 1;
				const msg = String(error instanceof Error ? error.message : error);
				if (classifySendError(error) !== 'retry' || attempts >= BACKOFF_MS.length) {
					markSafe('gave_up', attempts, row.next_at, msg, row.id);
					this.onGiveUp(item, attempts >= BACKOFF_MS.length ? `重发 ${attempts} 次都没成功：${msg}` : `重发时${msg}，可能已经发出去了，不再重发`);
					continue;
				}
				markSafe('queued', attempts, now + BACKOFF_MS[attempts], msg, row.id);
				blocked.add(row.channel_id);
				continue;
			}
			// 消息已经真的发出去了。这里写失败只影响记账（重启后会被当成 unknown 请人核实），
			// 绝不能让异常冒出去 —— 那等于「发成功了一条，宿主却崩了」。
			markSafe('sent', row.attempts + 1, row.next_at, '', row.id);
			try { this.onSent(id, item); }
			catch (error) { this.log('warn', `[fish-soul] 重发成功通知失败：${error}`); }
		}
		const next = this.db.prepare("SELECT MIN(next_at) AS t FROM outbox WHERE status = 'queued'").get().t;
		if (next !== null && next !== undefined) {
			const delay = Number(next) - this.now();
			this.schedule(this.channel.connected === false ? Math.max(OFFLINE_RECHECK_MS, delay) : delay);
		}
	}

	stop() {
		this.stopped = true;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}
}
