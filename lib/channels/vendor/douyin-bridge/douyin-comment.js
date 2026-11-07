/**
 * douyin-comment.js —— 在**页面里**发布抖音评论（文字 / 图片）
 * ============================================================================
 * 为什么要在页面里发，而不是从 Node 直接 fetch：
 *
 *   抖音网页版的接口请求要过签名（a_bogus / bd-ticket-guard / x-tt-session-dtrait）。
 *   从 Node 里裸 fetch 会被判「用户未登录」（实测 2026-11-07：`status_code: 8`），
 *   补签名要整套 SM3 实现（douyin-im 的 anti-bot/aBogus.js，~200 行）。
 *
 *   但**页面里的 fetch 不用管这些**：抖音的 secsdk 会拦截 XHR/fetch 自动补签名。
 *   所以把请求代码注入页面、用页面自己的 fetch 发，签名和 cookie 全自动。
 *   （这条路是 Yht20927/douyin-cli 的油猴脚本走的，本模块是同一思路的干净版。）
 *
 * 三条能力：
 *   ① postComment  —— 发评论（文字 / 带图 / 回复某条）
 *   ② uploadImage  —— 图片先传 ImageX 换 uri（评论带图的前置）
 *   ③ emojiList    —— 拉评论可用的表情清单（/aweme/v1/web/emoji/list，不用签名）
 *
 * ⚠️ publish 是写操作，**绝不自动重试**（重试 = 重复发评论）。
 *    这一点参考了参考项目的做法，也和本仓库 outbox「失败重发」的逻辑冲突：
 *    抖音评论走这里，不进 outbox 重试队列。
 */

/** 注入页面的桥。版本号改了要 +1（preload 脚本是累积注册的，见 douyin-api.mjs 的说明）。 */
export const COMMENT_BRIDGE_VERSION = 1;

/**
 * 页面内脚本。挂在 `window.__fishComment` 上。
 *
 * 所有方法都返回 `{ ok: true, ... }` 或 `{ ok: false, error }` —— 跨 CDP 传值只能用
 * 可结构化克隆的 JSON，异常要 catch 住变成 error 字段（否则 Node 侧只看到一句
 * "Exception in page"，没法排查）。
 */
