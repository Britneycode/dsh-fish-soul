// 一次性数据修整：抖音身份拆分修复（真机库查证，不是推断）。
//
// 修的是什么：
//  ① master 行同时挂 QQ + B站，但没挂抖音 ⇒ 主人的抖音消息被建成独立 person 行 ⇒
//     「抖音的记忆跟 QQ/B站 分开」。根因是 `douyin.masterUid` 是空的：认人走
//     `resolveOrCreatePlatformPerson({ masterId: cfg.masterUid || '' })`，空就认不出主人。
//  ② `person.douyin_uid` 里混着裸昵称（`Re.`）和截断 uid（`uid:7702399256389125000`），
//     而认人按这一列精确匹配 ⇒ 同一个人的不同写法各占一行。
//
// 用法：node scripts/fix-douyin-master-split.mjs [--dry-run]
// 幂等：已经并过的行不存在，跳过。
import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const DRY = process.argv.includes('--dry-run');
const dbPath = join(homedir(), '.dsh', 'fish-soul', 'soul.db');
if (!existsSync(dbPath)) { console.error('找不到库：', dbPath); process.exit(1); }

/**
 * 合并计划：[被并走的行, 并到哪一行]
 * 每条都要人工确认过（真机库里逐条看过记忆内容，不是按名字猜的）。
 */
const MERGES = [
	// 主人的抖音身份 → master（内容是他本人：「这是我呀」「你在干嘛呢」+ 我发的测试消息）
	{ from: 'p_4c0644fc', to: 'master' },
	// 两个「Re.」是同一个人：内容对得上（在打什么 / 王者 / 赛车游戏 / [晚上好]），
	// 一行是 QQ 身份挂着裸昵称，一行是抖音 uid
	{ from: 'p_e70d82a7', to: 'p_4eb7df52' }
];
/**
 * 直接删掉的行（人工确认过，记忆要么是别人的、要么是空壳）：
 *  · p_b30a1bb3 —— 假 uid `1234567890123456789` 的空壳（0 条记忆，210 是互动次数）
 *  · p_459fa59e —— 被 Number() 截断的假 uid（真 uid 是 ...169），2 条记忆是群里
 *                  一个陌生群友说的话，不属于主人
 */
const DROPS = ['p_b30a1bb3', 'p_459fa59e'];

const db = new DatabaseSync(dbPath);
const row = (cid) => db.prepare('SELECT * FROM person WHERE canonical_id = ?').get(cid) ?? null;
const memCount = (cid) => db.prepare('SELECT COUNT(*) n FROM memory WHERE owner_id = ?').get(`user:${cid}`).n;

console.log(`模式：${DRY ? 'dry-run（只打印，不改）' : '真的改'}\n`);

