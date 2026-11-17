// 熟人传话之外的「刷到就分享」兜底（#133）：
//   模型不标 [分享] 时，最近 N 天没分享过就主动挑一条排上。
//
// 为什么要有：分享原本只靠模型在每条视频末尾标 [分享]，而提示词里明说
// 「大多数视频不用」⇒ 真机实测她几乎不标 ⇒ 分享待办长期为 0，
// 主人看到的就是「她刷了一堆视频，但从不开腔分享」（#133 的截图就是这个）。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { afterRound } from '../lib/browse.js';

const ok = (msg) => console.log('  ✓ ' + msg);

// ── afterRound 的兜底行为 ──
{
	const notes = [];
	const shared = [];
	const self = {
		note: (k, x) => notes.push([k, x]),
		share: (x) => { shared.push(x); return { ok: true }; },
		shareFallback: (x) => { self._fb = x; return { ok: true }; }
	};
	const watched = [
		{ share: false, skipped: false, impression: '讲得挺清楚', title: 'A', owner: '甲', url: 'https://x/a' },
		{ share: false, skipped: true, impression: '', title: 'B', owner: '乙', url: 'https://x/b' }
	];
	const pick = (w) => ({ title: w.title, owner: w.owner });
	afterRound(self, 'B站', watched, pick);

	assert.equal(shared.length, 0, '模型没标分享时不该走正常的 share 回调');
	assert.ok(self._fb, '应该调 shareFallback');
	assert.equal(self._fb.platform, 'B站');
	assert.equal(self._fb.candidates.length, 2, '兜底要把候选都交给自走层挑');
	assert.ok(notes.some(([k]) => k === 'share'), '排上了要记一条 share 动态');
	ok('模型没标 [分享] 时走兜底回调');
}

// ── 模型标了分享时，兜底不该被调用（别重复排两条）──
{
	let fbCalled = false;
	const shared = [];
	const self = {
		note: () => {},
		share: (x) => { shared.push(x); return { ok: true }; },
		shareFallback: () => { fbCalled = true; return { ok: true }; }
	};
	const watched = [{ share: true, skipped: false, impression: '有意思', title: 'A', owner: '甲', url: 'https://x/a' }];
	afterRound(self, 'B站', watched, (w) => ({ title: w.title, owner: w.owner }));
	assert.equal(shared.length, 1, '模型标了就正常走 share');
	assert.equal(fbCalled, false, '模型标了就不该再兜底（否则一条视频排两次）');
	ok('模型标了 [分享] 时不重复兜底');
}

// ── 没有 shareFallback 回调时不能炸（旧调用方兼容）──
{
	const self = { note: () => {}, share: () => ({ ok: true }) };
	assert.doesNotThrow(() => {
		afterRound(self, 'B站', [{ share: false, skipped: false, impression: 'x', title: 'A', owner: '甲', url: 'u' }], (w) => ({ title: w.title }));
	}, '没有 shareFallback 回调时不能抛');
	ok('没有兜底回调时不抛异常');
}

