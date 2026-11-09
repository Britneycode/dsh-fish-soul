import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseFields,parseTree,getIntString} from '../lib/channels/vendor/douyin-bridge/pb.mjs';
import {parseMessages} from '../lib/channels/vendor/douyin-bridge/douyin-api.mjs';
const v=n=>{n=BigInt(n);const b=[];while(n>=128n){b.push(Number(n&127n)|128);n>>=7n}b.push(Number(n));return Buffer.from(b)};
const field=(id,n)=>Buffer.concat([v(id*8),v(n)]);
const bytes=(id,b)=>Buffer.concat([v(id*8+2),v(b.length),b]);
test('protobuf 64 位用户 ID 与连续序号保持精确字符串',()=>{
 const uid='7702399256389125123',seq='9007199254740993';
 const f=field(7,uid);assert.equal(parseFields(f)[0].exact,uid);assert.equal(getIntString(parseTree(f),7),uid);
 const message=Buffer.concat([bytes(1,Buffer.from('0:1:23:45')),field(2,1),field(6,7),field(7,uid),bytes(8,Buffer.from('{"text":"hello"}')),field(10,1700000000000),field(17,seq)]);
 const msg2=Buffer.concat([bytes(1,Buffer.from('0:1:23:45')),field(2,1),field(6,7),field(7,'7702399256389125124'),bytes(8,Buffer.from('{"text":"hello2"}')),field(10,1700000000000),field(17,'9007199254740992')]);
 const raw=bytes(6,bytes(301,Buffer.concat([bytes(1,message),bytes(1,msg2)])));
 const result=parseMessages(raw);assert.equal(result.ok,true);assert.deepEqual(result.messages.map(x=>x.seq),['9007199254740992',seq]);assert.deepEqual(result.messages.map(x=>x.senderId),['7702399256389125124',uid]);
});
test('零序号和零用户 ID 不作为有效标识',()=>{
 const m=Buffer.concat([bytes(1,Buffer.from('0:1:23:45')),field(2,1),field(6,7),field(7,0),bytes(8,Buffer.from('{"text":"hello"}')),field(10,1700000000000),field(17,0)]);
 const result=parseMessages(bytes(6,bytes(301,bytes(1,m))));
 assert.equal(result.messages[0].seq,'');assert.equal(result.messages[0].senderId,'');
});
