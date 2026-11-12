// 发版四环校验（scripts/check-rings.mjs）。
//
// 为什么单独测：CI 里那段 shell 连续三次 `free(): invalid next size` + exit 134
// （glibc 堆损坏）。病根是拿 registry 整包文档（265KB）反复解析；现在只用
// 单版本端点和 /latest（各约 6KB）。
//
// 两段式等待是 0.15.42 的真机教训：单版本端点 6 分钟内就有了，latest 标签还没跟上，
// 结果脚本报「四环没对齐」—— 其实包已经发出去了。现在分开等、分开报。
//
// 钉住：
//   ① 一次就对上 → ok
//   ② 单版本端点还没出现 → 报 npm-version（= 包可能没发出去）
//   ③ 单版本有但 gitHead 不对 → 报 gitHead（= 提交不对，和没发出去是两回事）
//   ④ 单版本对了但 latest 标签慢 → 报 npm-latest（= 只是 CDN 缓存）
//   ⑤ 慢一拍要能等到
//   ⑥ gitHead 为空也算没对齐
import assert from 'node:assert/strict';
import { checkRings } from '../scripts/check-rings.mjs';

const ok = (n) => console.log('✓', n);
const noSleep = async () => {};
const noLog = () => {};
const BASE = 'https://example.test/dsh-fish-soul';

/** 造假 registry：按 URL 返回，值可以是数组（按调用次数取，最后一个重复）。 */
function fakeRegistry(map) {
	const counts = new Map();
	return async (url) => {
		const key = url.replace(BASE, '');
		const spec = map[key];
		if (spec === undefined) return null;
		const arr = Array.isArray(spec) ? spec : [spec];
		const i = counts.get(key) ?? 0;
		counts.set(key, i + 1);
		return arr[Math.min(i, arr.length - 1)];
	};
}

{
	const r = await checkRings({
		ver: '1.2.3', sha: 'abc123', base: BASE, waitSec: 10, log: noLog, sleepFn: noSleep,
		getJsonFn: fakeRegistry({ '/1.2.3': { version: '1.2.3', gitHead: 'abc123' }, '/latest': { version: '1.2.3' } })
	});
	assert.equal(r.ok, true, '一次就对上的要判 ok');
	ok('一次就对上 → ok');
}

{
	const r = await checkRings({
		ver: '1.2.3', sha: 'abc123', base: BASE, waitSec: 10, log: noLog, sleepFn: noSleep,
		getJsonFn: fakeRegistry({ '/1.2.3': null, '/latest': { version: '1.2.2' } })
	});
	assert.equal(r.ok, false);
	assert.equal(r.ring, 'npm-version', '单版本端点没有 = 包可能没发出去');
	assert.match(r.reason, /npm publish 可能没成功/);
	ok('单版本端点没出现 → 报 npm-version（包没发出去）');
}

{
	const r = await checkRings({
		ver: '1.2.3', sha: 'abc123', base: BASE, waitSec: 10, log: noLog, sleepFn: noSleep,
		getJsonFn: fakeRegistry({ '/1.2.3': { version: '1.2.3', gitHead: 'wrong' }, '/latest': { version: '1.2.3' } })
	});
	assert.equal(r.ok, false);
	assert.equal(r.ring, 'gitHead', 'gitHead 不对要单独报');
	assert.match(r.reason, /wrong/);
	ok('gitHead 不对 → 报 gitHead（提交不对，不是没发出去）');
}

{
	// 0.15.42 的真实场景：单版本有了，latest 标签一直没跟上
	const r = await checkRings({
		ver: '1.2.3', sha: 'abc123', base: BASE, waitSec: 10, log: noLog, sleepFn: noSleep,
		getJsonFn: fakeRegistry({ '/1.2.3': { version: '1.2.3', gitHead: 'abc123' }, '/latest': { version: '1.2.2' } })
	});
	assert.equal(r.ok, false);
	assert.equal(r.ring, 'npm-latest', 'latest 标签慢要单独报');
	assert.match(r.reason, /包已经发出去了/, '要明确告诉人「包发出去了，只是标签没跟上」');
	ok('latest 标签没跟上 → 报 npm-latest（包其实发出去了）');
}

{
	// 慢一拍：前两次没有，第三次才出现
	const r = await checkRings({
		ver: '1.2.3', sha: 'abc123', base: BASE, waitSec: 120, log: noLog, sleepFn: noSleep,
		getJsonFn: fakeRegistry({
			'/1.2.3': [null, null, { version: '1.2.3', gitHead: 'abc123' }],
			'/latest': [{ version: '1.2.2' }, { version: '1.2.3' }]
		})
	});
	assert.equal(r.ok, true, 'registry 慢一拍也要能等到');
	ok('registry 慢一拍 → 等到对齐');
}

{
	const r = await checkRings({
		ver: '1.2.3', sha: 'abc123', base: BASE, waitSec: 10, log: noLog, sleepFn: noSleep,
		getJsonFn: fakeRegistry({ '/1.2.3': { version: '1.2.3', gitHead: '' }, '/latest': { version: '1.2.3' } })
	});
	assert.equal(r.ok, false);
	assert.equal(r.ring, 'gitHead');
	ok('gitHead 为空 → 也算没对齐（不能默认通过）');
}

console.log('check-rings ok');