// ── queueShareFallback 的门槛（用 life 的真实实现）──
{
	const { LifeEngine } = await import('../lib/life.js');
	const db = new DatabaseSync(':memory:');
	db.exec(`CREATE TABLE pending (id INTEGER PRIMARY KEY AUTOINCREMENT, character_id TEXT, owner_id TEXT, channel TEXT, channel_id TEXT, due_at INTEGER, reason TEXT, status TEXT, created_at INTEGER, origin TEXT, surfaced_at INTEGER);
	CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE day (character_id TEXT, date TEXT, proactive_count INTEGER, last_proactive_at INTEGER, PRIMARY KEY (character_id, date));`);
	// masterQqUin 要给：life 的 masterChannel() 从 config 推主人私聊通道（不是构造参数）
	let cfg = { masterQqUin: '10001', proactive: { enabled: true, shareMaxPerDay: 2, shareFallbackDays: 2, targets: { masterCanonicalId: 'user:master' } } };
	let now = 1_000_000_000;
	const life = new LifeEngine({
		db,
		clock: { now: () => now, getRoleDateParts: () => ({ dateStr: '2026-11-17' }) },
		getConfig: () => cfg,
		log: () => {},
		note: () => {},
		worker: { enqueueRealtime: () => {} },
		callLlm: async () => null,
		armPendingAlarm: () => {}
	});
	const candidates = [{ title: '高中数学', owner: '甲', url: 'https://bili/x1', impression: '讲得挺清楚', skipped: false }];

	// (1) 从来没分享过 → 排上了
	{
		const r = life.queueShareFallback({ platform: 'B站', candidates });
		assert.equal(r.ok, true, `应该排上，实际：${r.error}`);
		const rows = db.prepare("SELECT * FROM pending WHERE origin='share'").all();
		assert.equal(rows.length, 1, '应该排了一条分享待办');
		assert.ok(String(rows[0].reason).includes('高中数学'), '待办里要带上视频标题');
		ok('从没分享过 → 主动挑一条排上');
	}

	// (2) 刚**送达**过 → 不排（lastAt 记在送达时，不是入队时）
	{
		const pid = Number(db.prepare("SELECT id FROM pending WHERE origin='share' ORDER BY id DESC LIMIT 1").get().id);
		db.prepare("UPDATE pending SET status='done' WHERE id = ?").run(pid);
		life.recordShareSent(pid, now);
		const before = db.prepare("SELECT COUNT(*) c FROM pending WHERE origin='share'").get().c;
		const r = life.queueShareFallback({ platform: 'B站', candidates });
		assert.equal(r.ok, false, '刚送达过不该再排');
		assert.match(r.error, /最近 2 天分享过了/);
		assert.equal(db.prepare("SELECT COUNT(*) c FROM pending WHERE origin='share'").get().c, before, '没排新的');
		ok('刚送达过 → 不重复排');
	}

	// (3) 过了门槛 → 又可以排
	{
		db.prepare("UPDATE pending SET status='done' WHERE origin='share'").run();
		now += 3 * 24 * 3600_000; // 3 天后
		const r = life.queueShareFallback({ platform: 'B站', candidates });
		assert.equal(r.ok, true, `过了门槛应该能排，实际：${r.error}`);
		ok('过了「几天没分享」的门槛 → 又可以排');
	}

	// (4) 门槛关着（0）→ 永远不主动挑
	{
		db.prepare("UPDATE pending SET status='done' WHERE origin='share'").run();
		cfg = { ...cfg, proactive: { ...cfg.proactive, shareFallbackDays: 0 } };
		const before = db.prepare("SELECT COUNT(*) c FROM pending WHERE origin='share'").get().c;
		const r = life.queueShareFallback({ platform: 'B站', candidates });
		assert.equal(r.ok, false, '门槛关着就不该排');
		assert.match(r.error, /兜底关着/);
		assert.equal(db.prepare("SELECT COUNT(*) c FROM pending WHERE origin='share'").get().c, before);
		ok('门槛设为 0 → 不主动挑');
	}

	// (5) 候选里没有「有感受的」→ 不排一条没内容的链接
	{
		db.prepare("UPDATE pending SET status='done' WHERE origin='share'").run();
		cfg = { ...cfg, proactive: { ...cfg.proactive, shareFallbackDays: 2 } };
		now += 5 * 24 * 3600_000;
		const before = db.prepare("SELECT COUNT(*) c FROM pending WHERE origin='share'").get().c;
		const r = life.queueShareFallback({ platform: 'B站', candidates: [{ title: 'X', url: 'u', impression: '', skipped: false }] });
		assert.equal(r.ok, false, '没感受的不该排');
		assert.match(r.error, /没有值得分享的/);
		assert.equal(db.prepare("SELECT COUNT(*) c FROM pending WHERE origin='share'").get().c, before);
		ok('没有「有感受的」候选 → 不排');
	}

	// (6) 划走的不挑
	{
		db.prepare("UPDATE pending SET status='done' WHERE origin='share'").run();
		now += 5 * 24 * 3600_000;
		const r = life.queueShareFallback({ platform: 'B站', candidates: [{ title: 'X', url: 'u', impression: '还行', skipped: true }] });
		assert.equal(r.ok, false, '划走的视频不该被挑中分享');
		ok('划走的不挑');
	}
}

