// QQ 附件：txt/md 直读进提示词、看不了的格式落盘报路径、路径越界拒绝（node:test）
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { tmpHome } from './_tmp.mjs';
import { segmentsToText } from '../lib/channels/onebot.js';
import { applyAttachments, attachmentConfig } from '../lib/attachments.js';
import { ChatGateway } from '../lib/gateway.js';

const home = tmpHome('dsh-attach-');
process.env.DSH_HOME = home; // 网关把二进制存到 $DSH_HOME/fish-soul/files
const workspace = join(home, 'workspace'); // 允许读的目录（当工作区）
const outside = join(home, 'outside'); // 不允许读的目录
const dataDir = join(home, 'fish-soul', 'files'); // 二进制落盘的地方
mkdirSync(workspace, { recursive: true });
mkdirSync(outside, { recursive: true });

const write = (dir, name, content) => {
	const p = join(dir, name);
	writeFileSync(p, content);
	return p;
};
const opts = (over = {}) => ({
	readText: true, saveBinary: false, roots: [workspace, dataDir], dataDir, messageId: 'm1', log: () => {}, ...over
});
const file = (name, path, size = 0) => ({ name, path, url: '', size });

test('segmentsToText 把 file 段的附件信息带出来（占位文字不变）', () => {
	const seg = segmentsToText([
		{ type: 'text', data: { text: '看看这个' } },
		{ type: 'file', data: { name: 'note.txt', path: 'C:/tmp/note.txt', url: '', size: '12' } }
	]);
	assert.deepEqual(seg.files, [{ name: 'note.txt', path: 'C:/tmp/note.txt', url: '', size: 12 }]);
	assert.match(seg.text, /【文件：note\.txt】/, '占位文字照旧');
});

test('txt 直读：内容替换占位进提示词', () => {
	const p = write(workspace, 'note.txt', '今天天气不错');
	const r = applyAttachments('看看这个【文件：note.txt】', [file('note.txt', p, 12)], opts());
	assert.match(r.text, /【文件 note\.txt 内容】/, '占位换成内容块');
	assert.match(r.text, /今天天气不错/, '内容进提示词');
	assert.doesNotMatch(r.text, /【文件：note\.txt】/, '原占位没了');
	assert.deepEqual(r.read, ['note.txt']);
});

test('超过 8KB 只读前 8KB', () => {
	const body = 'A'.repeat(20 * 1024);
	const p = write(workspace, 'big.md', body);
	const r = applyAttachments('【文件：big.md】', [file('big.md', p, body.length)], opts());
	assert.ok(r.text.includes('A'.repeat(8 * 1024)), '前 8KB 在');
	assert.ok(!r.text.includes('A'.repeat(8 * 1024 + 1)), '8KB 之后的不在');
});

test('路径越界：只留占位并记 warn', () => {
	const p = write(outside, 'secret.txt', '不该被读到');
	const warns = [];
	const r = applyAttachments('【文件：secret.txt】', [file('secret.txt', p, 15)], opts({
		saveBinary: true, log: (level, msg) => warns.push(`${level}:${msg}`)
	}));
	assert.equal(r.text, '【文件：secret.txt】', '占位原样留着');
	assert.doesNotMatch(r.text, /不该被读到/, '没读到内容');
	assert.equal(r.saved.length, 0, '也没落盘');
	assert.equal(warns.length, 1, '记了一条 warn');
	assert.match(warns[0], /^warn:/);
});

test('文件不在了：只留占位并记 warn', () => {
	const warns = [];
	const r = applyAttachments('【文件：gone.txt】', [file('gone.txt', join(workspace, 'gone.txt'), 10)], opts({
		log: (level, msg) => warns.push(`${level}:${msg}`)
	}));
	assert.equal(r.text, '【文件：gone.txt】');
	assert.equal(warns.length, 1);
	assert.match(warns[0], /^warn:/);
});

test('saveBinary 关着：pdf 只留占位', () => {
	const p = write(workspace, 'a.pdf', '%PDF-1.4');
	const r = applyAttachments('【文件：a.pdf】', [file('a.pdf', p, 8)], opts({ saveBinary: false, messageId: 'm2' }));
	assert.equal(r.text, '【文件：a.pdf】', '占位原样留着');
	assert.equal(r.saved.length, 0);
	assert.ok(!existsSync(join(dataDir, 'm2-a.pdf')), '没落盘');
});

test('saveBinary 开着：pdf 落盘，提示词里给绝对路径', () => {
	const p = write(workspace, 'a.pdf', '%PDF-1.4');
	const r = applyAttachments('【文件：a.pdf】', [file('a.pdf', p, 8)], opts({ saveBinary: true, messageId: 'm2' }));
	assert.match(r.text, /我看不了这种格式/, '说明看不了这种格式');
	assert.match(r.text, /已存到 /, '给了存放位置');
	assert.equal(r.saved.length, 1);
	assert.ok(existsSync(r.saved[0]), '文件落盘了');
	assert.equal(basename(r.saved[0]), 'm2-a.pdf', '文件名是 <消息id>-<原名>');
	assert.ok(r.text.includes(r.saved[0]), '提示词里是绝对路径');
});

test('readText 关着：跟以前一样只留占位', () => {
	const p = write(workspace, 'note.txt', '今天天气不错');
	const r = applyAttachments('【文件：note.txt】', [file('note.txt', p, 12)], opts({ readText: false, saveBinary: true }));
	assert.equal(r.text, '【文件：note.txt】', '占位原样留着');
	assert.doesNotMatch(r.text, /今天天气不错/, '没读内容');
	assert.equal(r.saved.length, 0, '文本类不当二进制存');
});

test('开关默认值：读文本开、存二进制关', () => {
	assert.deepEqual(attachmentConfig({}), { readText: true, saveBinary: false });
	assert.deepEqual(attachmentConfig({ attachments: { readText: false, saveBinary: true } }), { readText: false, saveBinary: true });
});

// 网关里那个方法（只用到 getConfig / workspacePath / log，这里拿原型直接调，不起整个网关）
const 网关 = (config) => ({
	getConfig: () => config,
	workspacePath: () => workspace,
	log: () => {}
});

test('网关：入站时把附件内容换进 m.text', () => {
	const p = write(workspace, 'note.txt', '今天天气不错');
	const m = { text: '看看这个【文件：note.txt】', files: [file('note.txt', p, 12)], messageId: 'm1' };
	ChatGateway.prototype.readAttachments.call(网关({}), m);
	assert.match(m.text, /今天天气不错/, '内容进了消息正文');
});

test('网关：saveBinary 开着时 pdf 落盘到插件数据目录', () => {
	const p = write(workspace, 'a.pdf', '%PDF-1.4');
	const m = { text: '【文件：a.pdf】', files: [file('a.pdf', p, 8)], messageId: 'm2' };
	ChatGateway.prototype.readAttachments.call(网关({ attachments: { readText: true, saveBinary: true } }), m);
	assert.match(m.text, /我看不了这种格式/);
	const dest = join(home, 'fish-soul', 'files', 'm2-a.pdf');
	assert.ok(existsSync(dest), '落在 $DSH_HOME/fish-soul/files 下');
	assert.ok(m.text.includes(dest), '提示词里给了绝对路径');
});
