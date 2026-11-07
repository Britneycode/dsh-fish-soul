// 抖音评论发布桥（页面内注入）的测试：桥脚本结构 + Node 侧调用。
// 验证纪律：新断言必须先证明改前是红的。
import assert from 'node:assert/strict';

const ok = (name) => console.log('✓', name);

const mod = await import('../lib/channels/vendor/douyin-bridge/douyin-comment.js');

// ── 桥脚本本身：能被注入、语法对、暴露了预期方法 ──
{
  const src = mod.COMMENT_BRIDGE_SOURCE;
  assert.match(src, /window\.__fishComment/, '桥挂在 window.__fishComment 上');
  assert.match(src, /postComment/, '有 postComment');
  assert.match(src, /uploadImage/, '有 uploadImage');
  assert.match(src, /emojiList/, '有 emojiList');
  assert.match(src, /comment\/publish/, '发评论走 comment/publish');
  assert.match(src, /comment\/upload\/auth/, '图片上传先取授权');
  assert.match(src, /ApplyImageUpload/, '图片上传申请地址');
  assert.match(src, /CommitImageUpload/, '图片上传提交');
  assert.match(src, /image_uri_list/, '带图评论带 image_uri_list');
  assert.match(src, /reply_id/, '回复带 reply_id');
  assert.match(src, /one_level_comment_rank/, '带 one_level_comment_rank');
  ok('抖音评论桥：方法与字段齐全');
}

// 注入脚本必须能被 JS 引擎解析
try {
  // eslint-disable-next-line no-new-func
  new Function(mod.COMMENT_BRIDGE_SOURCE);
} catch (error) {
  assert.fail('注入脚本编译不过：' + String(error && error.message));
}
ok('抖音评论桥：注入脚本语法正确');

// ── 版本号 ──
assert.equal(typeof mod.COMMENT_BRIDGE_VERSION, 'number');
assert.ok(mod.COMMENT_BRIDGE_VERSION >= 1, '版本号从 1 起');

// ── installCommentBridge ──
{
  const sent = [];
  const fake = {
    sessionId: 'S1',
    preloadScripts: [],
    addPreloadScript(s) { this.preloadScripts.push(s); },
    async send(method, params) { sent.push([method, params]); return {}; },
    async eval() { return 1; },
  };
  const r = await mod.installCommentBridge(fake);
  assert.equal(r.ok, true, '装桥返回 ok');
  assert.equal(fake.preloadScripts.length, 1, '桥进了 preload（每次导航都装）');
  assert.ok(sent.some(([m]) => m === 'Page.addScriptToEvaluateOnNewDocument'), '也注册了 addScriptToEvaluateOnNewDocument');
  ok('抖音评论桥：装桥（preload + 当前页）');
}

// ── callBridge：结果透传、异常不外抛 ──
{
  const fake = { async eval() { return { ok: false, error: '桥没装上' }; } };
  const r = await mod.callBridge(fake, 'postComment', { awemeId: '1' });
  assert.equal(r.ok, false);
  assert.match(r.error, /桥没装上/);
}
{
  const fake = { async eval() { return undefined; } };
  const r = await mod.callBridge(fake, 'postComment', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /没返回结果/);
}
{
  let r = null;
  const fake = { async eval() { throw new Error('CDP 断了'); } };
  try { r = await mod.callBridge(fake, 'postComment', {}); } catch { /* 不该抛 */ }
  assert.ok(r, 'callBridge 不该把异常抛给调用方');
  assert.equal(r.ok, false);
}
{
  // 桥没装时（window.__fishComment 不存在）→ 页面侧返回 error，Node 侧照样拿到 {ok:false}
  let expr = '';
  const fake = {
    async eval(e) {
      expr = e;
      return { ok: false, error: '桥没装上（window.__fishComment 不存在）' };
    },
  };
  const r = await mod.callBridge(fake, 'postComment', { awemeId: '2', text: 'x' });
  assert.equal(r.ok, false);
  assert.match(expr, /__fishComment/, '调用表达式指向桥');
  assert.match(expr, /postComment/, '调用表达式带方法名');
}
ok('抖音评论桥：Node 侧调用（透传 / 异常不外抛 / 桥没装）');

// ── Node 侧：CRC32 / SigV4 / 图片字段 ──

