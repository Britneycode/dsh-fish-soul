import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

test('外发图片允许工作区真实文件，但拒绝符号链接或 junction 指向外部', (t) => {
  const ws = join(home, 'ws'); const outside = join(home, 'outside');
  mkdirSync(ws, { recursive: true }); mkdirSync(outside, { recursive: true });
  writeFileSync(join(ws, 'ok.png'), 'inside'); writeFileSync(join(outside, 'secret.png'), 'secret');
  const gateway = { log() {} };
  const resolveImage = (p) => ChatGateway.prototype.resolveImageFile.call(gateway, p, ws);
  assert.equal(Buffer.from(resolveImage('ok.png').data.file.slice(9), 'base64').toString(), 'inside');
  assert.equal(resolveImage(join(outside, 'secret.png')), null);
  try { symlinkSync(outside, join(ws, 'escape'), 'junction'); } catch (e) { t.skip(`无法创建链接: ${e.code}`); return; }
  assert.equal(resolveImage('escape/secret.png'), null);
});
