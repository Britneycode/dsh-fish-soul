// QQ 附件：txt/md 直读进提示词、看不了的格式落盘报路径、路径越界拒绝（node:test）
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
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

test('segmentsToText 把 file 段的附件信息带出来（占位文字不变）', async () => {
	const seg = segmentsToText([
		{ type: 'text', data: { text: '看看这个' } },
		{ type: 'file', data: { name: 'note.txt', path: 'C:/tmp/note.txt', url: '', size: '12' } }
	]);
	assert.deepEqual(seg.files, [{ name: 'note.txt', path: 'C:/tmp/note.txt', url: '', size: 12, fileId: '', fileHash: '' }]);
	assert.match(seg.text, /【文件：note\.txt】/, '占位文字照旧');
});

test('txt 直读：内容替换占位进提示词', async () => {
	const p = write(workspace, 'note.txt', '今天天气不错');
	const r = await applyAttachments('看看这个【文件：note.txt】', [file('note.txt', p, 12)], opts());
	assert.match(r.text, /【文件 note\.txt 内容】/, '占位换成内容块');
	assert.match(r.text, /今天天气不错/, '内容进提示词');
	assert.doesNotMatch(r.text, /【文件：note\.txt】/, '原占位没了');
	assert.deepEqual(r.read, ['note.txt']);
});

test('超过 8KB 只读前 8KB', async () => {
	const body = 'A'.repeat(20 * 1024);
	const p = write(workspace, 'big.md', body);
	const r = await applyAttachments('【文件：big.md】', [file('big.md', p, body.length)], opts());
	assert.ok(r.text.includes('A'.repeat(8 * 1024)), '前 8KB 在');
	assert.ok(!r.text.includes('A'.repeat(8 * 1024 + 1)), '8KB 之后的不在');
});

test('路径越界：只留占位并记 warn', async () => {
	const p = write(outside, 'secret.txt', '不该被读到');
	const warns = [];
	const r = await applyAttachments('【文件：secret.txt】', [file('secret.txt', p, 15)], opts({
		saveBinary: true, log: (level, msg) => warns.push(`${level}:${msg}`)
	}));
	assert.equal(r.text, '【文件：secret.txt】', '占位原样留着');
	assert.doesNotMatch(r.text, /不该被读到/, '没读到内容');
	assert.equal(r.saved.length, 0, '也没落盘');
	assert.equal(warns.length, 1, '记了一条 warn');
	assert.match(warns[0], /^warn:/);
});

test('文件不在了：只留占位并记 warn', async () => {
	const warns = [];
	const r = await applyAttachments('【文件：gone.txt】', [file('gone.txt', join(workspace, 'gone.txt'), 10)], opts({
		log: (level, msg) => warns.push(`${level}:${msg}`)
	}));
	assert.equal(r.text, '【文件：gone.txt】');
	assert.equal(warns.length, 1);
	assert.match(warns[0], /^warn:/);
});

test('saveBinary 关着：pdf 只留占位', async () => {
	const p = write(workspace, 'a.pdf', '%PDF-1.4');
	const r = await applyAttachments('【文件：a.pdf】', [file('a.pdf', p, 8)], opts({ saveBinary: false, messageId: 'm2' }));
	assert.equal(r.text, '【文件：a.pdf】', '占位原样留着');
	assert.equal(r.saved.length, 0);
	assert.ok(!existsSync(join(dataDir, 'm2-a.pdf')), '没落盘');
});

test('saveBinary 开着：pdf 落盘，提示词里给绝对路径', async () => {
	const p = write(workspace, 'a.pdf', '%PDF-1.4');
	const r = await applyAttachments('【文件：a.pdf】', [file('a.pdf', p, 8)], opts({ saveBinary: true, messageId: 'm2' }));
	assert.match(r.text, /我看不了这种格式/, '说明看不了这种格式');
	assert.match(r.text, /已存到 /, '给了存放位置');
	assert.equal(r.saved.length, 1);
	assert.ok(existsSync(r.saved[0]), '文件落盘了');
	assert.equal(basename(r.saved[0]), 'm2-a.pdf', '文件名是 <消息id>-<原名>');
	assert.ok(r.text.includes(r.saved[0]), '提示词里是绝对路径');
});

