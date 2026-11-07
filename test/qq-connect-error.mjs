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

const newChannel = (Impl, cfg = {}) => new SnowLumaChannel({
	getConfig: () => ({ enabled: true, wsUrl: 'ws://127.0.0.1:3001', accessToken: 't', ...cfg }),
	log: () => {}, onEvent: () => {}, onConnected: () => {}, WebSocketImpl: Impl,
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

console.log('qq-connect-error ok');
