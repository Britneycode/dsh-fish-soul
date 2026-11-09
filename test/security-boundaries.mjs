import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { 抠正文图 } from '../lib/channels/vendor/qq-bridge.js';
import { tmpHome } from './_tmp.mjs';
import { readResponseBounded } from '../lib/bounded-response.js';
import { fetchImageBytes } from '../lib/gateway-util.js';
import { ChatGateway } from '../lib/gateway.js';

const home = tmpHome('dsh-security-');
process.env.DSH_HOME = home;

test('下载按实际字节限流：无长度、伪造长度、边界和超限', async () => {
  const response = (parts, length) => new Response(new ReadableStream({
    start(controller) { for (const part of parts) controller.enqueue(Buffer.from(part)); controller.close(); }
  }), { headers: length === undefined ? {} : { 'content-length': String(length) } });
  assert.equal((await readResponseBounded(response(['ab', 'cd']), 4)).toString(), 'abcd');
  assert.equal(await readResponseBounded(response(['ab', 'cde']), 4), null);
  assert.equal(await readResponseBounded(response(['abcde'], 1), 4), null);
  assert.equal(await readResponseBounded(response(['x'], 99), 4), null);
  assert.equal((await readResponseBounded(response([]), 4)).length, 0);
});

test('入站图片的两个远程字段都在下载中限流', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(33 * 1024 * 1024)); c.close(); } }));
    assert.equal(await fetchImageBytes({ url: 'https://example.test/image' }), null);
    assert.equal(await fetchImageBytes({ file: 'https://example.test/image' }), null);
  } finally { globalThis.fetch = original; }
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('QQ 和 B站/抖音私信都拒绝越界链接，正常图片继续可发', async () => {
  const ws = join(home, 'ws'); const outside = join(home, 'outside');
  mkdirSync(ws, { recursive: true }); mkdirSync(outside, { recursive: true });
  writeFileSync(join(ws, 'ok.png'), PNG); writeFileSync(join(outside, 'secret.png'), PNG);
  const gateway = Object.assign(Object.create(ChatGateway.prototype), { log() {}, canvasConvert: null });
  const resolveImage = (p) => gateway.resolveImageFile(p, ws);
  assert.deepEqual(Buffer.from(resolveImage('ok.png').data.file.slice(9), 'base64'), PNG);
  assert.ok(gateway.localImagePath('ok.png', ws));
  assert.equal(resolveImage(join(outside, 'secret.png')), null);
  assert.equal(gateway.localImagePath(join(outside, 'secret.png'), ws), null);
  const neighbor = join(home, 'ws-neighbor'); mkdirSync(neighbor); writeFileSync(join(neighbor, 'x.png'), PNG);
  assert.equal(gateway.localImagePath(join(neighbor, 'x.png'), ws), null);
  const dataDir = join(home, 'fish-soul'); mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'data.png'), PNG);
  assert.ok(gateway.localImagePath(join(dataDir, 'data.png'), ws));
  assert.ok(resolveImage(join(dataDir, 'data.png')));
  // Unix 普通符号链接 / Windows junction：创建失败就失败，不允许静默跳过。
  symlinkSync(outside, join(ws, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(resolveImage('escape/secret.png'), null);
  assert.equal(gateway.localImagePath('escape/secret.png', ws), null);
  if (process.platform !== 'win32') {
    symlinkSync(join(outside, 'secret.png'), join(ws, 'linked.png'), 'file');
    assert.equal(resolveImage('linked.png'), null);
    assert.equal(gateway.localImagePath('linked.png', ws), null);
  }
  assert.equal(gateway.localImagePath('missing.png', ws), null);
  mkdirSync(join(ws, 'directory.png'));
  assert.equal(gateway.localImagePath('directory.png', ws), null);
  const escaped = 抠正文图('![x](escape/secret.png)').图;
  assert.equal((await gateway.dmImages({ workspace_path: ws }, escaped, { images: [] })).length, 0);
  const allowed = 抠正文图('![x](ok.png)').图;
  const images = await gateway.dmImages({ workspace_path: ws }, allowed, { images: [] });
  assert.equal(images.length, 1);
  assert.deepEqual(images[0].bytes, PNG);
});

test('file:// 图片按实际读取量限额，边界可读，超限和目录拒绝', async () => {
  const dir = join(home, 'local'); mkdirSync(dir, { recursive: true });
  const file = join(dir, 'local.png'); writeFileSync(file, '');
  truncateSync(file, 10 * 1024 * 1024);
  assert.equal((await fetchImageBytes({ url: pathToFileURL(file).href })).length, 10 * 1024 * 1024);
  truncateSync(file, 10 * 1024 * 1024 + 1);
  assert.equal((await fetchImageBytes({ url: pathToFileURL(file).href })) === null, true, '超限必须拒绝');
  assert.equal(await fetchImageBytes({ url: pathToFileURL(dir).href }), null);
});
