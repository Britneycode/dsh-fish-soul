/**
 * 静态检查：发版三处版本号必须一致 —— package.json / CHANGELOG.md / README.md。
 *
 * 为什么要有这个测试：
 *   2026-11-21 v0.18.21 发版时踩到：release.yml 里有一行
 *   `grep -q "版本 \*\*$VER\*\*" README.md || exit 1`，bump 了 package.json + CHANGELOG
 *   但漏了 README ⇒ run 13 秒失败。这个检查让「三处版本不一致」在本地 / CI 快速闸就被拦，
 *   不用等 release workflow 跑到那一步才发现。
 *
 * 三处各自的位置：
 *   - package.json:  "version": "x.y.z"
 *   - CHANGELOG.md:  第一段 `- vx.y.z：...`（最新一条）
 *   - README.md:     第 5 行附近 `版本 **x.y.z**`
 *
 * 任何一处不一致就 fail —— 谁不一致，错误信息就指谁。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const pkgVer = pkg.version;

const cl = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
const clMatch = cl.match(/^- v(\d+\.\d+\.\d+)：/m);
const clVer = clMatch ? clMatch[1] : '';

const readme = readFileSync(join(root, 'README.md'), 'utf8');
const rmMatch = readme.match(/版本 \*\*(\d+\.\d+\.\d+)\*\*/);
const rmVer = rmMatch ? rmMatch[1] : '';

const bad = [];
if (clVer !== pkgVer) bad.push(`CHANGELOG.md 最新段是 v${clVer || '(没找到)'}，package.json 是 ${pkgVer}`);
if (rmVer !== pkgVer) bad.push(`README.md 是 ${rmVer || '(没找到)'}，package.json 是 ${pkgVer}`);

assert.deepEqual(bad, [], `发版三处版本号不一致：\n${bad.join('\n')}\n\n修法：把 package.json / CHANGELOG.md / README.md 三处版本号改成同一个值。`);
console.log(`✓ 发版三处版本号一致：${pkgVer}`);
