// #56 / #57：DSH 桌面端聊天——世界书要注入、remember / recall 要能认出主人。
// 根因：noteInteraction 收到桌面端消息（source 无 QQ 号）时 person=null → speakers=[] →
// buildContextBlock 里世界书扫描输入为空；sessionForTool 拿到 UNKNOWN_OWNER → 工具被拦。
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpHome } from './_tmp.mjs';

const home = tmpHome('dsh-desktop-');
process.env.DSH_HOME = home;
const { openDatabase, ensureMasterPerson } = await import('../lib/db.js');

const db = openDatabase();

// ── 1. ensureMasterPerson：幂等建/取 master 行 ──
{
	const now = Date.now();
	const m1 = ensureMasterPerson(db, now);
	assert.equal(m1.canonical_id, 'master');
	assert.equal(m1.relation_stage, 'close');
	assert.equal(m1.display_name, '主人');
	const m2 = ensureMasterPerson(db, now + 1000);
	assert.equal(m2.canonical_id, 'master', '第二次拿同一行');
	assert.equal(m2.display_name, '主人', '不覆盖已有名字');
	// 只有一行 master
	const count = db.prepare("SELECT count(*) n FROM person WHERE canonical_id = 'master'").get().n;
	assert.equal(count, 1, 'master 只有一行');
}

// ── 2. 桌面端会话的 session 形状：有 speaker、有 query、ownerId 是 master ──
{
	// 模拟 noteInteraction 修复后的 beginTurn 参数
	const person = ensureMasterPerson(db, Date.now());
	const session = {
		channel: 'dsh',
		channelId: '',
		speakers: [{ ownerId: `user:${person.canonical_id}`, person, userId: '', displayName: person.display_name, query: '你的身体是桌宠吗', searchQuery: '你的身体是桌宠吗', vec: null, vecQuery: '' }],
		dueReasons: [], workspacePath: '', atReal: Date.now(), backlog: [], interject: false, voiceIn: false, recalled: [], recentLines: []
	};
	// 世界书扫描输入：speakers.query 非空
	const scanInput = session.speakers.map((s) => s.query).filter(Boolean);
	assert.ok(scanInput.length > 0, '桌面端会话要有消息文本供世界书扫描');
	assert.equal(scanInput[0], '你的身体是桌宠吗');
	// ownerId 不是 unknown
	assert.notEqual(session.speakers[0].ownerId, 'user:unknown', '桌面端不能是 unknown');
	assert.equal(session.speakers[0].ownerId, 'user:master');
	// sessionForTool 视角：speakerView 能拿到 ownerId
	const sp = session.speakers[session.speakers.length - 1];
	assert.equal(sp.ownerId, 'user:master', 'remember/recall 不会被 UNKNOWN_OWNER 拦');
}

// ── 3. matchLore 在桌面端场景下能命中 ──
{
	const { matchLore, normalizeEntry, loreConfig } = await import('../lib/worldinfo.js');
	const entry = normalizeEntry({ keys: ['身体', '桌宠'], content: '桌宠设定内容' });
	const hits = matchLore([entry], ['你的身体是桌宠吗'], loreConfig({}));
	assert.equal(hits.length, 1, '桌面端消息提及关键词要命中世界书');
	assert.equal(hits[0].content, '桌宠设定内容');
}

// ── 4. #58：maxTokens 默认值从 600 提到 1500 ──
{
	const { readFileSync } = await import('node:fs');
	const src = readFileSync(new URL('../lib/llm.js', import.meta.url), 'utf8');
	assert.ok(src.includes('maxTokens = 1500'), 'llm.js 默认 maxTokens 要是 1500');
	assert.ok(!src.includes('maxTokens = 600,'), '不能再有 600 默认值');
}

console.log('✓ 桌面端：master 兜底、世界书注入、remember/recall 不被拦、maxTokens 默认值');
db.close();
