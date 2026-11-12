// 发版四环校验（scripts/check-rings.mjs）。
//
// 为什么单独测：CI 里那段 shell 连续三次 `free(): invalid next size` + exit 134
// （glibc 堆损坏）。病根是拿 registry 整包文档（265KB）反复解析；现在只用
// `/latest` 端点（约 6KB）。这段逻辑换成 JS 之后要能离线测，别再靠"跑一次 CI 看看"。
//
// 钉住四件事：
//   ① 立刻对齐 → ok
//   ② 版本不符 → 报 npm-latest 环
//   ③ 版本对但 gitHead 不对 → 报 gitHead 环（和 ② 分开，修法完全不同）
//   ④ registry 读不到 → 报 registry 环，不当成"没对齐"
import assert from 'node:assert/strict';
import { checkRings } from '../scripts/check-rings.mjs';

const ok = (n) => console.log('✓', n);
const noSleep = async () => {};
const noLog = () => {};

// 造一个假 registry：按顺序吐出给定响应
const fakeProbe = (responses) => {
	let i = 0;
	return async () => {
		const r = responses[Math.min(i, responses.length - 1)];
		i += 1;
		return r;
	};
};

{
	const r = await checkRings({
		ver: '1.2.3', sha: 'abc123', waitSec: 10, log: noLog, sleepFn: noSleep,
		probeFn: fakeProbe([{ version: '1.2.3', gitHead: 'abc123' }])
	});
	assert.equal(r.ok, true, '立刻对齐要判 ok');
	ok('立刻对齐 → ok');
}

{
	// 前两次还没同步，第三次才上
	const r = await checkRings({
		ver: '1.2.3', sha: 'abc123', waitSec: 60, log: noLog, sleepFn: noSleep,
		probeFn: fakeProbe([
			{ version: '1.2.2', gitHead: 'old' },
			{ version: '1.2.2', gitHead: 'old' },
			{ version: '1.2.3', gitHead: 'abc123' }
		])
	});
	assert.equal(r.ok, true, 'registry 慢一拍也要能等到');
	ok('registry 慢一拍 → 等到对齐');
}

{
	const r = await checkRings({
		ver: '1.2.3', sha: 'abc123', waitSec: 10, log: noLog, sleepFn: noSleep,
		probeFn: fakeProbe([{ version: '1.2.2', gitHead: 'old' }])
	});
	assert.equal(r.ok, false);
	assert.equal(r.ring, 'npm-latest', '版本不符要报 npm-latest 环');
	assert.match(r.reason, /1\.2\.2/, '理由要带上实际值，方便排查');
	ok('版本不符 → 报 npm-latest 环（理由带实际值）');
}

{
	// 版本对上了，但 gitHead 不是这次提交 —— 和"没同步完"是两回事
	const r = await checkRings({
		ver: '1.2.3', sha: 'abc123', waitSec: 10, log: noLog, sleepFn: noSleep,
		probeFn: fakeProbe([{ version: '1.2.3', gitHead: 'wrong' }])
	});
	assert.equal(r.ok, false);
	assert.equal(r.ring, 'gitHead', 'gitHead 不对要单独报出来');
	assert.match(r.reason, /wrong/);
	ok('版本对但提交不对 → 报 gitHead 环（和没同步分开）');
}

{
	const r = await checkRings({
		ver: '1.2.3', sha: 'abc123', waitSec: 10, log: noLog, sleepFn: noSleep,
		probeFn: fakeProbe([null])
	});
	assert.equal(r.ok, false);
	assert.equal(r.ring, 'registry', '读不到要报 registry 环，别混成"没对齐"');
	ok('registry 读不到 → 报 registry 环');
}

{
	// 空 gitHead（registry 偶尔不给）也要报出来，不能当成"对上了"
	const r = await checkRings({
		ver: '1.2.3', sha: 'abc123', waitSec: 10, log: noLog, sleepFn: noSleep,
		probeFn: fakeProbe([{ version: '1.2.3', gitHead: '' }])
	});
	assert.equal(r.ok, false);
	assert.equal(r.ring, 'gitHead');
	ok('gitHead 为空 → 也算没对齐（不能默认通过）');
}

console.log('check-rings ok');