// ── 用**真实的 BiliBrowser 实例**跑一遍（#133 审查 P0-1 的教训）──
//    上一版测试全是手搓的对象字面量，所以「构造函数没接 shareFallback ⇒ 兜底是死代码」
//    这类洞一个都测不出来。判据：真实实例上 shareFallback 要是函数，且 afterRound 真能触发它。
{
	const { BiliBrowser } = await import('../lib/browse.js');
	let called = 0;
	const browser = new BiliBrowser({
		db: { prepare: () => ({ all: () => [] }) },
		clock: { now: () => Date.now() },
		client: {},
		getConfig: () => ({ enabled: true, browse: { share: true } }),
		callLlm: async () => null,
		persona: () => ({ name: '肥鱼', brief: '' }),
		share: () => ({ ok: true }),
		shareFallback: () => { called++; return { ok: true, chosen: { title: 'X' } }; }
	});
	assert.equal(typeof browser.shareFallback, 'function', '真实浏览器实例必须接住 shareFallback（否则兜底是死代码）');
	assert.equal(typeof browser.share, 'function', 'share 也要在');

	// 真跑一轮：模型没标分享 → 兜底被调用
	called = 0;
	afterRound(browser, 'B站', [{ share: false, skipped: false, impression: '有意思', title: 'A', owner: '甲', url: 'u' }], (w) => ({ title: w.title, owner: w.owner }));
	assert.equal(called, 1, '真实实例上模型没标分享要触发兜底');

	// 平台开关关着 → 兜底不许发（用户的显式关闭不能被反转）
	called = 0;
	browser.getConfig = () => ({ enabled: true, browse: { share: false } });
	afterRound(browser, 'B站', [{ share: false, skipped: false, impression: '有意思', title: 'A', owner: '甲', url: 'u' }], (w) => ({ title: w.title, owner: w.owner }));
	assert.equal(called, 0, '平台开关关了就不该兜底（用户显式关掉的开关不能被反转）');
	ok('真实 BiliBrowser：兜底接得住、平台开关关着就不发');
}

// ── lastAt 是「送达时」才记的（#133 审查 P1-5）──
//    排了但没发出去（failed / expired）不该把兜底锁死两天。
{
	const { LifeEngine } = await import('../lib/life.js');
	const db = new DatabaseSync(':memory:');
	db.exec(`CREATE TABLE pending (id INTEGER PRIMARY KEY AUTOINCREMENT, character_id TEXT, owner_id TEXT, channel TEXT, channel_id TEXT, due_at INTEGER, reason TEXT, status TEXT, created_at INTEGER, origin TEXT, surfaced_at INTEGER, attempts INTEGER DEFAULT 0);
	CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE day (character_id TEXT, date TEXT, proactive_count INTEGER, last_proactive_at INTEGER, PRIMARY KEY (character_id, date));`);
	const cfg = { masterQqUin: '10001', proactive: { enabled: true, shareMaxPerDay: 5, shareFallbackDays: 2, targets: { masterCanonicalId: 'user:master' } } };
	let now = 1_000_000_000;
	const life = new LifeEngine({
		db,
		clock: { now: () => now, getRoleDateParts: () => ({ dateStr: '2026-11-17' }) },
		getConfig: () => cfg, log: () => {}, note: () => {},
		worker: { enqueueRealtime: () => {} }, callLlm: async () => null,
		armPendingAlarm: () => {}
	});
	const candidates = [{ title: 'A', owner: '甲', url: 'u', impression: '有意思', skipped: false }];

	// 排上了，但**没发出去**（模拟投递失败）⇒ 兜底不该被锁死
	const r1 = life.queueShareFallback({ platform: 'B站', candidates });
	assert.equal(r1.ok, true, '应该排上');
	db.prepare("UPDATE pending SET status='failed' WHERE origin='share'").run();
	const r2 = life.queueShareFallback({ platform: 'B站', candidates });
	assert.equal(r2.ok, true, `排了但没发出去不该把兜底锁死（实际：${r2.error}）`);
	ok('lastAt 记在送达时 —— 排了没发出去不会锁死兜底');
}