test('readText 关着：跟以前一样只留占位', async () => {
	const p = write(workspace, 'note.txt', '今天天气不错');
	const r = await applyAttachments('【文件：note.txt】', [file('note.txt', p, 12)], opts({ readText: false, saveBinary: true }));
	assert.equal(r.text, '【文件：note.txt】', '占位原样留着');
	assert.doesNotMatch(r.text, /今天天气不错/, '没读内容');
	assert.equal(r.saved.length, 0, '文本类不当二进制存');
});

test('开关默认值：读文本开、存二进制关', async () => {
	assert.deepEqual(attachmentConfig({}), { readText: true, saveBinary: false });
	assert.deepEqual(attachmentConfig({ attachments: { readText: false, saveBinary: true } }), { readText: false, saveBinary: true });
});

// 网关里那个方法（只用到 getConfig / workspacePath / log，这里拿原型直接调，不起整个网关）
const 网关 = (config) => ({
	getConfig: () => config,
	workspacePath: () => workspace,
	log: () => {}
});

test('网关：入站时把附件内容换进 m.text', async () => {
	const p = write(workspace, 'note.txt', '今天天气不错');
	const m = { text: '看看这个【文件：note.txt】', files: [file('note.txt', p, 12)], messageId: 'm1' };
	await ChatGateway.prototype.readAttachments.call(网关({}), m);
	assert.match(m.text, /今天天气不错/, '内容进了消息正文');
});

test('网关：saveBinary 开着时 pdf 落盘到插件数据目录', async () => {
	const p = write(workspace, 'a.pdf', '%PDF-1.4');
	const m = { text: '【文件：a.pdf】', files: [file('a.pdf', p, 8)], messageId: 'm2' };
	await ChatGateway.prototype.readAttachments.call(网关({ attachments: { readText: true, saveBinary: true } }), m);
	assert.match(m.text, /我看不了这种格式/);
	const dest = join(home, 'fish-soul', 'files', 'm2-a.pdf');
	assert.ok(existsSync(dest), '落在 $DSH_HOME/fish-soul/files 下');
	assert.ok(m.text.includes(dest), '提示词里给了绝对路径');
});

test('符号链接/junction 越界：白名单里的链接指向外部时拒绝读取', async () => {
	const outsideDir = join(home, 'outside-secret');
	mkdirSync(outsideDir, { recursive: true });
	write(outsideDir, 'secret.txt', 'TOP-SECRET');
	// 在白名单目录里建一个指向外部的 junction
	const linkDir = join(workspace, 'link');
	try { symlinkSync(outsideDir, linkDir, 'junction'); } catch { return; } // Windows 可能需要权限，跳过
	const p = join(linkDir, 'secret.txt');
	if (!existsSync(p)) return; // 链接没建成功就跳过
	const r = await applyAttachments('【文件：secret.txt】', [file('secret.txt', p, 10)], opts());
	assert.equal(r.text, '【文件：secret.txt】', '占位原样留着');
	assert.doesNotMatch(r.text, /TOP-SECRET/, '没读到外部文件');
});

test('GBK/非法 UTF-8：读不进去，保留占位', async () => {
	// GBK 编码的"你好"（0xC4 0xE3 0xBA 0xC3）
	const buf = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3]);
	const p = join(workspace, 'gbk.txt');
	writeFileSync(p, buf);
	const r = await applyAttachments('【文件：gbk.txt】', [file('gbk.txt', p, 4)], opts());
	assert.equal(r.text, '【文件：gbk.txt】', '非法 UTF-8 保留占位');
	assert.doesNotMatch(r.text, /\uFFFD/, '没有乱码替换字符');
});

