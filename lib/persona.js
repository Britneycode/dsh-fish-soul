/**
 * persona.js —— 角色卡加载（SillyTavern 迁移兼容层）。
 *
 *  - 来源：$DSH_HOME/fish-soul/persona.json 或 persona.png（PNG tEXt/iTXt 中的 ccv3 / chara base64）；
 *  - 字段：V3/V2/扁平三种结构，读 name / description / personality / scenario / system_prompt /
 *    mes_example / first_mes / post_history_instructions / character_book；
 *  - 宏：{{char}} / <BOT> → 角色名；{{user}} / <USER> 在静态段替换为"对方"，动态段替换为真实昵称；
 *  - 世界书：constant 条目进静态人格段；关键词条目按本轮消息命中后进瞬态块（不碰前缀缓存）。
 */
import { personaAnchor } from './soul-memory.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

/** 读取 PNG 里的文本块（tEXt / 未压缩或压缩的 iTXt）。 */
export function readPngTextChunks(buf) {
	const out = {};
	const SIG = '89504e470d0a1a0a';
	if (buf.subarray(0, 8).toString('hex') !== SIG) return out;
	let off = 8;
	while (off + 8 <= buf.length) {
		const len = buf.readUInt32BE(off);
		const type = buf.subarray(off + 4, off + 8).toString('latin1');
		const data = buf.subarray(off + 8, off + 8 + len);
		if (type === 'tEXt') {
			const z = data.indexOf(0);
			if (z > 0) out[data.subarray(0, z).toString('latin1')] = data.subarray(z + 1).toString('latin1');
		} else if (type === 'iTXt') {
			const z = data.indexOf(0);
			if (z > 0) {
				const key = data.subarray(0, z).toString('latin1');
				const compressed = data[z + 1] === 1;
				let p = z + 3;
				p = data.indexOf(0, p) + 1; // language tag
				p = data.indexOf(0, p) + 1; // translated keyword
				const body = data.subarray(p);
				out[key] = (compressed ? inflateSync(body) : body).toString('utf8');
			}
		} else if (type === 'IEND') break;
		off += 12 + len;
	}
	return out;
}

/** PNG 卡 → JSON（优先 V3 的 ccv3，其次 V2 的 chara）。 */
export function parsePngCard(buf) {
	const chunks = readPngTextChunks(buf);
	const raw = chunks.ccv3 ?? chunks.chara;
	if (raw === undefined) throw new Error('PNG 中没有 ccv3/chara 角色卡数据');
	return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
}

export function applyMacros(text, { charName, userName }) {
	return String(text ?? '')
		.replace(/\{\{char\}\}|<BOT>/gi, charName)
		.replace(/\{\{user\}\}|<USER>/gi, userName)
		.replace(/\{\{original\}\}/gi, '');
}

/**
 * @returns {{name:string, staticText:string, postHistory:string, lore:Array<{keys:string[], content:string}>, source:string}}
 */
export function loadPersona(dir, log = () => {}) {
	const fallback = {
		name: 'feiyu',
		staticText: '你是 feiyu（鱼）：一个有自己的作息、会记住每个说过话的人的 QQ 好友。',
		postHistory: '',
		lore: [],
		anchor: '',
		source: 'builtin'
	};
	let raw = null;
	let source = 'builtin';
	try {
		const pngPath = join(dir, 'persona.png');
		const jsonPath = join(dir, 'persona.json');
		if (existsSync(jsonPath)) { raw = JSON.parse(readFileSync(jsonPath, 'utf8')); source = 'persona.json'; }
		else if (existsSync(pngPath)) { raw = parsePngCard(readFileSync(pngPath)); source = 'persona.png'; }
	} catch (error) {
		log('error', `[fish-soul] 角色卡读取失败：${String(error instanceof Error ? error.message : error)}`);
	}
	if (raw === null) return fallback;

	const card = raw.data ?? raw;
	const name = String(card.name ?? card.char_name ?? 'feiyu');
	const m = (t) => applyMacros(t, { charName: name, userName: '对方' });
	const parts = [];
	if (card.system_prompt) parts.push(m(card.system_prompt));
	if (card.description ?? card.char_persona) parts.push(m(card.description ?? card.char_persona));
	if (card.personality) parts.push(`性格：${m(card.personality)}`);
	if (card.scenario ?? card.world_scenario) parts.push(`场景：${m(card.scenario ?? card.world_scenario)}`);
	const ex = Array.isArray(card.mes_example) ? card.mes_example.join('\n') : (card.mes_example ?? card.example_dialogue);
	if (ex) parts.push(`对话示例：\n${m(ex)}`);
	if (card.first_mes ?? card.char_greeting) parts.push(`开场白风格参考：${m(card.first_mes ?? card.char_greeting)}`);

	const lore = [];
	const entries = card.character_book?.entries ?? [];
	const list = Array.isArray(entries) ? entries : Object.values(entries);
	for (const e of list) {
		if (e?.enabled === false || e?.disable === true) continue;
		const content = m(e?.content ?? '');
		if (content.trim() === '') continue;
		if (e.constant === true) parts.push(`设定：${content}`);
		else {
			const keys = [...(e.keys ?? e.key ?? [])].map(String).filter(Boolean);
			const secondary = [...(e.secondary_keys ?? e.keysecondary ?? [])].map(String).filter(Boolean);
			// SillyTavern：selective 打开时次要关键词按 selectiveLogic 生效（0 任一 / 1 不全有 / 2 都没有 / 3 全有）
			const logic = Number(e.extensions?.selectiveLogic ?? e.selectiveLogic ?? 0);
			const order = Number(e.priority ?? e.insertion_order ?? e.order ?? 100);
			if (keys.length > 0) lore.push({ keys, secondary, selective: e.selective === true && secondary.length > 0, logic, order: Number.isFinite(order) ? order : 100, caseSensitive: e.case_sensitive === true || e.extensions?.case_sensitive === true, content });
		}
	}
	lore.sort((a, b) => b.order - a.order);
	return {
		name,
		staticText: parts.length > 0 ? parts.join('\n\n') : `你是 ${name}。`,
		postHistory: card.post_history_instructions ? String(card.post_history_instructions) : '',
		lore,
		anchor: personaAnchor(card),
		source
	};
}

/**
 * 本轮命中的世界书条目：主关键词任一命中；selective 时再按次要关键词逻辑过滤；按优先级排，最多 limit 条。
 * text 传本轮的话 + 最近几句（前面聊到的设定也能接上）。
 */
export function matchLore(lore, text, limit = 4) {
	const raw = String(text ?? '');
	if (raw === '') return [];
	const lower = raw.toLowerCase();
	const has = (e, k) => (e.caseSensitive ? raw.includes(k) : lower.includes(k.toLowerCase()));
	return lore.filter((e) => {
		if (!e.keys.some((k) => has(e, k))) return false;
		if (!e.selective) return true;
		const hits = (e.secondary ?? []).filter((k) => has(e, k)).length;
		const n = (e.secondary ?? []).length;
		if (e.logic === 1) return hits < n;
		if (e.logic === 2) return hits === 0;
		if (e.logic === 3) return hits === n;
		return hits > 0;
	}).slice(0, limit);
}