{
  // crc32 是十六进制、补 8 位；标准值 3610a686 = crc32("hello")
  assert.equal(mod.crc32(Buffer.from('hello')), '3610a686', 'CRC32 要和标准一致（且是 hex）');
  assert.equal(mod.crc32(Buffer.alloc(0)), '00000000', '空输入 = 0');
  assert.equal(mod.guessFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'png');
  assert.equal(mod.guessFormat(Buffer.from([0xFF, 0xD8, 0xFF])), 'jpeg');
  assert.equal(mod.guessFormat(Buffer.from('RIFFxxxxWEBP', 'latin1')), 'webp');
  assert.equal(mod.guessFormat(Buffer.from('GIF89a')), 'gif');
  assert.equal(mod.guessFormat(Buffer.from([0x00, 0x01, 0x02, 0x03])), 'jpeg', '认不出默认 jpeg');
  ok('CRC32 / 图片格式识别');
}

{
  // 签名输出形状：必须有 Authorization + x-amz-date + x-amz-security-token
  const r = mod.signImageX('GET', 'imagex.bytedanceapi.com', '/', {
    accessKey: 'AK', secretKey: 'SK', sessionToken: 'TOK',
  }, { Action: 'ApplyImageUpload', Version: '2018-08-01', ServiceId: 'svc' });
  assert.match(r.url, /^https:\/\/imagex\.bytedanceapi\.com\/\?/);
  assert.match(r.url, /Action=ApplyImageUpload/);
  assert.match(r.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/cn-north-1\/imagex\/aws4_request, SignedHeaders=x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  assert.match(r.headers['x-amz-date'], /^\d{8}T\d{6}Z$/);
  assert.equal(r.headers['x-amz-security-token'], 'TOK');
  assert.equal(r.body, null, 'GET 没有 body');
  ok('SigV4 签名输出形状（含 cn-north-1 / imagex 固定）');
}

{
  // POST 带 body 时：body 参与签名、带 X-Amz-Content-Sha256
  const r = mod.signImageX('POST', 'imagex.bytedanceapi.com', '/', {
    accessKey: 'AK', secretKey: 'SK', sessionToken: 'TOK',
  }, { Action: 'CommitImageUpload', Version: '2018-08-01', ServiceId: 'svc' }, { SessionKey: 'abc' });
  assert.equal(r.body, '{"SessionKey":"abc"}');
  assert.equal(r.headers['X-Amz-Content-Sha256'], mod.sha256Hex('{"SessionKey":"abc"}'));
  ok('SigV4：POST body 参与签名');
}

{
  // 上传的输入校验：缺授权 / 空图 → 直接拒，不发请求
  const r = await mod.uploadImage({ auth: {}, bytes: Buffer.from('x') });
  assert.equal(r.ok, false);
  assert.match(r.error, /授权不完整/);
  const r2 = await mod.uploadImage({ auth: { accessKey: 'a', secretKey: 'b', sessionToken: 'c', serviceId: 's' }, bytes: Buffer.alloc(0) });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /图片是空的/);
  ok('上传前置校验（缺授权 / 空图直接拒）');
}

{
  // 上传：假 fetch 验证「授权 → 申请地址 → 传字节 → 提交 → 返回 uri/宽高」整条链
  const seen = [];
  const fakeFetch = async (url, init) => {
    seen.push({ url, method: init.method });
    if (url.indexOf('Action=ApplyImageUpload') >= 0) {
      return new Response(JSON.stringify({ Result: {
        UploadAddress: { UploadHost: 'tos.example.com', StoreInfos: [{ StoreUri: 'tos-cn-i-xxx', Auth: 'TMP_AUTH' }], SessionKey: 'sess1' },
      } }), { status: 200 });
    }
    if (url.indexOf('tos.example.com') >= 0) return new Response('', { status: 200 });
    if (url.indexOf('Action=CommitImageUpload') >= 0) {
      return new Response(JSON.stringify({ Result: { PluginResult: [{ ImageUri: 'tos-cn-i-final', ImageWidth: 100, ImageHeight: 200, ImageFormat: 'PNG' }] } }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  const r = await mod.uploadImage({
    auth: { accessKey: 'a', secretKey: 'b', sessionToken: 'c', serviceId: 'svc' },
    bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    fetchImpl: fakeFetch,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.uri, 'tos-cn-i-final');
  assert.equal(r.width, 100);
  assert.equal(r.height, 200);
  assert.equal(r.format, 'png');
  assert.equal(seen.length, 3, '授权后正好是「申请 → 传字节 → 提交」三步');
  ok('上传链路：授权 → 申请地址 → 传字节 → 提交 → 拿 uri');
}

console.log('douyin-comment-bridge ok');