// ── lastAt 分平台（#133 审查 P1-4）──
//    抖音分享一次不该把 B站的兜底也压掉（主人报的就是 B站）。
{
	const { LifeEngine } = await import('../lib/life.js');
	const db = new DatabaseSync(':memory:');
	db.exec(`CREATE TABLE pending (id INTEGER PRIMARY KEY AUTOINCREMENT, character_id TEXT, owner_id TEXT, channel TEXT, channel_id TEXT, due_at INTEGER, reason TEXT, status TEXT, created_at INTEGER, origin TEXT, surfaced_at INTEGER, attempts INTEGER DEFAULT 0);
	CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE day (character_id TEXT, date TEXT, proactive_count INTEGER, last_proactive_at INTEGER, PRIMARY KEY (character_id, date));`);
	const cfg = { masterQqUin: '10001', proactive: { enabled: true, shareMaxPerDay: 5, shareFallbackDays: 2, targets: { masterCanonicalId: 'user:master' } } };
	let now = 1_000_000_000;
	const life = new LifeEngine({
		db,
		clock: { now: () => now, getRoleDateParts: () => ({ dateStr: '2026-11-17' }) },
		getConfig: () => cfg, log: () => {}, note: () => {},
		worker: { enqueueRealtime: () => {} }, callLlm: async () => null,
		armPendingAlarm: () => {}
	});
	const candidates = [{ title: 'A', owner: '甲', url: 'u', impression: '有意思', skipped: false }];

	// 抖音分享一次（并标记为已送达）
	const r1 = life.queueShareFallback({ platform: '抖音', candidates });
	assert.equal(r1.ok, true, '抖音应该排上');
	const pid = Number(r1.id);
	db.prepare("UPDATE pending SET status='done' WHERE id = ?").run(pid);
	life.recordShareSent(pid, now);
	// B站的兜底不该被抖音这次分享压掉
	db.prepare("UPDATE pending SET status='done' WHERE origin='share'").run();
	const r2 = life.queueShareFallback({ platform: 'B站', candidates });
	assert.equal(r2.ok, true, `抖音分享过不该压掉 B站的兜底（实际：${r2.error}）`);
	ok('lastAt 分平台 —— 抖音分享过，B站照样能兜底');
}

// ── 过期判定：跨角色日的分享要作废（#133 审查 P1-6）──
//    TTL 放宽到 12 小时后，窗口必然跨午夜；待办正文写的是「你刚刷到」，
//    隔天早上发出去这话就不成立了。
{
	const { LifeEngine } = await import('../lib/life.js');
	const db = new DatabaseSync(':memory:');
	db.exec(`CREATE TABLE pending (id INTEGER PRIMARY KEY AUTOINCREMENT, character_id TEXT, owner_id TEXT, channel TEXT, channel_id TEXT, due_at INTEGER, reason TEXT, status TEXT, created_at INTEGER, origin TEXT, surfaced_at INTEGER, attempts INTEGER DEFAULT 0);
	CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE day (character_id TEXT, date TEXT, proactive_count INTEGER, last_proactive_at INTEGER, PRIMARY KEY (character_id, date));`);
	// now 要和 dateStr 对得上（角色日 2026-11-17 的下午），否则 roleDayStart 算出来是未来
	const dayStart = Date.UTC(2026, 10, 17) - 8 * 3600_000;
	const now = dayStart + 14 * 3600_000; // 当天 14:00（UTC+8）
	const life = new LifeEngine({
		db,
		clock: { now: () => now, getRoleDateParts: () => ({ dateStr: '2026-11-17' }) },
		getConfig: () => ({ masterQqUin: '10001', proactive: { enabled: true, shareMaxPerDay: 5, shareFallbackDays: 2 } }),
		log: () => {}, note: () => {}, worker: { enqueueRealtime: () => {} }, callLlm: async () => null,
		armPendingAlarm: () => {}
	});
	// 当天排的 → 不过期
	assert.equal(life.shareExpired({ due_at: now, created_at: now }, now), false, '当天排的分享不该作废');
	// ⚠️ 「跨角色日」判定只在**距入队不到 12 小时**时才起作用 ——
	//    超过 12 小时的话 TTL 条件先成立，撤掉跨日判定照样作废（测不出这一条）。
	//    所以判定时刻要贴着跨日点：昨天 23:00 入队，今天 01:00 判定。
	{
		const justAfterMidnight = dayStart + 3600_000;      // 今天 01:00
		const lateYesterday = dayStart - 3600_000;           // 昨天 23:00
		assert.ok(justAfterMidnight - lateYesterday < 12 * 3600_000,
			'这条用例的前提：距入队不到 12 小时（否则 TTL 条件先成立，测不出跨日判定）');
		assert.equal(life.shareExpired({ due_at: lateYesterday, created_at: lateYesterday }, justAfterMidnight), true,
			'刚跨角色日就该作废（隔天发就说不了「你刚刷到」）');
	}
	// 超过 TTL 的（同一天但排很久了）→ 作废
	assert.equal(life.shareExpired({ due_at: now - 13 * 3600_000, created_at: now - 13 * 3600_000 }, now), true, '超过 12 小时的要作废');
	ok('过期判定：超 TTL 或跨角色日都作废');
}

console.log('share-fallback: all assertions passed');
