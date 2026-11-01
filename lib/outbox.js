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
	}

	hasQueued(channelId) {
		return this.db.prepare("SELECT 1 FROM outbox WHERE status = 'queued' AND channel_id = ? LIMIT 1").get(channelId) !== undefined;
	}

	size() {
		return Number(this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status = 'queued'").get().n);
	}

	enqueue({ channelId, title = '', segs, text = '', error = '' }) {
		const now = this.now();
		this.db.prepare(`INSERT INTO outbox (channel_id, title, segs, text, next_at, created_at, last_error)
			VALUES (?, ?, ?, ?, ?, ?, ?)`).run(channelId, title, JSON.stringify(segs), text, now + BACKOFF_MS[0], now, String(error));
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
		this.db.prepare("DELETE FROM outbox WHERE status <> 'queued' AND created_at < ?").run(now - KEEP_DONE_MS);
		const rows = this.db.prepare("SELECT * FROM outbox WHERE status = 'queued' ORDER BY id").all();
		const blocked = new Set();
		const mark = this.db.prepare('UPDATE outbox SET status = ?, attempts = ?, next_at = ?, last_error = ? WHERE id = ?');
		for (const row of rows) {
			if (blocked.has(row.channel_id)) continue;
			const item = { ...row, segs: JSON.parse(row.segs) };
			if (now - row.created_at > this.windowMs()) {
				mark.run('expired', row.attempts, row.next_at, row.last_error, row.id);
				this.onGiveUp(item, '超过回复时限，不再重发');
				continue;
			}
			if (!force && row.next_at > now) { blocked.add(row.channel_id); continue; }
			if (this.channel.connected === false) { blocked.add(row.channel_id); continue; }
			try {
				const id = await this.channel.send(row.channel_id, item.segs);
				mark.run('sent', row.attempts + 1, row.next_at, '', row.id);
				this.onSent(id, item);
			} catch (error) {
				const attempts = row.attempts + 1;
				const msg = String(error instanceof Error ? error.message : error);
				if (classifySendError(error) !== 'retry' || attempts >= BACKOFF_MS.length) {
					mark.run('gave_up', attempts, row.next_at, msg, row.id);
					this.onGiveUp(item, attempts >= BACKOFF_MS.length ? `重发 ${attempts} 次都没成功：${msg}` : `重发时${msg}，可能已经发出去了，不再重发`);
					continue;
				}
				mark.run('queued', attempts, now + BACKOFF_MS[attempts], msg, row.id);
				blocked.add(row.channel_id);
			}
		}
		const next = this.db.prepare("SELECT MIN(next_at) AS t FROM outbox WHERE status = 'queued'").get().t;
		if (next !== null && next !== undefined) this.schedule(Number(next) - this.now());
	}

	stop() {
		this.stopped = true;
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}
}
