import assert from 'node:assert/strict';
import { tmpHome } from './_tmp.mjs';
process.env.DSH_HOME = tmpHome('desktop-archive-');
const { ChatArchive } = await import('../lib/chat-archive.js');
const { ChatGateway } = await import('../lib/gateway.js');
let config = { chatArchive: { enabled: true, channels: ['private:1'], days: 30 } };
const archive = new ChatArchive({ getConfig: () => config });
let externalSends = 0;
const gw = Object.assign(Object.create(ChatGateway.prototype), {
 bound: new Map([['s', { channel_id: 'private:1' }], ['other', { channel_id: 'private:2' }]]),
 turns: new Map(), waiters: new Map(), interjectTurns: new Set(), douyin: null,
 getConfig: () => config, note: () => {}, diag: { add: () => {} }, log: () => {},
 soul: { recallInfo: () => ({ at: 0, memories: [] }), archiveDesktop: (channel, text) => archive.add(channel, { who: '鱼', self: true, text }) },
 sendReply: async () => { externalSends++; return true; }
});
const turn = (id, text, reason = 'completed', interrupted = false) => {
 gw.onSessionEvent({id}, {type:'user/message', data:{message:{source:{kind:'user'}}}});
 gw.onSessionEvent({id}, {type:'assistant/message', data:{message:{content:[{type:'text',text}]}, interrupted}});
 gw.onSessionEvent({id}, {type:'turn/end', data:{reason:{kind:reason}}});
};
turn('s', '在 DSH 里的完整回复');
assert.deepEqual(archive.list('private:1').items.map(x => [x.self, x.content]), [[1, '在 DSH 里的完整回复']], '完成的桌面回复要按绑定会话进存档');
turn('s', '失败的回复', 'error');
turn('s', '中断的回复', 'completed', true);
turn('other', '非白名单会话');
turn('unbound', '非鱼会话');
assert.equal(archive.list('private:1').items.length, 1, '失败、中断和无关会话不写');
assert.equal(archive.list('private:2').items.length, 0, '会话白名单生效');
config = {chatArchive:{enabled:false,channels:[],days:30}};
turn('s', '关闭存档的回复');
assert.equal(archive.list('private:1').items.length, 1, '关闭存档不写');
assert.equal(externalSends, 0, '桌面回复不能外发到 QQ');
archive.stop();
console.log('✓ #113 DSH 回复按绑定会话存档，失败/中断、关闭、白名单和不外发');
