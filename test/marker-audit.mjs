// scripts/marker-audit.mjs 的自测：拆提交后「标记还在不在」的审计工具。
//
// 背景：2026-11-21 #160/#161/#166/#167/#78 那一轮，按 issue 拆提交时，
// 后一个提交（基于 HEAD 写替换块）把前一个提交在同一文件里的改动冲掉了。
// 测试没抓住（那时测试是红的，但红的原因不是这个），是手写的审计脚本抓到的。
//
// 这个套件保证：脚本能正确判「在 / 不在」，并且退出码对得上。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';

const root = join(import.meta.dirname, '..');
const script = join(root, 'scripts', 'marker-audit.mjs');

/** 跑脚本，返回 {code, out}。 */
function run(args) {
	const r = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('单条模式：标记存在 → 退出码 0', () => {
	// 拿一条一定在的：这个测试文件自己的路径就在仓库里
	const r = run(['--marker', '自测', '--in', 'scripts/marker-audit.mjs', '--text', '标记审计']);
	assert.equal(r.code, 0, `应该 0，实际 ${r.code}\n${r.out}`);
	assert.match(r.out, /✓/);
});

test('单条模式：标记不存在 → 退出码 1 且指出缺什么', () => {
	const r = run(['--marker', '假标记', '--in', 'scripts/marker-audit.mjs', '--text', 'zzz-绝对不存在-zzz']);
	assert.equal(r.code, 1, `应该 1，实际 ${r.code}\n${r.out}`);
	assert.match(r.out, /缺：/);
	assert.match(r.out, /冲掉/);
});

test('文件不存在 → 退出码 1，报「文件读不到」而不是崩溃', () => {
	const r = run(['--marker', 'x', '--in', 'lib/根本不存在.js', '--text', 'a']);
	assert.equal(r.code, 1);
	assert.match(r.out, /文件读不到/);
});

test('JSON 模式：多条里有一条缺失 → 退出码 1，其余仍逐条报告', () => {
	const dir = tmpHome('marker-audit-');
	const f = join(dir, 'markers.json');
	writeFileSync(f, JSON.stringify({
		'有的': { file: 'scripts/marker-audit.mjs', contains: ['标记审计'] },
		'没有的': { file: 'scripts/marker-audit.mjs', contains: ['zzz-nope'] }
	}), 'utf8');
	const r = run([f]);
	assert.equal(r.code, 1);
	assert.match(r.out, /✓ 有的/);
	assert.match(r.out, /✗ 没有的/);
	assert.match(r.out, /1 条标记缺失/);
});

test('JSON 模式：全部存在 → 退出码 0', () => {
	const dir = tmpHome('marker-audit-ok-');
	const f = join(dir, 'markers.json');
	writeFileSync(f, JSON.stringify({
		'a': { file: 'scripts/marker-audit.mjs', contains: ['标记审计', 'marker-audit'] },
		'b': { file: 'package.json', contains: ['"name": "dsh-fish-soul"'] }
	}), 'utf8');
	const r = run([f]);
	assert.equal(r.code, 0, `应该 0，实际 ${r.code}\n${r.out}`);
	assert.match(r.out, /全部标记都在/);
});

test('配置不完整（缺 contains）→ 报错而不是静默通过', () => {
	const dir = tmpHome('marker-audit-bad-');
	const f = join(dir, 'markers.json');
	writeFileSync(f, JSON.stringify({ '坏的': { file: 'scripts/marker-audit.mjs' } }), 'utf8');
	const r = run([f]);
	assert.equal(r.code, 1, '配置不完整不能当成通过');
	assert.match(r.out, /配置不完整/);
});
