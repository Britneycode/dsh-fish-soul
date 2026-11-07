// QQ 接入：连不上时必须在 lastError 上留下原因，否则设置页永远显示「连接中」
// （2026-11-07 真机踩到：SnowLuma 没起来 + 令牌不对，界面一直是灰的「连接中」，看不出任何问题）
import assert from 'node:assert/strict';
import { SnowLumaChannel, closeReason } from '../lib/channels/snowluma.js';

const ok = (s) => console.log(`  ✓ ${s}`);

// ① closeReason：各种关连接的原因都要有人话
assert.match(closeReason({ code: 1006 }), /连不上 SnowLuma/, '1006（TCP 连不上 / 握手被拒）');
assert.match(closeReason({ code: 1008 }), /令牌被拒绝/, '1008');
assert.match(closeReason({ code: 4001 }), /令牌被拒绝/, '4001');
assert.match(closeReason({ code: 403 }), /令牌被拒绝/, '403');
assert.match(closeReason({ code: 1000 }), /正常关闭/, '1000');
assert.match(closeReason({ code: 1001 }), /服务端重启或过载/, '1001');
assert.match(closeReason({ code: 1012 }), /服务端重启或过载/, '1012');
assert.match(closeReason({ code: 4321 }), /code 4321/, '其它 code 要带上数字');
assert.match(closeReason({}), /连不上 SnowLuma/, '没有 code 也要给一句');
assert.match(closeReason({ code: 1008, reason: 'bad token' }), /bad token/, '服务端给了 reason 就带上');
ok('closeReason：1006 / 令牌被拒 / 正常关 / 服务端重启 / 其它 code / 无 code');

// ② 假 WebSocket：按脚本在 connect 时决定「连上」「被拒」「连不上」
function fakeWs(script) {
	const made = [];
	class Fake {
		constructor(url) {
			this.url = url;
			made.push(this);
			const s = typeof script === 'function' ? script(made.length) : script;
			queueMicrotask(() => {
				if (s === 'open') { this.onopen?.(); return; }
				if (s === 'unauthorized') { this.onclose?.({ code: 1008, reason: 'unauthorized' }); return; }
				this.onclose?.({ code: 1006, reason: '' });
			});
		}
		close() { /* 已关 */ }
		send() { /* 不需要 */ }
	}
	Fake.made = made;
	return Fake;
}

const newChannel = (Impl, cfg = {}, deps = {}) => new SnowLumaChannel({
	getConfig: () => ({ enabled: true, wsUrl: 'ws://127.0.0.1:3001', accessToken: 't', ...cfg }),
	log: () => {}, onEvent: () => {}, onConnected: () => {}, WebSocketImpl: Impl,
	findToken: () => ({ token: '', from: '' }),   // 默认：找不到，除非用例自己给
	...deps,
});

// ③ 压根连不上（SnowLuma 没起）→ lastError 必须是「连不上」，不是空
{
	const Impl = fakeWs('refused');
	const ch = newChannel(Impl);
	ch.start();
	await new Promise((r) => setTimeout(r, 10));
	const st = ch.status();
	assert.equal(st.connected, false);
	assert.match(String(st.lastError), /连不上 SnowLuma/, '连不上要有可见的 lastError（以前这里是 null/空）');
	assert.equal(Number.isFinite(ch.reconnectTimer) || ch.reconnectTimer !== null, true, '还是要排重连');
	ch.stop();
}
ok('连不上：lastError 有话说（不再静默重连）');

// ④ 令牌被拒 → 明确说是令牌问题
{
	const ch = newChannel(fakeWs('unauthorized'));
	ch.start();
	await new Promise((r) => setTimeout(r, 10));
	assert.match(String(ch.status().lastError), /令牌被拒绝/, '令牌不对要说令牌，别说成「连不上」');
	ch.stop();
}
ok('令牌被拒：明确指向 accessToken');

// ⑤ 正常连上 → lastError 清空、connected=true
{
	const ch = newChannel(fakeWs('open'));
	ch.start();
	await new Promise((r) => setTimeout(r, 10));
	const st = ch.status();
	assert.equal(st.connected, true);
	assert.equal(st.lastError, null, '连上了要把错误清掉');
	ch.stop();
}
ok('连上了：lastError 清空 + connected');

// ⑥ 连上后掉线 → 也留下原因（服务端重启那类）
{
	let n = 0;
	const ch = newChannel(fakeWs(() => (++n === 1 ? 'open' : { code: 1006 })));
	ch.start();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(ch.status().connected, true);
	ch.ws.onclose?.({ code: 1006, reason: '' });   // 模拟服务端断了
	assert.match(String(ch.status().lastError), /连不上 SnowLuma/, '掉线也要说原因');
	assert.equal(ch.status().connected, false);
	ch.stop();
}
ok('连上后掉线：同样留下原因');

// ⑦ 令牌被拒 → 自动去 SnowLuma 配置里取一份，「换个钥匙再连一次」
{
	let called = 0;
	const ch = newChannel(fakeWs('unauthorized'), {}, { findToken: () => { called++; return { token: 'x'.repeat(43), from: 'fake' }; } });
	ch.start();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(called, 1, '被拒时要去找一次令牌');
	assert.equal(ch.autoToken.length, 43, '找到了就记在内存里');
	assert.ok(ch.buildUrl().includes(encodeURIComponent('x'.repeat(43))), '下一次连要用新令牌');
	ch.stop();
}
ok('令牌被拒：自动去 SnowLuma 配置里取一份');

