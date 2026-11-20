/** Fetch untrusted attachment URLs without contacting local or reserved addresses. */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

// Conservatively deny special-use IPv4 blocks. IPv6 is denied until it has an
// equally complete policy (including mapped, transition and scoped addresses).
export function publicIPv4(ip) {
 if (isIP(ip) !== 4) return false;
 const [a,b,c] = ip.split('.').map(Number);
 return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
  (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
  (a === 192 && b === 0 && (c === 0 || c === 2)) ||
  (a === 192 && b === 88 && c === 99) ||
  (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
  (a === 203 && b === 0 && c === 113));
}

function withAbort(promise, signal) {
 if (signal.aborted) return Promise.reject(signal.reason);
 return new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
 });
}

const REDIRECTS = [301,302,303,307,308];

/**
 * 这一跳的目标合不合格：协议/端口白名单 + 必须解析到公网 IPv4。
 * 不合格就返回 null（调用方直接放弃，绝不落到私网）。
 */
async function publicTarget(url, lookup, signal) {
 if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname ||
  (url.port && !['80','443'].includes(url.port))) return null;
 const host = url.hostname;
 const literal = isIP(host.replace(/^\[|\]$/g, ''));
 let addresses;
 if (literal) addresses = [{ address: host.replace(/^\[|\]$/g, ''), family: literal }];
 else addresses = await withAbort(lookup(host, { all: true, verbatim: true }), signal);
 // No fallback DNS resolution by the socket: every IPv4 answer must be allowed,
 // then connect to the chosen concrete address, with original TLS name/Host.
 const ipv4 = addresses.filter(x => x.family === 4);
 if (!ipv4.length || ipv4.some(x => !publicIPv4(x.address))) return null;
 return { host, address: ipv4[0].address };
}

/**
 * 发一跳：固定已验证的 IP 连（防 DNS 重绑定），保留原始 Host / TLS 服务器名。
 * `servername` 只进 TLS opts（SNI），不进 HTTP 头 —— 它是握手用的，不是请求头。
 */
function openHop(url, target, { request, signal, headers }) {
 const opts = { protocol: url.protocol, hostname: target.address, family: 4,
  port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search,
  method: 'GET', headers: { host: url.host, ...headers }, servername: target.host, signal, agent: false };
 return new Promise((resolve, reject) => {
  const req = request(url, opts, resolve); req.once('error', reject); req.end();
 });
}

/** Factory enables deterministic network tests; runtime uses only the defaults. */
export function createSafeDownload({ lookup = dnsLookup, request = (url, opts, cb) => (url.protocol === 'https:' ? https : http).request(opts, cb) } = {}) {
 return async function safeDownload(input, { maxBytes, timeoutMs = 8000, maxRedirects = 3 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
   let url = new URL(String(input));
   for (let n = 0; n <= maxRedirects; n++) {
    const target = await publicTarget(url, lookup, signal);
    if (!target) return null;
    const res = await openHop(url, target, { request, signal, headers: {} });
    if (REDIRECTS.includes(res.statusCode)) {
     const location = res.headers.location; res.destroy();
     if (!location || n === maxRedirects) return null;
     url = new URL(location, url); continue;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) { res.destroy(); return null; }
    const declared = Number(res.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(); return null; }
    const chunks = []; let size = 0;
    for await (const chunk of res) {
     size += chunk.length;
     if (size > maxBytes) { res.destroy(); return null; }
     chunks.push(chunk);
    }
    return size ? Buffer.concat(chunks, size) : null;
   }
  } catch { return null; }
  return null;
 };
}
export const safeDownload = createSafeDownload();

/**
 * 逐块下载：跟 safeDownload 同一套防护（协议/端口白名单、只连公网 IPv4、每一跳重新校验），
 * 区别是字节边下边给 —— 一条视频几十上百 MB，整份收进内存没必要。
 *
 * 跟 safeDownload 的差别还有两处：
 *  - 额外请求头（headers）可以带上鉴权；**跨站跳转不带走**（免得把 key 发给跳转目标）。
 *  - 超过 maxBytes 时抛错（code=ERR_TOO_LARGE），而不是静默返回 null —— 上层要分清
 *    「太大」和「下不下来」。
 *
 * @returns {Promise<{status:number, headers:object, body:AsyncGenerator<Buffer>}|null>}
 */
export function createSafeDownloadStream({ lookup = dnsLookup, request = (url, opts, cb) => (url.protocol === 'https:' ? https : http).request(opts, cb) } = {}) {
 return async function safeDownloadStream(input, { maxBytes, timeoutMs = 8000, maxRedirects = 3, headers = {} } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
  const signal = AbortSignal.timeout(timeoutMs);
  const extra = {};
  for (const [k, v] of Object.entries(headers || {})) if (v !== undefined && v !== null) extra[String(k).toLowerCase()] = String(v);
  try {
   let url = new URL(String(input));
   const origin = url.origin;
   let auth = { ...extra };
   for (let n = 0; n <= maxRedirects; n++) {
    const target = await publicTarget(url, lookup, signal);
    if (!target) return null;
    const res = await openHop(url, target, { request, signal, headers: auth });
    if (REDIRECTS.includes(res.statusCode)) {
     const location = res.headers.location; res.destroy();
     if (!location || n === maxRedirects) return null;
     const next = new URL(location, url);
     if (next.origin !== origin) auth = {}; // 跨站跳转不带走凭据
     url = next; continue;
    }
    if (res.statusCode < 200 || res.statusCode >= 300) { res.destroy(); return null; }
    return { status: res.statusCode, headers: res.headers ?? {}, body: limitedBody(res, maxBytes) };
   }
  } catch { return null; }
  return null;
 };
}
export const safeDownloadStream = createSafeDownloadStream();

/** 边读边给；上限按实际流量算（不信 Content-Length），超了就中断。 */
async function* limitedBody(res, maxBytes) {
 let size = 0;
 for await (const chunk of res) {
  size += chunk.length;
  if (size > maxBytes) {
   res.destroy();
   const err = new Error('超过下载大小上限');
   err.code = 'ERR_TOO_LARGE';
   throw err;
  }
  yield chunk;
 }
}
