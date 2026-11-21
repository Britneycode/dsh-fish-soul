// 接线测试的公共工具：证明「A 真的经过 B」。
//
// 为什么需要它：
//   本项目反复踩同一个坑（至少 6 次）：把逻辑从 A 搬到 B，或者给 B 加了个参数，
//   但**上游 A 从没传/从没调**。这时只测 B 的单测是全绿的 —— 测的是死代码。
//   真实案例：PR #170 的 [表情:] 兜底，第一版只测了纯函数的组合，
//   删掉 gateway 里那行调用，测试照样绿。
//
// 这个 helper 只解决**可注入依赖**那一半：
//   `assertWire({ run, target, pick, expect })` 跑两次 —— 一次正常、一次把 target 剪断，
//   断言 pick() 的结果在两次之间**确实变了**。没变 = 那条接线没被覆盖。
//
// ⚠️ 边界（别拿它当万能药）：
//   · 只能剪断**运行时可替换**的依赖（`obj.foo` / 注入的 props / 参数）。
//   · 直接 `import { foo } from './x.js'` 的调用剪不断 —— 那种要靠源码级变异验证
//     （改源码 → 跑测试 → 应该红 → 还原），helper 帮不上。
//   · 剪断后如果 pick() 结果不变，**可能是好事**（有纵深防御，另有一条路兜着），
//     也可能是坏事故意（接线根本没覆盖）。所以它只报「没变化」这个事实 + 提示，
//     判断归写测试的人：要么补一条打另一层的断言，要么承认这里没有纵深防御。
import assert from 'node:assert/strict';

/**
 * 证明 `run()` 的执行路径真的经过了 `target`。
 *
 * @param {object} o
 * @param {() => any|Promise<any>} o.run      跑一次被测流程（每次都会重新调用）
 * @param {() => object} o.target             返回「必须被经过」的那个依赖对象（通常是 this 或某个注入 props）
 * @param {string} o.method                   那个依赖上必须被调用的方法名
 * @param {() => any|Promise<any>} o.pick     从这次运行的副作用里取出「用来判断有没有变化」的那个值
 * @param {(a:any, b:any) => void} [o.expect] 自定义「通 vs 断」的对比断言；默认要求两者不相等
 * @param {string} [o.why]                    失败时补充的上下文（比如「这条是 #170 的兜底」）
 * @returns {Promise<{wired: any, cut: any}>} 两次的结果，方便调用方再补断言
 */
export async function assertWire({ run, target, method, pick, expect, why = '' }) {
	assert.equal(typeof run, 'function', 'assertWire: run 必须是函数');
	assert.equal(typeof target, 'function', 'assertWire: target 必须是函数（返回依赖对象）');
	assert.equal(typeof method, 'string', 'assertWire: method 必须是字符串');
	assert.equal(typeof pick, 'function', 'assertWire: pick 必须是函数');

	const hint = why ? `\n（${why}）` : '';

	// ① 正常跑一次
	const wired = await pick.call(null, await run());

	// ② 把 target 上的那个方法换成「什么都不做、直接返回 undefined」，再跑一次
	const obj = target();
	assert.ok(obj && typeof obj === 'object', `assertWire: target() 没返回对象${hint}`);
	const had = Object.prototype.hasOwnProperty.call(obj, method);
	const orig = obj[method];
	assert.equal(typeof orig, 'function', `assertWire: ${method} 不是函数，剪不断${hint}`);

	let cutCalls = 0;
	let cutError = null;
	obj[method] = function cut() { cutCalls++; return undefined; };
	let cut;
	try {
		cut = await pick.call(null, await run());
	} catch (error) {
		// 剪断之后下游直接崩了（`.includes` 打 undefined 之类）——这**也是接线存在的证明**：
		// 说明下游真的吃了这个返回值。记录下来，下面按「有差异」处理。
		cutError = error;
		cut = undefined;
	} finally {
		// 还原：原本没这个自有属性就删掉，别留一个 undefined 在原型链上挡路
		if (had) obj[method] = orig;
		else delete obj[method];
	}

	// ③ 剪断之后必须真的被调用过 —— 否则「结果没变」的原因可能是它压根没走到这里
	assert.ok(cutCalls > 0, `assertWire: 剪断后 ${method} 一次都没被调用，说明这次运行根本没走到它${hint}`);

	// ④ 结果必须有差异（或用调用方自己的判据）。
	//    剪断导致下游崩 = 有差异（下游确实在用这个值），不算失败。
	if (cutError !== null) return { wired, cut: cutError, crashed: true };
	if (expect) await expect(wired, cut);
	else assert.notDeepEqual(cut, wired, `assertWire: 剪断 ${method} 之后结果没变化 —— 说明这条接线没有被任何断言覆盖${hint}`);

	return { wired, cut, crashed: false };
}

/**
 * 只记录调用、不改行为：给注入的依赖套一层计数。
 * 用于「我只要知道它被调过几次、收到什么参数」的场合（不需要剪断）。
 *
 * @param {object} obj     依赖对象
 * @param {string[]} methods 要监视的方法名
 * @returns {{calls: Record<string, any[][]>, restore: () => void}}
 */
export function spyOn(obj, methods) {
	const calls = {};
	const originals = {};
	for (const name of methods) {
		calls[name] = [];
		const orig = obj[name];
		assert.equal(typeof orig, 'function', `spyOn: ${name} 不是函数`);
		originals[name] = orig;
		obj[name] = function spied(...args) {
			calls[name].push(args);
			return orig.apply(this, args);
		};
	}
	return {
		calls,
		restore() { for (const name of methods) obj[name] = originals[name]; }
	};
}