// ⑧ 用户自己填了令牌 → 用户填的优先（自动取的那份只在空的或连不上时顶上）
{
	const ch = newChannel(fakeWs('open'), { accessToken: 'user-token' }, { findToken: () => ({ token: 'x'.repeat(43), from: 'fake' }) });
	ch.start();
	await new Promise((r) => setTimeout(r, 10));
	assert.ok(ch.buildUrl().includes('user-token'), '用户填的优先');
	ch.stop();
}

// ⑨ 找不到令牌 / 每次都一样 → 不重复刷日志、不抖
{
	let called = 0;
	const ch = newChannel(fakeWs('refused'), { accessToken: '' }, { findToken: () => { called++; return { token: '', from: '' }; } });
	ch.start();
	await new Promise((r) => setTimeout(r, 10));
	assert.ok(called >= 1, '找不到也会去读（启动预读 + 自愈各一次都算）');
	assert.equal(ch.autoToken, '', '没找到就还是空的');
	assert.ok(!ch.buildUrl().includes('access_token'), '配置里没填、也没找到 → 不带参数（连不上会报「连不上」，不会假装在连）');
	const before = called;
	ch.askSnowLumaToken();
	assert.equal(called, before + 1, '再问一次也只会再读一次文件');
	assert.equal(ch.autoToken, '', '还是空');
	ch.stop();
}
ok('找不到令牌：不炸、不重复刷日志');

// ⑩ 自动取到的令牌在关掉重启后不残留（只在内存）→ 新实例 autoToken 是空的
{
	const ch2 = newChannel(fakeWs('open'));
	assert.equal(ch2.autoToken, '', '新实例不带上次自动取到的令牌');
	ch2.stop();
}
ok('自动令牌只在内存：新实例不带旧值');

// ⑪ 用户在设置页改了配置（restart）→ 自动取来的那份作废，重新听用户的
{
	const Impl = fakeWs('unauthorized');
	const ch = newChannel(Impl, { accessToken: 'user-token' }, { findToken: () => ({ token: 'x'.repeat(43), from: 'fake' }) });
	ch.start();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(ch.autoToken.length, 43, '被拒后拿到了自动令牌');
	const n = Impl.made.length;
	ch.restart();
	await new Promise((r) => setTimeout(r, 10));
	const first = Impl.made[n];
	assert.ok(String(first?.url).includes('user-token'), 'restart 后第一次连用的是用户填的那份');
	assert.ok(!String(first?.url).includes('x'.repeat(43)), '不再抱着旧的自动令牌不放');
	ch.stop();
}
ok('设置页改配置后：自动令牌作废');

// ⑫ 启动前预读：配置里没令牌 → 一次失败都没有，第一条连接就带上真令牌
{
	const Impl = fakeWs('open');
	const ch = newChannel(Impl, { accessToken: '' }, { findToken: () => ({ token: 'y'.repeat(43), from: 'fake' }) });
	ch.start();
	await new Promise((r) => setTimeout(r, 10));
	assert.ok(String(Impl.made[0]?.url).includes('y'.repeat(43)), '第一条连接就用上了预读到的令牌');
	assert.equal(ch.status().connected, true);
	assert.equal(ch.status().lastError, null, '一次失败都不该有');
	ch.stop();
}
ok('启动预读：没手填令牌时一次失败都没有');

// ⑬ 启动预读不顶替用户：手填了就先按手填的连（不猜用户为什么填）
{
	const Impl = fakeWs('open');
	const ch = newChannel(Impl, { accessToken: 'mine' }, { findToken: () => ({ token: 'y'.repeat(43), from: 'fake' }) });
	ch.start();
	await new Promise((r) => setTimeout(r, 10));
	assert.ok(String(Impl.made[0]?.url).includes('mine'), '手填的优先');
	assert.equal(ch.prefetchUsed, undefined, '不该被当成「用了自动令牌」');
	ch.stop();
}
ok('启动预读：手填了就先听手填的');

// ⑭ 预读到的和手填的撞上：不多读、也不改优先级
{
	let reads = 0;
	const ch = newChannel(fakeWs('refused'), { accessToken: 'mine' }, { findToken: () => { reads++; return { token: 'mine', from: 'fake' }; } });
	ch.start();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(reads, 1, '预读阶段不白读（这一读来自连不上之后的自愈，不是预读）');
	assert.equal(ch.autoToken, 'mine', '自愈读到的和手填的一样，就照旧用手填的');
	ch.stop();
}
ok('启动预读：手填了不白读，自愈撞上同值也不改优先级');

// ⑮ 端口没人听（SnowLuma 还没起）也能把令牌先拿在手里
{
	let refreshes = 0;
	const ch = newChannel(fakeWs('refused'), { accessToken: '' }, { findToken: () => { refreshes++; return { token: 'z'.repeat(43), from: 'fake' }; } });
	ch.start();
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(ch.autoToken, 'z'.repeat(43), '服务没起也该先备好钥匙');
	assert.equal(ch.status().connected, false);
	assert.match(String(ch.status().lastError), /连不上/, '连不上照样要说清楚原因');
	ch.stop();
}
ok('启动预读：服务没起也先把钥匙备好');

console.log('qq-connect-error ok');
