// _wire.mjs 自测：证明这个 helper 真的能抓到「接线零覆盖」，而不是个花架子。
//
// 三个用例，全部用**真实场景的形状**（不是玩具）：
//   1. 接线真的存在 → assertWire 通过
//   2. 接线被剪断 → assertWire 报错（这就是它要抓的）
//   3. 剪断后结果没变（纵深防御）→ assertWire 报「没变化」，但调用方可以自己判
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertWire, spyOn } from './_wire.mjs';

// ── 1. 接线真的存在：中间层把上游的输入转给了下游 ──
test('接线存在 → 通过', async () => {
	// 形状照抄 gateway 的 listStickers → 兜底表情包：
	// 上游（reply）调了中间层（listStickers），结果里有图。
	const stickerBox = { files: ['兔子OK.gif'] };
	const deps = {
		listStickers() { return stickerBox.files; },
		// 下游：靠 listStickers 的结果决定返回什么
		async reply(text) {
			const files = this.listStickers();
			return files.some((f) => f.startsWith('兔子OK')) ? ['text', 'image'] : ['text'];
		}
	};

	const { wired, cut, crashed } = await assertWire({
		run: () => deps.reply('好耶 [表情:兔子OK]'),
		target: () => deps,
		method: 'listStickers',
		pick: (r) => r,
		why: 'reply 必须经过 listStickers 才能发图'
	});

	assert.deepEqual(wired, ['text', 'image'], '正常路径发出了图');
	// 剪断后下游拿 undefined 去 .includes ⇒ 直接崩。崩了同样证明「下游真的在用这个返回值」。
	assert.equal(crashed, true, '剪断后下游崩了（说明它真的吃了 listStickers 的返回值）');
	assert.ok(cut instanceof TypeError, `应该是 TypeError，实际 ${cut}`);
});

// ── 2. 接线不存在（经典的「接线零覆盖」）→ 必须报错 ──
test('接线不存在 → 报错（这就是要抓的 bug）', async () => {
	// 形状照抄 PR #170 第一版测试的 bug：
	// reply 自己实现了逻辑，压根没调 listStickers ⇒ 剪断它毫无影响。
	const deps = {
		listStickers() { return ['兔子OK.gif']; },
		async reply(_text) {
			// 自己写死了判断，没经过 listStickers
			return ['text', 'image'];
		}
	};

	await assert.rejects(
		() => assertWire({
			run: () => deps.reply('好耶 [表情:兔子OK]'),
			target: () => deps,
			method: 'listStickers',
			pick: (r) => r,
			why: '这条必须红：reply 根本没调 listStickers'
		}),
		(err) => {
			// 两种失败都算抓到了：要么「没被调用」，要么「结果没变」
			assert.match(err.message, /一次都没被调用|结果没变化/);
			return true;
		}
	);
});

// ── 3. 有纵深防御：剪断一层结果不变，但 helper 仍报「没变化」 ──
test('两层防御 → 剪断一层不报「没被调用」，但仍报「没变化」', async () => {
	// 形状照抄 #166 的群排除：记忆行 channel 字段 + add() 里群前缀，两层都挡。
	// 只剪断其中一层，行为不变 ⇒ helper 会说「没变化」，这是**事实**，判断归人。
	// 两层各自独立挡：任一层说「排除」就排除（OR 关系才是真纵深防御）
	const deps = {
		layerA() { return true; },   // 第一层：channel 字段过滤
		layerB() { return true; }    // 第二层：前缀过滤
	};
	const decide = (d) => (d.layerA() || d.layerB() ? 'excluded' : 'included');

	const { wired, cut } = await assertWire({
		run: () => decide(deps),
		target: () => deps,
		method: 'layerA',
		pick: (r) => r,
		// 自定义判据：这里我们**知道**有两层，所以「没变化」是对的
		expect: (a, b) => {
			assert.equal(a, 'excluded');
			assert.equal(b, 'excluded', '只剪一层时第二层仍然挡着');
		},
		why: '两层防御：单剪一层不变是预期'
	});
	assert.equal(wired, 'excluded');
	assert.equal(cut, 'excluded');
});

// ── 4. spyOn：只记调用，不改行为 ──
test('spyOn 记录调用参数且不影响返回值', () => {
	const deps = {
		send(a, b) { return `${a}+${b}`; }
	};
	const spy = spyOn(deps, ['send']);
	try {
		assert.equal(deps.send('x', 'y'), 'x+y', '返回值不受影响');
		assert.equal(deps.send('p', 'q'), 'p+q');
		assert.deepEqual(spy.calls.send, [['x', 'y'], ['p', 'q']], '参数都记下来了');
	} finally {
		spy.restore();
	}
	assert.equal(deps.send('x', 'y'), 'x+y', '还原后仍然能用');
});
