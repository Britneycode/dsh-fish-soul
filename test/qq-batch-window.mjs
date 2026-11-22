// 连着发消息的合并窗口：同一个会话在窗口内的多条消息要合成一轮。
// 只测 enqueue 的分批逻辑（不连 QQ、不建会话）。
import { ChatGateway } from '../lib/gateway.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (cond, name, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failed++;
};

function harness() {
  const dispatched = [];
  const self = {
    batches: new Map(),
    log: () => {},
    dispatch: async (channelId, items) => { dispatched.push({ channelId, n: items.length }); }
  };
  self.enqueue = ChatGateway.prototype.enqueue;
  return { self, dispatched };
}
const msg = (channelId, text) => ({ channelId, chatType: 'private', targetId: '1', text, images: [] });
const person = { canonical_id: 'user:1' };

// 1) 窗口内两条 → 合成一轮
{
  const { self, dispatched } = harness();
  self.enqueue(msg('private:1', 'a'), person, { batchMs: 80 });
  await sleep(20);
  self.enqueue(msg('private:1', 'b'), person, { batchMs: 80 });
  ok(dispatched.length === 0, '窗口内先不回');
  await sleep(120);
  ok(dispatched.length === 1 && dispatched[0].n === 2, '两条合成一轮', JSON.stringify(dispatched));
}

// 2) 窗口 0 → 每条都回（关掉合并）
{
  const { self, dispatched } = harness();
  self.enqueue(msg('private:2', 'a'), person, { batchMs: 0 });
  ok(dispatched.length === 1 && dispatched[0].n === 1, '窗口 0 立刻回');
}

// 3) 攒够 20 条不再等
{
  const { self, dispatched } = harness();
  for (let i = 0; i < 20; i++) self.enqueue(msg('private:3', `m${i}`), person, { batchMs: 60_000 });
  ok(dispatched.length === 1 && dispatched[0].n === 20, '20 条直接发车', JSON.stringify(dispatched));
}

// 4) 不同会话各自计时，不互相吃消息
{
  const { self, dispatched } = harness();
  self.enqueue(msg('private:4', 'a'), person, { batchMs: 60 });
  self.enqueue(msg('private:5', 'b'), person, { batchMs: 60 });
  await sleep(110);
  ok(dispatched.length === 2, '两个会话各回一次', JSON.stringify(dispatched));
}

// #169：光有静默窗口会被「每条间隔都小于 batchMs」的持续说话无限推迟（只能靠 20 条硬顶）。
// batchMaxWaitMs = 从第一条进队算起的最长等待：到点必发。
//
// ⚠️ 参数必须让「最长等待」先于「静默窗口」到点，否则撤掉实现测试照样全绿（空转）。
//    下面：batchMs=800、maxWait=700，第二条在 t=500 续窗 ⇒ 窗口延到 t=1300。
//    检查点 t=1000 落在 (700, 1300) 之间：
//      · 有 batchMaxWaitMs → t=700 已发（绿）
//      · 撤掉实现          → t=1000 还在等（红）
{
  const { self, dispatched } = harness();
  self.enqueue(msg('private:6', 'a'), person, { batchMs: 800, batchMaxWaitMs: 700 });
  await sleep(400);
  ok(dispatched.length === 0, '最长等待内先不回'); // t≈400 < 700，两种实现都还没发
  await sleep(100); // t≈500
  self.enqueue(msg('private:6', 'b'), person, { batchMs: 800, batchMaxWaitMs: 700 }); // 窗口延到 ~1300
  await sleep(500); // t≈1000，落在 (700, 1300)
  ok(dispatched.length === 1 && dispatched[0].n === 2, '到最长等待必发（不能被续窗无限推迟）', JSON.stringify(dispatched));
}

// batchMaxWaitMs = 0 → 不限（旧行为）：静默窗口语义不变，到点照发
{
  const { self, dispatched } = harness();
  self.enqueue(msg('private:7', 'a'), person, { batchMs: 200, batchMaxWaitMs: 0 });
  await sleep(50);
  self.enqueue(msg('private:7', 'b'), person, { batchMs: 200, batchMaxWaitMs: 0 });
  await sleep(100);
  ok(dispatched.length === 0, 'maxWait=0：窗口内仍在等（旧行为）');
  await sleep(250); // 第二条重置的 200ms 窗口到点
  ok(dispatched.length === 1 && dispatched[0].n === 2, 'maxWait=0：窗口到点就发（旧行为）', JSON.stringify(dispatched));
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