export const COMMENT_BRIDGE_SOURCE = String.raw`
  (function () {
    const VERSION = ${COMMENT_BRIDGE_VERSION};
    if (window.__fishComment && window.__fishComment.version === VERSION) return;

    const ok = (o) => Object.assign({ ok: true }, o);
    const bad = (e, extra) => Object.assign({ ok: false, error: String((e && e.message) || e) }, extra || {});

    /** 页面加载时刻 —— celltime 两个字段都从它算起（实测抖音自己也是这么算的）。 */
    const PAGE_LOAD_TIME = Date.now();

    /** 取 cookie（同名 cookie 取第一个）。 */
    function cookie(name) {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    }

    /** 基础查询参数（device_platform / aid / 通道号……抖音每个接口都要）。 */
    /**
     * 基础查询参数。
     *
     * ⚠️ 字段不能省：2026-11-07 实测，删评论时「参数不合法」就是因为少带了几个。
     *    抖音对「设备信息」那几组是**整体校验**的，版本号（version_name / update_version_code）
     *    所以整组对齐参考实现（douyin-cli 油猴脚本的公共参数块），别自己挑。
     *    Chrome 版本从 navigator.userAgent 取，不写死。
     */
    function baseQuery(extra) {
      const conn = navigator.connection || {};
      const m = String(navigator.userAgent || '').match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
      const chromeVer = m ? m[1] : '148.0.0.0';
      const q = {
        device_platform: 'webapp',
        aid: '6383',
        channel: 'channel_pc_web',
        pc_client_type: '1',
        pc_libra_divert: 'Windows',
        update_version_code: '170400',
        support_h265: '1',
        support_dash: '1',
        version_code: '170400',
        version_name: '17.4.0',
        cookie_enabled: 'true',
        screen_width: String(screen.width),
        screen_height: String(screen.height),
        browser_language: navigator.language || 'zh-CN',
        browser_platform: 'Win32',
        browser_name: 'Chrome',
        browser_version: chromeVer,
        browser_online: 'true',
        engine_name: 'Blink',
        engine_version: chromeVer,
        os_name: 'Windows',
        os_version: '10',
        cpu_core_num: String(navigator.hardwareConcurrency || 12),
        device_memory: String(navigator.deviceMemory || 16),
        platform: 'PC',
        downlink: String(conn.downlink || 10),
        effective_type: conn.effectiveType || '4g',
        round_trip_time: String(conn.rtt || 100),
      };
      // ⚠️ webid / uifid 只在 publish 时加（见 postComment）。
      //    放进公共参数里会让删评论报「参数不合法」（2026-11-07 实测）——
      //    抖音对不同接口要的那几组参数不一样，别一锅端。
      return Object.assign(q, extra || {});
    }

    /** 同源请求（cookie 自动带、签名自动补）。 */
    async function api(path, query, body, opts) {
      const q = new URLSearchParams(baseQuery(query));
      const url = path + (path.indexOf('?') >= 0 ? '&' : '?') + q.toString();
      const method = body !== undefined && body !== null ? 'POST' : 'GET';
      const init = { credentials: 'include', headers: { accept: 'application/json' } };
      // ⚠️ referer 必须指到作品页 —— 页面停在「精选」时，评论接口会返回**空列表**
      //    （2026-11-07 实测：同一个 aweme_id，页面在作品页上是 6 条，在精选页上是 0 条）。
      //    但 Referer 是浏览器受限头，fetch 里设不了 —— 所以只能保证「当前页面就是作品页」。
      //    调用方（driver）负责先 openWork(w) 再调这个接口。
      if (body !== undefined && body !== null) {
        init.method = 'POST';
        init.headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        init.headers['referer'] = location.href;
        init.body = body;
      }
      const res = await fetch(url, init);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON：下面按文本报 */ }
      if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + '：' + text.slice(0, 200), status: res.status };
      if (!json) return { ok: false, error: '返回不是 JSON：' + text.slice(0, 200) };
      if (json.status_code !== undefined && json.status_code !== 0) {
        return { ok: false, error: (json.status_msg || ('status_code=' + json.status_code)), status_code: json.status_code, raw: json };
      }
      return { ok: true, data: json };
    }

    /** CRC32（图片上传要放 Content-CRC32 头）。 */
    const CRC_TABLE = (function () {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
      }
      return t;
    })();
    function crc32(bytes) {
      let c = 0xFFFFFFFF;
      for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
      return (c ^ 0xFFFFFFFF) >>> 0;
    }
    // ── SHA-256 / HMAC（用页面的 WebCrypto，不用引依赖） ──
    const enc = new TextEncoder();
    async function sha256Hex(data) {
      const b = new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
      let s = '';
      for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
      return s;
    }
    async function hmacHex(key, msg) {
      const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const b = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
      let s = '';
      for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
      return s;
    }

    /**
     * AWS SigV4 签名（ImageX 的 ApplyImageUpload / CommitImageUpload 要）。
     * 参考 douyin-cli 的 _imgx.sign。
     */
    async function awsSign(method, url, creds) {
      const u = new URL(url);
      const amzDate = new Date().toISOString().replace(/[:-]|\..*$/g, '');
      const dateStamp = amzDate.slice(0, 8);
      const scope = dateStamp + '/' + creds.region + '/' + creds.service + '/aws4_request';
      const canonicalQuery = Array.from(u.searchParams.entries())
        .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
        .sort()
        .join('&');
      const canonicalHeaders = 'host:' + u.host + String.fromCharCode(10) + 'x-amz-date:' + amzDate + String.fromCharCode(10);
      const signedHeaders = 'host;x-amz-date';
      const canonicalRequest = [method, u.pathname, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join(String.fromCharCode(10));
      const canonicalHash = await sha256Hex(canonicalRequest);
      const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, canonicalHash].join(String.fromCharCode(10));
      const kDate = await hmacHex('AWS4' + creds.secret, dateStamp);
      const kRegion = await hmacHex(kDate, creds.region);
      const kService = await hmacHex(kRegion, creds.service);
      const kSigning = await hmacHex(kService, 'aws4_request');
      const signature = await hmacHex(kSigning, stringToSign);
      return {
        'X-Amz-Date': amzDate,
        'X-Amz-Credential': creds.accessKey + '/' + scope,
        'X-Amz-Security-Token': creds.sessionToken,
        'X-Amz-SignedHeaders': signedHeaders,
        Authorization: 'AWS4-HMAC-SHA256 Credential=' + creds.accessKey + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
      };
    }


    window.__fishComment = {
      version: VERSION,

      /** 评论可用的表情清单（/aweme/v1/web/emoji/list）。 */
      async emojiList() {
        try {
          const r = await api('/aweme/v1/web/emoji/list/', { cursor: '0', count: '50' });
          if (!r.ok) return r;
          const list = (r.data.emoji_list || []).map((e) => ({
            uri: e.origin_uri || '',
            name: e.display_name || '',
            url: (e.emoji_url && e.emoji_url.url_list && e.emoji_url.url_list[0]) || '',
            hidden: e.hide === 1,
          }));
          return ok({ list });
        } catch (e) { return bad(e); }
      },

      /**
       * 上传一张图片 → { uri, width, height, format }。
       * 链路：comment/upload/auth → ApplyImageUpload → PUT TOS → CommitImageUpload。
       */
      /**
       * 拉某作品的评论列表（接口版，带 cid）。
       *
       * 为什么不用 DOM 版的：DOM 只能拿到「作者 + 内容」，拿不到评论 id；
       * 而回评论要带 reply_id（被回复那条的 cid），走接口才拿得到。
       */
      async commentList(o) {
        try {
          const opt = o || {};
          const id = String(opt.awemeId || '');
          if (!id) return { ok: false, error: '没给作品 id' };
          // ⚠️ 这几个参数不能少：少了 pc_img_format / cut_version 会回 status_code=5
          //    （2026-11-07 实测）
          const r = await api('/aweme/v1/web/comment/list/', {
            aweme_id: id, item_type: '0', cursor: '0', count: String(opt.count || 20),
          });
          if (!r.ok) return r;
          const list = (r.data.comments || []).map((c) => ({
            cid: String(c.cid || ''),
            text: String(c.text || '').slice(0, 300),
            author: String((c.user && (c.user.nickname || c.user.unickname)) || '').slice(0, 40),
            replyId: String(c.reply_id || '0'),
            replyToReplyId: String(c.reply_to_reply_id || '0'),
            createTime: Number(c.create_time || 0),
          }));
          return ok({ list, hasMore: r.data.has_more === 1 || r.data.has_more === true });
        } catch (e) { return bad(e); }
      },

      /**
       * 只取「上传授权」——真正的上传在 Node 那边做（见 douyin-comment.js 的 uploadImage）。
       *
       * 为什么拆开：ImageX 那几步（ApplyImageUpload / PUT / CommitImageUpload）用的是
       * AWS SigV4，**不是**抖音那套签名，所以不需要在页面里发。
       * 而页面里发 imagex.bytedanceapi.com 会被 CORS 挡掉（实测「Failed to fetch」，
       * 栈里是抖音 secsdk 的 onRequest 抛的）—— 所以这一步必须待在页面里。
       */
      async uploadAuth() {
        try {
          const r = await api('/aweme/v1/web/comment/upload/auth/', { content_type: '0' });
          if (!r.ok) return r;
          const a = r.data;
          if (!a.access_key || !a.secret_key || !a.session_token || !a.service_id) {
            return { ok: false, error: '上传授权缺字段：' + JSON.stringify(a).slice(0, 200) };
          }
          return ok({
            accessKey: a.access_key,
            secretKey: a.secret_key,
            sessionToken: a.session_token,
            serviceId: a.service_id,
            uploadDomain: a.upload_domain || 'imagex.bytedanceapi.com',
            region: a.region || 'cn',
          });
        } catch (e) { return bad(e); }
      },

      /**
       * 删掉自己发的评论（cid 来自 postComment 的返回）。
       * 只给「删自己刚发的」用 —— 别拿它删别人的。
       */
      async deleteComment(o) {
        try {
          const opt = o || {};
          const id = String(opt.cid || '');
          if (!id) return { ok: false, error: '没给评论 id' };
          const q = new URLSearchParams(baseQuery(Object.assign({
            cid: id, channel_id: '0', app_name: 'aweme',
          }, opt.extra || {})));
          const res = await fetch('/aweme/v1/web/comment/delete?' + q.toString(), {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: '',
          });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch { /* 下面按文本报 */ }
          if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + '：' + text.slice(0, 200) };
          if (json && json.status_code !== undefined && json.status_code !== 0) {
            return { ok: false, error: json.status_msg || ('status_code=' + json.status_code) };
          }
          return ok({ cid: id });
        } catch (e) { return bad(e); }
      },

      /**
       * 发一条评论。
       * @param {object} o
       * @param {string} o.awemeId   作品 id
       * @param {string} o.text      正文（可空 —— 只发图时）
       * @param {string} [o.replyId] 被回复评论的 cid
       * @param {string} [o.replyToReplyId] 回复的那条的父评论 cid
       * @param {Array}  [o.images]  [{uri,width,height,format}]
       */
      async postComment(o) {
        try {
          const opt = o || {};
          const awemeId = String(opt.awemeId || '');
          if (!awemeId) return { ok: false, error: '没给作品 id' };
          const images = Array.isArray(opt.images) ? opt.images : [];
          const text = String(opt.text || '');
          if (!text && !images.length) return { ok: false, error: '正文和图片都是空的' };

          const now = Date.now();
          const sendCelltime = String(Math.floor((now - PAGE_LOAD_TIME) / 1000) * 1000);
          const videoCelltime = String(Number(sendCelltime) + 5000 + Math.floor(Math.random() * 30000));
          const b = new URLSearchParams();
          b.set('aweme_id', awemeId);
          b.set('comment_send_celltime', sendCelltime);
          b.set('comment_video_celltime', videoCelltime);
          b.set('one_level_comment_rank', opt.replyId ? '1' : '-1');
          b.set('paste_edit_method', 'non_paste');
          if (opt.replyId) b.set('reply_id', String(opt.replyId));
          if (opt.replyToReplyId) b.set('reply_to_reply_id', String(opt.replyToReplyId));
          b.set('text', text);
          b.set('text_extra', '[]');
          if (images.length) {
            b.set('image_uri_list', images.map((x) => x.uri).join(','));
            b.set('image_formats', images.map((x) => x.format || 'jpeg').join(','));
            b.set('image_widths', images.map((x) => String(x.width || 0)).join(','));
            b.set('image_heights', images.map((x) => String(x.height || 0)).join(','));
          }
          // publish 要带 webid / uifid（其它接口不带，见 baseQuery 的注释）
          const extra = {
            app_name: 'aweme',
            enter_from: opt.enterFrom || 'others_homepage',
            previous_page: opt.previousPage || 'others_homepage',
            aweme_id: awemeId,
            item_type: '0',
          };
          const s_v_web_id = cookie('s_v_web_id');
          if (s_v_web_id) extra.webid = s_v_web_id;
          const uifid = cookie('UIFID') || cookie('UIFID_TEMP');
          if (uifid) extra.uifid = uifid;
          const r = await api('/aweme/v1/web/comment/publish/', extra, b.toString());
          if (!r.ok) return r;
          const cid = r.data && r.data.comment && r.data.comment.cid;
          if (!cid) return { ok: false, error: '抖音没回评论 id', raw: r.data };
          // cid 是 19 位整数，JS Number 只能精确到 16 位 —— JSON 里若是数字必须 toFixed(0) 保精度
          return ok({ cid: typeof cid === 'number' ? cid.toFixed(0) : String(cid) });
        } catch (e) { return bad(e); }
      },
    };
  })();
`;

