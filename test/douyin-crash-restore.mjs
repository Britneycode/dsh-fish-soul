// 抖音专用浏览器的 profile 里残留 `profile.exit_type: "Crashed"` 时（上次被 taskkill 强杀），
// 下次启动 Chromium 会弹「要恢复页面吗」气泡。启动前必须把这个标记清掉（exit_type → Normal）。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpHome } from './_tmp.mjs';
import { cleanLocks } from '../lib/channels/vendor/douyin-bridge/browser.mjs';

const ok = (name) => console.log('✓', name);

const home = tmpHome('dsh-crash-restore-');
const profile = join(home, 'chrome');

// ── ① 残留「Crashed」标记 + Singleton 锁：清理后标记变 Normal、锁被删 ──
mkdirSync(join(profile, 'Default'), { recursive: true });
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({
	profile: { exit_type: 'Crashed' },
	safebrowsing: { enabled: true }
}));
writeFileSync(join(profile, 'SingletonLock'), 'host-1234');

cleanLocks(profile);

const p1 = JSON.parse(String((await import('node:fs')).readFileSync(join(profile, 'Default', 'Preferences'))));
assert.equal(p1.profile.exit_type, 'Normal', '残留 Crashed 标记必须改成 Normal，否则下次启动弹「要恢复页面吗」');
assert.equal(p1.safebrowsing.enabled, true, 'Preferences 里的其他字段必须原样保留');
assert.equal(existsSync(join(profile, 'SingletonLock')), false, 'Singleton 锁仍要清理（原有行为）');
ok('残留 Crashed → Normal，其他字段保留，Singleton 锁照删');

// ── ② 正常退出（exit_type 已是 Normal / 没有该字段）：不该被动 ──
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ profile: { exit_type: 'Normal' }, x: 1 }));
const before2 = String((await import('node:fs')).readFileSync(join(profile, 'Default', 'Preferences')));
cleanLocks(profile);
const after2 = String((await import('node:fs')).readFileSync(join(profile, 'Default', 'Preferences')));
assert.equal(after2, before2, 'exit_type 不是 Crashed 时 Preferences 一个字节都不该动');
ok('正常退出的 Preferences 原样不动');

// ── ③ 没有 Preferences（全新 profile）/ JSON 坏了：不报错、不造文件 ──
const empty = join(home, 'fresh-profile');
mkdirSync(empty, { recursive: true });
cleanLocks(empty); // 目录存在但没有 Default/Preferences
assert.equal(existsSync(join(empty, 'Default', 'Preferences')), false, '全新 profile 不该被造出 Preferences');

mkdirSync(join(home, 'broken', 'Default'), { recursive: true });
writeFileSync(join(home, 'broken', 'Default', 'Preferences'), '{ not json');
cleanLocks(join(home, 'broken')); // JSON 坏了也只能忽略，不能启动失败
ok('没有 Preferences / JSON 坏了都不报错');

console.log('douyin-crash-restore: 3 组全部通过');