/** 把一行的记忆 / 互动搬到另一行，然后删掉这一行。 */
function mergeOne(from, to, col) {
	const src = row(from);
	const dst = row(to);
	if (!src) { console.log(`跳过 ${from}：行不存在（已经并过？）`); return; }
	if (!dst) { console.log(`跳过 ${from}：目标 ${to} 不存在`); return; }
	const n = memCount(from);
	const key = src[col];
	console.log(`合并 ${from}（${src.display_name} · ${key ?? '-'}）→ ${to}：记忆 ${n} 条、互动 ${src.interaction_count} 次`);
	if (DRY) return;

	db.exec('BEGIN');
	try {
		// 直接 UPDATE memory 会被 weekly_protect 触发器 ABORT（周记也算 owner 变化）
		db.exec('DROP TRIGGER IF EXISTS weekly_protect');
		db.prepare('UPDATE memory SET owner_id = ? WHERE owner_id = ?').run(`user:${to}`, `user:${from}`);
		db.prepare('UPDATE pending SET owner_id = ? WHERE owner_id = ?').run(`user:${to}`, `user:${from}`);
		db.exec(`CREATE TRIGGER IF NOT EXISTS weekly_protect BEFORE UPDATE ON memory
			WHEN OLD.kind = 'weekly' AND NEW.content <> OLD.content
			BEGIN SELECT RAISE(ABORT, 'weekly 记忆不可修改'); END`);
		db.prepare(`UPDATE person SET interaction_count = interaction_count + ?,
			first_seen_at = MIN(first_seen_at, ?), last_seen_at = MAX(last_seen_at, ?) WHERE canonical_id = ?`)
			.run(src.interaction_count ?? 0, src.first_seen_at ?? Date.now(), src.last_seen_at ?? Date.now(), to);
		// ⚠️ `person.douyin_uid` 是 UNIQUE：先摘掉旧行的键、删掉旧行，再写到目标行上。
		//
		// 🔴 判据不能写成 `dst[col] === null` —— 目标行上那个键可能是**脏值**（真机里
		//    `p_4eb7df52` 的 douyin_uid 是裸昵称 `Re.`，不是 null），那样就跳过写入，
		//    合并后目标行还挂着脏身份。正确判据是「目标行的键不是这个键」。
		if (key !== null && key !== undefined && dst[col] !== key) {
			db.prepare(`UPDATE person SET ${col} = NULL WHERE canonical_id = ?`).run(from);
			db.prepare('DELETE FROM person WHERE canonical_id = ?').run(from);
			db.prepare(`UPDATE person SET ${col} = ? WHERE canonical_id = ?`).run(key, to);
		} else {
			db.prepare('DELETE FROM person WHERE canonical_id = ?').run(from);
		}
		db.exec('COMMIT');
		console.log('  ✓ 已合并');
	} catch (error) {
		db.exec('ROLLBACK');
		console.error(`  ✗ 失败（已回滚）：${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
	}
}

// 主人那一行要并到 master 的 douyin_uid（master 原本是空的）
mergeOne('p_4c0644fc', 'master', 'douyin_uid');
// 两个 Re. 合并：并到挂着 QQ 的那行（真人身份更硬），把抖音 uid 挂上去
mergeOne('p_e70d82a7', 'p_4eb7df52', 'douyin_uid');

// ── 删掉确认过的脏行 ──
for (const cid of DROPS) {
	const p = row(cid);
	if (!p) { console.log(`跳过 ${cid}：行不存在`); continue; }
	const n = memCount(cid);
	console.log(`清掉 ${cid}（${p.display_name} · ${p.douyin_uid ?? '-'} · 互动 ${p.interaction_count} 次 · ${n} 条记忆）`);
	if (DRY) continue;
	db.exec('BEGIN');
	try {
		db.exec('DROP TRIGGER IF EXISTS weekly_protect');
		db.prepare('DELETE FROM memory WHERE owner_id = ?').run(`user:${cid}`);
		db.prepare('DELETE FROM pending WHERE owner_id = ?').run(`user:${cid}`);
		db.exec(`CREATE TRIGGER IF NOT EXISTS weekly_protect BEFORE UPDATE ON memory
			WHEN OLD.kind = 'weekly' AND NEW.content <> OLD.content
			BEGIN SELECT RAISE(ABORT, 'weekly 记忆不可修改'); END`);
		db.prepare('DELETE FROM person WHERE canonical_id = ?').run(cid);
		db.exec('COMMIT');
		console.log('  ✓ 已删除');
	} catch (error) {
		db.exec('ROLLBACK');
		console.error(`  ✗ 失败（已回滚）：${error instanceof Error ? error.message : error}`);
		process.exitCode = 1;
	}
}

// ── 结果 ──
if (!DRY) {
	console.log('\n=== 改完的样子 ===');
	for (const r of db.prepare("SELECT canonical_id, qq_uin, bili_uid, douyin_uid, display_name FROM person WHERE canonical_id IN ('master','p_4eb7df52') OR douyin_uid IS NOT NULL ORDER BY canonical_id").all()) {
		console.log(`${r.canonical_id} | qq=${r.qq_uin ?? '-'} | bili=${r.bili_uid ?? '-'} | douyin=${r.douyin_uid ?? '-'} | ${r.display_name}`);
	}
	for (const cid of ['master', 'p_4eb7df52']) {
		const n = db.prepare("SELECT COUNT(*) n FROM memory WHERE owner_id = ? AND status='active'").get(`user:${cid}`).n;
		console.log(`${cid} 活跃记忆: ${n}`);
	}
}
db.close();
