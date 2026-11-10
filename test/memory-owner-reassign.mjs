import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpHome } from './_tmp.mjs';

// 🔴 「主人换 QQ 号 / 平台身份合并」会被自家的 weekly_protect 触发器打穿。
//
// `weekly_protect` 是 BEFORE UPDATE ON memory，条件是「周记的内容/可见性/owner 等变了就 ABORT」。
// 但「把记忆搬给另一个人」（`UPDATE memory SET owner_id = ?`）也会命中 owner_id 那一条
// → 认人阶段直接抛 `derived weekly summary cannot be edited or restored`。
// 症状：主人换号后整条 QQ 通道一个字不回，而报错信息指不到真正的操作上。
//
// 修法：`reassignMemoryOwner()` 搬之前临时摘掉触发器、搬完按原定义重建 ——
// **不改触发器语义**（周记照样不能被编辑），只放行「换主人」这一种操作。

process.env.DSH_HOME = tmpHome('memory-owner-reassign-');
const { openDatabase, reassignMemoryOwner } = await import('../lib/db.js');

const db = openDatabase();
const now = Date.now();

function seedPerson(cid, qq) {
  db.prepare(`INSERT INTO person (canonical_id, qq_uin, display_name, aliases, relation_stage, interaction_count, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, '[]', 'stranger', 1, ?, ?)`).run(cid, qq, cid, now, now);
}
function seedMemory(owner, kind, content) {
  db.prepare(`INSERT INTO memory (owner_id, channel, kind, content, importance, created_at, updated_at)
    VALUES (?, 'douyin', ?, ?, 2, ?, ?)`).run(owner, kind, content, now, now);
}
function reset() {
  db.exec('DELETE FROM memory; DELETE FROM person;');
  seedPerson('p_a', '111');
  seedPerson('p_b', '222');
  seedMemory('p_a', 'weekly', '周记内容');
  seedMemory('p_a', 'event', '普通记忆');
}

test('换主人时记忆能搬（含周记），不会被触发器打穿', () => {
  reset();
  reassignMemoryOwner(db, 'p_a', 'p_b');
  const n = db.prepare("SELECT COUNT(*) n FROM memory WHERE owner_id = 'p_b'").get().n;
  assert.equal(n, 2, '两条记忆都该搬过去（周记也要跟着走，否则新主人看不到历史）');
  const left = db.prepare("SELECT COUNT(*) n FROM memory WHERE owner_id = 'p_a'").get().n;
  assert.equal(left, 0, '旧主人名下不该留残留');
});

test('触发器必须回来：周记仍然不能被编辑', () => {
  reset();
  reassignMemoryOwner(db, 'p_a', 'p_b');
  assert.throws(
    () => db.prepare("UPDATE memory SET content = '篡改' WHERE kind = 'weekly'").run(),
    /weekly summary cannot be edited/,
    '搬完必须重建 weekly_protect，否则周记就变成可篡改的了',
  );
});

test('搬的过程中抛错，触发器也要恢复（try/finally）', () => {
  reset();
  // 让搬运本身必然失败：memory 上加一个无条件 ABORT 的触发器
  db.exec("CREATE TRIGGER boom BEFORE UPDATE ON memory BEGIN SELECT RAISE(ABORT, 'boom'); END;");
  try {
    assert.throws(() => reassignMemoryOwner(db, 'p_a', 'p_b'), /boom/, '搬运动作本身该抛错');
  } finally {
    db.exec('DROP TRIGGER IF EXISTS boom');
  }
  // 关键：抛错之后 weekly_protect 必须还在
  assert.throws(
    () => db.prepare("UPDATE memory SET content = '篡改' WHERE kind = 'weekly'").run(),
    /weekly summary cannot be edited/,
    '异常路径也必须把触发器恢复回来',
  );
});

test('非 weekly 的记忆本来就能搬（回归：别把普通路径搞坏）', () => {
  reset();
  db.prepare("UPDATE memory SET owner_id = 'p_b' WHERE kind = 'event'").run();
  const n = db.prepare("SELECT COUNT(*) n FROM memory WHERE owner_id = 'p_b' AND kind = 'event'").get().n;
  assert.equal(n, 1, '普通记忆不受触发器影响');
});

test.after(() => db.close());
console.log('memory-owner-reassign ok');
