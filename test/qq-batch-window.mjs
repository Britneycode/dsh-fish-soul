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

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
