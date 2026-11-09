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

/** Factory enables deterministic network tests; runtime uses only the defaults. */
export function createSafeDownload({ lookup = dnsLookup, request = (url, opts, cb) => (url.protocol === 'https:' ? https : http).request(opts, cb) } = {}) {
 return async function safeDownload(input, { maxBytes, timeoutMs = 8000, maxRedirects = 3 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
   let url = new URL(String(input));
   for (let n = 0; n <= maxRedirects; n++) {
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
    const opts = { protocol: url.protocol, hostname: ipv4[0].address, family: 4,
     port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search,
     method: 'GET', headers: { host: url.host }, servername: host, signal, agent: false };
    const res = await new Promise((resolve, reject) => {
     const req = request(url, opts, resolve); req.once('error', reject); req.end();
    });
    if ([301,302,303,307,308].includes(res.statusCode)) {
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