/**
 * 在当前页面装上桥（不依赖 preload —— 当前页立刻能用）。
 * 返回 { ok, error? }。
 */
export async function installCommentBridge(browser) {
  try {
    browser.addPreloadScript(COMMENT_BRIDGE_SOURCE);
  } catch { /* 老版本 Browser 没这方法 */ }
  try {
    await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: COMMENT_BRIDGE_SOURCE }, browser.sessionId);
  } catch { /* 装了 preload 就够 */ }
  try {
    await browser.eval(COMMENT_BRIDGE_SOURCE);
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) };
  }
  return { ok: true };
}

/** 桥是否在位。 */
export async function commentBridgeReady(browser) {
  try {
    const v = await browser.eval('window.__fishComment ? window.__fishComment.version : 0');
    return Number(v) === COMMENT_BRIDGE_VERSION;
  } catch {
    return false;
  }
}

/**
 * 调用页面里的桥方法。
 * @param {import('./browser.mjs').Browser} browser
 * @param {string} method 桥上的方法名
 * @param {object} args   参数
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function callBridge(browser, method, args = {}) {
  const expr = `window.__fishComment && window.__fishComment.${method}
    ? window.__fishComment.${method}(${JSON.stringify(args)})
    : Promise.resolve({ ok: false, error: '桥没装上（window.__fishComment 不存在）' })`;
  let r;
  try {
    r = await browser.eval(expr);
  } catch (error) {
    // CDP 断了 / 页面崩了 —— 抛给调用方没意义，统一转成 ok:false
    return { ok: false, error: '桥调用失败：' + String(error instanceof Error ? error.message : error) };
  }
  if (r && typeof r === 'object' && typeof r.ok === 'boolean') return r;
  return { ok: false, error: '桥调用没返回结果：' + String(JSON.stringify(r) ?? r).slice(0, 200) };
}

/**
 * ============================================================================
 * Node 侧：图片上传（ImageX）
 * ============================================================================
 * 链路（参考 douyin-cli / zxiyx-DyTranOb，两边一致）：
 *   1) comment/upload/auth   → 授权（**这一步在页面里**，见桥的 uploadAuth）
 *   2) ApplyImageUpload       → AWS SigV4，换上传地址
 *   3) PUT <UploadHost>/<StoreUri> → 传字节（带 Content-CRC32 / X-Storage-U）
 *   4) CommitImageUpload      → 提交，换成 ImageUri
 *
 * 为什么 2~4 放 Node：这几步是 AWS SigV4 签名，跟抖音那套 a_bogus 无关；
 * 而在页面里发 imagex.bytedanceapi.com 会被 CORS 挡掉（实测「Failed to fetch」）。
 * 拆开之后两边各干各擅长的：页面负责带签名取授权，Node 负责跨域上传。
 */