test('二进制太大：超过 32MB 保留占位', async () => {
	const p = write(workspace, 'big.bin', 'x');
	const r = await applyAttachments('【文件：big.bin】', [file('big.bin', p, 33 * 1024 * 1024)], opts({ saveBinary: true }));
	assert.equal(r.text, '【文件：big.bin】', '超限保留占位');
	assert.equal(r.saved.length, 0, '没落盘');
});

test('fileId 路线：没有本地 path 时走 fetchFile 下载，txt 读进正文', async () => {
	// SnowLuma 不给 path，只有 fileId——模拟 get_private_file_url 下载回来的内容
	const fetched = Buffer.from('这是下载回来的内容', 'utf8');
	const r = await applyAttachments('【文件：note.txt】', [{ name: 'note.txt', path: '', url: '', size: 24, fileId: 'ID:-123', fileHash: '' }], opts({ fetchFile: async () => fetched }));
	assert.match(r.text, /【文件 note.txt 内容】/, '占位换成内容块');
	assert.match(r.text, /这是下载回来的内容/, '下载的内容进正文');
	assert.deepEqual(r.read, ['note.txt']);
});

test('fileId 路线：下载失败保留占位', async () => {
	const r = await applyAttachments('【文件：note.txt】', [{ name: 'note.txt', path: '', url: '', size: 24, fileId: 'ID:-123', fileHash: '' }], opts({ fetchFile: async () => null }));
	assert.equal(r.text, '【文件：note.txt】', '下载失败保留占位');
	assert.equal(r.read.length, 0, '没读');
});

test('fileId 路线：saveBinary 开着时 pdf 落盘', async () => {
	const fetched = Buffer.from('%PDF-1.4 downloaded', 'utf8');
	const r = await applyAttachments('【文件：a.pdf】', [{ name: 'a.pdf', path: '', url: '', size: 19, fileId: 'ID:-456', fileHash: '' }], opts({ saveBinary: true, fetchFile: async () => fetched }));
	assert.match(r.text, /我看不了这种格式/);
	const dest = join(home, 'fish-soul', 'files', 'm1-a.pdf');
	assert.ok(existsSync(dest), '落在插件数据目录下');
});

test('fileId 路线：没有 fetchFile 通道时保留占位', async () => {
	const r = await applyAttachments('【文件：note.txt】', [{ name: 'note.txt', path: '', url: '', size: 24, fileId: 'ID:-123', fileHash: '' }], opts());
	assert.equal(r.text, '【文件：note.txt】', '没有下载通道保留占位');
});

test('网关下载：把上限传给安全下载器', async () => {
 const calls = [];
 const gw = { channel: { call: async () => ({ url: 'https://example.test/file' }) },
  attachmentDownload: async (url, opts) => { calls.push({url, ...opts}); return Buffer.from('abcd'); } };
 const m = { chatType: 'private', userId: '1', channelId: 'private:1' };
 assert.equal((await ChatGateway.prototype.fetchQqFile.call(gw, m, { fileId: 'f', url: '', maxBytes: 4 })).toString(), 'abcd');
 assert.equal(calls[0].maxBytes, 4);
});

test('远程附件：按类别传下载上限，关闭时不下载', async () => {
 const calls = [];
 const fetchFile = async (args) => { calls.push(args); return Buffer.from('text'); };
 const txt = { name: 'note.txt', path: '', fileId: 'x' };
 const pdf = { name: 'a.pdf', path: '', fileId: 'y' };
 await applyAttachments('【文件：note.txt】', [txt], opts({ fetchFile }));
 assert.equal(calls.at(-1).maxBytes, 256 * 1024);
 await applyAttachments('【文件：a.pdf】', [pdf], opts({ fetchFile, saveBinary: true }));
 assert.equal(calls.at(-1).maxBytes, 32 * 1024 * 1024);
 const n = calls.length;
 await applyAttachments('【文件：note.txt】', [txt], opts({ fetchFile, readText: false }));
 await applyAttachments('【文件：a.pdf】', [pdf], opts({ fetchFile, saveBinary: false }));
 assert.equal(calls.length, n);
});
