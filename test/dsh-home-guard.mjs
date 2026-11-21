// dshHome() 的「指到 fish-soul 子目录」归一化 —— 2026-11-21 真机事故的回归锁。
//
// 事故：DSH_HOME 设成 `C:/Users/xxx/.dsh/fish-soul`（多了最后一层），而 fishSoulDir()
// 自己会再拼一层 fish-soul ⇒ openDatabase() 凭空新建 fish-soul/fish-soul/soul.db 空库。
// 症状是「认不出任何人」（81 人的真库 vs 0 行的空库），**无任何报错**，排查花了 4 轮。
//
// 修法是设计消除：dshHome() 见 basename 是 fish-soul 就往上归一层 ——
// 错配置直接产出正确路径（真库、真配置），嵌套空库这个 bug 形态写不出来。
// 这个套件守四件事：
//   ① 错配置归一到正确路径（事故回归锁）
//   ② 正常路径原样返回（回归）
//   ③ 端到端：错配置下 openDatabase() 打开的就是正确位置的库（不是嵌套空库）
//   ④ 非常规但合法的目录名（含 fish-soul 前缀但不是它）不受影响
// 路径全部用 tmpHome 构造（自动清理），不在测试里写死平台相关字面量（CI 是 Linux，本机是 Windows）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';

import { join } from 'node:path';

// db.js 的 dshHome() 每次调用都读环境变量，可以动态改逐用例验证。
import { tmpHome } from './_tmp.mjs';

const { dshHome, fishSoulDir } = await import('../lib/db.js');

test('事故形态：DSH_HOME 指到 fish-soul 子目录 → 归一到上一级', () => {
	const base = tmpHome('dsh-guard-a-');
	process.env.DSH_HOME = join(base, 'fish-soul'); // 事故形态：多了最后一层
	assert.equal(dshHome(), base, '应归一到上一级');
	assert.equal(fishSoulDir(), join(base, 'fish-soul'), 'fishSoulDir 应指向正确位置');
});

test('事故形态（尾部斜杠）也一样归一', () => {
	const base = tmpHome('dsh-guard-b-');
	process.env.DSH_HOME = join(base, 'fish-soul') + '/';
	assert.equal(dshHome(), base, '带尾斜杠也应归一到上一级');
});

test('正常路径：不带 fish-soul → 原样返回', () => {
	const base = tmpHome('dsh-guard-c-');
	process.env.DSH_HOME = base;
	assert.equal(dshHome(), base);
});

test('basename 不是 fish-soul 就不动（fish-soul-data 这类合法目录名）', () => {
	const base = tmpHome('fish-soul-data-'); // basename 是 fish-soul-data-xxx，不是 fish-soul
	process.env.DSH_HOME = base;
	assert.equal(dshHome(), base);
});

test('端到端：错配置下 openDatabase 打开的是正确位置的库，不产生嵌套目录', async () => {
	// DSH_HOME=tmp/x（正确），错配置写成 tmp/x/fish-soul。
	// 归一化后应打开 tmp/x/fish-soul/soul.db —— 即「正确位置」，且不会出现 tmp/x/fish-soul/fish-soul。
	const base = tmpHome('dsh-guard-e-');
	process.env.DSH_HOME = join(base, 'fish-soul'); // 事故形态：多了最后一层
	const { openDatabase } = await import('../lib/db.js');
	const db = openDatabase();
	db.close();
	// 正确位置的库被创建了（归一化的结果）
	assert.ok(existsSync(join(base, 'fish-soul', 'soul.db')), '正确位置应有 soul.db');
	// 嵌套空库不存在 —— bug 形态被消除
	assert.ok(!existsSync(join(base, 'fish-soul', 'fish-soul')), '不得出现 fish-soul/fish-soul 嵌套目录');
	assert.ok(statSync(join(base, 'fish-soul', 'soul.db')).size > 0, '库文件非空');
});