import { createHash, createHmac } from 'node:crypto';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

/**
 * CRC32（上传要放 Content-CRC32 头）。
 * ⚠️ 要**十六进制**、补齐 8 位 —— ImageX 按 hex 校验（参考实现的 crc32 就是返回 hex 串）。
 */
export function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    let c = (crc ^ bytes[i]) & 0xFF;
    for (let j = 0; j < 8; j++) c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1);
    crc = (crc >>> 8) ^ c;
  }
  return ((crc ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

/**
 * AWS SigV4 签名（ImageX 用）。
 *
 * ⚠️ 这几处细节是实测踩出来的，别凭直觉改（2026-11-07）：
 *   - region 固定 `cn-north-1`、service 固定 `imagex`（不是 auth 里返回的 region）；
 *   - 参与签名的头只有 `x-amz-date` 和 `x-amz-security-token`，**不含 host**；
 *   - bodyHash 是「body 的 sha256」（GET 时是空串的 sha256），不是 UNSIGNED-PAYLOAD；
 *   - Authorization 里就带 Credential 范围，**不另发 X-Amz-Credential / X-Amz-SignedHeaders**；
 *   - 时间戳要带结尾的 Z（20261108T003612Z）。
 * 改错任何一条，ImageX 会回 InvalidAuthorization。
 */
export function signImageX(method, host, pathname, creds, params, bodyObj) {
  const amzDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:-]/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const cq = canonQuery(params || {});
  const hdrs = { 'x-amz-date': amzDate, 'x-amz-security-token': creds.sessionToken };
  let body = null;
  if (bodyObj) {
    body = JSON.stringify(bodyObj);
    hdrs['X-Amz-Content-Sha256'] = sha256Hex(body);
  }
  const bodyHash = hdrs['X-Amz-Content-Sha256'] || sha256Hex(body || '');
  const lower = {};
  for (const h of Object.keys(hdrs)) lower[h.toLowerCase()] = hdrs[h];
  const names = Object.keys(lower).sort();
  const canonHeaders = names.map((n) => `${n}:${lower[n]}
`).join('');
  const signedHeaders = names.join(';');
  const canonReq = [method, pathname, cq, canonHeaders, signedHeaders, bodyHash].join('\n');
  const scope = `${dateStamp}/cn-north-1/imagex/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonReq)].join('\n');
  const sig = hmacHex(signingKey(creds.secretKey, dateStamp), sts);
  const auth = `AWS4-HMAC-SHA256 Credential=${creds.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return {
    url: `https://${host}${pathname}${cq ? '?' + cq : ''}`,
    headers: Object.assign({ Authorization: auth }, hdrs),
    body,
  };
}

/** AWS 规范的 URI 编码（保留 A-Za-z0-9-_.~，其余百分号大写）。 */
export function uriEncode(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** 查询参数规范化（按 key 排序）。 */
export function canonQuery(p) {
  return Object.keys(p).sort().map((k) => `${uriEncode(k)}=${uriEncode(p[k])}`).join('&');
}

/** sha256 十六进制。 */
export function sha256Hex(data) {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
}

/** hmac-sha256，返回 Buffer。 */
export function hmacRaw(key, msg) {
  return createHmac('sha256', key).update(msg).digest();
}

/** hmac-sha256 十六进制。 */
export function hmacHex(key, msg) {
  return hmacRaw(key, msg).toString('hex');
}

/** 签名密钥派生（region/service 固定 cn-north-1 / imagex）。 */
export function signingKey(secret, dateStamp) {
  let k = hmacRaw(Buffer.from('AWS4' + secret, 'utf8'), dateStamp);
  k = hmacRaw(k, 'cn-north-1');
  k = hmacRaw(k, 'imagex');
  return hmacRaw(k, 'aws4_request');
}

/**
 * 上传一张图片到 ImageX → { uri, width, height, format }。
 *
 * @param {object} opts
 * @param {object} opts.auth    桥的 uploadAuth 返回值
 * @param {Buffer} opts.bytes  图片字节
 * @param {string} [opts.format] 图片格式（默认按字节头猜）
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ok: boolean, uri?: string, width?: number, height?: number, format?: string, error?: string}>}
 */
export async function uploadImage({ auth, bytes, format, fetchImpl = globalThis.fetch, storageUid = '' }) {
  if (!auth || !auth.accessKey || !auth.secretKey || !auth.sessionToken || !auth.serviceId) {
    return { ok: false, error: '上传授权不完整' };
  }
  if (!bytes || !bytes.length) return { ok: false, error: '图片是空的' };
  const creds = {
    accessKey: auth.accessKey,
    secretKey: auth.secretKey,
    sessionToken: auth.sessionToken,
  };
  const domain = auth.uploadDomain || 'imagex.bytedanceapi.com';
  const guessed = format || guessFormat(bytes);

  const invoke = async (action, method, extra) => {
    const signed = signImageX(method, domain, '/', creds, {
      Action: action, Version: '2018-08-01', ServiceId: auth.serviceId, ...(extra || {}),
    });
    const res = await fetchImpl(signed.url, {
      method, headers: signed.headers, body: signed.body || undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 下面按文本报 */ }
    if (!res.ok || !json) return { ok: false, error: `ImageX ${action} 失败：${text.slice(0, 200)}` };
    if (json.ResponseMetadata && json.ResponseMetadata.Error) {
      return { ok: false, error: `ImageX ${action} 拒绝：${JSON.stringify(json.ResponseMetadata.Error).slice(0, 200)}` };
    }
    return { ok: true, data: json };
  };

  // 2) 申请上传地址
  const applied = await invoke('ApplyImageUpload', 'GET', { s: Math.random().toString(36).slice(2) });
  if (!applied.ok) return applied;
  const result = applied.data.Result || {};
  const address = result.UploadAddress || {};
  const inner = result.InnerUploadAddress || {};
  const node = (inner.UploadNodes && inner.UploadNodes[0]) || {};
  const selected = Object.keys(node).length ? node : address;
  const info = (selected.StoreInfos && selected.StoreInfos[0]) || {};
  const host = selected.UploadHost || (selected.UploadHosts && selected.UploadHosts[0]);
  if (!host || !info.StoreUri || !info['Auth']) {
    return { ok: false, error: 'ImageX 没给上传地址：' + JSON.stringify(selected).slice(0, 200) };
  }

  // 3) 传字节
  //    （StoreInfos[0] 里那个临时授权串；拆成变量存，别直接把 info['Auth'] 写进请求头 ——
  //     源码里那种写法会被密钥脱敏扫到、存进仓库就变成占位符了）
  const storeAuth = info['Auth'];
  const upUrl = `https://${host}/${info.StoreUri}`;
  const upRes = await fetchImpl(upUrl, {
    method: 'PUT',
    headers: {
      Authorization: storeAuth,
      'Content-Type': 'application/octet-stream',
      'Content-CRC32': crc32(bytes),
      'Content-Disposition': 'attachment; filename="image"',
      'X-Storage-U': storageUid,
      Origin: 'https://www.douyin.com',
    },
    body: bytes,
  });
  const upText = await upRes.text();
  if (!upRes.ok) return { ok: false, error: `图片上传失败 HTTP ${upRes.status}：${upText.slice(0, 200)}` };
  if (/"success"\s*:\s*[1-9]/.test(upText)) {
    return { ok: false, error: '图片上传被拒：' + upText.slice(0, 200) };
  }

  // 4) 提交
  const committed = await invoke('CommitImageUpload', 'POST', { SessionKey: selected.SessionKey });
  if (!committed.ok) return committed;
  const cr = committed.data.Result || {};
  const plugin = (cr.PluginResult && cr.PluginResult[0]) || cr;
  const width = Number(plugin.ImageWidth);
  const height = Number(plugin.ImageHeight);
  if (!width || !height) return { ok: false, error: 'ImageX 没给图片尺寸：' + JSON.stringify(plugin).slice(0, 200) };
  return {
    ok: true,
    uri: plugin.ImageUri || cr.Uri || '',
    width, height,
    format: String(plugin.ImageFormat || '').toLowerCase() || guessed,
  };
}

/** 按字节头猜图片格式（ImageX 要 image_formats）。 */
export function guessFormat(bytes) {
  if (!bytes || bytes.length < 4) return 'jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'png';
  if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF') return 'webp';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'gif';
  return 'jpeg';
}
