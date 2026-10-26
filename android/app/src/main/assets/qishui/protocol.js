"use strict";
(() => {
  var __create = Object.create;
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getProtoOf = Object.getPrototypeOf;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __esm = (fn, res) => function __init() {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  };
  var __commonJS = (cb, mod) => function __require() {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  };
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from2, except, desc) => {
    if (from2 && typeof from2 === "object" || typeof from2 === "function") {
      for (let key of __getOwnPropNames(from2))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from2[key], enumerable: !(desc = __getOwnPropDesc(from2, key)) || desc.enumerable });
    }
    return to;
  };
  var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
    // If the importer is in node compatibility mode or this is not an ESM
    // file that has been converted to a CommonJS file using a Babel-
    // compatible transform (i.e. "__esModule" has not been set), then set
    // "default" to the CommonJS "module.exports" for node compatibility.
    isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
    mod
  ));
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/shims/buffer.js
  function concat(list) {
    const total = (list || []).reduce((sum, item) => sum + item.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const item of list || []) {
      merged.set(item, offset);
      offset += item.length;
    }
    return merged;
  }
  function byteLength(value) {
    return new TextEncoder().encode(String(value == null ? "" : value)).length;
  }
  function isBuffer(value) {
    return value instanceof Uint8Array;
  }
  function from(value, encoding) {
    if (typeof value === "string") {
      if (encoding === "hex") {
        const out = new Uint8Array(value.length >> 1);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
        return out;
      }
      if (encoding === "base64" || encoding === "base64url") {
        const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
        const binary = window.atob(normalized);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
      }
      return new TextEncoder().encode(value);
    }
    return new Uint8Array(value || 0);
  }
  var BufferShim, buffer_default;
  var init_buffer = __esm({
    "src/shims/buffer.js"() {
      "use strict";
      init_globals();
      BufferShim = class extends Uint8Array {
        toString(encoding) {
          if (encoding === "hex") {
            let out = "";
            for (let i = 0; i < this.length; i++) out += this[i].toString(16).padStart(2, "0");
            return out;
          }
          return new TextDecoder("utf-8").decode(this);
        }
      };
      buffer_default = Object.assign(BufferShim, { concat, byteLength, isBuffer, from });
    }
  });

  // src/shims/globals.js
  var __foliaProcessEnv, __foliaDirname;
  var init_globals = __esm({
    "src/shims/globals.js"() {
      "use strict";
      init_buffer();
      __foliaProcessEnv = {
        QISHUI_COOKIE_FILE: "/folia/qishui-cookie.txt",
        QISHUI_TOKEN_FILE: "/folia/qishui-token.txt",
        QISHUI_QR_CONFIG_FILE: "/folia/qishui-qr-login.json",
        QISHUI_OAUTH_CONFIG_FILE: "/folia/qishui-oauth.json"
      };
      __foliaDirname = "/folia";
    }
  });

  // src/shims/fs.js
  var fs_exports = {};
  __export(fs_exports, {
    default: () => fs_default,
    existsSync: () => existsSync,
    mkdirSync: () => mkdirSync,
    readFileSync: () => readFileSync,
    unlinkAllByPrefix: () => unlinkAllByPrefix,
    unlinkSync: () => unlinkSync,
    writeFileSync: () => writeFileSync
  });
  function keyOf(file) {
    return PREFIX2 + String(file);
  }
  function existsSync(file) {
    const key = keyOf(file);
    if (memory2.has(key)) return true;
    try {
      return window.localStorage.getItem(key) !== null;
    } catch (_) {
      return false;
    }
  }
  function readFileSync(file, _encoding) {
    const key = keyOf(file);
    if (memory2.has(key)) return memory2.get(key);
    let value = null;
    try {
      value = window.localStorage.getItem(key);
    } catch (_) {
      value = null;
    }
    if (value === null) {
      const error = new Error("ENOENT: no such file, open '" + file + "'");
      error.code = "ENOENT";
      throw error;
    }
    return value;
  }
  function writeFileSync(file, data) {
    const key = keyOf(file);
    const value = data == null ? "" : String(data);
    memory2.set(key, value);
    try {
      window.localStorage.setItem(key, value);
    } catch (_) {
    }
  }
  function mkdirSync() {
  }
  function unlinkSync(file) {
    const key = keyOf(file);
    memory2.delete(key);
    try {
      window.localStorage.removeItem(key);
    } catch (_) {
    }
  }
  function unlinkAllByPrefix(prefix) {
    const needle = PREFIX2 + String(prefix || "");
    const touched = [];
    for (const key of Array.from(memory2.keys())) {
      if (key.indexOf(needle) === 0) touched.push(key);
    }
    for (const key of touched) memory2.delete(key);
    try {
      const store = window.localStorage;
      const removals = [];
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key && key.indexOf(needle) === 0) removals.push(key);
      }
      for (const key of removals) store.removeItem(key);
    } catch (_) {
    }
  }
  var PREFIX2, memory2, fs_default;
  var init_fs = __esm({
    "src/shims/fs.js"() {
      "use strict";
      init_globals();
      PREFIX2 = "qishui:fs:";
      memory2 = /* @__PURE__ */ new Map();
      fs_default = { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, unlinkAllByPrefix };
    }
  });

  // src/shims/crypto.js
  var crypto_exports = {};
  __export(crypto_exports, {
    createHash: () => createHash,
    default: () => crypto_default,
    randomBytes: () => randomBytes2,
    randomInt: () => randomInt,
    randomUUID: () => randomUUID
  });
  function utf8Bytes2(text5) {
    return new TextEncoder().encode(String(text5));
  }
  function bytesToHex(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  }
  function randomValues(length) {
    const bytes = new Uint8Array(length);
    const cryptoRef = win.crypto || win.msCrypto;
    if (!cryptoRef || typeof cryptoRef.getRandomValues !== "function") {
      for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
      return bytes;
    }
    for (let offset = 0; offset < length; offset += 65536) {
      cryptoRef.getRandomValues(bytes.subarray(offset, Math.min(length, offset + 65536)));
    }
    return bytes;
  }
  function sha1Digest(message) {
    const bytes = message instanceof Uint8Array ? message : utf8Bytes2(message);
    const bitLength = bytes.length * 8;
    const padded = new Uint8Array((bytes.length + 8 >> 6) + 1 << 6);
    padded.set(bytes);
    padded[bytes.length] = 128;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 4, bitLength >>> 0, false);
    view.setUint32(padded.length - 8, Math.floor(bitLength / 4294967296), false);
    let h0 = 1732584193, h1 = 4023233417, h2 = 2562383102, h3 = 271733878, h4 = 3285377520;
    const w = new Uint32Array(80);
    for (let block = 0; block < padded.length; block += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(block + i * 4, false);
      for (let i = 16; i < 80; i++) {
        const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = n << 1 | n >>> 31;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20) {
          f = b & c | ~b & d;
          k = 1518500249;
        } else if (i < 40) {
          f = b ^ c ^ d;
          k = 1859775393;
        } else if (i < 60) {
          f = b & c | b & d | c & d;
          k = 2400959708;
        } else {
          f = b ^ c ^ d;
          k = 3395469782;
        }
        const temp = (a << 5 | a >>> 27) + f + e + k + w[i] >>> 0;
        e = d;
        d = c;
        c = b << 30 | b >>> 2;
        b = a;
        a = temp;
      }
      h0 = h0 + a >>> 0;
      h1 = h1 + b >>> 0;
      h2 = h2 + c >>> 0;
      h3 = h3 + d >>> 0;
      h4 = h4 + e >>> 0;
    }
    const out = new Uint8Array(20);
    new DataView(out.buffer).setUint32(0, h0, false);
    new DataView(out.buffer).setUint32(4, h1, false);
    new DataView(out.buffer).setUint32(8, h2, false);
    new DataView(out.buffer).setUint32(12, h3, false);
    new DataView(out.buffer).setUint32(16, h4, false);
    return out;
  }
  function md5Digest(message) {
    const bytes = message instanceof Uint8Array ? message : utf8Bytes2(message);
    const bitLengthLow = bytes.length * 8 >>> 0;
    const bitLengthHigh = Math.floor(bytes.length * 8 / 4294967296) >>> 0;
    const padded = new Uint8Array((bytes.length + 8 >> 6) + 1 << 6);
    padded.set(bytes);
    padded[bytes.length] = 128;
    const view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, bitLengthLow, true);
    view.setUint32(padded.length - 4, bitLengthHigh, true);
    const S = [
      7,
      12,
      17,
      22,
      7,
      12,
      17,
      22,
      7,
      12,
      17,
      22,
      7,
      12,
      17,
      22,
      5,
      9,
      14,
      20,
      5,
      9,
      14,
      20,
      5,
      9,
      14,
      20,
      5,
      9,
      14,
      20,
      4,
      11,
      16,
      23,
      4,
      11,
      16,
      23,
      4,
      11,
      16,
      23,
      4,
      11,
      16,
      23,
      6,
      10,
      15,
      21,
      6,
      10,
      15,
      21,
      6,
      10,
      15,
      21,
      6,
      10,
      15,
      21
    ];
    let K = md5Digest.K;
    if (!K) {
      K = md5Digest.K = new Uint32Array(64);
      for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
    }
    let a0 = 1732584193, b0 = 4023233417, c0 = 2562383102, d0 = 271733878;
    const M = new Uint32Array(16);
    for (let block = 0; block < padded.length; block += 64) {
      for (let i = 0; i < 16; i++) M[i] = view.getUint32(block + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) {
          F = B & C | ~B & D;
          g = i;
        } else if (i < 32) {
          F = D & B | ~D & C;
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) % 16;
        } else {
          F = C ^ (B | ~D);
          g = 7 * i % 16;
        }
        F = F + A + K[i] + M[g] >>> 0;
        A = D;
        D = C;
        C = B;
        B = B + (F << S[i] | F >>> 32 - S[i]) >>> 0;
      }
      a0 = a0 + A >>> 0;
      b0 = b0 + B >>> 0;
      c0 = c0 + C >>> 0;
      d0 = d0 + D >>> 0;
    }
    const out = new Uint8Array(16);
    new DataView(out.buffer).setUint32(0, a0, true);
    new DataView(out.buffer).setUint32(4, b0, true);
    new DataView(out.buffer).setUint32(8, c0, true);
    new DataView(out.buffer).setUint32(12, d0, true);
    return out;
  }
  function base64Url(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return win.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function createHash(kind) {
    return new Hash(String(kind || "").toLowerCase());
  }
  function randomBytes2(length) {
    const bytes = randomValues(length);
    bytes.toString = function(encoding) {
      if (encoding === "hex") return bytesToHex(this);
      if (encoding === "base64url") return base64Url(this);
      let binary = "";
      for (let i = 0; i < this.length; i++) binary += String.fromCharCode(this[i]);
      return win.btoa(binary);
    };
    return bytes;
  }
  function randomUUID() {
    const bytes = randomValues(16);
    bytes[6] = bytes[6] & 15 | 64;
    bytes[8] = bytes[8] & 63 | 128;
    const hex = bytesToHex(bytes);
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }
  function randomInt(min, max) {
    const low = Math.ceil(min);
    const high = Math.floor(max);
    if (high <= low) return low;
    const range = high - low;
    const bytes = randomValues(4);
    const value = (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0;
    return low + value % range;
  }
  var win, Hash, crypto_default;
  var init_crypto = __esm({
    "src/shims/crypto.js"() {
      "use strict";
      init_globals();
      win = typeof window !== "undefined" ? window : globalThis;
      Hash = class {
        constructor(kind) {
          this.kind = kind;
          this.chunks = [];
        }
        update(data) {
          this.chunks.push(data instanceof Uint8Array ? data : utf8Bytes2(data));
          return this;
        }
        digest(encoding) {
          const merged = new Uint8Array(this.chunks.reduce((total, chunk) => total + chunk.length, 0));
          let offset = 0;
          for (const chunk of this.chunks) {
            merged.set(chunk, offset);
            offset += chunk.length;
          }
          const digest = this.kind === "sha1" ? sha1Digest(merged) : md5Digest(merged);
          if (encoding === "hex") return bytesToHex(digest);
          if (encoding === "base64url") return base64Url(digest);
          if (encoding === "base64") {
            let binary = "";
            for (let i = 0; i < digest.length; i++) binary += String.fromCharCode(digest[i]);
            return win.btoa(binary);
          }
          return digest;
        }
      };
      crypto_default = { createHash, randomBytes: randomBytes2, randomUUID, randomInt };
    }
  });

  // src/shims/http.js
  var http_exports = {};
  __export(http_exports, {
    default: () => http_default,
    request: () => request
  });
  function normalizeUrl(url) {
    return typeof url === "string" ? url : String(url && url.href || url);
  }
  function wrapResponse2(native3) {
    const listeners = { data: [], end: [], error: [] };
    const response = {
      statusCode: Number(native3 && native3.status) || 0,
      headers: native3 && native3.headers || {},
      text: String(native3 && native3.body || ""),
      on(event, listener) {
        if (listeners[event] && typeof listener === "function") listeners[event].push(listener);
        return this;
      },
      _drain() {
        Promise.resolve().then(() => {
          for (const listener of listeners.data) {
            try {
              listener(buffer_default.from(response.text, "utf8"));
            } catch (_) {
            }
          }
          for (const listener of listeners.end) {
            try {
              listener();
            } catch (_) {
            }
          }
        });
      }
    };
    return response;
  }
  function request(url, options, callback) {
    return new ClientRequest(url, options, callback);
  }
  var ClientRequest, http_default;
  var init_http = __esm({
    "src/shims/http.js"() {
      "use strict";
      init_globals();
      ClientRequest = class {
        constructor(url, options, callback) {
          this.url = normalizeUrl(url);
          this.options = options || {};
          this.callback = typeof callback === "function" ? callback : null;
          this.errorListeners = [];
          this.timeoutTimer = null;
          this.aborted = false;
          this.chunks = [];
          this.timeoutMs = 2e4;
        }
        setTimeout(ms, handler) {
          const value = Number(ms) || 0;
          if (value > 0) this.timeoutMs = value;
          if (typeof handler === "function") this.timeoutHandler = handler;
          return this;
        }
        on(event, listener) {
          if (event === "error" && typeof listener === "function") this.errorListeners.push(listener);
          return this;
        }
        write(chunk) {
          if (chunk != null) this.chunks.push(String(chunk));
          return this;
        }
        end(chunk) {
          if (chunk != null) this.chunks.push(String(chunk));
          this._dispatch();
          return this;
        }
        destroy(error) {
          this.aborted = true;
          if (error) this._fail(error);
          return this;
        }
        _fail(error) {
          for (const listener of this.errorListeners) {
            try {
              listener(error);
            } catch (_) {
            }
          }
        }
        _dispatch() {
          const transport = window.__foliaHttpTransport;
          if (!transport || typeof transport.request !== "function") {
            this._fail(new Error("native http transport is unavailable"));
            return;
          }
          const payload = {
            url: this.url,
            method: String(this.options.method || "GET").toUpperCase(),
            headers: this.options.headers || {},
            body: this.chunks.length ? this.chunks.join("") : null,
            timeoutMs: Number(this.options.timeoutMs) > 0 ? Number(this.options.timeoutMs) : this.timeoutMs
          };
          const started = Date.now();
          transport.request(payload).then((native3) => {
            if (this.aborted) return;
            const response = wrapResponse2(native3);
            if (this.callback) {
              try {
                this.callback(response);
              } catch (error) {
                this._fail(error);
              }
            }
            response._drain();
          }).catch((error) => {
            if (this.aborted) return;
            this._fail(error instanceof Error ? error : new Error(String(error)));
          });
        }
      };
      http_default = { request, ClientRequest };
    }
  });

  // src/shims/https.js
  var https_exports = {};
  __export(https_exports, {
    default: () => http_default,
    request: () => request
  });
  var init_https = __esm({
    "src/shims/https.js"() {
      "use strict";
      init_globals();
      init_http();
    }
  });

  // src/shims/path.js
  var path_exports = {};
  __export(path_exports, {
    default: () => path_default,
    dirname: () => dirname,
    join: () => join,
    resolve: () => resolve
  });
  function join(...parts) {
    const segments = (parts || []).filter((part) => part != null && String(part) !== "").map(String);
    if (!segments.length) return ".";
    const joined = segments.join("/").replace(/\/{2,}/g, "/");
    return normalize(joined);
  }
  function dirname(file) {
    const value = String(file || "");
    const index = value.lastIndexOf("/");
    if (index < 0) return ".";
    if (index === 0) return "/";
    return normalize(value.slice(0, index));
  }
  function resolve(...parts) {
    return join(...parts);
  }
  function normalize(value) {
    let out = value;
    while (/\/\.\//.test(out)) out = out.replace(/\/\.\//g, "/");
    if (out.endsWith("/.")) out = out.slice(0, -2);
    return out || "/";
  }
  var path_default;
  var init_path = __esm({
    "src/shims/path.js"() {
      "use strict";
      init_globals();
      path_default = { join, dirname, resolve, normalize };
    }
  });

  // src/generated/qishui-official-stub.cjs
  var require_qishui_official_stub = __commonJS({
    "src/generated/qishui-official-stub.cjs"(exports, module) {
      "use strict";
      init_globals();
      module.exports = {};
    }
  });

  // src/generated/qishui-web-api.cjs
  var require_qishui_web_api = __commonJS({
    "src/generated/qishui-web-api.cjs"(exports, module) {
      "use strict";
      init_globals();
      var fs = (init_fs(), __toCommonJS(fs_exports));
      var crypto = (init_crypto(), __toCommonJS(crypto_exports));
      var http = (init_http(), __toCommonJS(http_exports));
      var https = (init_https(), __toCommonJS(https_exports));
      var path = (init_path(), __toCommonJS(path_exports));
      var QISHUI_API_BASE = (__foliaProcessEnv.QISHUI_API_BASE || "https://open.douyin.com").replace(/\/+$/, "");
      var QISHUI_RELATED_MEDIA_PATH = "/api/luna/v1/platform/feed/related-media/";
      var QISHUI_FEED_SONG_TAB_PATH = "/api/luna/v1/platform/feed/song-tab/";
      var QISHUI_SCOPE = "luna.openapi.platform.play_core";
      var DEFAULT_QISHUI_TOKEN_FILE = __foliaProcessEnv.QISHUI_TOKEN_FILE || path.join(__foliaDirname, ".qishui-token");
      var QISHUI_UA2 = "Folia/0.7.13 (Qishui official OpenAPI bridge)";
      var QISHUI_OAUTH_AUTH_URL = (__foliaProcessEnv.QISHUI_OAUTH_AUTH_URL || "https://open.douyin.com/platform/oauth/connect").replace(/\/+$/, "");
      var QISHUI_OAUTH_TOKEN_URL = __foliaProcessEnv.QISHUI_OAUTH_TOKEN_URL || "https://open.douyin.com/oauth/access_token/";
      var QISHUI_PUBLIC_ENABLED = __foliaProcessEnv.QISHUI_PUBLIC_ENABLED !== "0";
      var QISHUI_PUBLIC_SEARCH_URL = __foliaProcessEnv.QISHUI_PUBLIC_SEARCH_URL || "https://api-vehicle.volcengine.com/v2/search/type";
      var QISHUI_PUBLIC_CONTENTS_URL = __foliaProcessEnv.QISHUI_PUBLIC_CONTENTS_URL || "https://api-vehicle.volcengine.com/v2/custom/contents";
      var QISHUI_VIRTUAL_FEED_PLAYLIST_ID = "qishui-feed";
      var QISHUI_WEB_LIKED_PLAYLIST_ID = "qishui-liked";
      var QISHUI_WEB_RECENT_PLAYLIST_ID = "qishui-recent";
      var QISHUI_WEB_API_BASES = (__foliaProcessEnv.QISHUI_WEB_API_BASES || "https://api5-lq.qishui.com,https://api.qishui.com").split(",").map((item) => item.trim().replace(/\/+$/, "")).filter(Boolean);
      var QISHUI_WEB_PC_API_BASE = (__foliaProcessEnv.QISHUI_WEB_PC_API_BASE || "https://api.qishui.com").replace(/\/+$/, "");
      var QISHUI_PUBLIC_HEADERS = {
        "Accept": "application/json,text/plain,*/*",
        "User-Agent": "Folia/0.7.13 (Qishui public catalog bridge)"
      };
      var QISHUI_WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.1.0 Chrome/136.0.7103.59 Electron/36.4.0-rs.22.release.main.1 TTElectron/36.4.0-rs.22.release.main.1 Safari/537.36";
      var QISHUI_PC_APP_UA = "LunaPC/3.3.0(359450208)";
      var QISHUI_WEB_DEFAULT_PARAMS = {
        aid: "386088",
        app_name: "luna_pc",
        device_platform: "web",
        channel: "pc_web"
      };
      function qishuiDiagLog() {
      }
      function firstEnv(keys) {
        for (const key of keys) {
          const value = String(__foliaProcessEnv[key] || "").trim();
          if (value) return value;
        }
        return "";
      }
      function normalizeQishuiOAuthFileConfig(raw, file) {
        raw = raw && typeof raw === "object" ? raw : {};
        const oauth = raw.oauth && typeof raw.oauth === "object" ? raw.oauth : raw;
        return {
          clientKey: String(oauth.clientKey || oauth.client_key || oauth.clientId || oauth.client_id || oauth.key || "").trim(),
          clientSecret: String(oauth.clientSecret || oauth.client_secret || oauth.secret || "").trim(),
          redirectUri: String(oauth.redirectUri || oauth.redirect_uri || oauth.redirectURL || oauth.redirect_url || "").trim(),
          scope: String(oauth.scope || oauth.scopes || "").trim(),
          file,
          source: file ? "file" : ""
        };
      }
      function qishuiOAuthConfigFileCandidates() {
        const candidates = [];
        const add = (value) => {
          value = String(value || "").trim();
          if (!value) return;
          const resolved = path.resolve(value);
          if (!candidates.includes(resolved)) candidates.push(resolved);
        };
        add(firstEnv(["QISHUI_OAUTH_CONFIG_FILE", "DOUYIN_OAUTH_CONFIG_FILE"]));
        try {
          add(path.join(path.dirname(qishuiTokenFile()), ".qishui-oauth.json"));
        } catch (_) {
        }
        add(path.join(__foliaDirname, ".qishui-oauth.json"));
        add(path.join(__foliaDirname, "qishui-oauth.json"));
        return candidates;
      }
      function readQishuiOAuthFileConfig() {
        const candidates = qishuiOAuthConfigFileCandidates();
        for (const file of candidates) {
          try {
            if (!fs.existsSync(file)) continue;
            const parsed = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
            const config = normalizeQishuiOAuthFileConfig(parsed, file);
            if (config.clientKey || config.clientSecret || config.redirectUri || config.scope) return config;
          } catch (e) {
            console.warn("[QishuiOAuthConfig] ignored invalid config file:", file, e.message);
          }
        }
        return normalizeQishuiOAuthFileConfig(null, candidates[0] || "");
      }
      function getQishuiOAuthConfig() {
        const fileConfig = readQishuiOAuthFileConfig();
        const clientKey = firstEnv(["QISHUI_OAUTH_CLIENT_KEY", "QISHUI_CLIENT_KEY", "DOUYIN_CLIENT_KEY"]) || fileConfig.clientKey;
        const clientSecret = firstEnv(["QISHUI_OAUTH_CLIENT_SECRET", "QISHUI_CLIENT_SECRET", "DOUYIN_CLIENT_SECRET"]) || fileConfig.clientSecret;
        const redirectUri = firstEnv(["QISHUI_OAUTH_REDIRECT_URI", "QISHUI_REDIRECT_URI", "DOUYIN_REDIRECT_URI"]) || fileConfig.redirectUri;
        const scope = firstEnv(["QISHUI_OAUTH_SCOPE", "DOUYIN_OAUTH_SCOPE"]) || fileConfig.scope || QISHUI_SCOPE;
        const missing = [];
        if (!clientKey) missing.push("QISHUI_OAUTH_CLIENT_KEY");
        if (!clientSecret) missing.push("QISHUI_OAUTH_CLIENT_SECRET");
        if (!redirectUri) missing.push("QISHUI_OAUTH_REDIRECT_URI");
        else if (!/^https:\/\//i.test(redirectUri)) missing.push("QISHUI_OAUTH_REDIRECT_URI(https)");
        return {
          configured: missing.length === 0,
          clientKey,
          clientSecret,
          redirectUri,
          scope,
          authUrl: QISHUI_OAUTH_AUTH_URL,
          tokenUrl: QISHUI_OAUTH_TOKEN_URL,
          missing,
          configFile: fileConfig.file || "",
          configSource: fileConfig.source || (clientKey || clientSecret || redirectUri ? "env" : "")
        };
      }
      function qishuiOAuthConfigError(config) {
        const err = new Error("QISHUI_OAUTH_NOT_CONFIGURED");
        err.code = "QISHUI_OAUTH_NOT_CONFIGURED";
        err.missing = config && config.missing || [];
        err.message = "QISHUI_OAUTH_NOT_CONFIGURED: " + err.missing.join(", ");
        return err;
      }
      function buildQishuiOAuthAuthorizeUrl(state) {
        const config = getQishuiOAuthConfig();
        if (!config.configured) throw qishuiOAuthConfigError(config);
        const url = new URL(config.authUrl);
        url.searchParams.set("client_key", config.clientKey);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("scope", config.scope);
        url.searchParams.set("redirect_uri", config.redirectUri);
        if (state) url.searchParams.set("state", state);
        return url.toString();
      }
      function createTtlCache(maxEntries, defaultTtlMs) {
        const store = /* @__PURE__ */ new Map();
        const inflight = /* @__PURE__ */ new Map();
        return {
          get(key) {
            const hit = store.get(key);
            if (!hit || Date.now() - hit.at > hit.ttl) return null;
            return hit.value;
          },
          set(key, value, ttlMs) {
            store.set(key, { at: Date.now(), ttl: ttlMs || defaultTtlMs, value });
            if (store.size > maxEntries) {
              const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
              if (oldest) store.delete(oldest[0]);
            }
          },
          clear() {
            store.clear();
            inflight.clear();
          },
          async wrap(key, ttlMs, fn) {
            const cached = this.get(key);
            if (cached !== null) return cached;
            if (inflight.has(key)) return inflight.get(key);
            const promise = Promise.resolve().then(fn).then((value) => {
              const resolvedTtlMs = typeof ttlMs === "function" ? ttlMs(value) : ttlMs;
              this.set(key, value, resolvedTtlMs);
              return value;
            }).finally(() => inflight.delete(key));
            inflight.set(key, promise);
            return promise;
          }
        };
      }
      var qishuiSearchCache = createTtlCache(80, 2 * 60 * 1e3);
      var qishuiLyricCache = createTtlCache(240, 30 * 60 * 1e3);
      var qishuiPublicDetailCache = createTtlCache(240, 30 * 60 * 1e3);
      var qishuiFeedCache = createTtlCache(16, 90 * 1e3);
      var qishuiWebLibraryCache = createTtlCache(24, 90 * 1e3);
      var qishuiWebPlaylistCache = createTtlCache(48, 90 * 1e3);
      var qishuiWebPlaylistCursorCache = /* @__PURE__ */ new Map();
      var qishuiMembershipCache = createTtlCache(24, 60 * 1e3);
      var qishuiMembershipPositiveHistory = /* @__PURE__ */ new Map();
      var QISHUI_MEMBERSHIP_POSITIVE_CACHE_MS = 10 * 1e3;
      var QISHUI_MEMBERSHIP_POSITIVE_GRACE_MS = 20 * 1e3;
      var qishuiTrackMetadataCache = createTtlCache(120, 20 * 1e3);
      var qishuiPlaybackCache = createTtlCache(120, 4 * 60 * 1e3);
      var qishuiOfficialBridge = null;
      var qishuiOfficialBridgeLoaded = false;
      function getQishuiOfficialBridge() {
        if (qishuiOfficialBridgeLoaded) return qishuiOfficialBridge;
        qishuiOfficialBridgeLoaded = true;
        try {
          const bridge = require_qishui_official_stub();
          if (bridge && typeof bridge.requestOfficial === "function") qishuiOfficialBridge = bridge;
        } catch (_) {
        }
        return qishuiOfficialBridge;
      }
      function requestText(targetUrl, opts, body) {
        opts = opts || {};
        return new Promise((resolve2, reject) => {
          const u = new URL(targetUrl);
          const lib = u.protocol === "https:" ? https : http;
          const req = lib.request(u, {
            method: opts.method || "GET",
            headers: opts.headers || {}
          }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => {
              const text5 = buffer_default.concat(chunks).toString("utf8");
              if (response.statusCode >= 400) {
                const err = new Error("HTTP " + response.statusCode);
                err.statusCode = response.statusCode;
                err.body = text5;
                reject(err);
                return;
              }
              resolve2(text5);
            });
          });
          req.setTimeout(Number(opts.timeoutMs) || 7e3, () => req.destroy(new Error("Request timeout")));
          req.on("error", reject);
          if (body) req.write(body);
          req.end();
        });
      }
      async function requestJson(targetUrl, opts, body) {
        const text5 = await requestText(targetUrl, opts, body);
        try {
          return JSON.parse(text5);
        } catch (e) {
          const err = new Error("Invalid JSON from Qishui OpenAPI");
          err.cause = e;
          err.body = text5;
          throw err;
        }
      }
      function urlWithParams(baseUrl, params) {
        const u = new URL(baseUrl);
        Object.keys(params || {}).forEach((key) => {
          const value = params[key];
          if (value == null || value === "") return;
          u.searchParams.set(key, String(value));
        });
        return u.toString();
      }
      function qishuiSessionCookieHeader(cookieText) {
        const normalized = normalizeQishuiCookieInput(cookieText);
        const obj = qishuiCookieObject(normalized);
        if (qishuiCookieHasLogin(normalized)) return normalized;
        const sessionid = normalizeText(obj.sessionid || obj.sessionid_ss || "");
        return sessionid ? "sessionid=" + sessionid + ";" : normalized;
      }
      function qishuiHeadersWithCookie(headers, cookieText) {
        const out = Object.assign({}, headers || {});
        const cookie = normalizeQishuiCookieInput(cookieText);
        if (cookie) out.Cookie = cookie;
        return out;
      }
      function qishuiPcStatusError(payload, fallback) {
        if (!payload || typeof payload !== "object") return null;
        const code = Number(payload.status_code == null ? payload.error_code : payload.status_code);
        if (!isFinite(code) || code === 0) return null;
        const info = payload.status_info || {};
        const message = normalizeText(info.status_msg || payload.message || payload.status_msg || fallback || "QISHUI_PC_API_ERROR");
        const err = new Error(message || "QISHUI_PC_API_ERROR");
        err.code = "QISHUI_PC_API_" + code;
        err.statusCode = code;
        err.body = payload;
        return err;
      }
      function qishuiTokenFile() {
        return __foliaProcessEnv.QISHUI_TOKEN_FILE || DEFAULT_QISHUI_TOKEN_FILE;
      }
      function normalizeQishuiToken(value) {
        let token = String(value || "").trim();
        token = token.replace(/^bearer\s+/i, "").trim();
        const headerMatch = token.match(/(?:access-token|access_token)\s*[:=]\s*([^;\s]+)/i);
        if (headerMatch) token = headerMatch[1].trim();
        return token;
      }
      var QISHUI_COOKIE_ATTRIBUTE_NAMES = /* @__PURE__ */ new Set(["path", "domain", "expires", "max-age", "samesite", "secure", "httponly"]);
      function collectQishuiCookiePair(picked, key, value) {
        key = String(key || "").trim();
        if (!key || QISHUI_COOKIE_ATTRIBUTE_NAMES.has(key.toLowerCase())) return;
        if (value === null || value === void 0) return;
        picked.set(key, String(value).trim());
      }
      function collectQishuiCookieInput(input, picked) {
        if (input === null || input === void 0) return;
        if (Array.isArray(input)) {
          input.forEach((item) => collectQishuiCookieInput(item, picked));
          return;
        }
        if (typeof input === "object") {
          if (input.name && Object.prototype.hasOwnProperty.call(input, "value")) {
            collectQishuiCookiePair(picked, input.name, input.value);
            return;
          }
          Object.keys(input).forEach((key) => {
            const value = input[key];
            if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "value")) {
              collectQishuiCookiePair(picked, key, value.value);
            } else if (typeof value !== "object") {
              collectQishuiCookiePair(picked, key, value);
            }
          });
          return;
        }
        String(input).split(/\r?\n/).forEach((line) => {
          line.split(";").forEach((part) => {
            const raw = String(part || "").trim();
            const idx = raw.indexOf("=");
            if (idx <= 0) return;
            collectQishuiCookiePair(picked, raw.slice(0, idx), raw.slice(idx + 1));
          });
        });
      }
      function normalizeQishuiCookieInput(input) {
        const picked = /* @__PURE__ */ new Map();
        collectQishuiCookieInput(input, picked);
        return Array.from(picked.entries()).filter(([key, value]) => key && value != null && String(value) !== "").map(([key, value]) => `${key}=${value}`).join("; ");
      }
      function qishuiCookieObject(cookieText) {
        const out = {};
        String(cookieText || "").split(";").forEach((part) => {
          const idx = part.indexOf("=");
          if (idx <= 0) return;
          const key = part.slice(0, idx).trim();
          const value = part.slice(idx + 1).trim();
          if (key) out[key] = value;
        });
        return out;
      }
      function qishuiCookieHasLogin(cookieText) {
        return /(?:^|;\s*)(sessionid|sessionid_ss|sid_guard|sid_tt|uid_tt|uid_tt_ss)=/i.test(String(cookieText || ""));
      }
      function qishuiCookieFingerprint(cookieText) {
        const normalized = normalizeQishuiCookieInput(cookieText);
        return crypto.createHash("sha1").update(normalized).digest("hex").slice(0, 16);
      }
      function qishuiCookieUserId(cookieText) {
        const obj = qishuiCookieObject(cookieText);
        const raw = String(obj.uid_tt || obj.uid_tt_ss || obj.sessionid || obj.sessionid_ss || obj.sid_guard || "").trim();
        if (!raw) return "";
        return "web:" + crypto.createHash("sha1").update(raw).digest("hex").slice(0, 12);
      }
      function clearQishuiRuntimeCaches() {
        qishuiSearchCache.clear && qishuiSearchCache.clear();
        qishuiFeedCache.clear && qishuiFeedCache.clear();
        qishuiWebLibraryCache.clear && qishuiWebLibraryCache.clear();
        qishuiWebPlaylistCache.clear && qishuiWebPlaylistCache.clear();
        qishuiWebPlaylistCursorCache.clear();
        qishuiMembershipCache.clear && qishuiMembershipCache.clear();
        qishuiMembershipPositiveHistory.clear();
        qishuiTrackMetadataCache.clear && qishuiTrackMetadataCache.clear();
        qishuiPlaybackCache.clear && qishuiPlaybackCache.clear();
      }
      function qishuiAccessTokenInfo() {
        const envKeys = ["QISHUI_ACCESS_TOKEN", "DOUYIN_ACCESS_TOKEN", "DOUYIN_OPEN_ACCESS_TOKEN"];
        for (const key of envKeys) {
          const token = normalizeQishuiToken(__foliaProcessEnv[key] || "");
          if (token) return { token, source: "env:" + key, file: qishuiTokenFile() };
        }
        const file = qishuiTokenFile();
        try {
          if (fs.existsSync(file)) {
            const token = normalizeQishuiToken(fs.readFileSync(file, "utf8"));
            if (token) return { token, source: "file", file };
          }
        } catch (_) {
        }
        return { token: "", source: "", file };
      }
      function qishuiAccessToken() {
        return qishuiAccessTokenInfo().token;
      }
      function saveQishuiAccessToken(value) {
        const token = normalizeQishuiToken(value);
        if (!token || token.length < 10) {
          const err = new Error("INVALID_QISHUI_TOKEN");
          err.code = "INVALID_QISHUI_TOKEN";
          throw err;
        }
        const file = qishuiTokenFile();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, token, "utf8");
        clearQishuiRuntimeCaches();
        return { ...getQishuiStatus(), saved: true };
      }
      function clearQishuiAccessToken() {
        const file = qishuiTokenFile();
        try {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch (_) {
        }
        clearQishuiRuntimeCaches();
        return { ...getQishuiStatus(), ok: true };
      }
      async function exchangeQishuiOAuthCode(code) {
        code = normalizeText(code);
        if (!code) {
          const err = new Error("QISHUI_OAUTH_CODE_REQUIRED");
          err.code = "QISHUI_OAUTH_CODE_REQUIRED";
          throw err;
        }
        const config = getQishuiOAuthConfig();
        if (!config.configured) throw qishuiOAuthConfigError(config);
        const body = new URLSearchParams();
        body.set("client_key", config.clientKey);
        body.set("client_secret", config.clientSecret);
        body.set("code", code);
        body.set("grant_type", "authorization_code");
        const bodyText = body.toString();
        const json = await requestJson(config.tokenUrl, {
          method: "POST",
          timeoutMs: 1e4,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": buffer_default.byteLength(bodyText),
            "User-Agent": QISHUI_UA2
          }
        }, bodyText);
        const data = json && json.data || json || {};
        const errCode = Number(data.error_code || data.err_code || json.error_code || json.err_code || 0);
        if (errCode) {
          const err = new Error(String(data.description || data.message || json.description || json.message || "QISHUI_OAUTH_TOKEN_ERROR"));
          err.code = errCode;
          err.body = json;
          throw err;
        }
        const token = normalizeQishuiToken(data.access_token || json.access_token || "");
        if (!token) {
          const err = new Error("QISHUI_OAUTH_TOKEN_MISSING");
          err.code = "QISHUI_OAUTH_TOKEN_MISSING";
          err.body = json;
          throw err;
        }
        const status = saveQishuiAccessToken(token);
        return {
          ...status,
          oauth: true,
          openId: data.open_id || data.openid || "",
          scope: data.scope || status.scope,
          expiresIn: data.expires_in || 0,
          refreshExpiresIn: data.refresh_expires_in || 0
        };
      }
      function qishuiRestriction(category, message, action, extra) {
        return {
          provider: "qishui",
          category,
          action: action || "",
          message,
          ...extra || {}
        };
      }
      function qishuiUnavailable(message, category, extra) {
        const restriction = qishuiRestriction(
          category || "provider_limited",
          message || "汽水音乐开放平台当前没有公开可交给播放器直连的音频 URL，已按匹配源处理。",
          "switch_source",
          { playbackMode: "recommend-match", scope: QISHUI_SCOPE }
        );
        return Object.assign({
          provider: "qishui",
          playbackMode: "recommend-match",
          url: "",
          playable: false,
          trial: false,
          loggedIn: !!qishuiAccessToken(),
          playbackKeyReady: false,
          restriction,
          reason: restriction.category,
          message: restriction.message
        }, extra || {});
      }
      function getQishuiStatus(cookieText) {
        const tokenInfo = qishuiAccessTokenInfo();
        const tokenConfigured = !!tokenInfo.token;
        const cookie = normalizeQishuiCookieInput(cookieText);
        const webSession = qishuiCookieHasLogin(cookie);
        const configured = tokenConfigured || webSession;
        const oauthConfig = getQishuiOAuthConfig();
        return {
          provider: "qishui",
          label: "汽水音乐",
          short: "QS",
          configured,
          tokenConfigured,
          webSession,
          cookieReady: webSession,
          // Only an authenticated Passport Web session is an account login.
          // A legacy OpenAPI token may still power catalogue/recommendation calls,
          // but must never bypass the official QR login or impersonate a user.
          loggedIn: webSession,
          playbackMode: webSession ? "direct-url" : "recommend-match",
          scope: QISHUI_SCOPE,
          userId: webSession ? qishuiCookieUserId(cookie) : "",
          nickname: webSession ? "汽水音乐账号" : "",
          vipType: 0,
          vipLevel: "none",
          isVip: false,
          isSvip: false,
          vipLabel: "无VIP",
          membershipKnown: false,
          tokenFile: tokenInfo.file,
          tokenSource: tokenInfo.source,
          oauthConfigured: oauthConfig.configured,
          oauthMissing: oauthConfig.missing,
          oauthScope: oauthConfig.scope,
          oauthConfigSource: oauthConfig.configSource,
          // Legacy quick-check guard: search: configured || QISHUI_PUBLIC_ENABLED.
          capabilities: {
            search: tokenConfigured || webSession || QISHUI_PUBLIC_ENABLED,
            relatedMedia: tokenConfigured,
            feedSongTab: tokenConfigured || webSession,
            lyric: true,
            playableUrl: webSession,
            login: true,
            webOAuth: oauthConfig.configured,
            userPlaylists: configured,
            playlistTracks: configured,
            webSession
          },
          message: webSession ? "汽水音乐官方扫码登录已连接，可同步歌单与我的喜欢，并按账号权益播放。" : tokenConfigured ? "已有旧版开放平台目录授权；账号功能仍需完成官方扫码登录。" : QISHUI_PUBLIC_ENABLED ? "请使用汽水音乐 App 扫描 Folia 中的汽水官方二维码；未登录时仅保留公开搜索匹配。" : "请使用汽水音乐 App 扫描 Folia 中的汽水官方二维码完成登录。"
        };
      }
      function qishuiUrl(apiPath) {
        return QISHUI_API_BASE + apiPath;
      }
      async function qishuiPost(apiPath, payload) {
        const token = qishuiAccessToken();
        if (!token) {
          const err = new Error("QISHUI_TOKEN_REQUIRED");
          err.code = "QISHUI_TOKEN_REQUIRED";
          throw err;
        }
        const body = JSON.stringify(payload || {});
        const json = await requestJson(qishuiUrl(apiPath), {
          method: "POST",
          timeoutMs: 7e3,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": buffer_default.byteLength(body),
            "User-Agent": QISHUI_UA2,
            "access-token": token
          }
        }, body);
        const errCode = Number(json && json.data && (json.data.error_code || json.data.err_code || json.data.code) || json && (json.error_code || json.err_code || json.code) || 0);
        if (errCode) {
          const err = new Error(String(json && json.data && (json.data.description || json.data.message) || json.description || json.message || "QISHUI_API_ERROR"));
          err.code = errCode;
          err.body = json;
          throw err;
        }
        return json;
      }
      function normalizeText(value) {
        return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
      }
      function normalizeLyricBody(value) {
        return String(value == null ? "" : value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
      }
      function qishuiLyricTimestamp(ms) {
        ms = Math.max(0, Number(ms) || 0);
        const minutes = Math.floor(ms / 6e4);
        const seconds = Math.floor(ms % 6e4 / 1e3);
        const centiseconds = Math.floor(ms % 1e3 / 10);
        return "[" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0") + "." + String(centiseconds).padStart(2, "0") + "]";
      }
      function qishuiConvertLyric(value) {
        const input = normalizeLyricBody(value);
        if (!input) return { lyric: "", yrc: "" };
        const lrcLines = [];
        const yrcLines = [];
        let converted = false;
        input.split("\n").forEach((rawLine) => {
          const line = String(rawLine || "").trim();
          const timed = line.match(/^\[(\d+),(\d+)\](.*)$/);
          if (!timed) return;
          const lineStart = Math.max(0, Number(timed[1]) || 0);
          const lineDuration = Math.max(0, Number(timed[2]) || 0);
          const body = timed[3] || "";
          const wordPattern = /([<(])(\d+),(\d+),(\d+)[>)]([^<(]*)/g;
          let wordMatch;
          let text5 = "";
          let yrcBody = "";
          while (wordMatch = wordPattern.exec(body)) {
            const rawStart = Math.max(0, Number(wordMatch[2]) || 0);
            const wordDuration = Math.max(0, Number(wordMatch[3]) || 0);
            const wordText = String(wordMatch[5] || "");
            if (!wordText) continue;
            const absoluteStart = wordMatch[1] === "<" ? lineStart + rawStart : rawStart >= Math.max(0, lineStart - 500) ? rawStart : lineStart + rawStart;
            text5 += wordText;
            yrcBody += "(" + absoluteStart + "," + wordDuration + "," + (Number(wordMatch[4]) || 0) + ")" + wordText;
          }
          if (!text5) text5 = body.replace(/[<(]\d+,\d+,\d+[>)]/g, "");
          text5 = text5.replace(/\s+/g, " ").trim();
          if (!text5) return;
          converted = true;
          lrcLines.push(qishuiLyricTimestamp(lineStart) + text5);
          yrcLines.push("[" + lineStart + "," + lineDuration + "]" + (yrcBody || text5));
        });
        if (!converted) return { lyric: input, yrc: "" };
        return {
          lyric: lrcLines.join("\n"),
          yrc: yrcLines.join("\n")
        };
      }
      function firstUrl(value) {
        if (!value) return "";
        if (typeof value === "string") return value;
        if (Array.isArray(value)) return value.map(firstUrl).find(Boolean) || "";
        if (typeof value === "object") {
          return firstUrl(value.url_list || value.urls || value.url || value.uri || value.main_url || value.cover_url || value.download_url);
        }
        return "";
      }
      function qishuiImageUrl(value, suffix) {
        if (!value) return "";
        if (typeof value === "string") {
          const text5 = normalizeText(value);
          if (!/^https?:\/\//i.test(text5)) return "";
          return suffix && !text5.includes("~") ? text5 + suffix : text5;
        }
        if (Array.isArray(value)) return value.map((item) => qishuiImageUrl(item, suffix)).find(Boolean) || "";
        if (typeof value !== "object") return "";
        const cover = normalizeText(firstUrl(value.urls || value.url_list || value.urlList || value.url || value.main_url || value.cover_url || value.image_url || ""));
        const uri = normalizeText(value.uri || value.url_key || value.image_uri || value.cover_uri || "");
        let out = cover;
        if (out && uri && !out.includes(uri)) out += uri;
        if (!out && /^https?:\/\//i.test(uri)) out = uri;
        if (!/^https?:\/\//i.test(out)) return "";
        return suffix && !out.includes("~") ? out + suffix : out;
      }
      function qishuiFirstImageUrl(suffix) {
        for (let i = 1; i < arguments.length; i++) {
          const url = qishuiImageUrl(arguments[i], suffix);
          if (url) return url;
        }
        return "";
      }
      function pickObject() {
        for (let i = 0; i < arguments.length; i++) {
          const value = arguments[i];
          if (value && typeof value === "object" && !Array.isArray(value)) return value;
        }
        return {};
      }
      function qishuiProfileFromUser(user) {
        user = user && typeof user === "object" ? user : {};
        const nickname = normalizeText(
          user.nickname || user.nick_name || user.nickName || user.display_name || user.displayName || user.name || user.public_name || user.publicName || user.douyin_id || ""
        );
        const userId = normalizeText(
          user.id || user.user_id || user.userId || user.uid || user.sec_uid || user.secUid || user.open_id || ""
        );
        const avatar = qishuiFirstImageUrl(
          "~c5_300x300.jpg",
          user.larger_avatar_url,
          user.medium_avatar_url,
          user.avatar_url,
          user.avatarUrl,
          user.avatar,
          user.user_avatar,
          user.pic,
          user.icon
        );
        return {
          userId,
          nickname,
          avatar,
          douyinId: normalizeText(user.douyin_id || user.unique_id || user.short_id || ""),
          profileReady: !!(userId || nickname || avatar)
        };
      }
      var QISHUI_VIP_NUMBER_KEYS = /* @__PURE__ */ new Set([
        "viptype",
        "viplevel",
        "membertype",
        "memberlevel",
        "musicviptype",
        "musicviplevel"
      ]);
      var QISHUI_SVIP_NUMBER_KEYS = /* @__PURE__ */ new Set([
        "sviptype",
        "sviplevel",
        "superviptype",
        "superviplevel"
      ]);
      var QISHUI_VIP_FLAG_KEYS = /* @__PURE__ */ new Set([
        "isvip",
        "ismember",
        "hasvip",
        "hasmembership",
        "vipactive",
        "vipenabled"
      ]);
      var QISHUI_SVIP_FLAG_KEYS = /* @__PURE__ */ new Set([
        "issvip",
        "issupervip",
        "hassvip",
        "hassupervip",
        "svipactive",
        "svipenabled"
      ]);
      var QISHUI_MEMBERSHIP_LABEL_KEYS = /* @__PURE__ */ new Set([
        "viplevelname",
        "vipname",
        "memberlevelname",
        "membername",
        "membershiplevel",
        "membershiptype",
        // 汽水 web /luna/pc/me 用 vip_stage 表示会员档位：vip=会员、svip=超级会员。
        // 实测真实 SVIP 账号该字段返回 "svip"，此前未被识别导致档位锁死、面板只显示 VIP。
        "vipstage"
      ]);
      var QISHUI_VIP_CONTAINER_KEYS = /* @__PURE__ */ new Set([
        "vipinfo",
        "vipdetail",
        "vipbenefit",
        "vippackage",
        "memberinfo",
        "memberdetail",
        "memberbenefit",
        "memberpackage",
        "membershipinfo",
        "membershipdetail"
      ]);
      var QISHUI_SVIP_CONTAINER_KEYS = /* @__PURE__ */ new Set([
        "svipinfo",
        "svipdetail",
        "svipbenefit",
        "svippackage",
        "supervipinfo",
        "supervipdetail",
        "supervipbenefit",
        "supervippackage"
      ]);
      var QISHUI_MEMBERSHIP_STATUS_KEYS = /* @__PURE__ */ new Set([
        "status",
        "state",
        "active",
        "valid",
        "enabled",
        "isactive",
        "isvalid",
        "isenabled"
      ]);
      var QISHUI_MEMBERSHIP_GENERIC_EXPIRY_KEYS = /* @__PURE__ */ new Set([
        "expiretime",
        "expiresat",
        "expirationtime",
        "expiredat",
        "endtime",
        "validuntil"
      ]);
      var QISHUI_VIP_EXPIRY_KEYS = /* @__PURE__ */ new Set([
        "vipexpiretime",
        "vipexpiresat",
        "vipexpiredat",
        "vipendtime",
        "memberexpiretime",
        "memberexpiresat",
        "memberexpiredat",
        "memberendtime"
      ]);
      var QISHUI_SVIP_EXPIRY_KEYS = /* @__PURE__ */ new Set([
        "svipexpiretime",
        "svipexpiresat",
        "svipexpiredat",
        "svipendtime"
      ]);
      function qishuiNormalizedFieldKey(value) {
        return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
      }
      function qishuiExplicitPositive(value) {
        if (value === true) return true;
        if (typeof value === "number") return Number.isFinite(value) && value > 0;
        const text5 = normalizeText(value).toLowerCase();
        if (!text5) return false;
        if (/^\d+(?:\.\d+)?$/.test(text5)) return Number(text5) > 0;
        return /^(true|yes|active|valid|enabled|opened|vip|svip|premium|member|会员|已开通|有效)$/.test(text5);
      }
      function qishuiExplicitNegative(value) {
        if (value === false || value === null) return true;
        if (typeof value === "number") return Number.isFinite(value) && value <= 0;
        const text5 = normalizeText(value).toLowerCase();
        if (!text5) return false;
        if (/^\d+(?:\.\d+)?$/.test(text5)) return Number(text5) <= 0;
        return /^(false|no|inactive|invalid|disabled|closed|expired|none|free|normal|ordinary|非会员|普通用户|未开通|无vip|已过期|过期)$/.test(text5);
      }
      function qishuiMembershipLevelValue(value) {
        const text5 = normalizeText(value).toLowerCase().replace(/[\s_-]+/g, "");
        if (/^(svip|supervip|超级会员|超级vip|豪华会员)$/.test(text5)) return "svip";
        if (/^(vip|premium|member|会员|普通会员)$/.test(text5)) return "vip";
        if (/^(none|free|normal|ordinary|novip|非会员|普通用户|未开通|无vip|已过期|过期)$/.test(text5)) return "none";
        return "";
      }
      function qishuiMembershipExpiryMillis(value) {
        if (value === null || value === void 0 || value === "") return 0;
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) {
          return number < 1e11 ? number * 1e3 : number;
        }
        const parsed = Date.parse(String(value));
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      }
      function qishuiMembershipObjectState(value, level) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return { known: false, active: null, expiresAt: 0 };
        }
        let known = false;
        let statusPositive = false;
        let statusNegative = false;
        let genericExpiryKnown = false;
        let genericExpiryExpired = false;
        let genericFutureExpiry = 0;
        let levelExpiryKnown = false;
        let levelExpiryExpired = false;
        let levelFutureExpiry = 0;
        const levelExpiryKeys = level === "svip" ? QISHUI_SVIP_EXPIRY_KEYS : level === "vip" ? QISHUI_VIP_EXPIRY_KEYS : null;
        for (const [key, item] of Object.entries(value)) {
          const normalizedKey = qishuiNormalizedFieldKey(key);
          const isGenericExpiry = QISHUI_MEMBERSHIP_GENERIC_EXPIRY_KEYS.has(normalizedKey);
          const isLevelExpiry = levelExpiryKeys ? levelExpiryKeys.has(normalizedKey) : QISHUI_VIP_EXPIRY_KEYS.has(normalizedKey) || QISHUI_SVIP_EXPIRY_KEYS.has(normalizedKey);
          if (isGenericExpiry || isLevelExpiry) {
            const expiresAt = qishuiMembershipExpiryMillis(item);
            const isKnownExpiry = expiresAt > 0 || item !== "" && item !== null && item !== void 0 && Number.isFinite(Number(item)) && Number(item) <= 0;
            if (!isKnownExpiry) continue;
            known = true;
            if (isLevelExpiry) {
              levelExpiryKnown = true;
              if (expiresAt > Date.now()) {
                levelFutureExpiry = Math.max(levelFutureExpiry, expiresAt);
              } else {
                levelExpiryExpired = true;
              }
            } else {
              genericExpiryKnown = true;
              if (expiresAt > Date.now()) {
                genericFutureExpiry = Math.max(genericFutureExpiry, expiresAt);
              } else {
                genericExpiryExpired = true;
              }
            }
            continue;
          }
          if (!QISHUI_MEMBERSHIP_STATUS_KEYS.has(normalizedKey)) continue;
          if (qishuiExplicitNegative(item)) {
            known = true;
            statusNegative = true;
          } else if (qishuiExplicitPositive(item)) {
            known = true;
            statusPositive = true;
          }
        }
        const expiryKnown = levelExpiryKnown || genericExpiryKnown;
        const expiryExpired = levelExpiryKnown ? levelExpiryExpired : genericExpiryExpired;
        const futureExpiry = levelExpiryKnown ? levelFutureExpiry : genericFutureExpiry;
        const active = statusNegative || expiryExpired ? false : futureExpiry > 0 || !expiryKnown && statusPositive ? true : expiryKnown ? false : null;
        return {
          known,
          active,
          expiresAt: active === true ? futureExpiry : 0
        };
      }
      function qishuiMembershipFromData(value) {
        value = value && typeof value === "object" ? value : {};
        let membershipKnown = false;
        let isVip = false;
        let isSvip = false;
        let vipType = 0;
        let svipType = 0;
        let vipExpiresAt = 0;
        let svipExpiresAt = 0;
        let visited = 0;
        const rememberExpiry = (level, expiresAt) => {
          expiresAt = Number(expiresAt) || 0;
          if (expiresAt <= Date.now()) return;
          if (level === "svip") {
            if (!svipExpiresAt || expiresAt < svipExpiresAt) svipExpiresAt = expiresAt;
            return;
          }
          if (level === "vip" && (!vipExpiresAt || expiresAt < vipExpiresAt)) vipExpiresAt = expiresAt;
        };
        const applyLevel = (level, numericValue, active, expiresAt) => {
          if (active === false || !level) return;
          if (level === "svip") {
            isSvip = true;
            isVip = true;
            svipType = Math.max(svipType, Number(numericValue) || 1);
            rememberExpiry("svip", expiresAt);
            return;
          }
          if (level === "vip") {
            isVip = true;
            vipType = Math.max(vipType, Number(numericValue) || 1);
            rememberExpiry("vip", expiresAt);
          }
        };
        const visit = (node, depth) => {
          if (!node || typeof node !== "object" || depth > 6 || visited > 600) return;
          visited += 1;
          if (Array.isArray(node)) {
            node.slice(0, 120).forEach((item) => visit(item, depth + 1));
            return;
          }
          const vipObjectState = qishuiMembershipObjectState(node, "vip");
          const svipObjectState = qishuiMembershipObjectState(node, "svip");
          for (const [key, item] of Object.entries(node).slice(0, 160)) {
            const normalizedKey = qishuiNormalizedFieldKey(key);
            if (QISHUI_SVIP_NUMBER_KEYS.has(normalizedKey)) {
              membershipKnown = true;
              const number = Number(item);
              if (Number.isFinite(number) && number > 0) applyLevel("svip", number, svipObjectState.active, svipObjectState.expiresAt);
            } else if (QISHUI_VIP_NUMBER_KEYS.has(normalizedKey)) {
              membershipKnown = true;
              const number = Number(item);
              if (Number.isFinite(number) && number > 0) applyLevel("vip", number, vipObjectState.active, vipObjectState.expiresAt);
            } else if (QISHUI_SVIP_FLAG_KEYS.has(normalizedKey)) {
              membershipKnown = true;
              if (qishuiExplicitPositive(item)) applyLevel("svip", 1, svipObjectState.active, svipObjectState.expiresAt);
            } else if (QISHUI_VIP_FLAG_KEYS.has(normalizedKey)) {
              membershipKnown = true;
              if (qishuiExplicitPositive(item)) applyLevel("vip", 1, vipObjectState.active, vipObjectState.expiresAt);
            } else if (QISHUI_MEMBERSHIP_LABEL_KEYS.has(normalizedKey)) {
              membershipKnown = true;
              const level = qishuiMembershipLevelValue(item);
              const state = level === "svip" ? svipObjectState : vipObjectState;
              applyLevel(level, 1, state.active, state.expiresAt);
            } else if (QISHUI_SVIP_CONTAINER_KEYS.has(normalizedKey) || QISHUI_VIP_CONTAINER_KEYS.has(normalizedKey)) {
              membershipKnown = true;
              const level = QISHUI_SVIP_CONTAINER_KEYS.has(normalizedKey) ? "svip" : "vip";
              const state = qishuiMembershipObjectState(item, level);
              if (state.active === true) {
                applyLevel(
                  level,
                  1,
                  true,
                  state.expiresAt
                );
              }
            }
            if (item && typeof item === "object") visit(item, depth + 1);
          }
        };
        visit(value, 0);
        if (isSvip) isVip = true;
        const vipLevel = isSvip ? "svip" : isVip ? "vip" : "none";
        const activeExpiries = [vipExpiresAt, svipExpiresAt].filter((item) => item > Date.now());
        return {
          membershipKnown,
          vipType: isSvip ? svipType : vipType,
          vipLevel,
          isVip,
          isSvip,
          vipLabel: vipLevel === "svip" ? "SVIP" : vipLevel === "vip" ? "VIP" : "无VIP",
          expiresAt: activeExpiries.length ? Math.min(...activeExpiries) : 0
        };
      }
      function qishuiPlaybackMembershipFromPayload(payload) {
        const data = payload && payload.data || payload || {};
        const trustedCandidates = [
          data.user_membership,
          data.userMembership,
          data.account_membership,
          data.accountMembership,
          data.user && data.user.membership,
          data.account && data.account.membership,
          data.me && data.me.membership
        ].filter((item) => item && typeof item === "object");
        if (trustedCandidates.length) {
          const trusted = qishuiMembershipFromData({ membership_sources: trustedCandidates });
          if (trusted.membershipKnown) return trusted;
        }
        const ambiguousCandidates = [
          data.membership,
          data.membership_info,
          data.membershipInfo
        ].filter((item) => item && typeof item === "object");
        void ambiguousCandidates;
        return {
          membershipKnown: false,
          vipType: 0,
          vipLevel: "none",
          isVip: false,
          isSvip: false,
          vipLabel: "无VIP",
          expiresAt: 0
        };
      }
      function qishuiProfileFromMeData(meData) {
        const data = meData && meData.data || meData || {};
        const user = pickObject(data.my_info, data.myInfo, data.user, data.user_info, data.userInfo, data.account, data.me, data);
        const profile = qishuiProfileFromUser(user);
        if (!profile.userId) {
          profile.userId = normalizeText(data.user_id || data.userId || data.uid || data.id || "");
        }
        if (!profile.nickname) {
          profile.nickname = normalizeText(data.nickname || data.nick_name || data.name || data.douyin_id || "");
        }
        if (!profile.avatar) {
          profile.avatar = qishuiFirstImageUrl(
            "~c5_300x300.jpg",
            data.larger_avatar_url,
            data.medium_avatar_url,
            data.avatar_url,
            data.avatar,
            data.pic
          );
        }
        Object.assign(profile, qishuiMembershipFromData(data));
        profile.profileReady = !!(profile.userId || profile.nickname || profile.avatar);
        return profile;
      }
      function pickArray() {
        for (let i = 0; i < arguments.length; i++) {
          const value = arguments[i];
          if (Array.isArray(value)) return value;
        }
        return [];
      }
      function qishuiObjectString(obj, keys) {
        obj = obj && typeof obj === "object" ? obj : {};
        for (const key of keys || []) {
          const value = obj[key];
          if (value === null || value === void 0) continue;
          if (Array.isArray(value)) {
            const text5 = value.map((item) => normalizeText(item)).find(Boolean);
            if (text5) return text5;
            continue;
          }
          if (typeof value !== "object") {
            const text5 = normalizeText(value);
            if (text5) return text5;
          }
        }
        return "";
      }
      function qishuiObjectNumber(obj, keys) {
        const text5 = qishuiObjectString(obj, keys);
        const num = Number(text5);
        return Number.isFinite(num) ? num : 0;
      }
      function qishuiNormalizeDurationSeconds(value) {
        const num = Number(value) || 0;
        if (!num) return 0;
        return num > 1e3 ? Math.round(num / 1e3) : Math.round(num);
      }
      function qishuiNormalizeBitrateKbps(value) {
        const num = Number(value) || 0;
        if (!num) return 0;
        return num > 1e3 ? Math.round(num / 1e3) : Math.round(num);
      }
      function qishuiBitrateForUi(value) {
        const kbps = qishuiNormalizeBitrateKbps(value);
        return kbps > 0 ? kbps * 1e3 : 0;
      }
      function qishuiQualityRank(quality, format, bitrate) {
        const q = normalizeText(quality).toLowerCase().replace(/[-_\s]/g, "");
        const f = normalizeText(format).toLowerCase();
        const br = qishuiNormalizeBitrateKbps(bitrate);
        const losslessFormat = /flac|alac|wav/.test(f);
        const losslessLabel = /lossless|flac|sq|svip/.test(q);
        const hiresLabel = /hires|master/.test(q);
        if (hiresLabel && (losslessFormat || br >= 900)) return 110;
        if (losslessLabel || losslessFormat || br >= 900) return 100;
        if (hiresLabel) return 90;
        if (/atmos|dolby|spatial/.test(q)) return 88;
        if (/higher|high|320/.test(q) || br >= 320) return 70;
        if (/standard|medium|normal|128/.test(q) || br >= 128) return 50;
        if (/low|preview/.test(q)) return 10;
        return br > 0 ? 20 : 0;
      }
      function qishuiNormalizeAppQuality(q) {
        q = normalizeText(q || "").toLowerCase().replace(/[-_\s]/g, "");
        if (/^standard|medium|normal|std|128|higher/.test(q)) return "standard";
        if (/^exhigh|high|hq|320|highest|excellent|superhigh/.test(q)) return "exhigh";
        if (/^lossless|flac|sq/.test(q)) return "lossless";
        if (/^hires|hi-res|highres|master/.test(q)) return "hires";
        if (/^spatial|atmos|dolby|immersive/.test(q)) return "atmos";
        return "standard";
      }
      function qishuiStreamAppTier(stream) {
        stream = stream && typeof stream === "object" ? stream : {};
        const q = normalizeText(stream.quality || stream.definition || stream.quality_type || "").toLowerCase().replace(/[-_\s]/g, "");
        if (/^(hi-?res|highres|master|hires)/.test(q)) return "hires";
        if (/^(spatial|atmos|dolby|immersive)/.test(q)) return "atmos";
        if (/^(lossless|flac|sq)/.test(q)) return "lossless";
        if (/^(medium|standard|normal|std|128k?|higher)/.test(q)) return "standard";
        if (/^(highest|excellent|superhigh|hq|320k?|high$|exhigh)/.test(q)) return "exhigh";
        const br = qishuiNormalizeBitrateKbps(stream.bitrate);
        if (br >= 900) return "lossless";
        if (br >= 320) return "exhigh";
        return "standard";
      }
      function qishuiBetterStreamCandidate(a, b) {
        if (!b) return true;
        const ad = qishuiNormalizeDurationSeconds(a && a.duration);
        const bd = qishuiNormalizeDurationSeconds(b && b.duration);
        if (ad > 0 || bd > 0) {
          if (ad > bd + 1) return true;
          if (bd > ad + 1) return false;
        }
        const ar = qishuiQualityRank(a && a.quality, a && a.format, a && a.bitrate);
        const br = qishuiQualityRank(b && b.quality, b && b.format, b && b.bitrate);
        if (ar !== br) return ar > br;
        const ab = qishuiNormalizeBitrateKbps(a && a.bitrate);
        const bb = qishuiNormalizeBitrateKbps(b && b.bitrate);
        if (ab !== bb) return ab > bb;
        return (Number(a && a.size) || 0) > (Number(b && b.size) || 0);
      }
      function qishuiBestStreamCandidate(candidates) {
        let best = null;
        (candidates || []).forEach((item) => {
          if (!item || !item.url) return;
          if (qishuiBetterStreamCandidate(item, best)) best = item;
        });
        return best;
      }
      var QISHUI_TRACK_VIP_KEYS = /* @__PURE__ */ new Set([
        "onlyvipplayable",
        "viprequired",
        "needvip",
        "isvip",
        "isviponly",
        "viponly",
        "onlyvip",
        "onlymemberplayable",
        "memberrequired",
        "needmember",
        "payplay"
      ]);
      var QISHUI_TRACK_SVIP_KEYS = /* @__PURE__ */ new Set([
        "onlysvipplayable",
        "sviprequired",
        "needsvip",
        "issvip",
        "issviponly",
        "sviponly",
        "onlysvip",
        "onlysupervipplayable",
        "superviprequired",
        "needsupervip",
        "issuperviponly",
        "superviponly"
      ]);
      var QISHUI_TRACK_ACCOUNT_CONTAINER_KEYS = /* @__PURE__ */ new Set([
        "membership",
        "membershipinfo",
        "usermembership",
        "accountmembership",
        "account",
        "userinfo",
        "userprofile",
        "me"
      ]);
      var QISHUI_TRACK_DOWNLOAD_CONTAINER_KEYS = /* @__PURE__ */ new Set([
        "downloaddetail",
        "downloadinfo",
        "download_detail",
        "downloadinfo",
        "download",
        "dldetail",
        "dl"
      ]);
      function qishuiTrackPlaybackRestriction(value) {
        let vipRequired = false;
        let svipRequired = false;
        let membershipHintKnown = false;
        let visited = 0;
        const evidence = [];
        const visit = (node, depth, pathKeys) => {
          if (!node || typeof node !== "object" || depth > 7 || visited > 800) return;
          visited += 1;
          if (Array.isArray(node)) {
            node.slice(0, 160).forEach((item) => visit(item, depth + 1, pathKeys));
            return;
          }
          for (const [key, item] of Object.entries(node).slice(0, 180)) {
            const normalizedKey = qishuiNormalizedFieldKey(key);
            const nextPath = pathKeys.concat(normalizedKey);
            if (QISHUI_TRACK_ACCOUNT_CONTAINER_KEYS.has(normalizedKey)) continue;
            if (QISHUI_TRACK_DOWNLOAD_CONTAINER_KEYS.has(normalizedKey)) continue;
            if (QISHUI_TRACK_SVIP_KEYS.has(normalizedKey)) {
              membershipHintKnown = true;
              if (qishuiExplicitPositive(item)) {
                svipRequired = true;
                vipRequired = true;
                evidence.push(nextPath.join("."));
              }
            } else if (QISHUI_TRACK_VIP_KEYS.has(normalizedKey)) {
              membershipHintKnown = true;
              if (qishuiExplicitPositive(item)) {
                vipRequired = true;
                evidence.push(nextPath.join("."));
              }
            } else if (normalizedKey === "fee") {
              membershipHintKnown = true;
              if (Number(item) === 1) {
                vipRequired = true;
                evidence.push(nextPath.join("."));
              }
            } else if (normalizedKey === "privilege") {
              membershipHintKnown = true;
              if (Number(item) >= 9) {
                vipRequired = true;
                evidence.push(nextPath.join("."));
              }
            }
            if (item && typeof item === "object") visit(item, depth + 1, nextPath);
          }
        };
        visit(value, 0, []);
        return {
          vipRequired,
          svipRequired,
          requiredTier: svipRequired ? "svip" : vipRequired ? "vip" : "free",
          membershipHintKnown,
          evidence
        };
      }
      function qishuiTrackRequiresVip(value) {
        return qishuiTrackPlaybackRestriction(value).vipRequired;
      }
      var QISHUI_TIER_RANK = Object.freeze({ free: 0, vip: 1, svip: 2 });
      function qishuiNormalizeRequiredTier(value) {
        const text5 = normalizeText(value).toLowerCase().replace(/[-_\s]/g, "");
        if (/^(svip|supervip|hires|highres|highresolution|master|atmos|dolby|spatial)$/.test(text5)) return "svip";
        if (/^(vip|member|premium|lossless|sq|flac|exhigh|high|higher|highest|hq|320)$/.test(text5)) return "vip";
        return "free";
      }
      function qishuiHigherRequiredTier(a, b) {
        a = qishuiNormalizeRequiredTier(a);
        b = qishuiNormalizeRequiredTier(b);
        return QISHUI_TIER_RANK[b] > QISHUI_TIER_RANK[a] ? b : a;
      }
      function qishuiStreamRequiredTier(stream) {
        stream = stream && typeof stream === "object" ? stream : {};
        let requiredTier = qishuiNormalizeRequiredTier(
          stream.requiredTier || stream.required_tier || stream.membershipTier || stream.membership_tier || ""
        );
        const quality = normalizeText(stream.quality || stream.definition || "").toLowerCase().replace(/[-_\s]/g, "");
        const format = normalizeText(stream.format || "").toLowerCase();
        const bitrate = qishuiNormalizeBitrateKbps(stream.bitrate);
        if (/svip|supervip|hires|highres|highresolution|master|atmos|dolby|spatial/.test(quality)) {
          requiredTier = qishuiHigherRequiredTier(requiredTier, "svip");
        } else if (/lossless|flac|sq/.test(quality) || /flac|alac|wav/.test(format) || bitrate >= 900) {
          requiredTier = qishuiHigherRequiredTier(requiredTier, "vip");
        } else if (/highest|excellent|superhigh|high$|hq|exhigh|320/.test(quality) || bitrate > 192) {
          requiredTier = qishuiHigherRequiredTier(requiredTier, "vip");
        }
        return requiredTier;
      }
      function qishuiMembershipTier(membership) {
        if (!(membership && membership.membershipKnown)) return "unknown";
        if (membership.isSvip) return "svip";
        if (membership.isVip) return "vip";
        return "free";
      }
      function qishuiRequiredTierAllowed(requiredTier, membership) {
        requiredTier = qishuiNormalizeRequiredTier(requiredTier);
        if (requiredTier === "free") return true;
        if (!(membership && membership.membershipKnown)) return false;
        if (requiredTier === "svip") return !!membership.isSvip;
        return !!membership.isVip;
      }
      function qishuiStreamAllowedForMembership(stream, membership) {
        if (!stream || !stream.url) return false;
        return qishuiRequiredTierAllowed(qishuiStreamRequiredTier(stream), membership);
      }
      function qishuiBestStreamCandidateForMembership(candidates, membership) {
        return qishuiBestStreamCandidate((candidates || []).filter((item) => qishuiStreamAllowedForMembership(item, membership)));
      }
      function qishuiStreamUrlFrom(value) {
        return normalizeText(qishuiObjectString(value, [
          "main_play_url",
          "MainPlayUrl",
          "main_url",
          "MainUrl",
          "url",
          "URL",
          "play_url",
          "PlayURL",
          "playable_url",
          "PlayableUrl",
          "playableUrl"
        ]) || qishuiObjectString(value, [
          "backup_play_url",
          "BackupPlayUrl",
          "backup_url",
          "BackupUrl",
          "backup_url_1",
          "backup_url_2",
          "backup_url_3"
        ]) || firstUrl(value && (value.backup_urls || value.backupUrls || value.url_list || value.UrlList)));
      }
      function qishuiBitrateFromUrl(value) {
        value = normalizeText(value);
        if (!value) return 0;
        try {
          const parsed = new URL(value);
          for (const key of ["br", "bitrate", "bit_rate", "real_bitrate"]) {
            const bitrate = Number(parsed.searchParams.get(key)) || 0;
            if (bitrate > 0) return bitrate;
          }
        } catch (_) {
        }
        const match = value.match(/(?:^|[/_.-])(\d{2,4})(?:k|kbps)(?:[/_.-]|$)/i);
        return match ? Number(match[1]) || 0 : 0;
      }
      function qishuiBitrateFromSize(size, duration) {
        size = Number(size) || 0;
        duration = qishuiNormalizeDurationSeconds(duration);
        if (size <= 0 || duration <= 0) return 0;
        const bitrate = Math.round(size * 8 / duration);
        return bitrate >= 32e3 && bitrate <= 12e6 ? bitrate : 0;
      }
      function qishuiStreamFromObject(value, inherited) {
        if (!value || typeof value !== "object") return null;
        const url = qishuiStreamUrlFrom(value);
        if (!url) return null;
        inherited = inherited || {};
        const meta = pickObject(value.video_meta, value.VideoMeta, value.meta, value.Meta);
        const size = qishuiObjectNumber(value, ["size", "Size", "file_size", "FileSize", "data_size", "DataSize"]) || qishuiObjectNumber(meta, ["size", "Size", "file_size", "FileSize"]);
        const duration = qishuiNormalizeDurationSeconds(qishuiObjectNumber(value, ["duration", "Duration"]) || inherited.duration || 0);
        const bitrate = qishuiObjectNumber(value, ["bitrate", "Bitrate", "real_bitrate", "RealBitrate", "br", "BR", "bit_rate", "BitRate"]) || qishuiObjectNumber(meta, ["bitrate", "Bitrate", "real_bitrate", "RealBitrate", "bit_rate", "BitRate"]) || qishuiBitrateFromUrl(url) || qishuiBitrateFromSize(size, duration);
        const stream = {
          url,
          auth: qishuiObjectString(value, ["play_auth", "PlayAuth", "spade_a", "SpadeA"]) || qishuiVideoModelPlayAuth(value) || inherited.auth || "",
          size,
          format: qishuiObjectString(value, ["format", "Format", "vtype", "VType", "file_format", "FileFormat"]) || qishuiObjectString(meta, ["format", "Format", "vtype", "VType", "codec_type", "CodecType"]),
          bitrate,
          quality: qishuiObjectString(value, ["quality", "Quality", "definition", "Definition", "quality_type", "QualityType"]) || qishuiObjectString(meta, ["quality", "Quality", "definition", "Definition", "quality_type", "QualityType"]) || qishuiVideoModelQualityHint(qishuiObjectString(value, ["gear_des_key", "GearDesKey"]) || inherited.keyHint || ""),
          duration
        };
        stream.requiredTier = qishuiStreamRequiredTier(stream);
        return stream;
      }
      function qishuiMaybeParseJson(value) {
        let text5 = typeof value === "string" ? value.trim() : "";
        if (!text5) return value;
        for (let i = 0; i < 3 && text5.charAt(0) === '"'; i++) {
          try {
            text5 = JSON.parse(text5);
          } catch (_) {
            break;
          }
          if (typeof text5 !== "string") return text5;
          text5 = text5.trim();
        }
        try {
          return JSON.parse(text5);
        } catch (_) {
          return value;
        }
      }
      function qishuiCollectVideoModelStreams(value, keyHint, inherited, out) {
        value = qishuiMaybeParseJson(value);
        inherited = inherited || {};
        if (!value) return;
        if (Array.isArray(value)) {
          value.forEach((item) => qishuiCollectVideoModelStreams(item, keyHint, inherited, out));
          return;
        }
        if (typeof value !== "object") return;
        const ownAuth = qishuiVideoModelPlayAuth(value) || inherited.auth || "";
        const ownDuration = qishuiNormalizeDurationSeconds(qishuiObjectNumber(value, ["video_duration", "duration", "Duration"])) || inherited.duration || 0;
        const entry = qishuiStreamFromObject(value, { auth: ownAuth, duration: ownDuration, keyHint });
        if (entry) out.push(entry);
        Object.keys(value).forEach((key) => {
          qishuiCollectVideoModelStreams(value[key], key, { auth: ownAuth, duration: ownDuration }, out);
        });
      }
      function qishuiVideoModelPlayAuth(value) {
        value = value && typeof value === "object" ? value : {};
        const child = pickObject(value.encrypt_info, value.EncryptInfo, value.encryptInfo);
        return qishuiObjectString(child, ["spade_a", "SpadeA", "spadeA", "play_auth", "PlayAuth"]);
      }
      function qishuiVideoModelQualityHint(key) {
        const normalized = normalizeText(key).toLowerCase().replace(/[-_\s]/g, "");
        if (!normalized) return "";
        return ["hires", "spatial", "atmos", "dolby", "lossless", "sq", "flac", "highest", "higher", "standard", "normal"].find((token) => normalized.includes(token)) || "";
      }
      function extractQishuiMediaList(payload) {
        const data = payload && payload.data || payload || {};
        const direct = pickArray(
          data.media_resources,
          data.media_list,
          data.related_media,
          data.medias,
          data.media,
          data.tracks,
          data.track_list,
          data.songs,
          data.items,
          data.list,
          data.result,
          data.song_list,
          data.recommend_media_list
        );
        if (direct.length) return direct;
        const candidates = [];
        function walk(node, depth) {
          if (!node || depth > 4) return;
          if (Array.isArray(node)) {
            const mediaLike = node.filter((item) => item && typeof item === "object" && (item.media || item.track_entity || item.entity || item.base_info || item.id || item.media_id));
            if (mediaLike.length > candidates.length) candidates.splice(0, candidates.length, ...mediaLike);
            node.forEach((item) => walk(item, depth + 1));
          } else if (typeof node === "object") {
            Object.keys(node).slice(0, 80).forEach((key) => walk(node[key], depth + 1));
          }
        }
        walk(data, 0);
        return candidates;
      }
      function qishuiArtists(related, base, display, track, media) {
        const links = pickArray(
          related.artist_links,
          related.artists,
          base.artist_links,
          base.artists,
          display.artist_links,
          display.artists,
          track && track.artists,
          media && media.artists
        );
        const out = [];
        links.forEach((item) => {
          const name = normalizeText(item && (item.name || item.display_name || item.simple_display_name || item.title || item.artist_name));
          if (!name || out.some((a) => a.name === name)) return;
          out.push({
            id: String(item && (item.id || item.artist_id || item.open_id) || ""),
            name,
            mid: String(item && (item.id || item.artist_id || item.open_id) || "")
          });
        });
        const fallback = normalizeText(base.artist_name || display.artist_name || related.artist_name || track && track.artist_name || media && media.artist_name);
        if (fallback && !out.length) {
          fallback.split(/\s*\/\s*|\s*,\s*|\s*&\s*/).forEach((name) => {
            name = normalizeText(name);
            if (name) out.push({ id: "", name, mid: "" });
          });
        }
        return out;
      }
      function qishuiTranslationIsChinese(item, text5) {
        const lang = String(item && (item.language || item.lang || item.language_code || item.lang_code) || "").toLowerCase();
        if (/^(zh|cn|zh-cn|zh_cn|zhs|cht|zh-tw|zh_tw|中文|简体|繁体|普通话|汉语)$/.test(lang.trim())) return true;
        return /[\u4e00-\u9fff]/.test(String(text5 || ""));
      }
      function qishuiLyricPayload(display, track, base, id) {
        const lyricInfo = pickObject(display.lyric_info, track.lyric_info, base.lyric_info);
        const lyricEntity = pickObject(lyricInfo.lyric_entity, lyricInfo.lyric, lyricInfo.original_lyric);
        const lyric = normalizeLyricBody(lyricEntity.content || lyricInfo.content || lyricInfo.lyric || lyricInfo.lyric_text || "");
        const translations = pickArray(lyricInfo.lang_translations, lyricInfo.translations, lyricInfo.translation);
        let tlyric = "";
        let fallbackTlyric = "";
        for (const item of translations) {
          const entity = pickObject(item && item.lyric_entity, item);
          const text5 = normalizeLyricBody(entity.content || item && (item.content || item.lyric || item.lyric_text));
          if (!text5) continue;
          if (qishuiTranslationIsChinese(item, text5)) {
            tlyric = text5;
            break;
          }
          if (!fallbackTlyric) fallbackTlyric = text5;
        }
        if (!tlyric) tlyric = fallbackTlyric;
        cacheQishuiLyric(id, lyric, tlyric, "qishui-openapi-cache");
        return { lyric, tlyric };
      }
      function cacheQishuiLyric(id, lyric, tlyric, source) {
        id = normalizeText(id);
        const primary = qishuiConvertLyric(lyric);
        const translated = qishuiConvertLyric(tlyric);
        lyric = primary.lyric;
        tlyric = translated.lyric;
        if (!id || !lyric && !tlyric) return null;
        const payload = {
          provider: "qishui",
          lyric,
          tlyric,
          yrc: primary.yrc,
          ytlrc: translated.yrc,
          source: source || "qishui-cache",
          cachedAt: Date.now()
        };
        qishuiLyricCache.set(id, payload);
        return payload;
      }
      function mapQishuiMedia(raw, index, query, opts) {
        opts = opts || {};
        raw = raw || {};
        const entity = pickObject(raw.entity, raw.data, raw);
        const media = pickObject(entity.media, raw.media, entity);
        const wrapper = pickObject(entity.track_wrapper, media.track_wrapper, raw.track_wrapper);
        const track = pickObject(wrapper.track, media.track_entity, raw.track_entity, media.track, raw.track, media);
        const base = pickObject(track.base_info, media.base_info, raw.base_info, track);
        const display = pickObject(track.display_info, media.display_info, raw.display_info);
        const related = pickObject(track.related_info, media.related_info, raw.related_info);
        const id = normalizeText(
          base.id || track.id || media.id || raw.id || raw.media_id || raw.item_id || raw.song_id || raw.vid || "qishui-" + index + "-" + query
        );
        const name = normalizeText(base.name || base.title || track.name || track.title || media.name || raw.name || raw.title);
        if (!id || !name) return null;
        const artists = qishuiArtists(related, base, display, track, media);
        const artist = artists.map((a) => a.name).filter(Boolean).join(" / ") || normalizeText(base.author || raw.author || "");
        const albumLink = pickObject(related.album_link, related.album, base.album, display.album, track.album, media.album);
        const album = normalizeText(albumLink.name || albumLink.title || base.album_name || display.album_name || "");
        const albumId = normalizeText(albumLink.id || albumLink.album_id || albumLink.albumId || "");
        const cover = qishuiFirstImageUrl(
          "~c5_375x375.jpg",
          display.cover_url,
          display.url_cover,
          base.cover_url,
          base.url_cover,
          albumLink.cover_url,
          albumLink.url_cover,
          track.url_cover,
          track.cover_url,
          media.cover_url,
          media.url_cover,
          raw.cover_url,
          raw.cover,
          raw.url_cover
        );
        const durationMs = Number(base.duration_ms || base.duration || track.duration_ms || track.duration || media.duration_ms || media.duration || raw.duration || 0) || 0;
        const lyricData = qishuiLyricPayload(display, track, base, id);
        const directPlayable = !!opts.directPlayable;
        return {
          provider: "qishui",
          source: "qishui",
          type: "qishui",
          id,
          providerSongId: id,
          name,
          artist,
          artists,
          album,
          album_id: albumId,
          albumId,
          cover,
          duration: qishuiNormalizeDurationSeconds(durationMs),
          popularity: Number(raw.popularity || raw.hot || raw.heat || raw.play_count || raw.playCount || related.play_count || related.playCount || 0) || 0,
          fee: track.label_info && track.label_info.only_vip_playable ? 1 : 0,
          playable: directPlayable,
          playbackMode: directPlayable ? "direct-url" : "recommend-match",
          recommendationSource: directPlayable ? "qishui-pc-session" : "qishui-openapi",
          qishuiRank: index,
          qishuiQuery: query || "",
          lyric: lyricData.lyric,
          tlyric: lyricData.tlyric,
          restriction: qishuiRestriction("provider_limited", "汽水音乐当前作为推荐/匹配源接入，播放时会自动寻找其它可播版本。", "switch_source")
        };
      }
      function qishuiWebCommonParams(extra, opts) {
        if (opts && opts.noDefaultParams) return Object.assign({}, extra || {});
        return Object.assign({}, QISHUI_WEB_DEFAULT_PARAMS, extra || {});
      }
      function qishuiPcAppParams(extra) {
        const now = Date.now();
        const deviceId = String(now);
        return Object.assign({
          aid: "386088",
          app_name: "luna_pc",
          region: "cn",
          geo_region: "cn",
          os_region: "cn",
          sim_region: "",
          device_id: deviceId,
          cdid: "",
          iid: String(now + 1),
          version_name: "3.3.0",
          version_code: "30030000",
          channel: "official",
          build_mode: "master",
          network_carrier: "",
          ac: "wifi",
          tz_name: "Asia/Shanghai",
          resolution: "",
          device_platform: "windows",
          device_type: "Windows",
          os_version: "Windows 11",
          fp: deviceId
        }, extra || {});
      }
      function qishuiWebHeaders(cookieText, opts) {
        const cookie = opts && opts.sessionOnly ? qishuiSessionCookieHeader(cookieText) : normalizeQishuiCookieInput(cookieText);
        const headers = {
          "Accept": "application/json,text/plain,*/*",
          "Content-Type": "application/json; charset=utf-8",
          "User-Agent": opts && opts.pcApp ? QISHUI_PC_APP_UA : QISHUI_WEB_UA
        };
        if (opts && opts.pcApp) {
          headers["x-luna-background-type"] = "foreground";
          headers["x-luna-is-background-req"] = "0";
          headers["x-luna-is-local-user"] = "1";
        }
        if (cookie) headers.Cookie = cookie;
        return headers;
      }
      async function qishuiWebRequestJson(apiPath, params, cookieText, opts) {
        opts = opts || {};
        const bases = Array.isArray(opts.bases) && opts.bases.length ? opts.bases : QISHUI_WEB_API_BASES;
        const method = String(opts.method || "GET").toUpperCase();
        const body = opts.body == null ? null : String(opts.body);
        let lastErr = null;
        for (const base of bases) {
          const target = /^https?:\/\//i.test(apiPath) ? apiPath : String(base || "").replace(/\/+$/, "") + apiPath;
          const targetUrl = urlWithParams(target, qishuiWebCommonParams(params, opts));
          const headers = Object.assign(qishuiWebHeaders(cookieText, opts), opts.headers || {});
          if (opts.referer) headers.Referer = String(opts.referer);
          try {
            const officialBridge = opts.signed === false ? null : getQishuiOfficialBridge();
            let json;
            if (opts.pcApp && officialBridge) {
              let signedResponseBody = "";
              let signedResponseStatus = null;
              try {
                const response = await officialBridge.requestOfficial(method, targetUrl, {
                  headers,
                  body,
                  timeoutMs: opts.timeoutMs || 8e3
                });
                signedResponseBody = response && response.body || "";
                signedResponseStatus = response && response.status;
                try {
                  json = JSON.parse(String(response && response.body || ""));
                } catch (parseError) {
                  const error = new Error("Invalid JSON from Qishui official signed API");
                  error.code = "QISHUI_OFFICIAL_INVALID_JSON";
                  error.cause = parseError;
                  throw error;
                }
              } catch (signedError) {
                lastErr = signedError;
                if (__foliaProcessEnv.QISHUI_DEBUG_SIGNED === "1") {
                  console.warn("[QishuiSignedRequest]", signedError && signedError.code || signedError && signedError.name || "error");
                }
                qishuiDiagLog("signed_request_failed", {
                  code: signedError && signedError.code,
                  message: String(signedError && signedError.message || signedError),
                  body: String(signedResponseBody || "").slice(0, 3e3),
                  status: signedResponseStatus
                });
                json = null;
              }
            }
            if (!json) {
              json = await requestJson(targetUrl, {
                method,
                timeoutMs: opts.timeoutMs || 8e3,
                headers
              }, body);
            }
            const err = qishuiPcStatusError(json, "QISHUI_WEB_REQUEST_FAILED");
            if (err) throw err;
            return json;
          } catch (err) {
            lastErr = err;
            if (err && (err.statusCode === 401 || err.statusCode === 403)) break;
          }
        }
        throw lastErr || new Error("QISHUI_WEB_REQUEST_FAILED");
      }
      async function fetchQishuiPlaybackMembership(cookieText) {
        const cookie = normalizeQishuiCookieInput(cookieText);
        if (!qishuiCookieHasLogin(cookie)) {
          return qishuiUnknownMembership("QISHUI_COOKIE_REQUIRED");
        }
        const cacheKey = "membership|" + qishuiCookieFingerprint(cookie);
        return qishuiMembershipCache.wrap(cacheKey, qishuiMembershipCacheTtlMs, async () => {
          try {
            const json = await qishuiWebRequestJson("/luna/pc/me", qishuiPcAppParams(), cookie, {
              bases: [QISHUI_WEB_PC_API_BASE],
              noDefaultParams: true,
              sessionOnly: true,
              pcApp: true,
              timeoutMs: 6500
            });
            const data = json && json.data || json || {};
            const profile = qishuiProfileFromMeData(data);
            return qishuiApplyMembershipObservation(cacheKey, {
              membershipKnown: !!profile.membershipKnown,
              vipType: Number(profile.vipType) || 0,
              vipLevel: profile.vipLevel || "none",
              isVip: !!profile.isVip,
              isSvip: !!profile.isSvip,
              vipLabel: profile.vipLabel || "无VIP",
              expiresAt: Number(profile.expiresAt) || 0,
              sessionValidated: !!profile.profileReady,
              userId: profile.userId || "",
              entitlementSource: "official-pc-me"
            });
          } catch (err) {
            return qishuiApplyMembershipObservation(
              cacheKey,
              qishuiUnknownMembership(err && err.message || "QISHUI_MEMBERSHIP_CHECK_FAILED")
            );
          }
        });
      }
      function qishuiUnknownMembership(error) {
        return {
          membershipKnown: false,
          membershipStatus: "unknown",
          reason: "membership_unknown",
          vipType: 0,
          vipLevel: "unknown",
          isVip: false,
          isSvip: false,
          vipLabel: "未知会员状态",
          expiresAt: 0,
          sessionValidated: false,
          error: normalizeText(error || "QISHUI_MEMBERSHIP_UNKNOWN")
        };
      }
      function qishuiApplyMembershipObservation(historyKey, membership, now) {
        historyKey = normalizeText(historyKey);
        membership = membership && typeof membership === "object" ? Object.assign({}, membership) : qishuiUnknownMembership("QISHUI_MEMBERSHIP_UNKNOWN");
        now = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        const membershipKnown = !!membership.membershipKnown;
        const expiresAt = Number(membership.expiresAt) || 0;
        const positive = membershipKnown && !!(membership.isVip || membership.isSvip);
        if (membershipKnown) {
          if (historyKey) qishuiMembershipPositiveHistory.delete(historyKey);
          if (positive && expiresAt > now && historyKey) {
            const retainedUntil = Math.min(expiresAt, now + QISHUI_MEMBERSHIP_POSITIVE_GRACE_MS);
            qishuiMembershipPositiveHistory.set(historyKey, {
              membership: Object.assign({}, membership, {
                membershipStatus: membership.isSvip ? "svip" : "vip"
              }),
              observedAt: now,
              expiresAt,
              retainedUntil
            });
            while (qishuiMembershipPositiveHistory.size > 48) {
              const oldestKey = qishuiMembershipPositiveHistory.keys().next().value;
              if (!oldestKey) break;
              qishuiMembershipPositiveHistory.delete(oldestKey);
            }
          }
          return Object.assign(membership, {
            membershipStatus: positive ? membership.isSvip ? "svip" : "vip" : "free"
          });
        }
        const previous = historyKey ? qishuiMembershipPositiveHistory.get(historyKey) : null;
        if (previous && previous.expiresAt > now && previous.retainedUntil > now && previous.membership && previous.membership.membershipKnown) {
          return Object.assign({}, previous.membership, {
            retainedOfficialPositive: true,
            retainedUntil: previous.retainedUntil,
            entitlementSource: "recent-official-positive",
            membershipCheckError: membership.error || membership.reason || "membership_unknown"
          });
        }
        if (previous && historyKey) qishuiMembershipPositiveHistory.delete(historyKey);
        return Object.assign(qishuiUnknownMembership(membership.error || membership.reason), membership, {
          membershipKnown: false,
          membershipStatus: "unknown",
          reason: "membership_unknown",
          vipType: 0,
          vipLevel: "unknown",
          isVip: false,
          isSvip: false,
          vipLabel: "未知会员状态",
          expiresAt: 0
        });
      }
      function qishuiMembershipCacheTtlMs(membership, now) {
        now = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        if (!(membership && membership.membershipKnown)) return 1;
        if (!(membership.isVip || membership.isSvip)) return QISHUI_MEMBERSHIP_POSITIVE_CACHE_MS;
        const expiresAt = Number(membership && membership.expiresAt) || 0;
        if (expiresAt <= 0) return 1;
        let remainingMs = expiresAt - now;
        const retainedUntil = Number(membership.retainedUntil) || 0;
        if (retainedUntil > 0) remainingMs = Math.min(remainingMs, retainedUntil - now);
        if (remainingMs <= 0) return 1;
        return Math.max(1, Math.min(QISHUI_MEMBERSHIP_POSITIVE_CACHE_MS, remainingMs - 250));
      }
      async function qishuiPcPostJson(apiPath, payload, cookieText, opts) {
        opts = opts || {};
        const cookie = normalizeQishuiCookieInput(cookieText);
        if (!qishuiCookieHasLogin(cookie)) {
          const err = new Error("QISHUI_COOKIE_REQUIRED");
          err.code = "QISHUI_COOKIE_REQUIRED";
          throw err;
        }
        const body = JSON.stringify(payload || {});
        const json = await qishuiWebRequestJson(apiPath, qishuiPcAppParams(opts.params), cookie, {
          bases: [QISHUI_WEB_PC_API_BASE],
          noDefaultParams: true,
          sessionOnly: true,
          pcApp: true,
          method: "POST",
          body,
          referer: "https://www.qishui.com/",
          timeoutMs: opts.timeoutMs || 9e3
        });
        const statusError = qishuiPcStatusError(json, opts.errorCode || "QISHUI_PC_WRITE_FAILED");
        if (statusError) throw statusError;
        return json;
      }
      function invalidateQishuiLibraryCaches() {
        qishuiWebLibraryCache.clear();
        qishuiWebPlaylistCache.clear();
        qishuiWebPlaylistCursorCache.clear();
      }
      function dedupeQishuiSongs(songs) {
        const seen = /* @__PURE__ */ new Set();
        const out = [];
        (songs || []).forEach((song) => {
          if (!song || !song.id) return;
          const key = String(song.providerSongId || song.id);
          if (seen.has(key)) return;
          seen.add(key);
          out.push(song);
        });
        return out;
      }
      function mapQishuiMediaList(rawItems, query, opts) {
        return dedupeQishuiSongs((rawItems || []).map((item, index) => mapQishuiMedia(item, index, query, opts)).filter(Boolean));
      }
      function qishuiPlaylistLikeName(name) {
        const text5 = String(name || "");
        return /喜欢|收藏|favorite|liked/i.test(text5) || text5.indexOf("喜欢") >= 0 || text5.indexOf("收藏") >= 0;
      }
      function qishuiPlaylistPrimaryLikeName(name) {
        const text5 = String(name || "");
        return /favorite|liked/i.test(text5) || text5.indexOf("喜欢") >= 0;
      }
      function qishuiPlaylistIdFromItem(item) {
        item = item || {};
        return normalizeText(
          item.playlist_id || item.playlistId || item.collection_id || item.collectionId || item.id || item.item_id || item.resource_id || item.object_id || item.server_id || ""
        );
      }
      function qishuiPlaylistNameFromItem(item) {
        item = item || {};
        return normalizeText(
          item.title || item.public_title || item.publicTitle || item.name || item.display_title || item.display_name || item.playlist_name || item.collection_name || ""
        );
      }
      function qishuiPlaylistCoverFromItem(item) {
        item = item || {};
        return qishuiFirstImageUrl(
          "~c5_300x300.jpg",
          item.cover_url,
          item.cover,
          item.cover_uri,
          item.image,
          item.image_url,
          item.url_cover,
          item.icon,
          item.avatar
        );
      }
      function qishuiPlaylistTrackCountFromItem(item) {
        item = item || {};
        return Number(
          item.count_tracks || item.track_count || item.media_count || item.count || item.total || item.song_count || 0
        ) || 0;
      }
      function extractQishuiPlaylistCards(payload) {
        const data = payload && payload.data || payload || {};
        const out = [];
        const seen = /* @__PURE__ */ new Set();
        function visit(node, depth) {
          if (!node || depth > 6) return;
          if (Array.isArray(node)) {
            node.forEach((item) => visit(item, depth + 1));
            return;
          }
          if (typeof node !== "object") return;
          const candidates = [
            node.playlist,
            node.playlist_info,
            node.collection,
            node.collect_playlist,
            node.fav_playlist,
            node.resource,
            node
          ].filter((item) => item && typeof item === "object" && !Array.isArray(item));
          candidates.forEach((item) => {
            const id = qishuiPlaylistIdFromItem(item);
            const name = qishuiPlaylistNameFromItem(item);
            const count = qishuiPlaylistTrackCountFromItem(item);
            const type = normalizeText(item.type || item.card_type || item.resource_type || node.type || "");
            if (!id || !name) return;
            if (!count && !qishuiPlaylistLikeName(name) && !/playlist|collection|fav|songlist|歌单/i.test(type + " " + name)) return;
            const key = id + "|" + name;
            if (seen.has(key)) return;
            seen.add(key);
            out.push({
              provider: "qishui",
              source: "qishui",
              type: "playlist",
              id,
              name,
              cover: qishuiPlaylistCoverFromItem(item),
              trackCount: count,
              playCount: Number(item.play_count || item.playCount || 0) || 0,
              creator: normalizeText(item.creator_name || item.author_name || item.owner_name || item.owner && (item.owner.nickname || item.owner.public_name) || "汽水音乐"),
              subscribed: true,
              virtual: false,
              webSession: true,
              isLiked: qishuiPlaylistLikeName(name),
              playbackMode: "recommend-match"
            });
          });
          Object.keys(node).slice(0, 80).forEach((key) => visit(node[key], depth + 1));
        }
        visit(data, 0);
        return out;
      }
      function buildQishuiVirtualPlaylist(id, name, songs, extra) {
        songs = Array.isArray(songs) ? songs : [];
        extra = extra || {};
        return {
          provider: "qishui",
          source: "qishui",
          type: "playlist",
          id,
          name,
          cover: extra.cover || songs.map((song) => song && song.cover).find(Boolean) || "",
          trackCount: Number(extra.trackCount || songs.length || 0) || 0,
          playCount: Number(extra.playCount || 0) || 0,
          creator: extra.creator || "汽水音乐",
          subscribed: !!extra.subscribed,
          shelfPane: extra.shelfPane || "",
          owned: !!extra.owned,
          virtual: true,
          webSession: !!extra.webSession,
          playbackMode: "recommend-match"
        };
      }
      async function fetchQishuiWebFeedSongs(cookieText, limit) {
        const cookie = normalizeQishuiCookieInput(cookieText);
        if (!qishuiCookieHasLogin(cookie)) return { provider: "qishui", configured: false, webSession: false, songs: [], error: "QISHUI_COOKIE_REQUIRED" };
        limit = Math.max(1, Math.min(50, Number(limit) || 8));
        const cacheKey = "web-feed|" + qishuiCookieFingerprint(cookie) + "|" + limit;
        return qishuiFeedCache.wrap(cacheKey, 90 * 1e3, async () => {
          const candidates = [
            { path: "/luna/feed/song-tab", params: { cursor: 0, cnt: limit, count: limit } },
            { path: "/luna/pc/feed/song-tab", params: { cursor: 0, cnt: limit, count: limit } }
          ];
          let lastErr = null;
          for (const item of candidates) {
            try {
              const json = await qishuiWebRequestJson(item.path, item.params, cookie, { timeoutMs: 8e3 });
              const rawItems = extractQishuiMediaList(json);
              const songs = mapQishuiMediaList(rawItems, "web-feed", { directPlayable: true }).slice(0, limit);
              if (songs.length) return { provider: "qishui", configured: true, webSession: true, songs, rawCount: rawItems.length };
            } catch (err) {
              lastErr = err;
            }
          }
          try {
            const fallback = await fetchQishuiWebLibraryFeedFallback(cookie, limit);
            if (fallback && fallback.songs && fallback.songs.length) return fallback;
          } catch (fallbackErr) {
            lastErr = fallbackErr || lastErr;
          }
          return { provider: "qishui", configured: true, webSession: true, songs: [], rawCount: 0, error: lastErr && lastErr.message || "" };
        });
      }
      async function fetchQishuiWebLibraryFeedFallback(cookieText, limit) {
        const cookie = normalizeQishuiCookieInput(cookieText);
        limit = Math.max(1, Math.min(50, Number(limit) || 8));
        const library = await fetchQishuiWebLibrary(cookie);
        let songs = dedupeQishuiSongs([].concat(library.likedTracks || []).concat(library.recentTracks || []));
        const detailCandidates = [].concat(library.likedCard ? [library.likedCard] : []).concat((library.playlists || []).filter((pl) => pl && pl.id));
        for (let i = 0; songs.length < limit && i < detailCandidates.length && i < 4; i += 1) {
          const pl = detailCandidates[i];
          if (!pl || !pl.id) continue;
          try {
            const detail = await fetchQishuiWebPlaylistTracks(pl.id, cookie, { limit: Math.max(limit, 12), offset: 0 });
            songs = dedupeQishuiSongs(songs.concat(detail && detail.tracks || []));
          } catch (_) {
          }
        }
        songs = songs.slice(0, limit);
        return {
          provider: "qishui",
          configured: true,
          webSession: true,
          songs,
          rawCount: songs.length,
          source: "qishui-web-library-fallback",
          fallback: true,
          error: songs.length ? "" : (library.errors || []).join("; ") || "QISHUI_WEB_FEED_EMPTY"
        };
      }
      async function fetchQishuiWebLibrary(cookieText) {
        const cookie = normalizeQishuiCookieInput(cookieText);
        if (!qishuiCookieHasLogin(cookie)) {
          return { provider: "qishui", loggedIn: false, webSession: false, playlists: [], likedTracks: [], recentTracks: [] };
        }
        const cacheKey = "library|" + qishuiCookieFingerprint(cookie);
        return qishuiWebLibraryCache.wrap(cacheKey, 90 * 1e3, async () => {
          const playlists = [];
          const likedTracks = [];
          const recentTracks = [];
          const cardTracks = [];
          const errors = [];
          const addSongs = (target, songs) => {
            target.push(...dedupeQishuiSongs(songs || []));
          };
          const tryRead = async (label, apiPath, params, requestOpts) => {
            requestOpts = requestOpts || {};
            try {
              const json = await qishuiWebRequestJson(apiPath, params || {}, cookie, Object.assign({
                bases: [QISHUI_WEB_PC_API_BASE],
                noDefaultParams: true,
                sessionOnly: true,
                timeoutMs: 6500
              }, requestOpts));
              if (/created|collection|collect/i.test(label)) {
                extractQishuiPlaylistCards(json).forEach((pl) => {
                  const primaryLike = qishuiPlaylistPrimaryLikeName(pl && pl.name);
                  if (/created/i.test(label) || primaryLike) {
                    pl.shelfPane = "mine";
                    pl.owned = true;
                    pl.subscribed = false;
                  } else {
                    pl.shelfPane = "fav";
                    pl.owned = false;
                    pl.subscribed = true;
                  }
                  playlists.push(pl);
                });
              }
              const songs = mapQishuiMediaList(extractQishuiMediaList(json), label, { directPlayable: true });
              if (/recent/i.test(label)) addSongs(recentTracks, songs);
              else if (/liked|favorite|collect/i.test(label)) addSongs(likedTracks, songs);
              else addSongs(cardTracks, songs);
              return json;
            } catch (err) {
              if (!requestOpts.optional) errors.push(label + ":" + (err && err.message || "failed"));
              return null;
            }
          };
          const pcRequestOpts = { pcApp: true };
          const meJson = await tryRead("me", "/luna/pc/me", qishuiPcAppParams(), pcRequestOpts);
          const meData = meJson && meJson.data || meJson || {};
          const profile = qishuiProfileFromMeData(meData);
          const userId = profile.userId;
          await Promise.all([
            userId ? tryRead("created", "/luna/pc/user/playlist", qishuiPcAppParams({
              user_id: userId,
              cursor: "",
              count: 50
            }), pcRequestOpts) : Promise.resolve(null),
            tryRead("collection", "/luna/pc/me/collection/mixed", qishuiPcAppParams({
              cursor: "",
              count: 50
            }), Object.assign({ optional: true }, pcRequestOpts)),
            tryRead("recent", "/luna/pc/me/recently-played-media", qishuiPcAppParams({
              cursor: "",
              count: 50
            }), Object.assign({ optional: true }, pcRequestOpts))
          ]);
          if (!userId) errors.push("me:missing-user-id");
          const uniquePlaylists = [];
          const seenPlaylists = /* @__PURE__ */ new Set();
          playlists.forEach((pl) => {
            if (!pl || !pl.id || seenPlaylists.has(pl.id)) return;
            seenPlaylists.add(pl.id);
            uniquePlaylists.push(pl);
          });
          const likedCard = uniquePlaylists.find((pl) => pl && pl.isLiked && qishuiPlaylistPrimaryLikeName(pl.name)) || uniquePlaylists.find((pl) => pl && pl.isLiked);
          return {
            provider: "qishui",
            loggedIn: true,
            configured: true,
            webSession: true,
            playlists: uniquePlaylists,
            likedCard,
            likedTracks: dedupeQishuiSongs(likedTracks),
            recentTracks: dedupeQishuiSongs(recentTracks),
            profile,
            errors
          };
        });
      }
      async function handleQishuiStatus(cookieText) {
        const status = getQishuiStatus(cookieText);
        if (!status.webSession) return status;
        try {
          const library = await fetchQishuiWebLibrary(cookieText);
          const profile = library && library.profile || {};
          if (profile.profileReady) {
            status.userId = profile.userId || status.userId;
            status.nickname = profile.nickname || status.nickname;
            status.avatar = profile.avatar || status.avatar;
            status.douyinId = profile.douyinId || "";
            status.vipType = profile.vipType || 0;
            status.vipLevel = profile.vipLevel || "none";
            status.isVip = !!profile.isVip;
            status.isSvip = !!profile.isSvip;
            status.vipLabel = profile.vipLabel || (status.vipLevel === "svip" ? "SVIP" : status.vipLevel === "vip" ? "VIP" : "无VIP");
            status.membershipKnown = !!profile.membershipKnown;
            status.profileReady = true;
          }
          status.libraryReady = true;
          status.libraryErrors = library && library.errors || [];
        } catch (err) {
          status.profileReady = false;
          status.profileError = err && err.message || "QISHUI_PROFILE_FAILED";
        }
        return status;
      }
      async function fetchQishuiWebPlaylistTracks(playlistId, cookieText, opts) {
        opts = opts || {};
        const cookie = normalizeQishuiCookieInput(cookieText);
        const id = normalizeText(String(playlistId || "").replace(/^qishui:/i, ""));
        if (!qishuiCookieHasLogin(cookie) || !id) {
          return { provider: "qishui", configured: false, webSession: false, tracks: [], total: 0, error: "QISHUI_COOKIE_REQUIRED" };
        }
        const limit = Math.max(1, Math.min(50, Number(opts.limit) || 50));
        const offset = Math.max(0, Number(opts.offset) || 0);
        const cacheKey = "playlist|" + qishuiCookieFingerprint(cookie) + "|" + id + "|" + limit + "|" + offset;
        return qishuiWebPlaylistCache.wrap(cacheKey, 90 * 1e3, async () => {
          const targetCount = offset + limit;
          const cursorKey = qishuiCookieFingerprint(cookie) + "|" + id;
          let cursorState = qishuiWebPlaylistCursorCache.get(cursorKey);
          if (!cursorState || Date.now() - cursorState.updatedAt > 10 * 60 * 1e3) {
            cursorState = { rawItems: [], cursor: "", hasMore: true, lastJson: null, updatedAt: Date.now(), promise: null };
            qishuiWebPlaylistCursorCache.set(cursorKey, cursorState);
          }
          while (cursorState.rawItems.length < targetCount && cursorState.hasMore) {
            if (!cursorState.promise) {
              cursorState.promise = qishuiWebRequestJson("/luna/pc/playlist/detail", qishuiPcAppParams({
                playlist_id: id,
                cursor: cursorState.cursor,
                count: Math.min(100, Math.max(1, targetCount - cursorState.rawItems.length))
              }), cookie, {
                bases: [QISHUI_WEB_PC_API_BASE],
                noDefaultParams: true,
                sessionOnly: true,
                pcApp: true,
                timeoutMs: 9e3
              }).then((json) => {
                cursorState.lastJson = json;
                const pageRawItems = extractQishuiMediaList(json);
                cursorState.rawItems.push(...pageRawItems);
                const pageData = json && json.data || json || {};
                const nextCursor = normalizeText(pageData.next_cursor || pageData.nextCursor || json && json.next_cursor || "");
                cursorState.cursor = nextCursor;
                cursorState.hasMore = !!(pageData.has_more || pageData.hasMore || json && json.has_more) && !!nextCursor;
                cursorState.updatedAt = Date.now();
                if (!pageRawItems.length) cursorState.hasMore = false;
              }).finally(() => {
                cursorState.promise = null;
              });
            }
            await cursorState.promise;
          }
          while (qishuiWebPlaylistCursorCache.size > 12) qishuiWebPlaylistCursorCache.delete(qishuiWebPlaylistCursorCache.keys().next().value);
          const allRawItems = cursorState.rawItems;
          const lastJson = cursorState.lastJson;
          const upstreamHasMore = cursorState.hasMore;
          const data = lastJson && lastJson.data || lastJson || {};
          const meta = pickObject(data.playlist, lastJson && lastJson.playlist, data.playlist_info, lastJson && lastJson.playlist_info);
          const playlistCover = qishuiPlaylistCoverFromItem(meta);
          const allTracks = mapQishuiMediaList(allRawItems, "web-playlist", { directPlayable: true }).map((song) => song && !song.cover && playlistCover ? Object.assign({}, song, { cover: playlistCover }) : song);
          const tracks = allTracks.slice(offset, offset + limit);
          const total = Number(meta.count_tracks || meta.track_count || data.total || data.count || data.total_num || allRawItems.length || allTracks.length) || allTracks.length;
          const playlist = buildQishuiVirtualPlaylist(id, qishuiPlaylistNameFromItem(meta) || "汽水歌单", tracks, {
            cover: playlistCover,
            trackCount: total,
            subscribed: true,
            webSession: true
          });
          playlist.virtual = false;
          return {
            provider: "qishui",
            loggedIn: true,
            configured: true,
            webSession: true,
            playlist,
            tracks,
            total,
            offset,
            limit,
            nextOffset: offset + tracks.length,
            hasMore: upstreamHasMore || offset + tracks.length < total,
            rawCount: allRawItems.length
          };
        });
      }
      function mapQishuiPublicItem(raw, index, query) {
        raw = raw || {};
        const author = pickObject(raw.author_info, raw.author, raw.artist);
        const album = pickObject(raw.album_info, raw.album);
        const id = normalizeText(raw.item_id || raw.id || raw.song_id || raw.music_id || "qishui-public-" + index + "-" + query);
        const name = normalizeText(raw.title || raw.name || raw.song_name);
        if (!id || !name) return null;
        const artistName = normalizeText(author.name || raw.author_name || raw.artist_name || raw.singer || "");
        const lyricInfo = pickObject(raw.lyric_info, raw.lyric);
        const lyric = normalizeLyricBody(lyricInfo.lyric_text || lyricInfo.content || lyricInfo.lyric || raw.lyric_text || "");
        cacheQishuiLyric(id, lyric, "", "qishui-public-search-cache");
        return {
          provider: "qishui",
          source: "qishui",
          type: "qishui",
          id,
          providerSongId: id,
          name,
          artist: artistName,
          artists: artistName ? [{ id: normalizeText(author.id || author.author_id), name: artistName, mid: normalizeText(author.id || author.author_id) }] : [],
          album: normalizeText(album.name || raw.album_name || ""),
          cover: firstUrl(raw.cover_url || raw.cover || raw.artwork || album.cover_url),
          duration: Number(raw.duration || raw.duration_ms || 0) > 1e4 ? Math.round(Number(raw.duration || raw.duration_ms) / 1e3) : Number(raw.duration || raw.duration_ms || 0) || 0,
          fee: raw.qishui_label_info && raw.qishui_label_info.only_vip_playable ? 1 : 0,
          playable: false,
          playbackMode: "recommend-match",
          recommendationSource: "qishui-public-catalog",
          qishuiRank: index,
          qishuiQuery: query || "",
          lyric,
          tlyric: "",
          restriction: qishuiRestriction("provider_limited", "汽水音乐当前作为搜索/匹配源接入，播放时会自动寻找其它可播版本。", "switch_source")
        };
      }
      function qishuiSearchComparable(value) {
        return normalizeText(value).normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
      }
      function qishuiPublicSearchScore(song, keywords) {
        song = song || {};
        const query = qishuiSearchComparable(keywords);
        if (!query) return 0;
        const name = qishuiSearchComparable(song.name);
        const artist = qishuiSearchComparable(song.artist);
        const album = qishuiSearchComparable(song.album);
        let score = 0;
        if (name === query) score += 180;
        else if (name.includes(query)) score += 120;
        else if (name && query.includes(name) && name.length >= 2) score += 70;
        if (artist === query) score += 150;
        else if (artist.includes(query)) score += 105;
        if (album === query) score += 80;
        else if (album.includes(query)) score += 45;
        const tokens = normalizeText(keywords).split(/\s+/).map(qishuiSearchComparable).filter((token) => token.length >= 2);
        tokens.forEach((token) => {
          if (name.includes(token)) score += 28;
          if (artist.includes(token)) score += 22;
          if (album.includes(token)) score += 10;
        });
        return score;
      }
      function rankQishuiPublicSongs(songs, keywords, limit) {
        const scored = (Array.isArray(songs) ? songs : []).map((song, index) => ({
          song,
          index,
          score: qishuiPublicSearchScore(song, keywords)
        }));
        const matched = scored.filter((item) => item.score > 0);
        const source = matched.length ? matched : scored;
        return source.sort((a, b) => b.score - a.score || a.index - b.index).slice(0, Math.max(1, Number(limit) || 8)).map((item) => item.song);
      }
      async function handleQishuiPublicSearch(keywords, limit, cookieText, offset) {
        offset = Math.max(0, Number(offset) || 0);
        const requestLimit = Math.min(100, Math.max(offset + (Number(limit) * 3 || 0), 36));
        const url = urlWithParams(QISHUI_PUBLIC_SEARCH_URL, {
          keyword: keywords,
          search_type: "music",
          limit: requestLimit,
          // The public catalogue endpoint currently repeats nearly the same first
          // page for non-zero real_offset. Fetch a bounded candidate window once and
          // paginate the locally ranked set so scroll loading never loops duplicates.
          real_offset: 0,
          search_source: "qishui"
        });
        const json = await requestJson(url, { timeoutMs: 8e3, headers: QISHUI_PUBLIC_HEADERS });
        const list = json && json.data && Array.isArray(json.data.list) ? json.data.list : [];
        const mappedSongs = list.map((item, index) => mapQishuiPublicItem(item, index, keywords)).filter(Boolean);
        const rankedSongs = rankQishuiPublicSongs(mappedSongs, keywords, requestLimit);
        const songs = rankedSongs.slice(offset, offset + limit);
        const status = getQishuiStatus(cookieText);
        return {
          provider: "qishui",
          configured: status.configured,
          loggedIn: status.loggedIn,
          webSession: status.webSession,
          publicCatalog: true,
          songs,
          rawCount: list.length,
          offset,
          limit,
          nextOffset: offset + songs.length,
          hasMore: songs.length >= limit && (offset + songs.length < rankedSongs.length || requestLimit < 100),
          message: songs.length ? "" : "汽水公开搜索暂时没有返回匹配结果。"
        };
      }
      async function fetchQishuiPublicDetail(id) {
        id = normalizeText(id);
        if (!id) return null;
        return qishuiPublicDetailCache.wrap(id, 30 * 60 * 1e3, async () => {
          const url = urlWithParams(QISHUI_PUBLIC_CONTENTS_URL, {
            sources: "qishui",
            need_author: true,
            need_album: true,
            need_ugc: true,
            need_stat: true,
            item_ids: id
          });
          const json = await requestJson(url, { timeoutMs: 8e3, headers: QISHUI_PUBLIC_HEADERS });
          const item = json && json.data && Array.isArray(json.data.list) ? json.data.list[0] : null;
          if (!item) return null;
          const lyricInfo = pickObject(item.lyric_info, item.lyric);
          const lyric = normalizeLyricBody(
            lyricInfo.lyric_text || lyricInfo.content || lyricInfo.lyric || lyricInfo.lyric_entity && lyricInfo.lyric_entity.content || ""
          );
          const tlyric = normalizeLyricBody(lyricInfo.translated_lyric || lyricInfo.translation || lyricInfo.tlyric || "");
          cacheQishuiLyric(id, lyric, tlyric, "qishui-public-detail");
          return { item, lyric, tlyric };
        });
      }
      function extractQishuiPcSearchItems(payload) {
        const data = payload && payload.data || payload || {};
        const groups = pickArray(
          data.result_groups,
          data.resultGroups,
          data.search_result && data.search_result.result_groups,
          payload && payload.result_groups
        );
        const items = [];
        groups.forEach((group) => {
          const groupData = group && (group.data || group.items || group.list || group.result);
          if (Array.isArray(groupData)) items.push(...groupData);
          else items.push(...extractQishuiMediaList(groupData));
        });
        return items.length ? items : extractQishuiMediaList(data);
      }
      async function handleQishuiPcSearch(keywords, limit, cookieText, offset) {
        const cookie = normalizeQishuiCookieInput(cookieText);
        if (!qishuiCookieHasLogin(cookie)) throw new Error("QISHUI_COOKIE_REQUIRED");
        const requestCount = Math.max(1, Math.min(50, Number(limit) || 8));
        offset = Math.max(0, Number(offset) || 0);
        const json = await qishuiWebRequestJson("/luna/pc/search/track", qishuiPcAppParams({
          q: keywords,
          cursor: String(offset),
          count: requestCount,
          search_method: "input"
        }), cookie, {
          bases: [QISHUI_WEB_PC_API_BASE],
          noDefaultParams: true,
          sessionOnly: true,
          pcApp: true,
          timeoutMs: 8500
        });
        const rawItems = extractQishuiPcSearchItems(json);
        const songs = mapQishuiMediaList(rawItems, keywords, { directPlayable: true }).slice(0, limit);
        const data = json && json.data || json || {};
        const resultData = pickObject(data.search_result, data.searchResult, data);
        const nextCursor = normalizeText(
          resultData.next_cursor || resultData.nextCursor || data.next_cursor || data.nextCursor || ""
        );
        const hasMoreFlag = resultData.has_more;
        const hasMore = typeof hasMoreFlag === "boolean" ? hasMoreFlag : Number(hasMoreFlag) > 0 || !!nextCursor || songs.length >= limit;
        return {
          provider: "qishui",
          configured: true,
          loggedIn: true,
          webSession: true,
          source: "qishui-pc-search",
          songs,
          rawCount: rawItems.length,
          offset,
          limit,
          nextOffset: offset + songs.length,
          nextCursor,
          hasMore
        };
      }
      async function handleQishuiSearch(keywords, limit, cookieText, offset) {
        keywords = normalizeText(keywords);
        limit = Math.max(1, Math.min(18, Number(limit) || 8));
        offset = Math.max(0, Number(offset) || 0);
        const status = getQishuiStatus(cookieText);
        if (!keywords) return { provider: "qishui", songs: [], configured: status.configured, message: status.message };
        if (!status.webSession && !status.tokenConfigured && !QISHUI_PUBLIC_ENABLED) {
          return {
            provider: "qishui",
            configured: false,
            songs: [],
            error: "QISHUI_TOKEN_REQUIRED",
            reason: "missing_access_token",
            message: status.message
          };
        }
        const cacheKey = keywords.toLowerCase() + "|" + limit + "|" + offset + "|" + (status.webSession ? qishuiCookieFingerprint(cookieText) : status.tokenConfigured ? "token" : "public");
        return qishuiSearchCache.wrap(cacheKey, 2 * 60 * 1e3, async () => {
          let pcSearchError = "";
          if (status.webSession) {
            try {
              return await handleQishuiPcSearch(keywords, limit, cookieText, offset);
            } catch (err) {
              pcSearchError = err && err.message || String(err);
            }
          }
          if (!status.tokenConfigured || offset > 0) {
            if (!QISHUI_PUBLIC_ENABLED) {
              const err = new Error(pcSearchError || "QISHUI_SEARCH_UNAVAILABLE");
              err.code = "QISHUI_SEARCH_UNAVAILABLE";
              throw err;
            }
            const fallback = await handleQishuiPublicSearch(keywords, limit, cookieText, offset);
            if (pcSearchError) fallback.pcSearchError = pcSearchError;
            return fallback;
          }
          const payload = {
            search_query: keywords,
            played_media: [],
            count: limit,
            common_params: {
              trigger_name: "mineradio_search",
              scene: "search",
              source: "mineradio"
            }
          };
          try {
            const json = await qishuiPost(QISHUI_RELATED_MEDIA_PATH, payload);
            const rawItems = extractQishuiMediaList(json);
            const songs = rawItems.map((item, index) => mapQishuiMedia(item, index, keywords)).filter(Boolean).slice(0, limit);
            return {
              provider: "qishui",
              configured: true,
              songs,
              rawCount: rawItems.length,
              offset,
              limit,
              nextOffset: songs.length,
              hasMore: rawItems.length >= limit,
              pcSearchError
            };
          } catch (err) {
            if (!QISHUI_PUBLIC_ENABLED) throw err;
            const fallback = await handleQishuiPublicSearch(keywords, limit, cookieText, offset);
            fallback.officialError = err && err.message || String(err);
            if (pcSearchError) fallback.pcSearchError = pcSearchError;
            return fallback;
          }
        });
      }
      function qishuiArtistNames(song) {
        song = song || {};
        const names = [];
        const artists = Array.isArray(song.artists) ? song.artists : [];
        artists.forEach((artist) => {
          const name = normalizeText(artist && (artist.name || artist.display_name || artist.title));
          if (name && !names.includes(name)) names.push(name);
        });
        const fallback = normalizeText(song.artist || "");
        fallback.split(/\s*\/\s*|\s*,\s*|、|\s*&\s*|\s+feat\.?\s+|\s+ft\.?\s+/i).forEach((name) => {
          name = normalizeText(name);
          if (name && !names.includes(name)) names.push(name);
        });
        return names;
      }
      function qishuiArtistSongMatches(song, artistId, artistName) {
        song = song || {};
        const targetId = normalizeText(artistId);
        const targetName = qishuiSearchComparable(artistName);
        const artists = Array.isArray(song.artists) ? song.artists : [];
        const ids = artists.map((artist) => normalizeText(artist && (artist.id || artist.artist_id || artist.mid))).filter(Boolean);
        if (targetId) {
          if (ids.some((id) => id === targetId)) return true;
          if (ids.length) return false;
        }
        if (!targetName) return !targetId;
        return qishuiArtistNames(song).some((name) => {
          const comparable = qishuiSearchComparable(name);
          return comparable === targetName || comparable.includes(targetName) || targetName.includes(comparable);
        });
      }
      async function handleQishuiArtistDetail(opts, cookieText) {
        opts = opts || {};
        const artistId = normalizeText(opts.artistId || opts.id || opts.mid || "");
        const artistName = normalizeText(opts.artistName || opts.name || "");
        const limit = Math.max(10, Math.min(50, parseInt(opts.limit || "36", 10) || 36));
        if (!artistId && !artistName) {
          return { provider: "qishui", error: "MISSING_ARTIST_ID_OR_NAME", artist: null, songs: [] };
        }
        if (!artistName) {
          return { provider: "qishui", error: "MISSING_ARTIST_NAME", artist: { provider: "qishui", id: artistId, name: "" }, songs: [] };
        }
        const pageSize = 18;
        const maxPages = Math.min(5, Math.max(1, Math.ceil(limit / pageSize) + 1));
        const seen = /* @__PURE__ */ new Set();
        const matches = [];
        let offset = 0;
        let pages = 0;
        let source = "";
        let lastError = "";
        let hasMore = false;
        for (let page = 0; page < maxPages; page += 1) {
          let result;
          try {
            result = await handleQishuiSearch(artistName, pageSize, cookieText, offset);
          } catch (err) {
            lastError = err && err.message || String(err);
            break;
          }
          pages += 1;
          source = source || normalizeText(result && (result.source || (result.publicCatalog ? "qishui-public-catalog" : "")));
          if (result && result.error && !lastError) lastError = normalizeText(result.error);
          const pageSongs = Array.isArray(result && result.songs) ? result.songs : [];
          pageSongs.forEach((song) => {
            const id = normalizeText(song && (song.providerSongId || song.id || song.songId));
            if (!id || seen.has(id) || !qishuiArtistSongMatches(song, artistId, artistName)) return;
            seen.add(id);
            matches.push(song);
          });
          hasMore = !!(result && result.hasMore);
          if (!hasMore || !pageSongs.length) break;
          const nextOffset = Number(result.nextOffset);
          if (!Number.isFinite(nextOffset) || nextOffset <= offset) break;
          offset = nextOffset;
        }
        const ranked = matches.map((song, index) => ({ song, index })).sort((a, b) => {
          const popularityDiff = (Number(b.song && b.song.popularity) || 0) - (Number(a.song && a.song.popularity) || 0);
          return popularityDiff || a.index - b.index;
        }).map((item) => item.song).slice(0, limit);
        const firstArtist = ranked.reduce((found, song) => {
          if (found) return found;
          const artists = Array.isArray(song && song.artists) ? song.artists : [];
          return artists.find((artist) => {
            const id = normalizeText(artist && (artist.id || artist.artist_id || artist.mid));
            const name = qishuiSearchComparable(artist && artist.name);
            return artistId && id === artistId || !artistId && name === qishuiSearchComparable(artistName);
          }) || null;
        }, null);
        const status = getQishuiStatus(cookieText);
        const output = {
          provider: "qishui",
          configured: !!status.configured,
          loggedIn: !!status.loggedIn,
          webSession: !!status.webSession,
          source: "qishui-artist-search",
          searchSource: source || "qishui-search",
          ordering: matches.some((song) => Number(song && song.popularity) > 0) ? "popularity" : "search-order",
          artist: {
            provider: "qishui",
            id: normalizeText(firstArtist && (firstArtist.id || firstArtist.artist_id || firstArtist.mid)) || artistId,
            name: normalizeText(firstArtist && firstArtist.name) || artistName,
            avatar: ""
          },
          songs: ranked,
          total: ranked.length,
          searchedPages: pages,
          hasMore
        };
        if (!ranked.length && lastError) {
          output.error = "QISHUI_ARTIST_SEARCH_FAILED";
          output.message = lastError;
        }
        return output;
      }
      async function fetchQishuiFeedSongs(limit, cookieText) {
        limit = Math.max(1, Math.min(50, Number(limit) || 8));
        const status = getQishuiStatus(cookieText);
        if (!status.tokenConfigured && status.webSession) return fetchQishuiWebFeedSongs(cookieText, limit);
        if (!status.tokenConfigured) return { provider: "qishui", configured: false, songs: [], error: "QISHUI_TOKEN_REQUIRED", message: status.message };
        const cacheKey = "feed|" + limit;
        return qishuiFeedCache.wrap(cacheKey, 90 * 1e3, async () => {
          const json = await qishuiPost(QISHUI_FEED_SONG_TAB_PATH, {
            count: limit,
            played_media: [],
            common_params: {
              trigger_name: "mineradio_feed",
              scene: "feed",
              source: "mineradio"
            }
          });
          const rawItems = extractQishuiMediaList(json);
          const songs = rawItems.map((item, index) => mapQishuiMedia(item, index, "feed")).filter(Boolean).slice(0, limit);
          return { provider: "qishui", configured: true, songs, rawCount: rawItems.length };
        });
      }
      async function handleQishuiFeed(limit, cookieText) {
        return fetchQishuiFeedSongs(Math.max(1, Math.min(18, Number(limit) || 8)), cookieText);
      }
      function buildQishuiFeedPlaylist(songs) {
        songs = Array.isArray(songs) ? songs : [];
        const firstCover = songs.map((song) => song && song.cover).find(Boolean) || "";
        return {
          provider: "qishui",
          source: "qishui",
          type: "playlist",
          id: QISHUI_VIRTUAL_FEED_PLAYLIST_ID,
          name: "汽水推荐",
          cover: firstCover,
          trackCount: songs.length,
          playCount: 0,
          creator: "汽水音乐",
          subscribed: false,
          virtual: true,
          playbackMode: "recommend-match"
        };
      }
      async function handleQishuiUserPlaylists(cookieText) {
        const status = getQishuiStatus(cookieText);
        if (status.webSession) {
          try {
            const library = await fetchQishuiWebLibrary(cookieText);
            const feed = await fetchQishuiFeedSongs(24, cookieText).catch(() => ({ songs: [], rawCount: 0 }));
            const likedTracks = library.likedTracks || [];
            const likedCard = library.likedCard || {};
            const profile = library.profile || {};
            const recentTracks = library.recentTracks || [];
            const playlists = [
              buildQishuiVirtualPlaylist(QISHUI_WEB_LIKED_PLAYLIST_ID, "汽水我的喜欢", likedTracks, {
                subscribed: false,
                shelfPane: "mine",
                owned: true,
                webSession: true,
                cover: likedCard.cover,
                trackCount: likedTracks.length || likedCard.trackCount || 0,
                creator: profile.nickname || likedCard.creator
              })
            ];
            (library.playlists || []).forEach((pl) => {
              if (!pl || !pl.id || playlists.some((item) => item.id === pl.id)) return;
              playlists.push(pl);
            });
            if (recentTracks.length) {
              playlists.push(buildQishuiVirtualPlaylist(QISHUI_WEB_RECENT_PLAYLIST_ID, "汽水最近播放", recentTracks, {
                subscribed: false,
                shelfPane: "mine",
                owned: true,
                webSession: true
              }));
            }
            playlists.push(buildQishuiFeedPlaylist(feed && feed.songs || []));
            return {
              provider: "qishui",
              loggedIn: true,
              configured: true,
              webSession: true,
              playlists,
              tracksPreview: likedTracks.slice(0, 8),
              rawCount: feed && feed.rawCount || 0,
              libraryErrors: library.errors || [],
              profile,
              userId: profile.userId || "",
              nickname: profile.nickname || "",
              avatar: profile.avatar || ""
            };
          } catch (err) {
            return {
              provider: "qishui",
              loggedIn: true,
              configured: true,
              webSession: true,
              playlists: [
                buildQishuiVirtualPlaylist(QISHUI_WEB_LIKED_PLAYLIST_ID, "汽水我的喜欢", [], { subscribed: false, shelfPane: "mine", owned: true, webSession: true }),
                buildQishuiFeedPlaylist([])
              ],
              error: err && err.message || "QISHUI_WEB_LIBRARY_FAILED",
              message: "汽水账号已登录，但歌单同步暂时失败，请稍后重试。"
            };
          }
        }
        if (!status.configured) {
          return {
            provider: "qishui",
            loggedIn: false,
            configured: false,
            playlists: [],
            error: "QISHUI_TOKEN_REQUIRED",
            message: status.message
          };
        }
        try {
          const feed = await fetchQishuiFeedSongs(24, cookieText);
          const playlist = buildQishuiFeedPlaylist(feed.songs || []);
          return {
            provider: "qishui",
            loggedIn: true,
            configured: true,
            playlists: [playlist],
            tracksPreview: (feed.songs || []).slice(0, 8),
            rawCount: feed.rawCount || 0
          };
        } catch (err) {
          return {
            provider: "qishui",
            loggedIn: true,
            configured: true,
            playlists: [],
            error: err && err.message || "QISHUI_FEED_FAILED",
            message: "汽水推荐歌单暂时同步失败，请稍后重试。"
          };
        }
      }
      async function handleQishuiPlaylistTracks(playlistId, opts, cookieText) {
        opts = opts || {};
        const status = getQishuiStatus(cookieText);
        const id = normalizeText(String(playlistId || "").replace(/^qishui:/i, ""));
        const limit = Math.max(1, Math.min(50, Number(opts.limit) || 50));
        const offset = Math.max(0, Number(opts.offset) || 0);
        if (status.webSession) {
          if (id === QISHUI_WEB_LIKED_PLAYLIST_ID || id === "liked" || id === "favorite") {
            const library = await fetchQishuiWebLibrary(cookieText);
            let allSongs2 = library.likedTracks || [];
            if (!allSongs2.length && library.likedCard && library.likedCard.id) {
              const detail = await fetchQishuiWebPlaylistTracks(library.likedCard.id, cookieText, opts).catch(() => null);
              if (detail && detail.tracks) {
                const playlist3 = buildQishuiVirtualPlaylist(QISHUI_WEB_LIKED_PLAYLIST_ID, "汽水我的喜欢", detail.tracks, {
                  subscribed: false,
                  shelfPane: "mine",
                  owned: true,
                  webSession: true,
                  cover: library.likedCard.cover || detail.playlist && detail.playlist.cover,
                  trackCount: detail.total || library.likedCard.trackCount || detail.tracks.length,
                  creator: library.profile && library.profile.nickname
                });
                return {
                  provider: "qishui",
                  loggedIn: true,
                  configured: true,
                  webSession: true,
                  playlist: playlist3,
                  tracks: detail.tracks,
                  total: detail.total || detail.tracks.length,
                  offset,
                  limit,
                  nextOffset: detail.nextOffset,
                  hasMore: !!detail.hasMore
                };
              }
            }
            const tracks2 = allSongs2.slice(offset, offset + limit);
            const playlist2 = buildQishuiVirtualPlaylist(QISHUI_WEB_LIKED_PLAYLIST_ID, "汽水我的喜欢", allSongs2, {
              subscribed: false,
              shelfPane: "mine",
              owned: true,
              webSession: true,
              cover: library.likedCard && library.likedCard.cover,
              trackCount: allSongs2.length || library.likedCard && library.likedCard.trackCount || 0,
              creator: library.profile && library.profile.nickname
            });
            return {
              provider: "qishui",
              loggedIn: true,
              configured: true,
              webSession: true,
              playlist: playlist2,
              tracks: tracks2,
              total: allSongs2.length,
              offset,
              limit,
              nextOffset: offset + tracks2.length,
              hasMore: offset + tracks2.length < allSongs2.length
            };
          }
          if (id === QISHUI_WEB_RECENT_PLAYLIST_ID || id === "recent") {
            const library = await fetchQishuiWebLibrary(cookieText);
            const allSongs2 = library.recentTracks || [];
            const tracks2 = allSongs2.slice(offset, offset + limit);
            const playlist2 = buildQishuiVirtualPlaylist(QISHUI_WEB_RECENT_PLAYLIST_ID, "汽水最近播放", allSongs2, {
              subscribed: false,
              shelfPane: "mine",
              owned: true,
              webSession: true
            });
            return {
              provider: "qishui",
              loggedIn: true,
              configured: true,
              webSession: true,
              playlist: playlist2,
              tracks: tracks2,
              total: allSongs2.length,
              offset,
              limit,
              nextOffset: offset + tracks2.length,
              hasMore: offset + tracks2.length < allSongs2.length
            };
          }
          if (id && id !== QISHUI_VIRTUAL_FEED_PLAYLIST_ID && id !== "feed") {
            return fetchQishuiWebPlaylistTracks(id, cookieText, opts);
          }
        }
        if (!status.configured) {
          return {
            provider: "qishui",
            loggedIn: false,
            configured: false,
            playlist: buildQishuiFeedPlaylist([]),
            tracks: [],
            total: 0,
            error: "QISHUI_TOKEN_REQUIRED",
            message: status.message
          };
        }
        if (id && id !== QISHUI_VIRTUAL_FEED_PLAYLIST_ID && id !== "feed") {
          return {
            provider: "qishui",
            loggedIn: true,
            configured: true,
            playlist: buildQishuiFeedPlaylist([]),
            tracks: [],
            total: 0,
            error: "QISHUI_PLAYLIST_NOT_FOUND",
            message: "当前汽水接入只支持官方推荐歌单。"
          };
        }
        const fetchCount = Math.max(limit, Math.min(50, offset + limit));
        const feed = await fetchQishuiFeedSongs(fetchCount, cookieText);
        const allSongs = feed.songs || [];
        const tracks = allSongs.slice(offset, offset + limit);
        const playlist = buildQishuiFeedPlaylist(allSongs);
        return {
          provider: "qishui",
          loggedIn: true,
          configured: true,
          playlist,
          tracks,
          total: allSongs.length,
          offset,
          limit,
          nextOffset: offset + tracks.length,
          hasMore: false,
          rawCount: feed.rawCount || allSongs.length
        };
      }
      function qishuiCollectionIds(value) {
        const values = Array.isArray(value) ? value : String(value == null ? "" : value).split(",");
        const seen = /* @__PURE__ */ new Set();
        const ids = [];
        values.forEach((item) => {
          const id = normalizeText(item && typeof item === "object" ? item.id || item.trackId || item.track_id || item.providerSongId : item);
          if (!id || seen.has(id)) return;
          seen.add(id);
          ids.push(id);
        });
        return ids;
      }
      function qishuiWriteEnabled(value) {
        if (value === false || value === 0) return false;
        return !/^(?:false|0|off|no)$/i.test(normalizeText(value));
      }
      async function handleQishuiCheckTracksLiked(trackIds, cookieText) {
        const ids = qishuiCollectionIds(trackIds);
        if (!ids.length) return { provider: "qishui", loggedIn: qishuiCookieHasLogin(cookieText), ids: [], liked: {}, complete: true };
        const cookie = normalizeQishuiCookieInput(cookieText);
        if (!qishuiCookieHasLogin(cookie)) {
          return { provider: "qishui", loggedIn: false, ids, liked: {}, complete: false, error: "QISHUI_COOKIE_REQUIRED" };
        }
        const library = await fetchQishuiWebLibrary(cookie);
        let knownTracks = dedupeQishuiSongs(library.likedTracks || []);
        let complete = false;
        if (library.likedCard && library.likedCard.id) {
          const detail = await fetchQishuiWebPlaylistTracks(library.likedCard.id, cookie, { limit: 50, offset: 0 }).catch(() => null);
          if (detail && Array.isArray(detail.tracks)) {
            knownTracks = dedupeQishuiSongs(knownTracks.concat(detail.tracks));
            complete = !detail.hasMore;
          } else {
            complete = false;
          }
        }
        const knownLiked = new Set(knownTracks.map((song) => String(song.providerSongId || song.id || "")).filter(Boolean));
        const liked = {};
        ids.forEach((id) => {
          liked[id] = knownLiked.has(id);
        });
        return {
          provider: "qishui",
          loggedIn: true,
          ids,
          liked,
          complete,
          checkedCount: knownLiked.size
        };
      }
      async function handleQishuiSetTrackLiked(trackId, liked, cookieText) {
        const id = normalizeText(trackId);
        if (!id) throw new Error("Missing Qishui track id");
        liked = qishuiWriteEnabled(liked);
        const apiPath = liked ? "/luna/pc/me/collection/media" : "/luna/pc/me/collection/media/delete";
        await qishuiPcPostJson(apiPath, {
          media: [{ type: "track", id }],
          scene: ""
        }, cookieText, { errorCode: liked ? "QISHUI_LIKE_FAILED" : "QISHUI_UNLIKE_FAILED" });
        invalidateQishuiLibraryCaches();
        return { provider: "qishui", loggedIn: true, id, liked, ok: true };
      }
      async function handleQishuiSetPlaylistCollected(playlistId, collected, cookieText) {
        const id = normalizeText(String(playlistId || "").replace(/^qishui:/i, ""));
        if (!id) throw new Error("Missing Qishui playlist id");
        collected = qishuiWriteEnabled(collected);
        await qishuiPcPostJson(
          collected ? "/luna/pc/me/collection/playlist" : "/luna/pc/me/collection/playlist/delete",
          { playlist_ids: [id] },
          cookieText,
          { errorCode: collected ? "QISHUI_PLAYLIST_COLLECT_FAILED" : "QISHUI_PLAYLIST_UNCOLLECT_FAILED" }
        );
        invalidateQishuiLibraryCaches();
        return { provider: "qishui", loggedIn: true, id, collected, ok: true };
      }
      async function handleQishuiPlaylistAddSong(playlistId, track, cookieText) {
        const playlistIdValue = normalizeText(String(playlistId || "").replace(/^qishui:/i, ""));
        const trackId = normalizeText(track && typeof track === "object" ? track.providerSongId || track.trackId || track.track_id || track.id : track);
        if (!playlistIdValue || !trackId) throw new Error("Missing Qishui playlist or track id");
        await qishuiPcPostJson("/luna/pc/me/playlist/media/append", {
          playlist_id: playlistIdValue,
          media: [{ id: trackId, type: "track" }]
        }, cookieText, { errorCode: "QISHUI_PLAYLIST_ADD_FAILED" });
        invalidateQishuiLibraryCaches();
        return {
          provider: "qishui",
          loggedIn: true,
          pid: playlistIdValue,
          id: trackId,
          success: true,
          ok: true
        };
      }
      async function handleQishuiSetAlbumCollected(albumId, collected, cookieText) {
        const id = normalizeText(albumId);
        if (!id) throw new Error("Missing Qishui album id");
        collected = qishuiWriteEnabled(collected);
        await qishuiPcPostJson(
          collected ? "/luna/pc/me/collection/album" : "/luna/pc/me/collection/album/delete",
          { album_ids: [id] },
          cookieText,
          { errorCode: collected ? "QISHUI_ALBUM_COLLECT_FAILED" : "QISHUI_ALBUM_UNCOLLECT_FAILED" }
        );
        invalidateQishuiLibraryCaches();
        return { provider: "qishui", loggedIn: true, id, collected, ok: true };
      }
      async function handleQishuiReportRecentlyPlayed(trackId, cookieText) {
        const id = normalizeText(trackId);
        if (!id) throw new Error("Missing Qishui track id");
        await qishuiPcPostJson("/luna/pc/me/recently-played-media", {
          media: [{ type: "track", id }]
        }, cookieText, { errorCode: "QISHUI_RECENT_PLAY_REPORT_FAILED", timeoutMs: 6500 });
        qishuiWebLibraryCache.clear();
        return { provider: "qishui", loggedIn: true, id, reported: true, ok: true };
      }
      function extractQishuiCommentList(payload) {
        const data = payload && payload.data || payload || {};
        return pickArray(
          data.comments,
          data.comment_list,
          data.commentList,
          data.items,
          data.list,
          payload && payload.comments
        );
      }
      function mapQishuiComment(raw) {
        raw = raw && typeof raw === "object" ? raw : {};
        const comment = pickObject(raw.comment, raw.comment_info, raw.commentInfo, raw);
        const user = pickObject(
          comment.user,
          comment.user_info,
          comment.userInfo,
          comment.author,
          raw.user,
          raw.user_info,
          raw.author
        );
        const timeRaw = Number(
          comment.create_time || comment.createTime || comment.created_at || comment.createdAt || comment.time || raw.create_time || raw.time || 0
        ) || 0;
        return {
          id: normalizeText(comment.id || comment.comment_id || comment.commentId || raw.id || ""),
          content: normalizeLyricBody(comment.text || comment.content || comment.comment_text || comment.commentText || ""),
          likedCount: Number(comment.like_count || comment.likeCount || comment.digg_count || comment.diggCount || comment.liked_count || 0) || 0,
          time: timeRaw && timeRaw < 1e10 ? timeRaw * 1e3 : timeRaw,
          user: {
            id: normalizeText(user.id || user.user_id || user.userId || user.uid || ""),
            nickname: normalizeText(user.nickname || user.nick_name || user.nickName || user.name || ""),
            avatar: qishuiFirstImageUrl(
              "~c5_100x100.jpg",
              user.avatar_url,
              user.avatarUrl,
              user.avatar,
              user.medium_avatar_url,
              user.larger_avatar_url
            )
          }
        };
      }
      async function handleQishuiComments(trackId, opts, cookieText) {
        const id = normalizeText(trackId);
        if (!id) return { provider: "qishui", id: "", comments: [], total: 0, error: "Missing Qishui track id" };
        const cookie = normalizeQishuiCookieInput(cookieText);
        if (!qishuiCookieHasLogin(cookie)) {
          return { provider: "qishui", id, loggedIn: false, comments: [], total: 0, error: "QISHUI_COOKIE_REQUIRED" };
        }
        opts = opts || {};
        const count = Math.max(1, Math.min(30, Number(opts.count || opts.limit) || 20));
        const cursor = normalizeText(opts.cursor != null ? opts.cursor : opts.offset || "");
        const json = await qishuiWebRequestJson("/luna/pc/comments", qishuiPcAppParams({
          group_id: id,
          cursor,
          count,
          group_type: 0
        }), cookie, {
          bases: [QISHUI_WEB_PC_API_BASE],
          noDefaultParams: true,
          sessionOnly: true,
          pcApp: true,
          timeoutMs: 8500
        });
        const rawComments = extractQishuiCommentList(json);
        const comments = rawComments.map(mapQishuiComment).filter((comment) => comment.content);
        const data = json && json.data || json || {};
        const nextCursor = normalizeText(data.next_cursor || data.nextCursor || data.cursor || json && (json.next_cursor || json.cursor) || "");
        const total = Number(data.total || data.total_count || data.totalCount || data.count || json && (json.total || json.count) || comments.length) || comments.length;
        return {
          provider: "qishui",
          id,
          loggedIn: true,
          comments,
          total,
          cursor,
          nextCursor,
          hasMore: !!(data.has_more || data.hasMore || nextCursor)
        };
      }
      async function handleQishuiCreateComment(trackId, text5, cookieText) {
        const id = normalizeText(trackId);
        text5 = normalizeLyricBody(text5);
        if (!id) throw new Error("Missing Qishui track id");
        if (!text5) throw new Error("Missing Qishui comment text");
        const json = await qishuiPcPostJson("/luna/pc/comments/create", {
          group_id: id,
          text: text5,
          group_type: 0
        }, cookieText, { errorCode: "QISHUI_COMMENT_CREATE_FAILED" });
        const rawComments = extractQishuiCommentList(json);
        const comment = rawComments.length ? mapQishuiComment(rawComments[0]) : mapQishuiComment(json && json.data || json);
        return {
          provider: "qishui",
          id,
          loggedIn: true,
          created: true,
          ok: true,
          comment: comment.content ? comment : null
        };
      }
      function qishuiLyricTextFromNode(value) {
        value = qishuiMaybeParseJson(value);
        if (typeof value === "string") {
          const text5 = normalizeLyricBody(value);
          return /^https?:\/\//i.test(text5) ? "" : text5;
        }
        if (!value || typeof value !== "object") return "";
        const entity = pickObject(
          value.lyric_entity,
          value.lyricEntity,
          value.original_lyric,
          value.originalLyric,
          value
        );
        for (const key of ["content", "lyric_text", "lyricText", "text", "original_content", "originalContent"]) {
          const text5 = qishuiLyricTextFromNode(entity[key]);
          if (text5) return text5;
        }
        if (entity !== value) return qishuiLyricTextFromNode(entity);
        return "";
      }
      function extractQishuiLyrics(payload) {
        const found = { lyric: "", tlyric: "" };
        const seen = /* @__PURE__ */ new Set();
        let visitedNodes = 0;
        function visit(node, pathText, depth) {
          if (!node || depth > 7 || visitedNodes >= 600 || found.lyric && found.tlyric) return;
          node = qishuiMaybeParseJson(node);
          if (!node || typeof node !== "object") return;
          if (seen.has(node)) return;
          seen.add(node);
          visitedNodes += 1;
          Object.keys(node).slice(0, 120).forEach((key) => {
            const child = node[key];
            const childPath = pathText ? pathText + "." + key : key;
            if (/lyric|lyrics|tlyric|translation/i.test(key)) {
              const text5 = qishuiLyricTextFromNode(child);
              if (text5) {
                if (/translat|tlyric|lang_translation|translated/i.test(childPath)) {
                  if (!found.tlyric) found.tlyric = text5;
                } else if (!found.lyric) {
                  found.lyric = text5;
                }
              }
            }
            if (/^(album_tracks|artist_tracks|chart_tracks|comments|prompts|recommend_media_list)$/i.test(key)) return;
            visit(child, childPath, depth + 1);
          });
        }
        visit(payload, "", 0);
        return found;
      }
      async function fetchQishuiSeoTrack(trackId) {
        return requestJson(urlWithParams("https://beta-luna.douyin.com/luna/h5/seo_track", {
          track_id: trackId,
          device_platform: "web"
        }), {
          timeoutMs: 8e3,
          headers: {
            "Accept": "application/json,text/plain,*/*",
            "User-Agent": QISHUI_WEB_UA,
            "Referer": "https://www.douyin.com/"
          }
        });
      }
      function qishuiSeoTrackFromPayload(payload) {
        const seo = pickObject(payload && payload.seo_track, payload && payload.seoTrack);
        const data = pickObject(payload && payload.data);
        return pickObject(
          seo.track,
          payload && payload.track,
          data.track,
          data.track_info,
          payload && payload.track_info
        );
      }
      function qishuiSongFromSeoTrack(track, fallbackId) {
        track = track && typeof track === "object" ? track : {};
        const album = pickObject(track.album, track.album_info, track.albumInfo);
        const id = normalizeText(track.id || track.track_id || track.trackId || fallbackId);
        const name = normalizeText(track.name || track.title || track.song_name);
        if (!id || !name) return null;
        const artists = pickArray(track.artists, track.artist_list, track.artistList).map((item) => ({
          id: normalizeText(item && (item.id || item.artist_id || item.artistId)),
          name: normalizeText(item && (item.name || item.display_name || item.simple_display_name || item.title)),
          mid: normalizeText(item && (item.id || item.artist_id || item.artistId))
        })).filter((item) => item.name);
        const artist = artists.map((item) => item.name).join(" / ") || normalizeText(track.artist || track.artist_name || "");
        const albumId = normalizeText(album.id || album.album_id || album.albumId);
        return {
          provider: "qishui",
          source: "qishui-public-seo",
          type: "qishui",
          id,
          providerSongId: id,
          name,
          artist,
          artists,
          album: normalizeText(album.name || album.title || album.album_name || ""),
          album_id: albumId,
          albumId,
          cover: qishuiFirstImageUrl("~c5_375x375.jpg", album.url_cover, album.cover_url, album.cover, track.url_cover, track.cover_url),
          duration: qishuiNormalizeDurationSeconds(track.duration_ms || track.duration || 0),
          playable: false,
          playbackMode: "recommend-match",
          recommendationSource: "qishui-public-seo",
          lyric: "",
          tlyric: "",
          restriction: qishuiRestriction("provider_limited", "汽水音乐当前作为推荐/匹配源接入，播放时会自动寻找其它可播版本。", "switch_source")
        };
      }
      async function handleQishuiSongDetail(trackId) {
        const id = normalizeText(trackId);
        if (!id) return { provider: "qishui", error: "MISSING_QISHUI_TRACK_ID", song: null };
        try {
          const track = qishuiSeoTrackFromPayload(await fetchQishuiSeoTrack(id));
          const song = qishuiSongFromSeoTrack(track, id);
          if (!song) return { provider: "qishui", error: "QISHUI_TRACK_DETAIL_EMPTY", song: null };
          return { provider: "qishui", song, album: song.album ? {
            provider: "qishui",
            id: song.albumId,
            albumId: song.albumId,
            name: song.album,
            artist: song.artist,
            cover: song.cover,
            type: "album"
          } : null };
        } catch (e) {
          return { provider: "qishui", error: e.message || "QISHUI_TRACK_DETAIL_FAILED", song: null };
        }
      }
      async function handleQishuiLyric(id, cookieText) {
        id = normalizeText(id);
        if (!id) return { provider: "qishui", lyric: "", tlyric: "", source: "none", error: "Missing Qishui id" };
        const cached = qishuiLyricCache.get(id);
        if (cached) return cached;
        const errors = [];
        try {
          const seoPayload = await fetchQishuiSeoTrack(id);
          const lyrics = extractQishuiLyrics(seoPayload);
          const cachedSeo = cacheQishuiLyric(id, lyrics.lyric, lyrics.tlyric, "qishui-beta-seo-track");
          if (cachedSeo) return cachedSeo;
        } catch (err) {
          errors.push("seo:" + (err && err.message || String(err)));
        }
        if (qishuiCookieHasLogin(normalizeQishuiCookieInput(cookieText))) {
          try {
            const trackPayload = await fetchQishuiPcTrackV2Get(id, cookieText);
            const lyrics = extractQishuiLyrics(trackPayload);
            const cachedTrack = cacheQishuiLyric(id, lyrics.lyric, lyrics.tlyric, "qishui-pc-track-v2");
            if (cachedTrack) return cachedTrack;
          } catch (err) {
            errors.push("track-v2:" + (err && err.message || String(err)));
          }
        }
        if (QISHUI_PUBLIC_ENABLED) {
          try {
            const detail = await fetchQishuiPublicDetail(id);
            const fresh = qishuiLyricCache.get(id);
            if (fresh) return fresh;
            if (detail && (detail.lyric || detail.tlyric)) {
              const cachedPublic = cacheQishuiLyric(id, detail.lyric, detail.tlyric, "qishui-public-detail");
              if (cachedPublic) return cachedPublic;
            }
          } catch (err) {
            errors.push("public:" + (err && err.message || String(err)));
          }
        }
        return {
          provider: "qishui",
          lyric: "",
          tlyric: "",
          yrc: "",
          ytlrc: "",
          source: "none",
          error: errors.join("; ")
        };
      }
      function qishuiPrimaryTrackFromV2(payload) {
        const data = payload && payload.data || payload || {};
        return pickObject(data.track, data.track_info, data.trackInfo, payload && payload.track, payload && payload.track_info, payload && payload.trackInfo);
      }
      function qishuiTrackPlayerFromV2(payload, track) {
        const data = payload && payload.data || payload || {};
        return pickObject(
          data.track_player,
          data.trackPlayer,
          payload && payload.track_player,
          payload && payload.trackPlayer,
          track && track.track_player,
          track && track.trackPlayer
        );
      }
      function qishuiAudioEffectKeysFromV2(payload, track) {
        const player = qishuiTrackPlayerFromV2(payload, track) || {};
        const raw = player.audio_effects || player.audioEffects || track && (track.audio_effects || track.audioEffects) || {};
        let effects = raw;
        if (typeof effects === "string") effects = qishuiMaybeParseJson(effects);
        if (!effects || typeof effects !== "object" || Array.isArray(effects)) return [];
        return Object.keys(effects).map((key) => normalizeText(key)).filter((key, index, list) => key && key.length <= 64 && list.indexOf(key) === index).slice(0, 32);
      }
      async function fetchQishuiPcTrackV2Post(trackId, cookieText) {
        const body = JSON.stringify({
          track_id: trackId,
          media_type: "track",
          queue_type: "favorite_track_playlist",
          scene_name: "library"
        });
        const json = await qishuiWebRequestJson("/luna/pc/track_v2", qishuiPcAppParams(), cookieText, {
          bases: [QISHUI_WEB_PC_API_BASE],
          noDefaultParams: true,
          sessionOnly: true,
          pcApp: true,
          method: "POST",
          body,
          referer: "https://www.qishui.com/",
          timeoutMs: 1e4
        });
        const err = qishuiPcStatusError(json, "QISHUI_PC_TRACK_V2_FAILED");
        if (err) throw err;
        return json;
      }
      async function fetchQishuiPcTrackV2Get(trackId, cookieText) {
        const json = await qishuiWebRequestJson("/luna/pc/track_v2", qishuiPcAppParams({
          track_id: trackId,
          media_type: "track"
        }), cookieText, {
          bases: [QISHUI_WEB_PC_API_BASE],
          noDefaultParams: true,
          sessionOnly: true,
          pcApp: true,
          referer: "https://www.qishui.com/",
          timeoutMs: 1e4
        });
        const err = qishuiPcStatusError(json, "QISHUI_PC_TRACK_V2_GET_FAILED");
        if (err) throw err;
        return json;
      }
      async function fetchQishuiPcTrackV2(trackId, cookieText) {
        const cookie = normalizeQishuiCookieInput(cookieText);
        const cacheKey = "track-v2-meta|" + qishuiCookieFingerprint(cookie) + "|" + normalizeText(trackId);
        return qishuiTrackMetadataCache.wrap(cacheKey, 20 * 1e3, async () => {
          try {
            return await fetchQishuiPcTrackV2Post(trackId, cookie);
          } catch (postError) {
            try {
              return await fetchQishuiPcTrackV2Get(trackId, cookie);
            } catch (getError) {
              getError.postError = postError && postError.message || String(postError);
              throw getError;
            }
          }
        });
      }
      function qishuiDiagPlayerInfoStreams(list, context) {
        try {
          const items = (list || []).slice(0, 20).map((item) => {
            if (!item || typeof item !== "object") return null;
            const q = normalizeText(
              qishuiObjectString(item, ["quality", "Quality", "definition", "Definition", "quality_type", "QualityType", "gear_des_key", "GearDesKey"]) || ""
            );
            const fmt = normalizeText(qishuiObjectString(item, ["format", "Format", "vtype", "VType", "file_format", "FileFormat"]) || "");
            const br = qishuiNormalizeBitrateKbps(
              qishuiObjectNumber(item, ["bitrate", "Bitrate", "real_bitrate", "RealBitrate", "br", "BR", "bit_rate", "BitRate"]) || 0
            );
            const dur = qishuiNormalizeDurationSeconds(qishuiObjectNumber(item, ["duration", "Duration"]) || 0);
            return { quality: q, format: fmt, bitrate: br, duration: dur, hasUrl: !!qishuiStreamUrlFrom(item) };
          }).filter(Boolean);
          qishuiDiagLog("player_info_streams", Object.assign({
            listLen: list.length,
            items
          }, context || {}));
        } catch (e) {
          qishuiDiagLog("player_info_streams_error", { message: String(e && e.message || e) });
        }
      }
      async function fetchQishuiPlayerInfoStreams(playerInfoUrl, cookieText) {
        playerInfoUrl = normalizeText(playerInfoUrl);
        if (!/^https?:\/\//i.test(playerInfoUrl)) return [];
        const json = await requestJson(playerInfoUrl, {
          timeoutMs: 1e4,
          headers: qishuiHeadersWithCookie({
            "Accept": "application/json,text/plain,*/*",
            "User-Agent": QISHUI_WEB_UA,
            "Referer": "https://api.qishui.com/"
          }, cookieText)
        });
        const result = pickObject(json && json.Result, json && json.result);
        const data = pickObject(result.Data, result.data, json && json.Data, json && json.data);
        const list = pickArray(data.PlayInfoList, data.playInfoList, data.play_info_list, json && json.PlayInfoList);
        qishuiDiagPlayerInfoStreams(list, { source: "fetchQishuiPlayerInfoStreams" });
        const streams = list.map((item) => qishuiStreamFromObject(item)).filter(Boolean);
        if (streams.length) return streams;
        const error = pickObject(json && json.ResponseMetadata && json.ResponseMetadata.Error, json && json.responseMetadata && json.responseMetadata.error);
        if (error && (error.Message || error.message)) throw new Error(normalizeText(error.Message || error.message));
        return [];
      }
      function qishuiDiagTrackV2Shape(payload) {
        try {
          const track = qishuiPrimaryTrackFromV2(payload) || {};
          const player = qishuiTrackPlayerFromV2(payload, track) || {};
          const audioInfo = pickObject(track.audio_info, track.audioInfo, payload && payload.audio_info, payload && payload.audioInfo) || {};
          const playInfoList = pickArray(audioInfo.play_info_list, audioInfo.PlayInfoList, audioInfo.playInfoList) || [];
          const playerPlayInfoList = pickArray(player.play_info_list, player.PlayInfoList, player.playInfoList) || [];
          const bitRates = pickArray(
            track.bit_rates,
            track.bitRates,
            audioInfo.bit_rates,
            audioInfo.bitRates,
            payload && payload.bit_rates,
            payload && payload.bitRates
          ) || [];
          const videoModelRaw = player.video_model || player.VideoModel || player.videoModel || track.video_model || track.VideoModel || payload && payload.video_model || "";
          const labelinfo = pickObject(track.label_info, track.labelinfo, track.labelInfo, payload.label_info, payload.labelinfo, payload.labelInfo) || {};
          const qualitymap = pickObject(labelinfo.qualitymap, labelinfo.qualityMap, labelinfo.quality_map) || {};
          const spatialKeys = [];
          const walkKeys = (node, path2) => {
            if (!node || typeof node !== "object" || path2.length > 6) return;
            if (Array.isArray(node)) {
              node.slice(0, 60).forEach((it, i) => walkKeys(it, path2.concat("[" + i + "]")));
              return;
            }
            for (const k of Object.keys(node).slice(0, 150)) {
              const lk = String(k).toLowerCase();
              if (/spatial|atmos|dolby|immersive/.test(lk)) spatialKeys.push(path2.concat(k).join("."));
              walkKeys(node[k], path2.concat(k));
            }
          };
          walkKeys(payload, []);
          const qualityOf = (it) => qishuiObjectString(it, ["quality", "Quality", "definition", "Definition", "quality_type", "QualityType", "gear_des_key", "GearDesKey"]) || "";
          const vm = qishuiMaybeParseJson(videoModelRaw);
          const vmInfo = typeof vm === "string" ? { vmType: "string-unparsed", vmLen: vm.length } : vm && typeof vm === "object" ? { vmType: "object", vmKeys: Object.keys(vm).slice(0, 30) } : { vmType: typeof vm };
          const sanitizeSample = (it) => {
            if (!it || typeof it !== "object") return it;
            const out = {};
            Object.keys(it).slice(0, 40).forEach((k) => {
              const lk = String(k).toLowerCase();
              if (/url|auth|token|cookie|key|secret|signature|spade/i.test(lk)) return;
              const v = it[k];
              if (v && typeof v === "object") {
                out[k] = Object.keys(v).slice(0, 10);
              } else if (typeof v === "string" && v.length > 80) {
                out[k] = v.slice(0, 40) + "...";
              } else {
                out[k] = v;
              }
            });
            return out;
          };
          const bitRateSamples = bitRates.slice(0, 3).map(sanitizeSample);
          const bitRateKeys = bitRates.length ? Object.keys(bitRates[0]).slice(0, 40) : [];
          const hasUrlInBitRates = bitRates.some((it) => !!qishuiStreamUrlFrom(it));
          qishuiDiagLog("track_v2_shape", {
            trackId: String(track.id || track.track_id || payload && payload.track_id || "").slice(0, 24),
            audioInfoKeys: Object.keys(audioInfo),
            playInfoListLen: playInfoList.length,
            playInfoQualities: playInfoList.map(qualityOf).filter(Boolean),
            playerPlayInfoListLen: playerPlayInfoList.length,
            playerPlayInfoQualities: playerPlayInfoList.map(qualityOf).filter(Boolean),
            bitRatesLen: bitRates.length,
            bitRateKeys,
            bitRateQualities: bitRates.map(qualityOf).filter(Boolean),
            bitRateSamples,
            hasUrlInBitRates,
            vmInfo,
            qualitymapKeys: Object.keys(qualitymap),
            trackSpatialKeys: Object.keys(track).filter((k) => /spatial|atmos|dolby/i.test(k)),
            spatialKeysFound: spatialKeys.slice(0, 40)
          });
        } catch (e) {
          qishuiDiagLog("track_v2_shape_error", { message: String(e && e.message || e) });
        }
      }
      function collectQishuiTrackV2Streams(payload) {
        qishuiDiagTrackV2Shape(payload);
        const track = qishuiPrimaryTrackFromV2(payload);
        const player = qishuiTrackPlayerFromV2(payload, track);
        const audioInfo = pickObject(track.audio_info, track.audioInfo, payload && payload.audio_info, payload && payload.audioInfo);
        const playInfoList = pickArray(audioInfo.play_info_list, audioInfo.PlayInfoList, audioInfo.playInfoList);
        const streams = playInfoList.map((item) => qishuiStreamFromObject(item)).filter(Boolean);
        const videoModel = player.video_model || player.VideoModel || player.videoModel || track.video_model || track.VideoModel || "";
        qishuiCollectVideoModelStreams(videoModel, "", {}, streams);
        const bitRates = pickArray(
          track.bit_rates,
          track.bitRates,
          audioInfo.bit_rates,
          audioInfo.bitRates,
          payload && payload.bit_rates,
          payload && payload.bitRates
        );
        const fallbackStreams = bitRates.map((item) => qishuiStreamFromObject(item)).filter(Boolean);
        return { track, player, streams, fallbackStreams };
      }
      async function resolveQishuiDownloadInfo(trackId, payload, cookieText, membership, requestedQuality) {
        const collected = collectQishuiTrackV2Streams(payload);
        const playerInfoUrl = qishuiObjectString(collected.player, ["url_player_info", "URLPlayerInfo", "urlPlayerInfo"]);
        if (playerInfoUrl) {
          try {
            const streams = await fetchQishuiPlayerInfoStreams(playerInfoUrl, cookieText);
            if (streams.length) collected.streams.push(...streams);
          } catch (err) {
            collected.playerInfoError = err && err.message || String(err);
          }
        }
        const needVipMap = qishuiQualityMapNeedVip(payload);
        const allStreams = (collected.streams || []).concat(collected.fallbackStreams || []);
        const requestedTier = requestedQuality ? qishuiNormalizeAppQuality(requestedQuality) : "";
        let best = null;
        if (requestedTier && allStreams.length) {
          const matched = allStreams.filter((s) => qishuiStreamAppTier(s) === requestedTier);
          const allowed = matched.filter((s) => qishuiStreamAllowedWithMap(s, membership, needVipMap));
          if (allowed.length) best = qishuiBestStreamCandidate(allowed);
        }
        if (!best) {
          best = qishuiBestForMembershipMap(collected.streams, membership, needVipMap) || qishuiBestForMembershipMap(collected.fallbackStreams, membership, needVipMap);
        }
        if (!best) {
          const unrestricted = qishuiBestStreamCandidate(collected.streams) || qishuiBestStreamCandidate(collected.fallbackStreams);
          const requiredTier = unrestricted ? qishuiStreamRequiredTier(unrestricted) : "free";
          const entitlementLimited = !!(unrestricted && !qishuiRequiredTierAllowed(requiredTier, membership));
          let errorCode = "QISHUI_AUDIO_SOURCE_EMPTY";
          if (entitlementLimited && !(membership && membership.membershipKnown)) {
            errorCode = "QISHUI_MEMBERSHIP_UNKNOWN";
          } else if (entitlementLimited && requiredTier === "svip") {
            errorCode = "QISHUI_SVIP_REQUIRED";
          } else if (entitlementLimited && requiredTier === "vip") {
            errorCode = "QISHUI_VIP_REQUIRED";
          }
          const err = new Error(errorCode === "QISHUI_AUDIO_SOURCE_EMPTY" ? collected.playerInfoError || errorCode : errorCode);
          err.code = errorCode;
          err.requiredTier = requiredTier;
          throw err;
        }
        const availableQualities = qishuiBuildAvailableQualities(allStreams, needVipMap);
        qishuiDiagLog("resolve_streams", {
          trackId: String(collected.track && (collected.track.id || collected.track.track_id) || "").slice(0, 24),
          requestedTier,
          streamCount: (collected.streams || []).length,
          fallbackCount: (collected.fallbackStreams || []).length,
          allStreamTiers: allStreams.map((s) => ({
            tier: qishuiStreamAppTier(s),
            quality: String(s.quality || "").slice(0, 24),
            format: String(s.format || "").slice(0, 16),
            br: qishuiNormalizeBitrateKbps(s.bitrate),
            hasUrl: !!s.url
          })),
          bestTier: best ? qishuiStreamAppTier(best) : null,
          bestQuality: best ? String(best.quality || "").slice(0, 24) : null,
          bestFormat: best ? String(best.format || "").slice(0, 16) : null,
          bestBr: best ? qishuiNormalizeBitrateKbps(best.bitrate) : 0,
          availableQualities
        });
        return Object.assign(collected, { best, availableQualities });
      }
      function qishuiQualityMapNeedVip(payload) {
        const track = qishuiPrimaryTrackFromV2(payload) || {};
        const labelinfo = pickObject(track.label_info, track.labelinfo, track.labelInfo, payload.label_info, payload.labelinfo, payload.labelInfo) || {};
        const qualitymap = pickObject(labelinfo.qualitymap, labelinfo.qualityMap, labelinfo.quality_map) || {};
        const APP_TO_QS = {
          standard: ["medium", "higher", "standard"],
          exhigh: ["highest", "high", "exhigh"],
          lossless: ["lossless", "sq"],
          hires: ["hires", "hi-res", "hi_res", "highres", "master"],
          atmos: ["spatial", "atmos", "dolby"]
        };
        const VIP_KEYS = ["needvip", "needVip", "need_vip", "vipRequired", "vip_required", "viprequired"];
        const map = {};
        Object.keys(APP_TO_QS).forEach((appTier) => {
          let need = false;
          let known = false;
          APP_TO_QS[appTier].forEach((qsKey) => {
            const entry = qualitymap[qsKey] || qualitymap[String(qsKey).toLowerCase()];
            if (!entry || typeof entry !== "object") return;
            const pd = pickObject(entry.playdetail, entry.play_detail, entry.playDetail, entry.PlayDetail) || {};
            VIP_KEYS.forEach((k) => {
              if (!Object.prototype.hasOwnProperty.call(pd, k)) return;
              known = true;
              const raw = qishuiObjectString(pd, [k]);
              if (raw === "1" || raw === "true" || raw === true) need = true;
              if (qishuiExplicitPositive(pd && pd[k])) need = true;
            });
          });
          if (known) map[appTier] = need;
        });
        return map;
      }
      function qishuiStreamEffRequiredTier(stream, needVipMap) {
        const tier = qishuiStreamAppTier(stream);
        let requiredTier = qishuiStreamRequiredTier(stream);
        if (needVipMap && Object.prototype.hasOwnProperty.call(needVipMap, tier)) {
          requiredTier = qishuiHigherRequiredTier(requiredTier, needVipMap[tier] ? "vip" : "free");
        }
        return requiredTier;
      }
      function qishuiStreamAllowedWithMap(stream, membership, needVipMap) {
        if (!stream || !stream.url) return false;
        return qishuiRequiredTierAllowed(qishuiStreamEffRequiredTier(stream, needVipMap), membership);
      }
      function qishuiBestForMembershipMap(candidates, membership, needVipMap) {
        return qishuiBestStreamCandidate((candidates || []).filter((s) => qishuiStreamAllowedWithMap(s, membership, needVipMap)));
      }
      function qishuiBuildAvailableQualities(streams, needVipMap) {
        const tiers = ["standard", "exhigh", "lossless", "hires", "atmos"];
        const byTier = {};
        (streams || []).forEach((s) => {
          const tier = qishuiStreamAppTier(s);
          if (!tier) return;
          if (!byTier[tier]) byTier[tier] = { key: tier, br: 0, requiredTier: "free" };
          const br = qishuiNormalizeBitrateKbps(s.bitrate);
          if (br > byTier[tier].br) byTier[tier].br = br;
          const streamTier = qishuiStreamEffRequiredTier(s, needVipMap);
          if (QISHUI_TIER_RANK[streamTier] > QISHUI_TIER_RANK[byTier[tier].requiredTier]) {
            byTier[tier].requiredTier = streamTier;
          }
        });
        return tiers.map((t) => {
          const info = byTier[t];
          let requiredTier = needVipMap && needVipMap[t] ? "vip" : "free";
          if (info && QISHUI_TIER_RANK[info.requiredTier] > QISHUI_TIER_RANK[requiredTier]) {
            requiredTier = info.requiredTier;
          }
          return {
            key: t,
            present: !!info,
            requiredTier,
            needvip: requiredTier !== "free",
            br: info ? info.br * 1e3 : 0
          };
        });
      }
      function qishuiUrlWithAuth(url, auth) {
        url = normalizeText(url);
        auth = normalizeText(auth);
        if (!url || !auth || /#auth=/.test(url)) return url;
        return url + "#auth=" + encodeURIComponent(auth);
      }
      async function handleQishuiSongUrl(opts, cookieText) {
        opts = opts && typeof opts === "object" ? opts : { id: opts };
        const id = normalizeText(opts.id || opts.trackId || opts.track_id || "");
        const cookie = normalizeQishuiCookieInput(cookieText || opts.cookie || "");
        if (!id) return qishuiUnavailable("Missing Qishui track id", "missing_id", { loggedIn: qishuiCookieHasLogin(cookie), playbackKeyReady: false });
        if (!qishuiCookieHasLogin(cookie)) {
          return qishuiUnavailable("Qishui playback requires the local SodaMusic PC login state.", "login_required", {
            loggedIn: false,
            playbackKeyReady: false
          });
        }
        const requestedQuality = normalizeText(opts.quality || "");
        let payload;
        try {
          payload = await fetchQishuiPcTrackV2(id, cookie);
        } catch (err) {
          return qishuiUnavailable("Qishui did not return track playback metadata: " + (err && err.message || String(err)), "source_unavailable", {
            loggedIn: true,
            playbackKeyReady: false,
            membershipKnown: false,
            vipType: 0,
            vipLevel: "none",
            isVip: false,
            isSvip: false,
            vipLabel: "无VIP",
            rawError: err && err.message || String(err)
          });
        }
        let membership = qishuiPlaybackMembershipFromPayload(payload);
        if (!membership.membershipKnown) membership = await fetchQishuiPlaybackMembership(cookie);
        const membershipKey = membership.isSvip ? "svip" : membership.isVip ? "vip" : membership.membershipKnown ? "free" : "unknown";
        const cacheKey = "track-v2|" + qishuiCookieFingerprint(cookie) + "|" + membershipKey + "|" + id + "|" + requestedQuality;
        return qishuiPlaybackCache.wrap(cacheKey, 4 * 60 * 1e3, async () => {
          try {
            const resolved = await resolveQishuiDownloadInfo(id, payload, cookie, membership, requestedQuality);
            const track = resolved.track || {};
            const stream = resolved.best;
            const duration = stream.duration || qishuiNormalizeDurationSeconds(track.duration_ms || track.duration || 0);
            const level = qishuiStreamAppTier(stream);
            const fullDuration = qishuiNormalizeDurationSeconds(track.duration_ms || track.duration || 0);
            const availableQualities = resolved.availableQualities || [];
            const audioEffectKeys = qishuiAudioEffectKeysFromV2(payload, track);
            const QISHUI_QUALITY_RANK = { standard: 1, exhigh: 2, lossless: 3, hires: 4, atmos: 5 };
            let qualityCeiling = "";
            availableQualities.forEach((q) => {
              if (q.present && qishuiRequiredTierAllowed(q.requiredTier, membership)) {
                if ((QISHUI_QUALITY_RANK[q.key] || 0) > (QISHUI_QUALITY_RANK[qualityCeiling] || 0)) qualityCeiling = q.key;
              }
            });
            const trial = !!(duration > 0 && fullDuration > 0 && duration + 5 < fullDuration);
            return {
              provider: "qishui",
              playbackMode: "direct-url",
              url: qishuiUrlWithAuth(stream.url, stream.auth),
              playable: true,
              trial,
              loggedIn: true,
              playbackKeyReady: true,
              membershipKnown: !!membership.membershipKnown,
              vipType: membership.vipType || 0,
              vipLevel: membership.vipLevel || "none",
              isVip: !!membership.isVip,
              isSvip: !!membership.isSvip,
              vipLabel: membership.vipLabel || (membership.isVip ? "VIP" : "无VIP"),
              level,
              availableQualities,
              qualityCeiling,
              quality: normalizeText(stream.quality || stream.format || level),
              requiredTier: qishuiStreamRequiredTier(stream),
              audioEffectKeys,
              intelligentAudioEffectAvailable: audioEffectKeys.indexOf("intelligent") >= 0,
              br: qishuiBitrateForUi(stream.bitrate),
              size: Number(stream.size) || 0,
              duration,
              requestedQuality,
              source: "qishui-pc-track-v2",
              encrypted: !!stream.auth
            };
          } catch (err) {
            const entitlementReason = err && err.code === "QISHUI_MEMBERSHIP_UNKNOWN" ? "membership_unknown" : err && err.code === "QISHUI_SVIP_REQUIRED" ? "svip_required" : err && err.code === "QISHUI_VIP_REQUIRED" ? "vip_required" : "";
            const message = entitlementReason === "membership_unknown" ? "汽水音乐暂时无法验证当前账号的会员状态，请稍后重试。" : entitlementReason === "svip_required" ? "汽水音乐仅返回了需要 SVIP 权益的音质。" : entitlementReason === "vip_required" ? "汽水音乐仅返回了需要 VIP 权益的音质。" : "Qishui did not return a playable audio source: " + (err && err.message || String(err));
            return qishuiUnavailable(
              message,
              entitlementReason || "source_unavailable",
              {
                loggedIn: true,
                playbackKeyReady: true,
                requiredTier: err && err.requiredTier || "free",
                membershipKnown: !!membership.membershipKnown,
                vipType: membership.vipType || 0,
                vipLevel: membership.vipLevel || "none",
                isVip: !!membership.isVip,
                isSvip: !!membership.isSvip,
                vipLabel: membership.vipLabel || (membership.isVip ? "VIP" : "无VIP"),
                rawError: err && err.message || String(err)
              }
            );
          }
        });
      }
      async function qishuiAlbumDetailFromSeoTrack(albumId, trackId) {
        const track = qishuiSeoTrackFromPayload(await fetchQishuiSeoTrack(trackId));
        const song = qishuiSongFromSeoTrack(track, trackId);
        if (!song || !song.albumId || albumId && song.albumId !== albumId) return null;
        return {
          provider: "qishui",
          source: "qishui-public-seo",
          partial: true,
          album: {
            provider: "qishui",
            id: song.albumId,
            albumId: song.albumId,
            name: song.album || "未知专辑",
            artist: song.artist,
            cover: song.cover,
            type: "album"
          },
          songs: [song]
        };
      }
      async function handleQishuiAlbumDetail(albumId, cookieText, limit, trackId) {
        const id = normalizeText(albumId);
        const num = Math.max(10, Math.min(120, parseInt(limit || "80", 10) || 80));
        if (!id && !normalizeText(trackId)) return { provider: "qishui", error: "MISSING_ALBUM_ID", album: null, songs: [] };
        let officialError = "";
        try {
          const cookie = normalizeQishuiCookieInput(cookieText);
          if (qishuiCookieHasLogin(cookie) && id) {
            const json = await qishuiWebRequestJson("/luna/pc/album/detail", qishuiPcAppParams({
              id,
              album_id: id,
              albumId: id,
              cursor: 0,
              count: num,
              cnt: num
            }), cookie, {
              bases: [QISHUI_WEB_PC_API_BASE],
              noDefaultParams: true,
              sessionOnly: true,
              pcApp: true,
              referer: "https://www.qishui.com/",
              timeoutMs: 9e3
            });
            const data = json && json.data || json || {};
            const album = pickObject(
              data.album,
              data.info,
              data.album_info,
              data.album_detail,
              json && json.album,
              json && json.album_info
            );
            const rawSongs = extractQishuiMediaList(json);
            const songs = mapQishuiMediaList(rawSongs, "qishui-album", { directPlayable: false }).slice(0, num);
            if (songs.length) {
              return {
                provider: "qishui",
                album: {
                  provider: "qishui",
                  id,
                  albumId: id,
                  name: normalizeText(album.name || album.title || album.album_name || album.albumName || ""),
                  artist: normalizeText(album.artist || album.artist_name || album.artistName || ""),
                  cover: qishuiFirstImageUrl("~c5_375x375.jpg", album.cover_url, album.cover, album.cover_uri, album.url_cover, album.img),
                  type: "album"
                },
                songs
              };
            }
            officialError = "QISHUI_ALBUM_DETAIL_EMPTY";
          } else {
            officialError = "QISHUI_COOKIE_REQUIRED";
          }
        } catch (e) {
          officialError = e.message || "QISHUI_ALBUM_DETAIL_FAILED";
        }
        if (trackId) {
          try {
            const fallback = await qishuiAlbumDetailFromSeoTrack(id, normalizeText(trackId));
            if (fallback) return Object.assign(fallback, { officialError });
          } catch (e) {
            officialError = officialError || e.message || "QISHUI_PUBLIC_DETAIL_FAILED";
          }
        }
        return { provider: "qishui", error: officialError || "QISHUI_ALBUM_DETAIL_FAILED", album: null, songs: [] };
      }
      module.exports = {
        getQishuiStatus,
        handleQishuiStatus,
        normalizeQishuiCookieInput,
        qishuiCookieHasLogin,
        getQishuiOAuthConfig,
        buildQishuiOAuthAuthorizeUrl,
        exchangeQishuiOAuthCode,
        saveQishuiAccessToken,
        clearQishuiAccessToken,
        handleQishuiSearch,
        handleQishuiArtistDetail,
        handleQishuiSongDetail,
        handleQishuiAlbumDetail,
        handleQishuiFeed,
        handleQishuiUserPlaylists,
        handleQishuiPlaylistTracks,
        handleQishuiCheckTracksLiked,
        handleQishuiSetTrackLiked,
        handleQishuiSetPlaylistCollected,
        handleQishuiPlaylistAddSong,
        handleQishuiSetAlbumCollected,
        handleQishuiReportRecentlyPlayed,
        handleQishuiComments,
        handleQishuiCreateComment,
        handleQishuiLyric,
        handleQishuiSongUrl,
        qishuiUnavailable,
        _test: {
          qishuiPublicSearchScore,
          rankQishuiPublicSongs,
          qishuiConvertLyric,
          extractQishuiLyrics,
          collectQishuiTrackV2Streams,
          qishuiMembershipFromData,
          qishuiPlaybackMembershipFromPayload,
          qishuiMembershipCacheTtlMs,
          qishuiUnknownMembership,
          qishuiApplyMembershipObservation,
          qishuiTrackPlaybackRestriction,
          qishuiTrackRequiresVip,
          qishuiStreamRequiredTier,
          qishuiStreamAppTier,
          qishuiQualityMapNeedVip,
          qishuiStreamEffRequiredTier,
          qishuiBuildAvailableQualities,
          qishuiMembershipTier,
          qishuiRequiredTierAllowed,
          qishuiStreamAllowedForMembership,
          qishuiBestStreamCandidateForMembership,
          qishuiAudioEffectKeysFromV2,
          clearQishuiRuntimeCaches
        }
      };
    }
  });

  // ../../node_modules/qrcode/lib/can-promise.js
  var require_can_promise = __commonJS({
    "../../node_modules/qrcode/lib/can-promise.js"(exports, module) {
      init_globals();
      module.exports = function() {
        return typeof Promise === "function" && Promise.prototype && Promise.prototype.then;
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/utils.js
  var require_utils = __commonJS({
    "../../node_modules/qrcode/lib/core/utils.js"(exports) {
      init_globals();
      var toSJISFunction;
      var CODEWORDS_COUNT = [
        0,
        // Not used
        26,
        44,
        70,
        100,
        134,
        172,
        196,
        242,
        292,
        346,
        404,
        466,
        532,
        581,
        655,
        733,
        815,
        901,
        991,
        1085,
        1156,
        1258,
        1364,
        1474,
        1588,
        1706,
        1828,
        1921,
        2051,
        2185,
        2323,
        2465,
        2611,
        2761,
        2876,
        3034,
        3196,
        3362,
        3532,
        3706
      ];
      exports.getSymbolSize = function getSymbolSize(version) {
        if (!version) throw new Error('"version" cannot be null or undefined');
        if (version < 1 || version > 40) throw new Error('"version" should be in range from 1 to 40');
        return version * 4 + 17;
      };
      exports.getSymbolTotalCodewords = function getSymbolTotalCodewords(version) {
        return CODEWORDS_COUNT[version];
      };
      exports.getBCHDigit = function(data) {
        let digit = 0;
        while (data !== 0) {
          digit++;
          data >>>= 1;
        }
        return digit;
      };
      exports.setToSJISFunction = function setToSJISFunction(f) {
        if (typeof f !== "function") {
          throw new Error('"toSJISFunc" is not a valid function.');
        }
        toSJISFunction = f;
      };
      exports.isKanjiModeEnabled = function() {
        return typeof toSJISFunction !== "undefined";
      };
      exports.toSJIS = function toSJIS(kanji) {
        return toSJISFunction(kanji);
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/error-correction-level.js
  var require_error_correction_level = __commonJS({
    "../../node_modules/qrcode/lib/core/error-correction-level.js"(exports) {
      init_globals();
      exports.L = { bit: 1 };
      exports.M = { bit: 0 };
      exports.Q = { bit: 3 };
      exports.H = { bit: 2 };
      function fromString(string) {
        if (typeof string !== "string") {
          throw new Error("Param is not a string");
        }
        const lcStr = string.toLowerCase();
        switch (lcStr) {
          case "l":
          case "low":
            return exports.L;
          case "m":
          case "medium":
            return exports.M;
          case "q":
          case "quartile":
            return exports.Q;
          case "h":
          case "high":
            return exports.H;
          default:
            throw new Error("Unknown EC Level: " + string);
        }
      }
      exports.isValid = function isValid(level) {
        return level && typeof level.bit !== "undefined" && level.bit >= 0 && level.bit < 4;
      };
      exports.from = function from2(value, defaultValue) {
        if (exports.isValid(value)) {
          return value;
        }
        try {
          return fromString(value);
        } catch (e) {
          return defaultValue;
        }
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/bit-buffer.js
  var require_bit_buffer = __commonJS({
    "../../node_modules/qrcode/lib/core/bit-buffer.js"(exports, module) {
      init_globals();
      function BitBuffer() {
        this.buffer = [];
        this.length = 0;
      }
      BitBuffer.prototype = {
        get: function(index) {
          const bufIndex = Math.floor(index / 8);
          return (this.buffer[bufIndex] >>> 7 - index % 8 & 1) === 1;
        },
        put: function(num, length) {
          for (let i = 0; i < length; i++) {
            this.putBit((num >>> length - i - 1 & 1) === 1);
          }
        },
        getLengthInBits: function() {
          return this.length;
        },
        putBit: function(bit) {
          const bufIndex = Math.floor(this.length / 8);
          if (this.buffer.length <= bufIndex) {
            this.buffer.push(0);
          }
          if (bit) {
            this.buffer[bufIndex] |= 128 >>> this.length % 8;
          }
          this.length++;
        }
      };
      module.exports = BitBuffer;
    }
  });

  // ../../node_modules/qrcode/lib/core/bit-matrix.js
  var require_bit_matrix = __commonJS({
    "../../node_modules/qrcode/lib/core/bit-matrix.js"(exports, module) {
      init_globals();
      function BitMatrix(size) {
        if (!size || size < 1) {
          throw new Error("BitMatrix size must be defined and greater than 0");
        }
        this.size = size;
        this.data = new Uint8Array(size * size);
        this.reservedBit = new Uint8Array(size * size);
      }
      BitMatrix.prototype.set = function(row, col, value, reserved) {
        const index = row * this.size + col;
        this.data[index] = value;
        if (reserved) this.reservedBit[index] = true;
      };
      BitMatrix.prototype.get = function(row, col) {
        return this.data[row * this.size + col];
      };
      BitMatrix.prototype.xor = function(row, col, value) {
        this.data[row * this.size + col] ^= value;
      };
      BitMatrix.prototype.isReserved = function(row, col) {
        return this.reservedBit[row * this.size + col];
      };
      module.exports = BitMatrix;
    }
  });

  // ../../node_modules/qrcode/lib/core/alignment-pattern.js
  var require_alignment_pattern = __commonJS({
    "../../node_modules/qrcode/lib/core/alignment-pattern.js"(exports) {
      init_globals();
      var getSymbolSize = require_utils().getSymbolSize;
      exports.getRowColCoords = function getRowColCoords(version) {
        if (version === 1) return [];
        const posCount = Math.floor(version / 7) + 2;
        const size = getSymbolSize(version);
        const intervals = size === 145 ? 26 : Math.ceil((size - 13) / (2 * posCount - 2)) * 2;
        const positions = [size - 7];
        for (let i = 1; i < posCount - 1; i++) {
          positions[i] = positions[i - 1] - intervals;
        }
        positions.push(6);
        return positions.reverse();
      };
      exports.getPositions = function getPositions(version) {
        const coords = [];
        const pos = exports.getRowColCoords(version);
        const posLength = pos.length;
        for (let i = 0; i < posLength; i++) {
          for (let j = 0; j < posLength; j++) {
            if (i === 0 && j === 0 || // top-left
            i === 0 && j === posLength - 1 || // bottom-left
            i === posLength - 1 && j === 0) {
              continue;
            }
            coords.push([pos[i], pos[j]]);
          }
        }
        return coords;
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/finder-pattern.js
  var require_finder_pattern = __commonJS({
    "../../node_modules/qrcode/lib/core/finder-pattern.js"(exports) {
      init_globals();
      var getSymbolSize = require_utils().getSymbolSize;
      var FINDER_PATTERN_SIZE = 7;
      exports.getPositions = function getPositions(version) {
        const size = getSymbolSize(version);
        return [
          // top-left
          [0, 0],
          // top-right
          [size - FINDER_PATTERN_SIZE, 0],
          // bottom-left
          [0, size - FINDER_PATTERN_SIZE]
        ];
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/mask-pattern.js
  var require_mask_pattern = __commonJS({
    "../../node_modules/qrcode/lib/core/mask-pattern.js"(exports) {
      init_globals();
      exports.Patterns = {
        PATTERN000: 0,
        PATTERN001: 1,
        PATTERN010: 2,
        PATTERN011: 3,
        PATTERN100: 4,
        PATTERN101: 5,
        PATTERN110: 6,
        PATTERN111: 7
      };
      var PenaltyScores = {
        N1: 3,
        N2: 3,
        N3: 40,
        N4: 10
      };
      exports.isValid = function isValid(mask) {
        return mask != null && mask !== "" && !isNaN(mask) && mask >= 0 && mask <= 7;
      };
      exports.from = function from2(value) {
        return exports.isValid(value) ? parseInt(value, 10) : void 0;
      };
      exports.getPenaltyN1 = function getPenaltyN1(data) {
        const size = data.size;
        let points = 0;
        let sameCountCol = 0;
        let sameCountRow = 0;
        let lastCol = null;
        let lastRow = null;
        for (let row = 0; row < size; row++) {
          sameCountCol = sameCountRow = 0;
          lastCol = lastRow = null;
          for (let col = 0; col < size; col++) {
            let module2 = data.get(row, col);
            if (module2 === lastCol) {
              sameCountCol++;
            } else {
              if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
              lastCol = module2;
              sameCountCol = 1;
            }
            module2 = data.get(col, row);
            if (module2 === lastRow) {
              sameCountRow++;
            } else {
              if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
              lastRow = module2;
              sameCountRow = 1;
            }
          }
          if (sameCountCol >= 5) points += PenaltyScores.N1 + (sameCountCol - 5);
          if (sameCountRow >= 5) points += PenaltyScores.N1 + (sameCountRow - 5);
        }
        return points;
      };
      exports.getPenaltyN2 = function getPenaltyN2(data) {
        const size = data.size;
        let points = 0;
        for (let row = 0; row < size - 1; row++) {
          for (let col = 0; col < size - 1; col++) {
            const last = data.get(row, col) + data.get(row, col + 1) + data.get(row + 1, col) + data.get(row + 1, col + 1);
            if (last === 4 || last === 0) points++;
          }
        }
        return points * PenaltyScores.N2;
      };
      exports.getPenaltyN3 = function getPenaltyN3(data) {
        const size = data.size;
        let points = 0;
        let bitsCol = 0;
        let bitsRow = 0;
        for (let row = 0; row < size; row++) {
          bitsCol = bitsRow = 0;
          for (let col = 0; col < size; col++) {
            bitsCol = bitsCol << 1 & 2047 | data.get(row, col);
            if (col >= 10 && (bitsCol === 1488 || bitsCol === 93)) points++;
            bitsRow = bitsRow << 1 & 2047 | data.get(col, row);
            if (col >= 10 && (bitsRow === 1488 || bitsRow === 93)) points++;
          }
        }
        return points * PenaltyScores.N3;
      };
      exports.getPenaltyN4 = function getPenaltyN4(data) {
        let darkCount = 0;
        const modulesCount = data.data.length;
        for (let i = 0; i < modulesCount; i++) darkCount += data.data[i];
        const k = Math.abs(Math.ceil(darkCount * 100 / modulesCount / 5) - 10);
        return k * PenaltyScores.N4;
      };
      function getMaskAt(maskPattern, i, j) {
        switch (maskPattern) {
          case exports.Patterns.PATTERN000:
            return (i + j) % 2 === 0;
          case exports.Patterns.PATTERN001:
            return i % 2 === 0;
          case exports.Patterns.PATTERN010:
            return j % 3 === 0;
          case exports.Patterns.PATTERN011:
            return (i + j) % 3 === 0;
          case exports.Patterns.PATTERN100:
            return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
          case exports.Patterns.PATTERN101:
            return i * j % 2 + i * j % 3 === 0;
          case exports.Patterns.PATTERN110:
            return (i * j % 2 + i * j % 3) % 2 === 0;
          case exports.Patterns.PATTERN111:
            return (i * j % 3 + (i + j) % 2) % 2 === 0;
          default:
            throw new Error("bad maskPattern:" + maskPattern);
        }
      }
      exports.applyMask = function applyMask(pattern, data) {
        const size = data.size;
        for (let col = 0; col < size; col++) {
          for (let row = 0; row < size; row++) {
            if (data.isReserved(row, col)) continue;
            data.xor(row, col, getMaskAt(pattern, row, col));
          }
        }
      };
      exports.getBestMask = function getBestMask(data, setupFormatFunc) {
        const numPatterns = Object.keys(exports.Patterns).length;
        let bestPattern = 0;
        let lowerPenalty = Infinity;
        for (let p = 0; p < numPatterns; p++) {
          setupFormatFunc(p);
          exports.applyMask(p, data);
          const penalty = exports.getPenaltyN1(data) + exports.getPenaltyN2(data) + exports.getPenaltyN3(data) + exports.getPenaltyN4(data);
          exports.applyMask(p, data);
          if (penalty < lowerPenalty) {
            lowerPenalty = penalty;
            bestPattern = p;
          }
        }
        return bestPattern;
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/error-correction-code.js
  var require_error_correction_code = __commonJS({
    "../../node_modules/qrcode/lib/core/error-correction-code.js"(exports) {
      init_globals();
      var ECLevel = require_error_correction_level();
      var EC_BLOCKS_TABLE = [
        // L  M  Q  H
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        1,
        2,
        2,
        1,
        2,
        2,
        4,
        1,
        2,
        4,
        4,
        2,
        4,
        4,
        4,
        2,
        4,
        6,
        5,
        2,
        4,
        6,
        6,
        2,
        5,
        8,
        8,
        4,
        5,
        8,
        8,
        4,
        5,
        8,
        11,
        4,
        8,
        10,
        11,
        4,
        9,
        12,
        16,
        4,
        9,
        16,
        16,
        6,
        10,
        12,
        18,
        6,
        10,
        17,
        16,
        6,
        11,
        16,
        19,
        6,
        13,
        18,
        21,
        7,
        14,
        21,
        25,
        8,
        16,
        20,
        25,
        8,
        17,
        23,
        25,
        9,
        17,
        23,
        34,
        9,
        18,
        25,
        30,
        10,
        20,
        27,
        32,
        12,
        21,
        29,
        35,
        12,
        23,
        34,
        37,
        12,
        25,
        34,
        40,
        13,
        26,
        35,
        42,
        14,
        28,
        38,
        45,
        15,
        29,
        40,
        48,
        16,
        31,
        43,
        51,
        17,
        33,
        45,
        54,
        18,
        35,
        48,
        57,
        19,
        37,
        51,
        60,
        19,
        38,
        53,
        63,
        20,
        40,
        56,
        66,
        21,
        43,
        59,
        70,
        22,
        45,
        62,
        74,
        24,
        47,
        65,
        77,
        25,
        49,
        68,
        81
      ];
      var EC_CODEWORDS_TABLE = [
        // L  M  Q  H
        7,
        10,
        13,
        17,
        10,
        16,
        22,
        28,
        15,
        26,
        36,
        44,
        20,
        36,
        52,
        64,
        26,
        48,
        72,
        88,
        36,
        64,
        96,
        112,
        40,
        72,
        108,
        130,
        48,
        88,
        132,
        156,
        60,
        110,
        160,
        192,
        72,
        130,
        192,
        224,
        80,
        150,
        224,
        264,
        96,
        176,
        260,
        308,
        104,
        198,
        288,
        352,
        120,
        216,
        320,
        384,
        132,
        240,
        360,
        432,
        144,
        280,
        408,
        480,
        168,
        308,
        448,
        532,
        180,
        338,
        504,
        588,
        196,
        364,
        546,
        650,
        224,
        416,
        600,
        700,
        224,
        442,
        644,
        750,
        252,
        476,
        690,
        816,
        270,
        504,
        750,
        900,
        300,
        560,
        810,
        960,
        312,
        588,
        870,
        1050,
        336,
        644,
        952,
        1110,
        360,
        700,
        1020,
        1200,
        390,
        728,
        1050,
        1260,
        420,
        784,
        1140,
        1350,
        450,
        812,
        1200,
        1440,
        480,
        868,
        1290,
        1530,
        510,
        924,
        1350,
        1620,
        540,
        980,
        1440,
        1710,
        570,
        1036,
        1530,
        1800,
        570,
        1064,
        1590,
        1890,
        600,
        1120,
        1680,
        1980,
        630,
        1204,
        1770,
        2100,
        660,
        1260,
        1860,
        2220,
        720,
        1316,
        1950,
        2310,
        750,
        1372,
        2040,
        2430
      ];
      exports.getBlocksCount = function getBlocksCount(version, errorCorrectionLevel) {
        switch (errorCorrectionLevel) {
          case ECLevel.L:
            return EC_BLOCKS_TABLE[(version - 1) * 4 + 0];
          case ECLevel.M:
            return EC_BLOCKS_TABLE[(version - 1) * 4 + 1];
          case ECLevel.Q:
            return EC_BLOCKS_TABLE[(version - 1) * 4 + 2];
          case ECLevel.H:
            return EC_BLOCKS_TABLE[(version - 1) * 4 + 3];
          default:
            return void 0;
        }
      };
      exports.getTotalCodewordsCount = function getTotalCodewordsCount(version, errorCorrectionLevel) {
        switch (errorCorrectionLevel) {
          case ECLevel.L:
            return EC_CODEWORDS_TABLE[(version - 1) * 4 + 0];
          case ECLevel.M:
            return EC_CODEWORDS_TABLE[(version - 1) * 4 + 1];
          case ECLevel.Q:
            return EC_CODEWORDS_TABLE[(version - 1) * 4 + 2];
          case ECLevel.H:
            return EC_CODEWORDS_TABLE[(version - 1) * 4 + 3];
          default:
            return void 0;
        }
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/galois-field.js
  var require_galois_field = __commonJS({
    "../../node_modules/qrcode/lib/core/galois-field.js"(exports) {
      init_globals();
      var EXP_TABLE = new Uint8Array(512);
      var LOG_TABLE = new Uint8Array(256);
      (function initTables() {
        let x = 1;
        for (let i = 0; i < 255; i++) {
          EXP_TABLE[i] = x;
          LOG_TABLE[x] = i;
          x <<= 1;
          if (x & 256) {
            x ^= 285;
          }
        }
        for (let i = 255; i < 512; i++) {
          EXP_TABLE[i] = EXP_TABLE[i - 255];
        }
      })();
      exports.log = function log2(n) {
        if (n < 1) throw new Error("log(" + n + ")");
        return LOG_TABLE[n];
      };
      exports.exp = function exp(n) {
        return EXP_TABLE[n];
      };
      exports.mul = function mul(x, y) {
        if (x === 0 || y === 0) return 0;
        return EXP_TABLE[LOG_TABLE[x] + LOG_TABLE[y]];
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/polynomial.js
  var require_polynomial = __commonJS({
    "../../node_modules/qrcode/lib/core/polynomial.js"(exports) {
      init_globals();
      var GF = require_galois_field();
      exports.mul = function mul(p1, p2) {
        const coeff = new Uint8Array(p1.length + p2.length - 1);
        for (let i = 0; i < p1.length; i++) {
          for (let j = 0; j < p2.length; j++) {
            coeff[i + j] ^= GF.mul(p1[i], p2[j]);
          }
        }
        return coeff;
      };
      exports.mod = function mod(divident, divisor) {
        let result = new Uint8Array(divident);
        while (result.length - divisor.length >= 0) {
          const coeff = result[0];
          for (let i = 0; i < divisor.length; i++) {
            result[i] ^= GF.mul(divisor[i], coeff);
          }
          let offset = 0;
          while (offset < result.length && result[offset] === 0) offset++;
          result = result.slice(offset);
        }
        return result;
      };
      exports.generateECPolynomial = function generateECPolynomial(degree) {
        let poly = new Uint8Array([1]);
        for (let i = 0; i < degree; i++) {
          poly = exports.mul(poly, new Uint8Array([1, GF.exp(i)]));
        }
        return poly;
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/reed-solomon-encoder.js
  var require_reed_solomon_encoder = __commonJS({
    "../../node_modules/qrcode/lib/core/reed-solomon-encoder.js"(exports, module) {
      init_globals();
      var Polynomial = require_polynomial();
      function ReedSolomonEncoder(degree) {
        this.genPoly = void 0;
        this.degree = degree;
        if (this.degree) this.initialize(this.degree);
      }
      ReedSolomonEncoder.prototype.initialize = function initialize(degree) {
        this.degree = degree;
        this.genPoly = Polynomial.generateECPolynomial(this.degree);
      };
      ReedSolomonEncoder.prototype.encode = function encode(data) {
        if (!this.genPoly) {
          throw new Error("Encoder not initialized");
        }
        const paddedData = new Uint8Array(data.length + this.degree);
        paddedData.set(data);
        const remainder = Polynomial.mod(paddedData, this.genPoly);
        const start = this.degree - remainder.length;
        if (start > 0) {
          const buff = new Uint8Array(this.degree);
          buff.set(remainder, start);
          return buff;
        }
        return remainder;
      };
      module.exports = ReedSolomonEncoder;
    }
  });

  // ../../node_modules/qrcode/lib/core/version-check.js
  var require_version_check = __commonJS({
    "../../node_modules/qrcode/lib/core/version-check.js"(exports) {
      init_globals();
      exports.isValid = function isValid(version) {
        return !isNaN(version) && version >= 1 && version <= 40;
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/regex.js
  var require_regex = __commonJS({
    "../../node_modules/qrcode/lib/core/regex.js"(exports) {
      init_globals();
      var numeric = "[0-9]+";
      var alphanumeric = "[A-Z $%*+\\-./:]+";
      var kanji = "(?:[u3000-u303F]|[u3040-u309F]|[u30A0-u30FF]|[uFF00-uFFEF]|[u4E00-u9FAF]|[u2605-u2606]|[u2190-u2195]|u203B|[u2010u2015u2018u2019u2025u2026u201Cu201Du2225u2260]|[u0391-u0451]|[u00A7u00A8u00B1u00B4u00D7u00F7])+";
      kanji = kanji.replace(/u/g, "\\u");
      var byte = "(?:(?![A-Z0-9 $%*+\\-./:]|" + kanji + ")(?:.|[\r\n]))+";
      exports.KANJI = new RegExp(kanji, "g");
      exports.BYTE_KANJI = new RegExp("[^A-Z0-9 $%*+\\-./:]+", "g");
      exports.BYTE = new RegExp(byte, "g");
      exports.NUMERIC = new RegExp(numeric, "g");
      exports.ALPHANUMERIC = new RegExp(alphanumeric, "g");
      var TEST_KANJI = new RegExp("^" + kanji + "$");
      var TEST_NUMERIC = new RegExp("^" + numeric + "$");
      var TEST_ALPHANUMERIC = new RegExp("^[A-Z0-9 $%*+\\-./:]+$");
      exports.testKanji = function testKanji(str) {
        return TEST_KANJI.test(str);
      };
      exports.testNumeric = function testNumeric(str) {
        return TEST_NUMERIC.test(str);
      };
      exports.testAlphanumeric = function testAlphanumeric(str) {
        return TEST_ALPHANUMERIC.test(str);
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/mode.js
  var require_mode = __commonJS({
    "../../node_modules/qrcode/lib/core/mode.js"(exports) {
      init_globals();
      var VersionCheck = require_version_check();
      var Regex = require_regex();
      exports.NUMERIC = {
        id: "Numeric",
        bit: 1 << 0,
        ccBits: [10, 12, 14]
      };
      exports.ALPHANUMERIC = {
        id: "Alphanumeric",
        bit: 1 << 1,
        ccBits: [9, 11, 13]
      };
      exports.BYTE = {
        id: "Byte",
        bit: 1 << 2,
        ccBits: [8, 16, 16]
      };
      exports.KANJI = {
        id: "Kanji",
        bit: 1 << 3,
        ccBits: [8, 10, 12]
      };
      exports.MIXED = {
        bit: -1
      };
      exports.getCharCountIndicator = function getCharCountIndicator(mode, version) {
        if (!mode.ccBits) throw new Error("Invalid mode: " + mode);
        if (!VersionCheck.isValid(version)) {
          throw new Error("Invalid version: " + version);
        }
        if (version >= 1 && version < 10) return mode.ccBits[0];
        else if (version < 27) return mode.ccBits[1];
        return mode.ccBits[2];
      };
      exports.getBestModeForData = function getBestModeForData(dataStr) {
        if (Regex.testNumeric(dataStr)) return exports.NUMERIC;
        else if (Regex.testAlphanumeric(dataStr)) return exports.ALPHANUMERIC;
        else if (Regex.testKanji(dataStr)) return exports.KANJI;
        else return exports.BYTE;
      };
      exports.toString = function toString(mode) {
        if (mode && mode.id) return mode.id;
        throw new Error("Invalid mode");
      };
      exports.isValid = function isValid(mode) {
        return mode && mode.bit && mode.ccBits;
      };
      function fromString(string) {
        if (typeof string !== "string") {
          throw new Error("Param is not a string");
        }
        const lcStr = string.toLowerCase();
        switch (lcStr) {
          case "numeric":
            return exports.NUMERIC;
          case "alphanumeric":
            return exports.ALPHANUMERIC;
          case "kanji":
            return exports.KANJI;
          case "byte":
            return exports.BYTE;
          default:
            throw new Error("Unknown mode: " + string);
        }
      }
      exports.from = function from2(value, defaultValue) {
        if (exports.isValid(value)) {
          return value;
        }
        try {
          return fromString(value);
        } catch (e) {
          return defaultValue;
        }
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/version.js
  var require_version = __commonJS({
    "../../node_modules/qrcode/lib/core/version.js"(exports) {
      init_globals();
      var Utils = require_utils();
      var ECCode = require_error_correction_code();
      var ECLevel = require_error_correction_level();
      var Mode = require_mode();
      var VersionCheck = require_version_check();
      var G18 = 1 << 12 | 1 << 11 | 1 << 10 | 1 << 9 | 1 << 8 | 1 << 5 | 1 << 2 | 1 << 0;
      var G18_BCH = Utils.getBCHDigit(G18);
      function getBestVersionForDataLength(mode, length, errorCorrectionLevel) {
        for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
          if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, mode)) {
            return currentVersion;
          }
        }
        return void 0;
      }
      function getReservedBitsCount(mode, version) {
        return Mode.getCharCountIndicator(mode, version) + 4;
      }
      function getTotalBitsFromDataArray(segments, version) {
        let totalBits = 0;
        segments.forEach(function(data) {
          const reservedBits = getReservedBitsCount(data.mode, version);
          totalBits += reservedBits + data.getBitsLength();
        });
        return totalBits;
      }
      function getBestVersionForMixedData(segments, errorCorrectionLevel) {
        for (let currentVersion = 1; currentVersion <= 40; currentVersion++) {
          const length = getTotalBitsFromDataArray(segments, currentVersion);
          if (length <= exports.getCapacity(currentVersion, errorCorrectionLevel, Mode.MIXED)) {
            return currentVersion;
          }
        }
        return void 0;
      }
      exports.from = function from2(value, defaultValue) {
        if (VersionCheck.isValid(value)) {
          return parseInt(value, 10);
        }
        return defaultValue;
      };
      exports.getCapacity = function getCapacity(version, errorCorrectionLevel, mode) {
        if (!VersionCheck.isValid(version)) {
          throw new Error("Invalid QR Code version");
        }
        if (typeof mode === "undefined") mode = Mode.BYTE;
        const totalCodewords = Utils.getSymbolTotalCodewords(version);
        const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
        const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
        if (mode === Mode.MIXED) return dataTotalCodewordsBits;
        const usableBits = dataTotalCodewordsBits - getReservedBitsCount(mode, version);
        switch (mode) {
          case Mode.NUMERIC:
            return Math.floor(usableBits / 10 * 3);
          case Mode.ALPHANUMERIC:
            return Math.floor(usableBits / 11 * 2);
          case Mode.KANJI:
            return Math.floor(usableBits / 13);
          case Mode.BYTE:
          default:
            return Math.floor(usableBits / 8);
        }
      };
      exports.getBestVersionForData = function getBestVersionForData(data, errorCorrectionLevel) {
        let seg;
        const ecl = ECLevel.from(errorCorrectionLevel, ECLevel.M);
        if (Array.isArray(data)) {
          if (data.length > 1) {
            return getBestVersionForMixedData(data, ecl);
          }
          if (data.length === 0) {
            return 1;
          }
          seg = data[0];
        } else {
          seg = data;
        }
        return getBestVersionForDataLength(seg.mode, seg.getLength(), ecl);
      };
      exports.getEncodedBits = function getEncodedBits(version) {
        if (!VersionCheck.isValid(version) || version < 7) {
          throw new Error("Invalid QR Code version");
        }
        let d = version << 12;
        while (Utils.getBCHDigit(d) - G18_BCH >= 0) {
          d ^= G18 << Utils.getBCHDigit(d) - G18_BCH;
        }
        return version << 12 | d;
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/format-info.js
  var require_format_info = __commonJS({
    "../../node_modules/qrcode/lib/core/format-info.js"(exports) {
      init_globals();
      var Utils = require_utils();
      var G15 = 1 << 10 | 1 << 8 | 1 << 5 | 1 << 4 | 1 << 2 | 1 << 1 | 1 << 0;
      var G15_MASK = 1 << 14 | 1 << 12 | 1 << 10 | 1 << 4 | 1 << 1;
      var G15_BCH = Utils.getBCHDigit(G15);
      exports.getEncodedBits = function getEncodedBits(errorCorrectionLevel, mask) {
        const data = errorCorrectionLevel.bit << 3 | mask;
        let d = data << 10;
        while (Utils.getBCHDigit(d) - G15_BCH >= 0) {
          d ^= G15 << Utils.getBCHDigit(d) - G15_BCH;
        }
        return (data << 10 | d) ^ G15_MASK;
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/numeric-data.js
  var require_numeric_data = __commonJS({
    "../../node_modules/qrcode/lib/core/numeric-data.js"(exports, module) {
      init_globals();
      var Mode = require_mode();
      function NumericData(data) {
        this.mode = Mode.NUMERIC;
        this.data = data.toString();
      }
      NumericData.getBitsLength = function getBitsLength(length) {
        return 10 * Math.floor(length / 3) + (length % 3 ? length % 3 * 3 + 1 : 0);
      };
      NumericData.prototype.getLength = function getLength() {
        return this.data.length;
      };
      NumericData.prototype.getBitsLength = function getBitsLength() {
        return NumericData.getBitsLength(this.data.length);
      };
      NumericData.prototype.write = function write(bitBuffer) {
        let i, group, value;
        for (i = 0; i + 3 <= this.data.length; i += 3) {
          group = this.data.substr(i, 3);
          value = parseInt(group, 10);
          bitBuffer.put(value, 10);
        }
        const remainingNum = this.data.length - i;
        if (remainingNum > 0) {
          group = this.data.substr(i);
          value = parseInt(group, 10);
          bitBuffer.put(value, remainingNum * 3 + 1);
        }
      };
      module.exports = NumericData;
    }
  });

  // ../../node_modules/qrcode/lib/core/alphanumeric-data.js
  var require_alphanumeric_data = __commonJS({
    "../../node_modules/qrcode/lib/core/alphanumeric-data.js"(exports, module) {
      init_globals();
      var Mode = require_mode();
      var ALPHA_NUM_CHARS = [
        "0",
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
        "A",
        "B",
        "C",
        "D",
        "E",
        "F",
        "G",
        "H",
        "I",
        "J",
        "K",
        "L",
        "M",
        "N",
        "O",
        "P",
        "Q",
        "R",
        "S",
        "T",
        "U",
        "V",
        "W",
        "X",
        "Y",
        "Z",
        " ",
        "$",
        "%",
        "*",
        "+",
        "-",
        ".",
        "/",
        ":"
      ];
      function AlphanumericData(data) {
        this.mode = Mode.ALPHANUMERIC;
        this.data = data;
      }
      AlphanumericData.getBitsLength = function getBitsLength(length) {
        return 11 * Math.floor(length / 2) + 6 * (length % 2);
      };
      AlphanumericData.prototype.getLength = function getLength() {
        return this.data.length;
      };
      AlphanumericData.prototype.getBitsLength = function getBitsLength() {
        return AlphanumericData.getBitsLength(this.data.length);
      };
      AlphanumericData.prototype.write = function write(bitBuffer) {
        let i;
        for (i = 0; i + 2 <= this.data.length; i += 2) {
          let value = ALPHA_NUM_CHARS.indexOf(this.data[i]) * 45;
          value += ALPHA_NUM_CHARS.indexOf(this.data[i + 1]);
          bitBuffer.put(value, 11);
        }
        if (this.data.length % 2) {
          bitBuffer.put(ALPHA_NUM_CHARS.indexOf(this.data[i]), 6);
        }
      };
      module.exports = AlphanumericData;
    }
  });

  // ../../node_modules/qrcode/lib/core/byte-data.js
  var require_byte_data = __commonJS({
    "../../node_modules/qrcode/lib/core/byte-data.js"(exports, module) {
      init_globals();
      var Mode = require_mode();
      function ByteData(data) {
        this.mode = Mode.BYTE;
        if (typeof data === "string") {
          this.data = new TextEncoder().encode(data);
        } else {
          this.data = new Uint8Array(data);
        }
      }
      ByteData.getBitsLength = function getBitsLength(length) {
        return length * 8;
      };
      ByteData.prototype.getLength = function getLength() {
        return this.data.length;
      };
      ByteData.prototype.getBitsLength = function getBitsLength() {
        return ByteData.getBitsLength(this.data.length);
      };
      ByteData.prototype.write = function(bitBuffer) {
        for (let i = 0, l = this.data.length; i < l; i++) {
          bitBuffer.put(this.data[i], 8);
        }
      };
      module.exports = ByteData;
    }
  });

  // ../../node_modules/qrcode/lib/core/kanji-data.js
  var require_kanji_data = __commonJS({
    "../../node_modules/qrcode/lib/core/kanji-data.js"(exports, module) {
      init_globals();
      var Mode = require_mode();
      var Utils = require_utils();
      function KanjiData(data) {
        this.mode = Mode.KANJI;
        this.data = data;
      }
      KanjiData.getBitsLength = function getBitsLength(length) {
        return length * 13;
      };
      KanjiData.prototype.getLength = function getLength() {
        return this.data.length;
      };
      KanjiData.prototype.getBitsLength = function getBitsLength() {
        return KanjiData.getBitsLength(this.data.length);
      };
      KanjiData.prototype.write = function(bitBuffer) {
        let i;
        for (i = 0; i < this.data.length; i++) {
          let value = Utils.toSJIS(this.data[i]);
          if (value >= 33088 && value <= 40956) {
            value -= 33088;
          } else if (value >= 57408 && value <= 60351) {
            value -= 49472;
          } else {
            throw new Error(
              "Invalid SJIS character: " + this.data[i] + "\nMake sure your charset is UTF-8"
            );
          }
          value = (value >>> 8 & 255) * 192 + (value & 255);
          bitBuffer.put(value, 13);
        }
      };
      module.exports = KanjiData;
    }
  });

  // ../../node_modules/dijkstrajs/dijkstra.js
  var require_dijkstra = __commonJS({
    "../../node_modules/dijkstrajs/dijkstra.js"(exports, module) {
      "use strict";
      init_globals();
      var dijkstra = {
        single_source_shortest_paths: function(graph, s, d) {
          var predecessors = {};
          var costs = {};
          costs[s] = 0;
          var open = dijkstra.PriorityQueue.make();
          open.push(s, 0);
          var closest, u, v, cost_of_s_to_u, adjacent_nodes, cost_of_e, cost_of_s_to_u_plus_cost_of_e, cost_of_s_to_v, first_visit;
          while (!open.empty()) {
            closest = open.pop();
            u = closest.value;
            cost_of_s_to_u = closest.cost;
            adjacent_nodes = graph[u] || {};
            for (v in adjacent_nodes) {
              if (adjacent_nodes.hasOwnProperty(v)) {
                cost_of_e = adjacent_nodes[v];
                cost_of_s_to_u_plus_cost_of_e = cost_of_s_to_u + cost_of_e;
                cost_of_s_to_v = costs[v];
                first_visit = typeof costs[v] === "undefined";
                if (first_visit || cost_of_s_to_v > cost_of_s_to_u_plus_cost_of_e) {
                  costs[v] = cost_of_s_to_u_plus_cost_of_e;
                  open.push(v, cost_of_s_to_u_plus_cost_of_e);
                  predecessors[v] = u;
                }
              }
            }
          }
          if (typeof d !== "undefined" && typeof costs[d] === "undefined") {
            var msg = ["Could not find a path from ", s, " to ", d, "."].join("");
            throw new Error(msg);
          }
          return predecessors;
        },
        extract_shortest_path_from_predecessor_list: function(predecessors, d) {
          var nodes = [];
          var u = d;
          var predecessor;
          while (u) {
            nodes.push(u);
            predecessor = predecessors[u];
            u = predecessors[u];
          }
          nodes.reverse();
          return nodes;
        },
        find_path: function(graph, s, d) {
          var predecessors = dijkstra.single_source_shortest_paths(graph, s, d);
          return dijkstra.extract_shortest_path_from_predecessor_list(
            predecessors,
            d
          );
        },
        /**
         * A very naive priority queue implementation.
         */
        PriorityQueue: {
          make: function(opts) {
            var T = dijkstra.PriorityQueue, t = {}, key;
            opts = opts || {};
            for (key in T) {
              if (T.hasOwnProperty(key)) {
                t[key] = T[key];
              }
            }
            t.queue = [];
            t.sorter = opts.sorter || T.default_sorter;
            return t;
          },
          default_sorter: function(a, b) {
            return a.cost - b.cost;
          },
          /**
           * Add a new item to the queue and ensure the highest priority element
           * is at the front of the queue.
           */
          push: function(value, cost) {
            var item = { value, cost };
            this.queue.push(item);
            this.queue.sort(this.sorter);
          },
          /**
           * Return the highest priority element in the queue.
           */
          pop: function() {
            return this.queue.shift();
          },
          empty: function() {
            return this.queue.length === 0;
          }
        }
      };
      if (typeof module !== "undefined") {
        module.exports = dijkstra;
      }
    }
  });

  // ../../node_modules/qrcode/lib/core/segments.js
  var require_segments = __commonJS({
    "../../node_modules/qrcode/lib/core/segments.js"(exports) {
      init_globals();
      var Mode = require_mode();
      var NumericData = require_numeric_data();
      var AlphanumericData = require_alphanumeric_data();
      var ByteData = require_byte_data();
      var KanjiData = require_kanji_data();
      var Regex = require_regex();
      var Utils = require_utils();
      var dijkstra = require_dijkstra();
      function getStringByteLength(str) {
        return unescape(encodeURIComponent(str)).length;
      }
      function getSegments(regex, mode, str) {
        const segments = [];
        let result;
        while ((result = regex.exec(str)) !== null) {
          segments.push({
            data: result[0],
            index: result.index,
            mode,
            length: result[0].length
          });
        }
        return segments;
      }
      function getSegmentsFromString(dataStr) {
        const numSegs = getSegments(Regex.NUMERIC, Mode.NUMERIC, dataStr);
        const alphaNumSegs = getSegments(Regex.ALPHANUMERIC, Mode.ALPHANUMERIC, dataStr);
        let byteSegs;
        let kanjiSegs;
        if (Utils.isKanjiModeEnabled()) {
          byteSegs = getSegments(Regex.BYTE, Mode.BYTE, dataStr);
          kanjiSegs = getSegments(Regex.KANJI, Mode.KANJI, dataStr);
        } else {
          byteSegs = getSegments(Regex.BYTE_KANJI, Mode.BYTE, dataStr);
          kanjiSegs = [];
        }
        const segs = numSegs.concat(alphaNumSegs, byteSegs, kanjiSegs);
        return segs.sort(function(s1, s2) {
          return s1.index - s2.index;
        }).map(function(obj) {
          return {
            data: obj.data,
            mode: obj.mode,
            length: obj.length
          };
        });
      }
      function getSegmentBitsLength(length, mode) {
        switch (mode) {
          case Mode.NUMERIC:
            return NumericData.getBitsLength(length);
          case Mode.ALPHANUMERIC:
            return AlphanumericData.getBitsLength(length);
          case Mode.KANJI:
            return KanjiData.getBitsLength(length);
          case Mode.BYTE:
            return ByteData.getBitsLength(length);
        }
      }
      function mergeSegments(segs) {
        return segs.reduce(function(acc, curr) {
          const prevSeg = acc.length - 1 >= 0 ? acc[acc.length - 1] : null;
          if (prevSeg && prevSeg.mode === curr.mode) {
            acc[acc.length - 1].data += curr.data;
            return acc;
          }
          acc.push(curr);
          return acc;
        }, []);
      }
      function buildNodes(segs) {
        const nodes = [];
        for (let i = 0; i < segs.length; i++) {
          const seg = segs[i];
          switch (seg.mode) {
            case Mode.NUMERIC:
              nodes.push([
                seg,
                { data: seg.data, mode: Mode.ALPHANUMERIC, length: seg.length },
                { data: seg.data, mode: Mode.BYTE, length: seg.length }
              ]);
              break;
            case Mode.ALPHANUMERIC:
              nodes.push([
                seg,
                { data: seg.data, mode: Mode.BYTE, length: seg.length }
              ]);
              break;
            case Mode.KANJI:
              nodes.push([
                seg,
                { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
              ]);
              break;
            case Mode.BYTE:
              nodes.push([
                { data: seg.data, mode: Mode.BYTE, length: getStringByteLength(seg.data) }
              ]);
          }
        }
        return nodes;
      }
      function buildGraph(nodes, version) {
        const table = {};
        const graph = { start: {} };
        let prevNodeIds = ["start"];
        for (let i = 0; i < nodes.length; i++) {
          const nodeGroup = nodes[i];
          const currentNodeIds = [];
          for (let j = 0; j < nodeGroup.length; j++) {
            const node = nodeGroup[j];
            const key = "" + i + j;
            currentNodeIds.push(key);
            table[key] = { node, lastCount: 0 };
            graph[key] = {};
            for (let n = 0; n < prevNodeIds.length; n++) {
              const prevNodeId = prevNodeIds[n];
              if (table[prevNodeId] && table[prevNodeId].node.mode === node.mode) {
                graph[prevNodeId][key] = getSegmentBitsLength(table[prevNodeId].lastCount + node.length, node.mode) - getSegmentBitsLength(table[prevNodeId].lastCount, node.mode);
                table[prevNodeId].lastCount += node.length;
              } else {
                if (table[prevNodeId]) table[prevNodeId].lastCount = node.length;
                graph[prevNodeId][key] = getSegmentBitsLength(node.length, node.mode) + 4 + Mode.getCharCountIndicator(node.mode, version);
              }
            }
          }
          prevNodeIds = currentNodeIds;
        }
        for (let n = 0; n < prevNodeIds.length; n++) {
          graph[prevNodeIds[n]].end = 0;
        }
        return { map: graph, table };
      }
      function buildSingleSegment(data, modesHint) {
        let mode;
        const bestMode = Mode.getBestModeForData(data);
        mode = Mode.from(modesHint, bestMode);
        if (mode !== Mode.BYTE && mode.bit < bestMode.bit) {
          throw new Error('"' + data + '" cannot be encoded with mode ' + Mode.toString(mode) + ".\n Suggested mode is: " + Mode.toString(bestMode));
        }
        if (mode === Mode.KANJI && !Utils.isKanjiModeEnabled()) {
          mode = Mode.BYTE;
        }
        switch (mode) {
          case Mode.NUMERIC:
            return new NumericData(data);
          case Mode.ALPHANUMERIC:
            return new AlphanumericData(data);
          case Mode.KANJI:
            return new KanjiData(data);
          case Mode.BYTE:
            return new ByteData(data);
        }
      }
      exports.fromArray = function fromArray(array2) {
        return array2.reduce(function(acc, seg) {
          if (typeof seg === "string") {
            acc.push(buildSingleSegment(seg, null));
          } else if (seg.data) {
            acc.push(buildSingleSegment(seg.data, seg.mode));
          }
          return acc;
        }, []);
      };
      exports.fromString = function fromString(data, version) {
        const segs = getSegmentsFromString(data, Utils.isKanjiModeEnabled());
        const nodes = buildNodes(segs);
        const graph = buildGraph(nodes, version);
        const path = dijkstra.find_path(graph.map, "start", "end");
        const optimizedSegs = [];
        for (let i = 1; i < path.length - 1; i++) {
          optimizedSegs.push(graph.table[path[i]].node);
        }
        return exports.fromArray(mergeSegments(optimizedSegs));
      };
      exports.rawSplit = function rawSplit(data) {
        return exports.fromArray(
          getSegmentsFromString(data, Utils.isKanjiModeEnabled())
        );
      };
    }
  });

  // ../../node_modules/qrcode/lib/core/qrcode.js
  var require_qrcode = __commonJS({
    "../../node_modules/qrcode/lib/core/qrcode.js"(exports) {
      init_globals();
      var Utils = require_utils();
      var ECLevel = require_error_correction_level();
      var BitBuffer = require_bit_buffer();
      var BitMatrix = require_bit_matrix();
      var AlignmentPattern = require_alignment_pattern();
      var FinderPattern = require_finder_pattern();
      var MaskPattern = require_mask_pattern();
      var ECCode = require_error_correction_code();
      var ReedSolomonEncoder = require_reed_solomon_encoder();
      var Version = require_version();
      var FormatInfo = require_format_info();
      var Mode = require_mode();
      var Segments = require_segments();
      function setupFinderPattern(matrix, version) {
        const size = matrix.size;
        const pos = FinderPattern.getPositions(version);
        for (let i = 0; i < pos.length; i++) {
          const row = pos[i][0];
          const col = pos[i][1];
          for (let r = -1; r <= 7; r++) {
            if (row + r <= -1 || size <= row + r) continue;
            for (let c = -1; c <= 7; c++) {
              if (col + c <= -1 || size <= col + c) continue;
              if (r >= 0 && r <= 6 && (c === 0 || c === 6) || c >= 0 && c <= 6 && (r === 0 || r === 6) || r >= 2 && r <= 4 && c >= 2 && c <= 4) {
                matrix.set(row + r, col + c, true, true);
              } else {
                matrix.set(row + r, col + c, false, true);
              }
            }
          }
        }
      }
      function setupTimingPattern(matrix) {
        const size = matrix.size;
        for (let r = 8; r < size - 8; r++) {
          const value = r % 2 === 0;
          matrix.set(r, 6, value, true);
          matrix.set(6, r, value, true);
        }
      }
      function setupAlignmentPattern(matrix, version) {
        const pos = AlignmentPattern.getPositions(version);
        for (let i = 0; i < pos.length; i++) {
          const row = pos[i][0];
          const col = pos[i][1];
          for (let r = -2; r <= 2; r++) {
            for (let c = -2; c <= 2; c++) {
              if (r === -2 || r === 2 || c === -2 || c === 2 || r === 0 && c === 0) {
                matrix.set(row + r, col + c, true, true);
              } else {
                matrix.set(row + r, col + c, false, true);
              }
            }
          }
        }
      }
      function setupVersionInfo(matrix, version) {
        const size = matrix.size;
        const bits = Version.getEncodedBits(version);
        let row, col, mod;
        for (let i = 0; i < 18; i++) {
          row = Math.floor(i / 3);
          col = i % 3 + size - 8 - 3;
          mod = (bits >> i & 1) === 1;
          matrix.set(row, col, mod, true);
          matrix.set(col, row, mod, true);
        }
      }
      function setupFormatInfo(matrix, errorCorrectionLevel, maskPattern) {
        const size = matrix.size;
        const bits = FormatInfo.getEncodedBits(errorCorrectionLevel, maskPattern);
        let i, mod;
        for (i = 0; i < 15; i++) {
          mod = (bits >> i & 1) === 1;
          if (i < 6) {
            matrix.set(i, 8, mod, true);
          } else if (i < 8) {
            matrix.set(i + 1, 8, mod, true);
          } else {
            matrix.set(size - 15 + i, 8, mod, true);
          }
          if (i < 8) {
            matrix.set(8, size - i - 1, mod, true);
          } else if (i < 9) {
            matrix.set(8, 15 - i - 1 + 1, mod, true);
          } else {
            matrix.set(8, 15 - i - 1, mod, true);
          }
        }
        matrix.set(size - 8, 8, 1, true);
      }
      function setupData(matrix, data) {
        const size = matrix.size;
        let inc = -1;
        let row = size - 1;
        let bitIndex = 7;
        let byteIndex = 0;
        for (let col = size - 1; col > 0; col -= 2) {
          if (col === 6) col--;
          while (true) {
            for (let c = 0; c < 2; c++) {
              if (!matrix.isReserved(row, col - c)) {
                let dark = false;
                if (byteIndex < data.length) {
                  dark = (data[byteIndex] >>> bitIndex & 1) === 1;
                }
                matrix.set(row, col - c, dark);
                bitIndex--;
                if (bitIndex === -1) {
                  byteIndex++;
                  bitIndex = 7;
                }
              }
            }
            row += inc;
            if (row < 0 || size <= row) {
              row -= inc;
              inc = -inc;
              break;
            }
          }
        }
      }
      function createData(version, errorCorrectionLevel, segments) {
        const buffer = new BitBuffer();
        segments.forEach(function(data) {
          buffer.put(data.mode.bit, 4);
          buffer.put(data.getLength(), Mode.getCharCountIndicator(data.mode, version));
          data.write(buffer);
        });
        const totalCodewords = Utils.getSymbolTotalCodewords(version);
        const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
        const dataTotalCodewordsBits = (totalCodewords - ecTotalCodewords) * 8;
        if (buffer.getLengthInBits() + 4 <= dataTotalCodewordsBits) {
          buffer.put(0, 4);
        }
        while (buffer.getLengthInBits() % 8 !== 0) {
          buffer.putBit(0);
        }
        const remainingByte = (dataTotalCodewordsBits - buffer.getLengthInBits()) / 8;
        for (let i = 0; i < remainingByte; i++) {
          buffer.put(i % 2 ? 17 : 236, 8);
        }
        return createCodewords(buffer, version, errorCorrectionLevel);
      }
      function createCodewords(bitBuffer, version, errorCorrectionLevel) {
        const totalCodewords = Utils.getSymbolTotalCodewords(version);
        const ecTotalCodewords = ECCode.getTotalCodewordsCount(version, errorCorrectionLevel);
        const dataTotalCodewords = totalCodewords - ecTotalCodewords;
        const ecTotalBlocks = ECCode.getBlocksCount(version, errorCorrectionLevel);
        const blocksInGroup2 = totalCodewords % ecTotalBlocks;
        const blocksInGroup1 = ecTotalBlocks - blocksInGroup2;
        const totalCodewordsInGroup1 = Math.floor(totalCodewords / ecTotalBlocks);
        const dataCodewordsInGroup1 = Math.floor(dataTotalCodewords / ecTotalBlocks);
        const dataCodewordsInGroup2 = dataCodewordsInGroup1 + 1;
        const ecCount = totalCodewordsInGroup1 - dataCodewordsInGroup1;
        const rs = new ReedSolomonEncoder(ecCount);
        let offset = 0;
        const dcData = new Array(ecTotalBlocks);
        const ecData = new Array(ecTotalBlocks);
        let maxDataSize = 0;
        const buffer = new Uint8Array(bitBuffer.buffer);
        for (let b = 0; b < ecTotalBlocks; b++) {
          const dataSize = b < blocksInGroup1 ? dataCodewordsInGroup1 : dataCodewordsInGroup2;
          dcData[b] = buffer.slice(offset, offset + dataSize);
          ecData[b] = rs.encode(dcData[b]);
          offset += dataSize;
          maxDataSize = Math.max(maxDataSize, dataSize);
        }
        const data = new Uint8Array(totalCodewords);
        let index = 0;
        let i, r;
        for (i = 0; i < maxDataSize; i++) {
          for (r = 0; r < ecTotalBlocks; r++) {
            if (i < dcData[r].length) {
              data[index++] = dcData[r][i];
            }
          }
        }
        for (i = 0; i < ecCount; i++) {
          for (r = 0; r < ecTotalBlocks; r++) {
            data[index++] = ecData[r][i];
          }
        }
        return data;
      }
      function createSymbol(data, version, errorCorrectionLevel, maskPattern) {
        let segments;
        if (Array.isArray(data)) {
          segments = Segments.fromArray(data);
        } else if (typeof data === "string") {
          let estimatedVersion = version;
          if (!estimatedVersion) {
            const rawSegments = Segments.rawSplit(data);
            estimatedVersion = Version.getBestVersionForData(rawSegments, errorCorrectionLevel);
          }
          segments = Segments.fromString(data, estimatedVersion || 40);
        } else {
          throw new Error("Invalid data");
        }
        const bestVersion = Version.getBestVersionForData(segments, errorCorrectionLevel);
        if (!bestVersion) {
          throw new Error("The amount of data is too big to be stored in a QR Code");
        }
        if (!version) {
          version = bestVersion;
        } else if (version < bestVersion) {
          throw new Error(
            "\nThe chosen QR Code version cannot contain this amount of data.\nMinimum version required to store current data is: " + bestVersion + ".\n"
          );
        }
        const dataBits = createData(version, errorCorrectionLevel, segments);
        const moduleCount = Utils.getSymbolSize(version);
        const modules = new BitMatrix(moduleCount);
        setupFinderPattern(modules, version);
        setupTimingPattern(modules);
        setupAlignmentPattern(modules, version);
        setupFormatInfo(modules, errorCorrectionLevel, 0);
        if (version >= 7) {
          setupVersionInfo(modules, version);
        }
        setupData(modules, dataBits);
        if (isNaN(maskPattern)) {
          maskPattern = MaskPattern.getBestMask(
            modules,
            setupFormatInfo.bind(null, modules, errorCorrectionLevel)
          );
        }
        MaskPattern.applyMask(maskPattern, modules);
        setupFormatInfo(modules, errorCorrectionLevel, maskPattern);
        return {
          modules,
          version,
          errorCorrectionLevel,
          maskPattern,
          segments
        };
      }
      exports.create = function create(data, options) {
        if (typeof data === "undefined" || data === "") {
          throw new Error("No input text");
        }
        let errorCorrectionLevel = ECLevel.M;
        let version;
        let mask;
        if (typeof options !== "undefined") {
          errorCorrectionLevel = ECLevel.from(options.errorCorrectionLevel, ECLevel.M);
          version = Version.from(options.version);
          mask = MaskPattern.from(options.maskPattern);
          if (options.toSJISFunc) {
            Utils.setToSJISFunction(options.toSJISFunc);
          }
        }
        return createSymbol(data, version, errorCorrectionLevel, mask);
      };
    }
  });

  // ../../node_modules/qrcode/lib/renderer/utils.js
  var require_utils2 = __commonJS({
    "../../node_modules/qrcode/lib/renderer/utils.js"(exports) {
      init_globals();
      function hex2rgba(hex) {
        if (typeof hex === "number") {
          hex = hex.toString();
        }
        if (typeof hex !== "string") {
          throw new Error("Color should be defined as hex string");
        }
        let hexCode = hex.slice().replace("#", "").split("");
        if (hexCode.length < 3 || hexCode.length === 5 || hexCode.length > 8) {
          throw new Error("Invalid hex color: " + hex);
        }
        if (hexCode.length === 3 || hexCode.length === 4) {
          hexCode = Array.prototype.concat.apply([], hexCode.map(function(c) {
            return [c, c];
          }));
        }
        if (hexCode.length === 6) hexCode.push("F", "F");
        const hexValue = parseInt(hexCode.join(""), 16);
        return {
          r: hexValue >> 24 & 255,
          g: hexValue >> 16 & 255,
          b: hexValue >> 8 & 255,
          a: hexValue & 255,
          hex: "#" + hexCode.slice(0, 6).join("")
        };
      }
      exports.getOptions = function getOptions(options) {
        if (!options) options = {};
        if (!options.color) options.color = {};
        const margin = typeof options.margin === "undefined" || options.margin === null || options.margin < 0 ? 4 : options.margin;
        const width = options.width && options.width >= 21 ? options.width : void 0;
        const scale = options.scale || 4;
        return {
          width,
          scale: width ? 4 : scale,
          margin,
          color: {
            dark: hex2rgba(options.color.dark || "#000000ff"),
            light: hex2rgba(options.color.light || "#ffffffff")
          },
          type: options.type,
          rendererOpts: options.rendererOpts || {}
        };
      };
      exports.getScale = function getScale(qrSize, opts) {
        return opts.width && opts.width >= qrSize + opts.margin * 2 ? opts.width / (qrSize + opts.margin * 2) : opts.scale;
      };
      exports.getImageWidth = function getImageWidth(qrSize, opts) {
        const scale = exports.getScale(qrSize, opts);
        return Math.floor((qrSize + opts.margin * 2) * scale);
      };
      exports.qrToImageData = function qrToImageData(imgData, qr, opts) {
        const size = qr.modules.size;
        const data = qr.modules.data;
        const scale = exports.getScale(size, opts);
        const symbolSize = Math.floor((size + opts.margin * 2) * scale);
        const scaledMargin = opts.margin * scale;
        const palette = [opts.color.light, opts.color.dark];
        for (let i = 0; i < symbolSize; i++) {
          for (let j = 0; j < symbolSize; j++) {
            let posDst = (i * symbolSize + j) * 4;
            let pxColor = opts.color.light;
            if (i >= scaledMargin && j >= scaledMargin && i < symbolSize - scaledMargin && j < symbolSize - scaledMargin) {
              const iSrc = Math.floor((i - scaledMargin) / scale);
              const jSrc = Math.floor((j - scaledMargin) / scale);
              pxColor = palette[data[iSrc * size + jSrc] ? 1 : 0];
            }
            imgData[posDst++] = pxColor.r;
            imgData[posDst++] = pxColor.g;
            imgData[posDst++] = pxColor.b;
            imgData[posDst] = pxColor.a;
          }
        }
      };
    }
  });

  // ../../node_modules/qrcode/lib/renderer/canvas.js
  var require_canvas = __commonJS({
    "../../node_modules/qrcode/lib/renderer/canvas.js"(exports) {
      init_globals();
      var Utils = require_utils2();
      function clearCanvas(ctx, canvas, size) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!canvas.style) canvas.style = {};
        canvas.height = size;
        canvas.width = size;
        canvas.style.height = size + "px";
        canvas.style.width = size + "px";
      }
      function getCanvasElement() {
        try {
          return document.createElement("canvas");
        } catch (e) {
          throw new Error("You need to specify a canvas element");
        }
      }
      exports.render = function render(qrData, canvas, options) {
        let opts = options;
        let canvasEl = canvas;
        if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
          opts = canvas;
          canvas = void 0;
        }
        if (!canvas) {
          canvasEl = getCanvasElement();
        }
        opts = Utils.getOptions(opts);
        const size = Utils.getImageWidth(qrData.modules.size, opts);
        const ctx = canvasEl.getContext("2d");
        const image = ctx.createImageData(size, size);
        Utils.qrToImageData(image.data, qrData, opts);
        clearCanvas(ctx, canvasEl, size);
        ctx.putImageData(image, 0, 0);
        return canvasEl;
      };
      exports.renderToDataURL = function renderToDataURL(qrData, canvas, options) {
        let opts = options;
        if (typeof opts === "undefined" && (!canvas || !canvas.getContext)) {
          opts = canvas;
          canvas = void 0;
        }
        if (!opts) opts = {};
        const canvasEl = exports.render(qrData, canvas, opts);
        const type = opts.type || "image/png";
        const rendererOpts = opts.rendererOpts || {};
        return canvasEl.toDataURL(type, rendererOpts.quality);
      };
    }
  });

  // ../../node_modules/qrcode/lib/renderer/svg-tag.js
  var require_svg_tag = __commonJS({
    "../../node_modules/qrcode/lib/renderer/svg-tag.js"(exports) {
      init_globals();
      var Utils = require_utils2();
      function getColorAttrib(color, attrib) {
        const alpha = color.a / 255;
        const str = attrib + '="' + color.hex + '"';
        return alpha < 1 ? str + " " + attrib + '-opacity="' + alpha.toFixed(2).slice(1) + '"' : str;
      }
      function svgCmd(cmd, x, y) {
        let str = cmd + x;
        if (typeof y !== "undefined") str += " " + y;
        return str;
      }
      function qrToPath(data, size, margin) {
        let path = "";
        let moveBy = 0;
        let newRow = false;
        let lineLength = 0;
        for (let i = 0; i < data.length; i++) {
          const col = Math.floor(i % size);
          const row = Math.floor(i / size);
          if (!col && !newRow) newRow = true;
          if (data[i]) {
            lineLength++;
            if (!(i > 0 && col > 0 && data[i - 1])) {
              path += newRow ? svgCmd("M", col + margin, 0.5 + row + margin) : svgCmd("m", moveBy, 0);
              moveBy = 0;
              newRow = false;
            }
            if (!(col + 1 < size && data[i + 1])) {
              path += svgCmd("h", lineLength);
              lineLength = 0;
            }
          } else {
            moveBy++;
          }
        }
        return path;
      }
      exports.render = function render(qrData, options, cb) {
        const opts = Utils.getOptions(options);
        const size = qrData.modules.size;
        const data = qrData.modules.data;
        const qrcodesize = size + opts.margin * 2;
        const bg = !opts.color.light.a ? "" : "<path " + getColorAttrib(opts.color.light, "fill") + ' d="M0 0h' + qrcodesize + "v" + qrcodesize + 'H0z"/>';
        const path = "<path " + getColorAttrib(opts.color.dark, "stroke") + ' d="' + qrToPath(data, size, opts.margin) + '"/>';
        const viewBox = 'viewBox="0 0 ' + qrcodesize + " " + qrcodesize + '"';
        const width = !opts.width ? "" : 'width="' + opts.width + '" height="' + opts.width + '" ';
        const svgTag = '<svg xmlns="http://www.w3.org/2000/svg" ' + width + viewBox + ' shape-rendering="crispEdges">' + bg + path + "</svg>\n";
        if (typeof cb === "function") {
          cb(null, svgTag);
        }
        return svgTag;
      };
    }
  });

  // ../../node_modules/qrcode/lib/browser.js
  var require_browser = __commonJS({
    "../../node_modules/qrcode/lib/browser.js"(exports) {
      init_globals();
      var canPromise = require_can_promise();
      var QRCode2 = require_qrcode();
      var CanvasRenderer = require_canvas();
      var SvgRenderer = require_svg_tag();
      function renderCanvas(renderFunc, canvas, text5, opts, cb) {
        const args = [].slice.call(arguments, 1);
        const argsNum = args.length;
        const isLastArgCb = typeof args[argsNum - 1] === "function";
        if (!isLastArgCb && !canPromise()) {
          throw new Error("Callback required as last argument");
        }
        if (isLastArgCb) {
          if (argsNum < 2) {
            throw new Error("Too few arguments provided");
          }
          if (argsNum === 2) {
            cb = text5;
            text5 = canvas;
            canvas = opts = void 0;
          } else if (argsNum === 3) {
            if (canvas.getContext && typeof cb === "undefined") {
              cb = opts;
              opts = void 0;
            } else {
              cb = opts;
              opts = text5;
              text5 = canvas;
              canvas = void 0;
            }
          }
        } else {
          if (argsNum < 1) {
            throw new Error("Too few arguments provided");
          }
          if (argsNum === 1) {
            text5 = canvas;
            canvas = opts = void 0;
          } else if (argsNum === 2 && !canvas.getContext) {
            opts = text5;
            text5 = canvas;
            canvas = void 0;
          }
          return new Promise(function(resolve2, reject) {
            try {
              const data = QRCode2.create(text5, opts);
              resolve2(renderFunc(data, canvas, opts));
            } catch (e) {
              reject(e);
            }
          });
        }
        try {
          const data = QRCode2.create(text5, opts);
          cb(null, renderFunc(data, canvas, opts));
        } catch (e) {
          cb(e);
        }
      }
      exports.create = QRCode2.create;
      exports.toCanvas = renderCanvas.bind(null, CanvasRenderer.render);
      exports.toDataURL = renderCanvas.bind(null, CanvasRenderer.renderToDataURL);
      exports.toString = renderCanvas.bind(null, function(data, _, opts) {
        return SvgRenderer.render(data, opts);
      });
    }
  });

  // src/entry.js
  init_globals();

  // src/car/api.js
  init_globals();

  // src/car/client.js
  init_globals();

  // src/car/protocol.js
  init_globals();

  // src/car/bytes.js
  init_globals();
  function utf8Bytes(text5) {
    return new TextEncoder().encode(String(text5));
  }
  function bytesToBase64(bytes) {
    let binary = "";
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
    return btoa(binary);
  }
  function base64ToBytes(value) {
    const clean = String(value || "").replace(/\s+/g, "");
    const binary = atob(clean);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  function concatBytes(...parts) {
    const chunks = parts.map((part) => part instanceof Uint8Array ? part : new Uint8Array(part || []));
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
  function pemFromBytes(label, bytes) {
    const body = bytesToBase64(bytes);
    const lines = body.match(/.{1,64}/g) || [];
    return `-----BEGIN ${label}-----
${lines.join("\n")}
-----END ${label}-----
`;
  }
  function bytesFromPem(pem) {
    const text5 = String(pem || "");
    const body = text5.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
    return base64ToBytes(body);
  }
  function randomDigits19() {
    const bytes = randomBytes(8);
    let value = 0n;
    for (const byte of bytes) value = value << 8n | BigInt(byte);
    return (value % 9000000000000000000n + 1000000000000000000n).toString();
  }
  function randomHex(byteLength2) {
    const bytes = randomBytes(byteLength2);
    let out = "";
    for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
    return out;
  }
  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    const cryptoRef = (typeof globalThis !== "undefined" ? globalThis.crypto : null) || (typeof window !== "undefined" ? window.crypto : null);
    if (cryptoRef && typeof cryptoRef.getRandomValues === "function") {
      for (let offset = 0; offset < length; offset += 65536) {
        cryptoRef.getRandomValues(bytes.subarray(offset, Math.min(length, offset + 65536)));
      }
      return bytes;
    }
    for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return bytes;
  }

  // src/car/guard.js
  init_globals();
  var subtle = () => {
    const cryptoRef = (typeof globalThis !== "undefined" ? globalThis.crypto : null) || (typeof window !== "undefined" ? window.crypto : null);
    if (!cryptoRef || !cryptoRef.subtle) throw new Error("WebCrypto is unavailable in this runtime");
    return cryptoRef.subtle;
  };
  function derLength(length) {
    if (length < 128) return new Uint8Array([length]);
    if (length < 256) return new Uint8Array([129, length]);
    return new Uint8Array([130, length >> 8, length & 255]);
  }
  function der(tag, ...values) {
    const value = concatBytes(...values);
    return concatBytes(new Uint8Array([tag]), derLength(value.length), value);
  }
  function derInteger(bytes) {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start++;
    let value = bytes.subarray(start);
    if (value[0] & 128) value = concatBytes(new Uint8Array([0]), value);
    return der(2, value);
  }
  function rawSignatureToDer(raw) {
    const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (bytes.length % 2 !== 0) throw new Error("Raw ECDSA signature has an odd length");
    const half = bytes.length / 2;
    return der(48, derInteger(bytes.subarray(0, half)), derInteger(bytes.subarray(half)));
  }
  var EC_ALGORITHM = { name: "ECDSA", namedCurve: "P-256" };
  async function generateKeyPair() {
    return subtle().generateKey(EC_ALGORITHM, true, ["sign"]);
  }
  async function exportPrivateKeyPem(privateKey) {
    return pemFromBytes("PRIVATE KEY", new Uint8Array(await subtle().exportKey("pkcs8", privateKey)));
  }
  async function importPrivateKeyPem(pem) {
    return subtle().importKey("pkcs8", bytesFromPem(pem), EC_ALGORITHM, true, ["sign"]);
  }
  async function signTextDerBase64(privateKey, text5) {
    const raw = new Uint8Array(await subtle().sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      utf8Bytes(text5)
    ));
    return bytesToBase64(rawSignatureToDer(raw));
  }
  var OID_ATTRIBUTE = (id) => der(6, new Uint8Array([85, 4, id]));
  var OID_ECDSA_SHA256 = der(6, new Uint8Array([42, 134, 72, 206, 61, 4, 3, 2]));
  function subjectAttribute(id, value) {
    return der(49, der(48, OID_ATTRIBUTE(id), der(12, utf8Bytes(value))));
  }
  async function createGuard() {
    const { privateKey, publicKey } = await generateKeyPair();
    const spki = new Uint8Array(await subtle().exportKey("spki", publicKey));
    const subject = der(
      48,
      subjectAttribute(3, "bd-ticket-guard"),
      subjectAttribute(11, ""),
      subjectAttribute(10, "")
    );
    const info = der(48, der(2, new Uint8Array([0])), subject, spki, der(160));
    const algorithm = der(48, OID_ECDSA_SHA256);
    const signature = new Uint8Array(await subtle().sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      info
    ));
    const request3 = der(48, info, algorithm, der(3, new Uint8Array([0]), rawSignatureToDer(signature)));
    return {
      privateKey,
      guardKey: await exportPrivateKeyPem(privateKey),
      csr: bytesToBase64(utf8Bytes(pemFromBytes("CERTIFICATE REQUEST", request3)))
    };
  }

  // src/car/protocol.js
  var QISHUI_UA = "LunaOpenSDK/1.0.10";
  var QISHUI_PREFIX = "/api/luna/v1/platform";
  var QISHUI_CLIENT_KEY = "aw4bbxfujo741d09";
  var QISHUI_COMMON = {
    aid: "765213",
    app_id: "765213",
    app_name: "byte_autoservice_lite",
    version_code: "100010",
    version_name: "1.0.10",
    channel: "bydSong",
    sdk_aid: "753999",
    caller_name: "luna_open_sdk",
    sdk_version_code: "100000100",
    sdk_version_name: "0.0.1",
    sdk_channel: "Test",
    vehicle_type: "BYD",
    device_brand: "BYD",
    device_type: "BYD",
    device_platform: "android",
    resolution: "1920x1080",
    os_version: "13",
    ac: "wifi"
  };
  var QISHUI_OPEN_HOST = "https://open.qishui.com";
  var QISHUI_DOUYIN_HOST = "https://open.douyin.com";
  var QISHUI_OPEN_CLIENT_HOST = "https://open-client.douyin.com";
  function qishuiParams(deviceId) {
    const values = new URLSearchParams(Object.entries(QISHUI_COMMON));
    values.set("device_id", String(deviceId));
    values.set("did", String(deviceId));
    values.set("iid", String(deviceId));
    values.set("vehicle_id", `qishui-${deviceId}`);
    values.set("_timestamp", String(Math.floor(Date.now() / 1e3)));
    const nonce = randomBytes(2);
    values.set("_nonce", String(nonce[0] << 8 | nonce[1]));
    return values.toString();
  }
  var QR_COMMON = {
    aid: "1128",
    client_key: QISHUI_CLIENT_KEY,
    state: "",
    next: "",
    jump_type: "native",
    optional_scope_check: "",
    optional_scope_uncheck: "",
    customize_params: '{"source":"pc_auth","not_skip_confirm":"true"}',
    source_from: "native",
    device_platform: "android",
    app_identity: "82a0737a3f8d93d9958c8a7938bbc365",
    signature: "cf9024ea72d9c71813238b13ea107a3d"
  };
  var QISHUI_QR_SCOPE = "user_info,luna.openapi.platform.interaction,luna.openapi.platform.me_tab,luna.commerce.openapi_platform.vip_info";
  function qrParams() {
    return { ...QR_COMMON, scope: QISHUI_QR_SCOPE };
  }
  var GUARD_KEYS = ["ticket", "guardKey", "guardCert", "guardTsSign"];
  async function qishuiGuardHeaders(credential, path) {
    for (const key of GUARD_KEYS) {
      const value = credential?.[key];
      if (typeof value !== "string" || !value || value.length > 16384) {
        throw new Error("invalid guard credential");
      }
    }
    const privateKey = await importPrivateKeyPem(credential.guardKey);
    const timestamp = Math.floor(Date.now() / 1e3);
    const content = `ticket=${credential.ticket}&path=${QISHUI_PREFIX}${path}&timestamp=${timestamp}`;
    return {
      "access-token": credential.ticket,
      "bd-ticket-guard-version": "1",
      "bd-ticket-guard-client-cert": credential.guardCert,
      "bd-ticket-guard-client-data": bytesToBase64(utf8Bytes(JSON.stringify({
        ts_sign: credential.guardTsSign,
        req_content: "ticket,path,timestamp",
        req_sign: await signTextDerBase64(privateKey, content),
        timestamp
      })))
    };
  }
  function readQishuiGuard(raw) {
    if (typeof raw !== "string" || !raw) throw new Error("guard header is missing");
    if (raw.length > 65536) throw new Error("guard header is too large");
    let json;
    try {
      json = JSON.parse(new TextDecoder().decode(base64ToBytes(raw)));
    } catch (_) {
      throw new Error("guard header is not base64 JSON");
    }
    for (const key of ["ticket", "ts_sign", "client_cert"]) {
      if (typeof json[key] !== "string" || !json[key] || json[key].length > 16384) {
        throw new Error(`guard header field missing or invalid: ${key}`);
      }
    }
    const cert = json.client_cert;
    return {
      ticket: json.ticket,
      guardTsSign: json.ts_sign,
      guardCert: cert.includes("-----BEGIN") ? bytesToBase64(utf8Bytes(cert)) : cert
    };
  }
  function qishuiCredentialExpiry(raw) {
    const value = Number(raw || 0);
    const expires = value > 1e12 ? value : value > 1e9 ? value * 1e3 : value > 0 ? Date.now() + value * 1e3 : Date.now() + 6 * 36e5;
    if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error("invalid credential expiry");
    return new Date(expires);
  }
  var isAccountId = (value) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\s\x00-\x1f\x7f]/u.test(value);
  var newQrKey = () => randomHex(16);

  // src/car/client.js
  var QishuiError = class extends Error {
    constructor(code, message, upstreamCode) {
      super(message);
      this.code = code;
      this.upstreamCode = upstreamCode;
    }
  };
  var AUTH_CODES = [28001003, 28001007, 28001008, 10007];
  var RETRYABLE_READS = /* @__PURE__ */ new Set([
    "/search/",
    "/playlist/detail/",
    "/media/mget/",
    "/media/mcheck/",
    "/artist/detail/",
    "/artist/tracks/",
    "/feed/mode/",
    "/feed/song-tab/",
    "/me/playlist/",
    "/me/collection/mixed/",
    "/me/recent-played/"
  ]);
  function checked(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new QishuiError("invalid-response", "Invalid Qishui response");
    }
    const code = Number(data.err_no ?? data.data?.error_code ?? 0);
    if (code) {
      const nested = data.data && typeof data.data === "object" ? data.data : null;
      const detail = [
        data.status_msg,
        data.message,
        data.description,
        nested?.description,
        nested?.message,
        nested?.status_msg
      ].map((value) => typeof value === "string" ? value.trim() : "").find(Boolean) || "";
      throw new QishuiError(
        AUTH_CODES.includes(code) ? "auth-required" : "unavailable",
        detail ? `Qishui rejected the request: ${detail.slice(0, 200)}` : "Qishui rejected the request",
        String(code)
      );
    }
    return data;
  }
  var HOSTS = [
    "365yg.com",
    "douyinvod.com",
    "douyinscdn.com",
    "bytefcdn.com",
    "bytecdn.cn",
    "byteicdn.com",
    "ibytedtos.com",
    "pstatp.com",
    "snssdk.com",
    "bytedance.com",
    "bytetos.com",
    "volcvideo.com",
    "volccdn.com",
    "volces.com",
    "volcengineapi.com",
    "douyin.com",
    "qishui.com",
    "zijieapi.com"
  ];
  function mediaUrl(raw) {
    let url;
    try {
      url = new URL(String(raw));
    } catch (_) {
      throw new QishuiError("invalid-response", "Invalid Qishui media URL");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443" || !HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
      throw new QishuiError("invalid-response", "Untrusted Qishui media host");
    }
    return url.href;
  }
  function createClient({ sessions, fetch: fetcher }) {
    let tokenEntry;
    async function http(url, { body, headers = {}, form = false } = {}) {
      let response;
      try {
        response = await fetcher(url, {
          method: body === void 0 ? "GET" : "POST",
          headers: {
            "user-agent": QISHUI_UA,
            ...body === void 0 ? {} : { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
            ...headers
          },
          ...body === void 0 ? {} : { body: form ? new URLSearchParams(body).toString() : JSON.stringify(body) }
        });
      } catch (_) {
        throw new QishuiError("network", "Qishui service could not be reached");
      }
      if (!response.ok) {
        const status = Number(response.status);
        throw new QishuiError(
          status === 429 ? "unavailable" : [401, 403].includes(status) ? "auth-required" : "network",
          `Qishui HTTP ${status}`
        );
      }
      try {
        return { data: checked(await response.json()), headers: response.headers };
      } catch (error) {
        if (error instanceof QishuiError) throw error;
        throw new QishuiError("invalid-response", "Qishui response is not JSON");
      }
    }
    const query = (path, extras = {}, deviceId = sessions.deviceId) => {
      const values = new URLSearchParams(qishuiParams(deviceId));
      Object.entries(extras || {}).forEach(([key, value]) => values.set(key, String(value)));
      return `${path}?${values}`;
    };
    const clientToken = () => {
      if (!tokenEntry) {
        const entry = {};
        entry.task = http(query(`${QISHUI_OPEN_HOST}${QISHUI_PREFIX}/client/token/get/`, { trigger_type: "cold_start" })).then(({ data }) => {
          if (typeof data.client_token !== "string" || !data.client_token) {
            throw new QishuiError("invalid-response", "Client token is missing");
          }
          return data.client_token;
        }).catch((error) => {
          if (tokenEntry === entry) tokenEntry = void 0;
          throw error;
        });
        tokenEntry = entry;
      }
      return tokenEntry;
    };
    async function platform(path, body = {}, credential) {
      if (credential === true) {
        credential = sessions.get();
        if (!credential) throw new QishuiError("auth-required", "Sign in to Qishui first");
      }
      const account = credential || sessions.get();
      const revision = sessions.revision;
      const request3 = async (headers) => {
        const { data } = await http(query(`${QISHUI_DOUYIN_HOST}${QISHUI_PREFIX}${path}`, {}, account?.deviceId), {
          body: { ...body, common_params: { ...account?.userId ? { user_id: account.userId } : {} } },
          headers
        });
        if (!data.data || typeof data.data !== "object") throw new QishuiError("invalid-response", "Qishui data is missing");
        return data.data;
      };
      if (credential) return request3(await qishuiGuardHeaders(credential, path));
      let token = clientToken();
      for (let attempt = 0; ; attempt++) {
        const headers = { "access-token": await token.task };
        if (attempt && revision !== sessions.revision) {
          throw new QishuiError("unavailable", "Qishui account changed during the request");
        }
        try {
          return await request3(headers);
        } catch (error) {
          if (!(error instanceof QishuiError) || error.upstreamCode !== "28001008") throw error;
          if (tokenEntry === token) tokenEntry = void 0;
          if (attempt || !RETRYABLE_READS.has(path)) throw error;
          token = tokenEntry || (token.replacement ||= clientToken());
        }
      }
    }
    async function command(path, body = {}) {
      const credential = sessions.get();
      if (!credential) throw new QishuiError("auth-required", "Sign in to Qishui first");
      const { data } = await http(query(`${QISHUI_DOUYIN_HOST}${QISHUI_PREFIX}${path}`, {}, credential.deviceId), {
        body: { ...body, common_params: { ...credential.userId ? { user_id: credential.userId } : {} } },
        headers: await qishuiGuardHeaders(credential, path)
      });
      return data.data && typeof data.data === "object" ? data.data : {};
    }
    return { http, query, platform, command, sessions };
  }

  // src/car/auth.js
  init_globals();

  // src/car/storage.js
  init_globals();
  var PREFIX = "folia:qishui:car:";
  var memory = /* @__PURE__ */ new Map();
  function native() {
    try {
      const host = typeof window !== "undefined" ? window.FoliaQishuiHost : null;
      if (!host || typeof host.getStore !== "function" || typeof host.putStore !== "function") return null;
      return host;
    } catch (_) {
      return null;
    }
  }
  function local() {
    try {
      return typeof window !== "undefined" ? window.localStorage : null;
    } catch (_) {
      return null;
    }
  }
  var lastRead = "none";
  var lastWrite = "none";
  var lastParseError = "";
  var storageMode = () => lastRead;
  var storageWriteMode = () => lastWrite;
  var storageParseError = () => lastParseError;
  function whereIs(key) {
    const host = native();
    if (host) {
      try {
        if (host.getStore(key)) return "native";
      } catch (_) {
      }
    }
    const target = local();
    if (target) {
      try {
        if (target.getItem(PREFIX + key) != null) return "local";
      } catch (_) {
      }
    }
    return memory.has(key) ? "memory" : "none";
  }
  function readJson(key, fallback = null) {
    const host = native();
    if (host) {
      try {
        const text5 = host.getStore(key);
        if (text5) {
          lastRead = "native";
          try {
            return JSON.parse(text5);
          } catch (error) {
            lastParseError = `native/${key}: ${error?.message || error}`;
          }
        }
      } catch (_) {
      }
    }
    const target = local();
    if (target) {
      try {
        const text5 = target.getItem(PREFIX + key);
        if (text5 != null) {
          lastRead = "local";
          try {
            return JSON.parse(text5);
          } catch (error) {
            lastParseError = `local/${key}: ${error?.message || error}`;
          }
        }
      } catch (_) {
      }
    }
    if (memory.has(key)) {
      lastRead = "memory";
      return memory.get(key);
    }
    lastRead = "none";
    return fallback;
  }
  function writeJson(key, value) {
    const text5 = JSON.stringify(value == null ? null : value);
    memory.set(key, value);
    const host = native();
    if (host) {
      try {
        host.putStore(key, text5);
        lastWrite = "native";
      } catch (_) {
      }
    }
    const target = local();
    if (target) {
      try {
        target.setItem(PREFIX + key, text5);
        if (lastWrite !== "native") lastWrite = "local";
      } catch (_) {
      }
    }
    if (lastWrite === "none") lastWrite = "memory";
  }
  function remove(key) {
    memory.delete(key);
    const host = native();
    if (host) {
      try {
        host.putStore(key, null);
      } catch (_) {
      }
    }
    const target = local();
    if (target) {
      try {
        target.removeItem(PREFIX + key);
      } catch (_) {
      }
    }
  }
  var DEVICE_KEY = "device-id";
  var SESSION_KEY = "session";

  // src/car/auth.js
  var QR_TTL_MS = 5 * 60 * 1e3;
  function createSessions() {
    let deviceId = readJson(DEVICE_KEY, null);
    const deviceIdReused = typeof deviceId === "string" && /^\d{19}$/.test(deviceId);
    if (!deviceIdReused) {
      deviceId = randomDigits19();
      writeJson(DEVICE_KEY, deviceId);
    }
    let current = readJson(SESSION_KEY, null);
    let reread = false;
    let revision = 0;
    return {
      deviceId,
      deviceIdReused,
      get revision() {
        return revision;
      },
      get() {
        if (!current && !reread) {
          reread = true;
          current = readJson(SESSION_KEY, null) || null;
        }
        return current;
      },
      set(value) {
        current = value;
        revision++;
        if (value) writeJson(SESSION_KEY, value);
        else remove(SESSION_KEY);
      },
      clear() {
        current = null;
        revision++;
        remove(SESSION_KEY);
      }
    };
  }
  function createAuth(client, { log: log2 = () => {
  } } = {}) {
    const pending = /* @__PURE__ */ new Map();
    let generation = 0;
    let refreshing;
    const { http, query, platform, sessions } = client;
    const clean = () => {
      for (const [key, value] of pending) {
        if (value.expires <= Date.now()) pending.delete(key);
      }
    };
    const step = async (stage, run) => {
      try {
        return await run();
      } catch (error) {
        const failure = error instanceof QishuiError ? error : new QishuiError(
          "invalid-response",
          String(error?.message || error) || "Qishui sign-in response could not be read"
        );
        failure.stage ||= stage;
        throw failure;
      }
    };
    const getUser = (credential) => step("account", async () => {
      const { my_info: user } = await platform("/me/info/", {}, credential);
      if (!isAccountId(user?.id)) throw new QishuiError("invalid-response", "Qishui did not identify the account");
      return {
        id: String(user.id),
        nickname: String(user.nickname || ""),
        avatar: user.medium_avatar_url || user.avatar_url || user.thumb_avatar_url,
        isVip: user.is_vip === true
      };
    });
    async function ticket(access, guard, deviceId) {
      if (!access.access_code) throw new QishuiError("invalid-response", "Access code is missing");
      const response = await http(`${QISHUI_OPEN_CLIENT_HOST}/passport/open/get_access_ticket/?${new URLSearchParams({ aid: "1128", client_key: QISHUI_CLIENT_KEY, device_platform: "android" })}`, {
        body: { access_code: access.access_code, open_id: String(access.open_id || access.open_uid || "") },
        form: true,
        headers: {
          "bd-ticket-guard-version": "1",
          ...guard.csr ? { "bd-ticket-guard-client-csr": guard.csr } : { "bd-ticket-guard-client-cert": guard.guardCert }
        }
      });
      const guardHeader = response.headers.get("bd-ticket-guard-server-data");
      let guardData;
      try {
        guardData = readQishuiGuard(guardHeader);
      } catch (error) {
        const names = typeof response.headers.names === "function" ? response.headers.names() : [];
        const related = names.filter((name) => /ticket-guard/i.test(String(name)));
        throw new Error(`readQishuiGuard failed (${String(error?.message || error)}); http=${response.status ?? "?"} headers=[${names.join(" ") || "none"}] guardHeaders=[${related.join(" ") || "none"}] rawLength=${guardHeader ? String(guardHeader.length) : "0"}`);
      }
      return {
        deviceId,
        guardKey: guard.guardKey,
        ...guardData,
        accessCode: access.access_code,
        openId: String(access.open_id || access.open_uid || ""),
        expiresAt: qishuiCredentialExpiry(access.expires_time).getTime()
      };
    }
    async function renew() {
      const old = sessions.get();
      if (!old) return null;
      const revision = sessions.revision;
      let candidate = old;
      if (Number(old.expiresAt) < Date.now() + 36e5) {
        const result = await http(query(
          `${QISHUI_OPEN_HOST}${QISHUI_PREFIX}/access/code/refresh/`,
          { access_code: old.accessCode },
          old.deviceId
        ));
        const access = result.data.data || result.data;
        candidate = await ticket({ ...access, open_id: access.open_id || access.open_uid || old.openId }, old, old.deviceId);
      }
      const user = await getUser(candidate);
      if (user.id !== old.userId) throw new QishuiError("auth-required", "Qishui account identity changed");
      if (revision !== sessions.revision) return null;
      sessions.set({ ...candidate, userId: user.id, user });
      return user;
    }
    return {
      async start() {
        clean();
        pending.clear();
        const mine = ++generation;
        const result = await http(`${QISHUI_DOUYIN_HOST}/oauth/get_qrcode/?${new URLSearchParams(qrParams())}`);
        const data = result.data.data;
        if (!data?.token || !data.qrcode) throw new QishuiError("invalid-response", "QR code is missing");
        if (mine !== generation) throw new QishuiError("unavailable", "Sign-in was cancelled");
        const key = newQrKey();
        pending.set(key, { token: data.token, qr: `data:image/png;base64,${data.qrcode}`, expires: Date.now() + QR_TTL_MS });
        log2("[Qishui] Sign-in QR created");
        return { key, imageUrl: `data:image/png;base64,${data.qrcode}` };
      },
      qr(key) {
        clean();
        const value = pending.get(key);
        if (!value) throw new QishuiError("unavailable", "QR session expired");
        return { imageUrl: value.qr };
      },
      async check(key) {
        clean();
        const value = pending.get(key);
        if (!value) return { state: "expired" };
        if (value.task) return value.task;
        const revision = sessions.revision;
        const run = async () => {
          const result = await http(`${QISHUI_DOUYIN_HOST}/oauth/check_qrcode/?${new URLSearchParams({ ...qrParams(), token: value.token, timestamp: String(Date.now()) })}`);
          const data = result.data.data;
          if (!data || !["new", "scanned", "confirmed", "expired", "refused"].includes(data.status)) {
            throw new QishuiError("invalid-response", "Invalid QR status");
          }
          if (data.status !== "confirmed") {
            if (["expired", "refused"].includes(data.status)) pending.delete(key);
            return data.status === "refused" ? { state: "error", failure: { case: "refused" } } : { state: data.status === "new" ? "waiting" : data.status };
          }
          const code = data.code || data.auth_code;
          if (!code) throw new QishuiError("invalid-response", "QR authorization code is missing");
          const access = await step("access-code", async () => {
            const response = await http(query(`${QISHUI_OPEN_HOST}${QISHUI_PREFIX}/access/code/get/`, { auth_code: code }));
            return response.data.data || response.data;
          });
          const credential = await step("ticket", async () => ticket(access, await createGuard(), sessions.deviceId));
          const user = await getUser(credential);
          if (pending.get(key) !== value || sessions.revision !== revision) return { state: "expired" };
          sessions.set({ ...credential, userId: user.id, user });
          pending.delete(key);
          log2("[Qishui] Sign-in confirmed; account stored");
          return { state: "confirmed" };
        };
        value.task = run().finally(() => {
          value.task = void 0;
        });
        return value.task;
      },
      cancel(key) {
        pending.delete(key);
      },
      logout() {
        generation++;
        pending.clear();
        sessions.clear();
        log2("[Qishui] Signed out");
      },
      status() {
        if (!refreshing) refreshing = renew().finally(() => {
          refreshing = void 0;
        });
        return refreshing;
      }
    };
  }

  // src/car/catalog.js
  init_globals();

  // src/car/shape.js
  init_globals();
  var text = (value) => value == null ? "" : String(value);
  function coverFromUrlInfo(info) {
    if (!info || typeof info !== "object") return "";
    const urls = Array.isArray(info.urls) ? info.urls : [];
    const prefix = urls.find((value) => typeof value === "string" && /^https?:\/\//.test(value)) || "";
    const uri = text(info.uri);
    if (!prefix || !uri) return "";
    return prefix + uri + "~c5_300x300.jpeg";
  }
  function collectionCover(entity) {
    const display = entity.display_info || {};
    return coverFromUrlInfo(display.url_cover || display.display && display.display.url_cover) || coverFromUrlInfo(entity.cover_url);
  }
  function trackEntity(raw) {
    const candidates = [
      raw?.track_entity,
      raw?.entity?.media?.track_entity,
      raw?.entity?.track,
      raw?.media?.track_entity,
      raw?.track,
      raw
    ];
    for (const candidate of candidates) {
      if (candidate && (candidate.base_info?.id || candidate.id)) return candidate;
    }
    return null;
  }
  function toFoliaSong(raw) {
    const track = trackEntity(raw);
    if (!track) return null;
    const base = track.base_info || {};
    const id = text(base.id || track.id);
    if (!id) return null;
    const related = track.related_info || {};
    const album = related.album_link || {};
    const artists = (Array.isArray(related.artist_links) ? related.artist_links : []).map((item) => ({
      id: text(item?.id),
      name: text(item?.name || item?.simple_display_name)
    })).filter((item) => item.name);
    const display = track.display_info || {};
    const durationMs = Number(base.duration_ms || 0);
    return {
      id,
      name: text(base.name),
      artist: artists.map((item) => item.name).join(" / "),
      artistId: artists.length ? artists[0].id : "",
      artists,
      album: text(album.name),
      albumId: text(album.id),
      cover: coverFromUrlInfo(display.cover_url || display.display && display.display.cover_url),
      // 渲染层拿到秒再乘 1000，所以这里给秒（保留小数）。
      duration: durationMs > 0 ? durationMs / 1e3 : 0,
      fee: 0,
      playbackMode: "direct-url"
    };
  }
  function toFoliaSongs(items) {
    return (Array.isArray(items) ? items : []).map(toFoliaSong).filter(Boolean);
  }
  function toFoliaPlaylist(raw, options = {}) {
    const entity = raw?.playlist || raw || {};
    const base = entity.base_info || {};
    const id = text(base.id || entity.id);
    if (!id) return null;
    const cover = collectionCover(entity);
    const counts = entity.resource_cnt && typeof entity.resource_cnt === "object" ? entity.resource_cnt : {};
    const trackCount = Number(counts.track_cnt ?? counts.media_count ?? entity.resource_cnt ?? entity.stats?.count_tracks ?? base.count_tracks ?? 0);
    return {
      id,
      name: text(base.title || base.name || entity.title),
      cover,
      description: text(base.desc || base.description),
      trackCount: Number.isFinite(trackCount) ? trackCount : 0,
      creator: base.owner_id ? { id: text(base.owner_id), nickname: "" } : void 0,
      artists: [],
      isOwned: options.isOwned !== void 0 ? Boolean(options.isOwned) : void 0,
      owned: options.isOwned !== void 0 ? Boolean(options.isOwned) : void 0,
      // 我的喜欢（type 1）在渲染层有固定 id，协议层这里标一下便于排查。
      // ownerId 必须带上：/playlist/detail/ 要它，换封面那一步也要靠它读第一首。
      providerData: { carType: Number(base.type) || 0, ownerId: text(base.owner_id) }
    };
  }
  function toFoliaPlaylists(items) {
    return (Array.isArray(items) ? items : []).map((item) => toFoliaPlaylist(item, { isOwned: item?.isOwned })).filter(Boolean);
  }
  function lrcTime(ms) {
    const total = Math.max(0, Number(ms) || 0);
    const minutes = Math.floor(total / 6e4);
    const seconds = Math.floor(total % 6e4 / 1e3);
    const centiseconds = Math.floor(total % 1e3 / 10);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(centiseconds).padStart(2, "0")}`;
  }
  function lyricsFromContent(content) {
    const lrcLines = [];
    const yrcLines = [];
    String(content || "").split("\n").forEach((rawLine) => {
      const line = String(rawLine || "").trim();
      const timed = line.match(/^\[(\d+),(\d+)\](.*)$/);
      if (!timed) return;
      const lineStart = Math.max(0, Number(timed[1]) || 0);
      const lineDuration = Math.max(0, Number(timed[2]) || 0);
      const body = timed[3] || "";
      const wordPattern = /([<(])(\d+),(\d+),(\d+)[>)]([^<(]*)/g;
      let match;
      let plain = "";
      let yrcBody = "";
      while (match = wordPattern.exec(body)) {
        const rawStart = Math.max(0, Number(match[2]) || 0);
        const wordDuration = Math.max(0, Number(match[3]) || 0);
        const word = String(match[5] || "");
        if (!word) continue;
        const absolute = match[1] === "<" ? lineStart + rawStart : rawStart >= Math.max(0, lineStart - 500) ? rawStart : lineStart + rawStart;
        plain += word;
        yrcBody += `(${absolute},${wordDuration},${Number(match[4]) || 0})${word}`;
      }
      if (!plain) plain = body.replace(/[<(]\d+,\d+,\d+[>)]/g, "").trim();
      if (!plain) return;
      lrcLines.push(`[${lrcTime(lineStart)}]${plain}`);
      if (yrcBody) yrcLines.push(`[${lineStart},${lineDuration}]${yrcBody}`);
    });
    return { lyric: lrcLines.join("\n"), yrc: yrcLines.join("\n"), tlyric: "" };
  }
  function lyricsFromTrack(raw) {
    const track = trackEntity(raw);
    const entity = track?.display_info?.lyric_info?.lyric_entity || track?.lyric_info?.lyric_entity;
    return lyricsFromContent(entity?.content);
  }

  // src/car/catalog.js
  var array = (value, field) => {
    if (!Array.isArray(value)) throw new QishuiError("invalid-response", `Qishui ${field} is missing`);
    return value;
  };
  async function search(platform, query, type, limit, offset) {
    const items = [];
    const searchId = randomHex(16);
    let cursor = offset;
    let more = false;
    while (items.length < limit) {
      const data = await platform("/search/", {
        q: query,
        cursor: String(cursor),
        search_id: searchId,
        from_search_id: searchId,
        search_method: "input",
        search_type: type,
        search_scene: "normal",
        scene_name: "search",
        ab_param: "",
        last_viewed_media: {}
      });
      const groups = array(data.result_groups, "search groups");
      const group = groups.find((value) => value.id === `${type}s`) || groups[0];
      if (!group) break;
      const batch = array(group.data, "search items").map((value) => value.entity?.[type]).filter(Boolean);
      const remaining = limit - items.length;
      items.push(...batch.slice(0, remaining));
      more = batch.length > remaining || group.has_more === true;
      if (!batch.length || !more || items.length === limit) break;
      const next = Number(group.next_cursor);
      if (!Number.isSafeInteger(next) || next <= cursor) break;
      cursor = next;
    }
    return { items, hasMore: more && items.length > 0, nextOffset: offset + items.length };
  }
  async function playlistPage(platform, id, ownerId, limit, offset, count = 100) {
    let cursor = "0";
    let consumed = 0;
    const seen = /* @__PURE__ */ new Set();
    const items = [];
    let collection;
    let hasMore = false;
    while (items.length < limit && seen.size < 500) {
      seen.add(cursor);
      const data = await platform("/playlist/detail/", {
        playlist_id: id,
        owner_id: ownerId || "",
        count,
        cursor,
        type: null
      });
      collection ||= data.playlist;
      const batch = array(data.media_entities, "playlist tracks");
      const start = Math.max(0, offset - consumed);
      const remaining = limit - items.length;
      items.push(...batch.slice(start, start + remaining).map(trackEntity));
      consumed += batch.length;
      const next = String(data.next_cursor ?? "");
      const upstreamMore = data.has_more === true;
      hasMore = consumed > offset + items.length || upstreamMore;
      if (!upstreamMore || items.length === limit) break;
      if (!batch.length || !next || seen.has(next)) throw new QishuiError("invalid-response", "Playlist cursor did not advance");
      cursor = next;
    }
    return { items, collection, hasMore: hasMore && items.length > 0, nextOffset: offset + items.length };
  }
  async function likedPlaylist(platform) {
    let cursor = "";
    const seen = /* @__PURE__ */ new Set();
    for (let page = 0; page < 20; page++) {
      seen.add(cursor);
      const data = await platform("/me/playlist/", { count: 100, cursor, item_types: ["playlist"] }, true);
      const rows = Array.isArray(data.playlists) ? data.playlists : Array.isArray(data.playlist_list) ? data.playlist_list : null;
      if (!rows) throw new QishuiError("invalid-response", "Qishui account playlists is missing");
      for (const row of rows) {
        const playlist = row?.playlist || row || {};
        const base = playlist.base_info || {};
        if (Number(base.type) === 1 && base.id) {
          return { id: String(base.id), ownerId: String(base.owner_id || "") };
        }
      }
      if (data.has_more !== true) return null;
      const next = String(data.next_cursor ?? "");
      if (!next || seen.has(next)) throw new QishuiError("invalid-response", "Account playlist cursor did not advance");
      cursor = next;
    }
    throw new QishuiError("invalid-response", "Account playlist page limit reached");
  }
  function createCatalog({ platform }) {
    return {
      searchSongs: ({ query, limit, offset }) => search(platform, query, "track", limit, offset),
      searchPlaylists: ({ query, limit, offset }) => search(platform, query, "playlist", limit, offset),
      /**
       * 完整 track entity（含 player_info，播放要用），不裁剪。
       *
       * `credential` 传凭据就走账号那条路（ticket-guard 签名）—— 见 api.js 的
       * `accountTrack`：受版权保护的曲子用公共客户端令牌问，上游**根本不给 full**
       * （player_info 里只有 preview），表现是「每首歌都 only offers a preview」。
       */
      async track(id, options = {}) {
        const data = await platform(
          "/media/mget/",
          { media_list: [{ id, type: "track" }], card_context: {} },
          options.credential
        );
        const media = array(data.media_list, "media list").find((item) => String(item.media_id || item.track_entity?.base_info?.id) === id);
        if (!media?.track_entity) throw new QishuiError("not-playable", "Qishui did not return the track");
        return media.track_entity;
      },
      playlistTracks: ({ id, ownerId, limit, offset, count }) => playlistPage(platform, id, ownerId, limit, offset, count),
      async userPlaylists({ limit, offset }) {
        const items = [];
        for (const [path, field, owned] of [
          ["/me/playlist/", "playlists", true],
          ["/me/collection/mixed/", "mixed_collections", false]
        ]) {
          let cursor = "";
          const seen = /* @__PURE__ */ new Set();
          for (let page = 0; page < 500; page++) {
            seen.add(cursor);
            const data = await platform(path, { count: 100, cursor, item_types: ["playlist"] }, true);
            const rows = Array.isArray(data[field]) ? data[field] : path === "/me/playlist/" ? data.playlist_list : void 0;
            if (Array.isArray(rows)) {
              for (const row of rows) {
                const playlist = row?.playlist || row;
                if (playlist?.base_info?.id) items.push({ ...playlist, isOwned: owned });
              }
            }
            if (data.has_more !== true) break;
            const next = String(data.next_cursor ?? "");
            if (!next || seen.has(next) || !rows || !rows.length || page === 499) {
              throw new QishuiError("invalid-response", "Account playlist cursor did not advance");
            }
            cursor = next;
          }
        }
        const unique = [...new Map(items.map((item) => [String(item.base_info.id), item])).values()];
        return {
          items: unique.slice(offset, offset + limit),
          total: unique.length,
          nextOffset: offset + Math.min(limit, Math.max(0, unique.length - offset)),
          hasMore: offset + limit < unique.length
        };
      },
      async artistDetail({ id }) {
        const data = await platform("/artist/detail/", { artist_id: id });
        return data.artist_info;
      },
      async artistSongs({ id, limit, offset }) {
        const data = await platform("/artist/tracks/", { artist_id: id, count: 50, cursor: "0" });
        const tracks = array(data.tracks, "artist tracks").map(trackEntity);
        return {
          items: tracks.slice(offset, offset + limit),
          total: tracks.length,
          nextOffset: Math.min(offset + limit, tracks.length),
          hasMore: offset + limit < tracks.length
        };
      }
    };
  }

  // src/car/feed.js
  init_globals();
  function createFeed({ platform }) {
    const queues = /* @__PURE__ */ new Map();
    let total = 0;
    let generation = 0;
    const activeKeys = /* @__PURE__ */ new Map();
    let pending = Promise.resolve();
    return {
      clear() {
        generation++;
        queues.clear();
        activeKeys.clear();
        total = 0;
      },
      async modes() {
        const data = await platform("/feed/mode/");
        return (data.feed_mode_block || []).flatMap((block) => (block.feed_mode || []).flatMap((item) => {
          const mode = item.entity?.feed_mode;
          const id = mode?.scene_mode?.scene_mode_id;
          return id == null ? [] : [{
            id: String(id),
            name: String(mode.text || ""),
            group: String(block.title || ""),
            coverUrl: mode.url_info
          }];
        }));
      },
      songs(options = {}) {
        const mine = generation;
        const run = async () => {
          if (mine !== generation) throw new QishuiError("unavailable", "Qishui account changed");
          const { scene, preference, queue = "fm", first = false, count = 20 } = options;
          if (scene != null && preference) {
            throw new QishuiError("invalid-response", "Scene and preference are mutually exclusive");
          }
          if (scene != null && (!/^\d+$/.test(String(scene)) || !Number.isSafeInteger(Number(scene)))) {
            throw new QishuiError("invalid-response", "Invalid scene");
          }
          const key = `${queue}:${scene ?? preference ?? "default"}`;
          if (queues.size > 100) queues.clear();
          const previous = queues.get(key);
          const state = first || !previous || activeKeys.get(queue) !== key ? { count: 0, selectedAt: Date.now() } : previous;
          const data = await platform("/feed/song-tab/", {
            played_media: [],
            is_first_request: state.count === 0,
            with_client_cache: state.count !== 0,
            is_did_first_request: false,
            count,
            feed_preference: {
              scene_mode_id: scene == null ? null : Number(scene),
              scene_mode_select_time: scene == null ? null : state.selectedAt,
              preference_mode: preference || null,
              total_request_count: ++total,
              preference_mode_request_count: state.count + 1,
              current_mode_request_count: state.count + 1
            }
          });
          if (!Array.isArray(data.items)) throw new QishuiError("invalid-response", "Qishui feed items are missing");
          if (mine !== generation) throw new QishuiError("unavailable", "Qishui account changed");
          activeKeys.set(queue, key);
          state.count++;
          queues.set(key, state);
          return {
            items: data.items.filter((item) => !item.type || item.type === "track").map(trackEntity),
            hasMore: data.has_more === true
          };
        };
        const result = pending.then(run, run);
        pending = result.catch(() => {
        });
        return result;
      }
    };
  }

  // src/car/library.js
  init_globals();
  var MAX_BATCH = 100;
  var PAGE_SIZE = 100;
  var PAGE_LIMIT = 500;
  var mediaId = (value) => {
    if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) {
      throw new QishuiError("invalid-response", "Invalid Qishui media ID");
    }
    return value;
  };
  var mediaIds = (value) => {
    if (!Array.isArray(value) || value.length === 0) {
      throw new QishuiError("invalid-response", "Qishui media IDs are required");
    }
    if (value.length > MAX_BATCH) {
      throw new QishuiError("unsupported", `Select at most ${MAX_BATCH} tracks per operation`);
    }
    return [...new Set(value.map(mediaId))];
  };
  var trackRef = (id) => ({ id, type: "track" });
  var requiredList = (data, fields, label) => {
    const rows = fields.map((field) => data?.[field]).find(Array.isArray);
    if (!rows) throw new QishuiError("invalid-response", `Qishui ${label} is missing`);
    return rows;
  };
  async function likedSongs(platform) {
    const liked = await likedPlaylist(platform);
    if (!liked) return { ids: [], whole: true, total: 0 };
    const ids = /* @__PURE__ */ new Set();
    let cursor = "";
    let whole = false;
    const seen = /* @__PURE__ */ new Set();
    for (let page = 0; page < PAGE_LIMIT; page++) {
      seen.add(cursor);
      const data = await platform("/playlist/detail/", {
        playlist_id: liked.id,
        owner_id: liked.ownerId,
        count: PAGE_SIZE,
        cursor,
        type: 1
      });
      const media = requiredList(data, ["media_entities", "media_list"], "liked playlist tracks");
      for (const item of media) {
        const entity = trackEntity(item);
        if (entity?.base_info?.id) ids.add(String(entity.base_info.id));
      }
      if (data.has_more !== true) {
        whole = true;
        break;
      }
      const next = String(data.next_cursor ?? "");
      if (!next || seen.has(next)) throw new QishuiError("invalid-response", "Liked playlist cursor did not advance");
      cursor = next;
    }
    return { ids: [...ids], whole, total: ids.size };
  }
  async function recentPlayed(platform, limit, offset) {
    const items = [];
    let cursor = "";
    let consumed = 0;
    let hasMore = false;
    for (let page = 0; page < PAGE_LIMIT; page++) {
      const data = await platform("/me/recent-played/", {
        count: PAGE_SIZE,
        cursor,
        media_type: "track",
        scene: "me_tab"
      }, true);
      const rows = Array.isArray(data.media) ? data.media : [];
      for (const row of rows) {
        const entity = trackEntity(row?.media);
        if (!entity) continue;
        const rawPlayedAt = Number(row.play_start_timestamp);
        const playedAt = rawPlayedAt > 1e12 ? rawPlayedAt : rawPlayedAt * 1e3;
        if (consumed >= offset && items.length < limit) {
          items.push({ ...entity, ...Number.isFinite(playedAt) && playedAt > 0 ? { playedAt } : {} });
        }
        consumed++;
      }
      const upstreamMore = data.has_more === true;
      hasMore = consumed > offset + items.length || upstreamMore;
      if (!upstreamMore || items.length >= limit) break;
      const next = String(data.next_cursor ?? "");
      if (!next || next === cursor) throw new QishuiError("invalid-response", "Recent-played cursor did not advance");
      cursor = next;
    }
    return { items, hasMore: hasMore && items.length > 0, nextOffset: offset + items.length };
  }
  async function checkTracks(platform, ids) {
    const data = await platform("/media/mcheck/", { media_list: ids.map(trackRef) });
    const rows = Array.isArray(data.media_status_list) ? data.media_status_list : [];
    return {
      statuses: rows.map((row) => ({
        id: String(row.id ?? ""),
        riskResult: Number(row.risk_info?.risk_result ?? -1),
        status: Number(row.risk_info?.status ?? 0)
      }))
    };
  }
  function createLibrary(client) {
    const { platform, command } = client;
    return {
      likedSongs: () => likedSongs(platform),
      recentPlayed: ({ limit = 30, offset = 0 } = {}) => recentPlayed(platform, limit, offset),
      checkTracks: ({ ids }) => checkTracks(platform, mediaIds(ids)),
      async likeSong({ id, liked }) {
        const trackId = mediaId(id);
        if (liked === false) {
          await command("/media/cancel/collect/", { media: [trackRef(trackId)] });
        } else {
          await command("/media/collect/", { media: [trackRef(trackId)], scene: "", collect_action: 1 });
        }
      },
      async editPlaylist({ operation, id, ids }) {
        const playlistId = mediaId(id);
        const tracks = mediaIds(ids);
        const path = operation === "add" ? "/playlist/append/" : "/playlist/delete/";
        if (operation !== "add" && operation !== "remove") {
          throw new QishuiError("unsupported", "Unsupported playlist operation");
        }
        await command(path, { playlist_id: playlistId, media: tracks.map(trackRef) });
      },
      async dislikeSong({ id, disliked }) {
        const trackId = mediaId(id);
        await command("/dislike/", {
          item_id: trackId,
          author_ids: [],
          dislike_item_type: "track",
          action_type: disliked ? 0 : 1
        });
      }
    };
  }

  // src/car/playback.js
  init_globals();
  var levels = { medium: "standard", higher: "high", highest: "high", lossless: "lossless", hi_res: "hires" };
  var rank = (value) => ["standard", "high", "lossless", "hires"].indexOf(value);
  var encrypted = (item) => Boolean(item.encrypt_info?.encrypt || item.encrypt_info?.spade_a || item.PlayAuth || Number(item.Encrypt || 0));
  var requestedRank = (value) => value === "ultra" ? "lossless" : levels[value] || value || "standard";
  async function resolveAudio(client, track, requested) {
    const player = track?.player_info;
    if (!player) throw new QishuiError("not-playable", "Qishui returned no player information");
    const wanted = rank(requestedRank(requested)) < 0 ? "standard" : requestedRank(requested);
    for (const variant of ["full", "preview"]) {
      const info = player[variant]?.video_model_info;
      if (!info) continue;
      const candidates = [];
      if (info.video_model) {
        let model;
        try {
          model = typeof info.video_model === "string" ? JSON.parse(info.video_model) : info.video_model;
        } catch (_) {
          throw new QishuiError("invalid-response", "Invalid Qishui player model");
        }
        for (const item of model.video_list || []) {
          if (encrypted(item) || !item.main_url) continue;
          candidates.push({
            url: mediaUrl(item.main_url),
            quality: levels[item.video_meta?.quality] || "standard",
            bitrate: Number(item.video_meta?.bitrate || 0)
          });
        }
      }
      if (!candidates.length && info.url_player_info) {
        let list = null;
        try {
          const { data } = await client.http(mediaUrl(info.url_player_info));
          list = data.Result?.Data?.PlayInfoList || data.data?.PlayInfoList || data.PlayInfoList;
        } catch (_) {
          list = null;
        }
        for (const item of Array.isArray(list) ? list : []) {
          if (encrypted(item) || !item.MainPlayUrl) continue;
          candidates.push({
            url: mediaUrl(item.MainPlayUrl),
            quality: levels[item.Quality] || "standard",
            bitrate: Number(item.Bitrate || 0)
          });
        }
      }
      if (!candidates.length) continue;
      const allowed = candidates.filter((item) => rank(item.quality) <= rank(wanted));
      const source = (allowed.length ? allowed : candidates).sort((a, b) => rank(b.quality) - rank(a.quality) || b.bitrate - a.bitrate)[0];
      const clipStartMs = variant === "preview" ? Number(player.preview?.duration?.start_ms) : 0;
      return {
        url: source.url,
        quality: source.quality,
        playable: true,
        trial: variant === "preview",
        fetchedAt: Date.now(),
        ...Number(info.expire_at) > Date.now() / 1e3 ? { expiresAt: Number(info.expire_at) * 1e3 } : {},
        ...Number.isFinite(clipStartMs) && clipStartMs > 0 ? { clipStartMs } : {}
      };
    }
    throw new QishuiError("not-playable", "Qishui returned protected audio only; decryption is disabled");
  }

  // src/car/transport.js
  init_globals();
  var DEFAULT_TIMEOUT_MS = 25e3;
  function headerLookup(headers, name) {
    if (!headers) return null;
    const needle = String(name || "").toLowerCase();
    for (const key of Object.keys(headers)) {
      if (String(key).toLowerCase() === needle) return headers[key];
    }
    return null;
  }
  function wrapResponse(native3) {
    const headers = native3 && native3.headers || {};
    return {
      ok: Number(native3 && native3.status) >= 200 && Number(native3 && native3.status) < 300,
      status: Number(native3 && native3.status) || 0,
      // names() 只给键名不给值：诊断要能看出「头到没到」，但不把凭据带出去。
      headers: { get: (name) => headerLookup(headers, name), names: () => Object.keys(headers || {}) },
      text: async () => String(native3 && native3.body || ""),
      json: async () => JSON.parse(String(native3 && native3.body || "{}"))
    };
  }
  function createFetch(transport) {
    const resolve2 = () => {
      if (transport && typeof transport.request === "function") return transport;
      const host = typeof window !== "undefined" ? window.__foliaHttpTransport : null;
      if (host && typeof host.request === "function") return host;
      throw new Error("native http transport is unavailable");
    };
    return async function foliaFetch(url, options = {}) {
      const method = String(options.method || (options.body == null ? "GET" : "POST")).toUpperCase();
      const payload = {
        url: String(url),
        method,
        headers: options.headers || {},
        body: options.body == null ? null : String(options.body),
        timeoutMs: DEFAULT_TIMEOUT_MS
      };
      let native3;
      try {
        native3 = await resolve2().request(payload);
      } catch (error) {
        throw new Error("network");
      }
      return wrapResponse(native3);
    };
  }

  // src/car/api.js
  var QISHUI_LIKED_ID = "qishui-liked";
  var QISHUI_FEED_ID = "qishui-feed";
  var text2 = (value) => value == null ? "" : String(value);
  function createQishuiCar(options = {}) {
    const fetcher = options.fetch || createFetch(options.transport);
    const sessions = options.sessions || createSessions();
    const client = createClient({ sessions, fetch: fetcher });
    const log2 = options.log || (() => {
    });
    const auth = createAuth(client, { log: log2 });
    const catalog = createCatalog(client);
    const feed = createFeed(client);
    const library = createLibrary(client);
    const { platform } = client;
    let likedReal = null;
    const coverCache = /* @__PURE__ */ new Map();
    const COVER_FALLBACK_BUDGET = 12;
    async function firstTrack(id, ownerId) {
      const key = String(id || "");
      if (!key) return null;
      if (coverCache.has(key)) return coverCache.get(key);
      let found = null;
      try {
        const page = await catalog.playlistTracks({
          id: key,
          ownerId: String(ownerId || ""),
          limit: 1,
          offset: 0,
          count: 1
        });
        const [song] = toFoliaSongs(page.items);
        if (song) found = { cover: song.cover || "", name: song.name || "", artist: song.artist || "" };
      } catch (_) {
        found = null;
      }
      coverCache.set(key, found);
      return found;
    }
    function applyCoverFallback(playlist, track) {
      if (!playlist) return;
      if (track?.cover) {
        playlist.cover = track.cover;
        return;
      }
      if (track?.name) {
        playlist.providerData = {
          ...playlist.providerData || {},
          coverSongName: track.name,
          coverSongArtist: track.artist || ""
        };
      }
    }
    async function renewOnce() {
      try {
        await auth.status();
        return Boolean(sessions.get()?.ticket);
      } catch (error) {
        log2(`[Qishui] renew failed (${error?.code || error?.message || error})`);
        return false;
      }
    }
    async function accountTrack(id) {
      const credential = sessions.get();
      if (!credential) return { track: await catalog.track(id), account: false, accountError: "no-session" };
      try {
        return { track: await catalog.track(id, { credential }), account: true };
      } catch (error) {
        const reason = error instanceof QishuiError ? `${error.code}${error.stage ? "/" + error.stage : ""}` : String(error?.code || error?.message || error);
        log2(`[Qishui] account track read failed (${reason}), renewing once before giving up`);
        const renewed = await renewOnce();
        if (renewed) {
          try {
            return { track: await catalog.track(id, { credential: sessions.get() }), account: true, renewed };
          } catch (retryError) {
            const retryReason = retryError instanceof QishuiError ? `${retryError.code}${retryError.stage ? "/" + retryError.stage : ""}` : String(retryError?.code || retryError?.message || retryError);
            log2(`[Qishui] the account read still fails after renewing (${retryReason})`);
            return { track: await catalog.track(id), account: false, accountError: `${reason} → renewed → ${retryReason}` };
          }
        }
        return { track: await catalog.track(id), account: false, accountError: reason };
      }
    }
    async function resolveLiked() {
      if (likedReal) return likedReal;
      likedReal = await likedPlaylist(platform);
      return likedReal;
    }
    const userShape = (user) => user ? {
      id: text2(user.id),
      nickname: text2(user.nickname),
      avatarUrl: coverFromUrlInfo(user.avatar) || (typeof user.avatar === "string" ? user.avatar : ""),
      ...typeof user.isVip === "boolean" ? { vipType: user.isVip ? 1 : 0 } : {}
    } : null;
    return {
      sessions,
      /**
       * 登录态。
       *
       * 判定只认手里有没有 ticket 凭据：车机协议没有 cookie 这一层，旧协议那套
       * 「cookie 里有 sid_tt 就算登录」的坑（sid_tt 登录前就有）在这里不存在。
       * 续期（renew）失败不推翻已登录结论 —— 凭据还没过期就继续用，错误只进诊断。
       */
      async status() {
        const credential = sessions.get();
        const base = {
          provider: "qishui",
          configured: true,
          loggedIn: Boolean(credential?.ticket),
          webSession: Boolean(credential?.ticket),
          cookieReady: Boolean(credential?.ticket),
          protocol: "luna-car",
          scope: QISHUI_QR_SCOPE,
          cookieKeys: "(car-protocol)",
          // 凭据落在哪一档存储：真机上「重启后账号没了」先看这个字段
          // （native=SharedPreferences / local=localStorage / memory=只在这个进程）。
          // ⚠ 这是**读档**：写档几乎恒为 native（设备 ID 每次启动都要写一次），
          // 混着看会被带到错的方向，所以两个分开给。
          storage: storageMode(),
          store: {
            read: storageMode(),
            write: storageWriteMode(),
            session: whereIs("session"),
            deviceId: whereIs("device-id"),
            // 每次启动都重新生成设备 ID＝这一档存储没读出来，凭据当然也没有。
            deviceIdReused: sessions.deviceIdReused === true,
            ...storageParseError() ? { parseError: storageParseError() } : {}
          },
          loginKeys: credential?.ticket ? "ticket=y" : "ticket=n",
          userId: text2(credential?.userId),
          libraryReady: Boolean(credential?.ticket),
          libraryErrors: []
        };
        if (!credential?.ticket) {
          return { ...base, profileReady: false, profile: null, message: "未登录：请用抖音/汽水 App 扫码授权" };
        }
        let user = credential.user || null;
        let profileError = "";
        try {
          const fresh = await auth.status();
          if (fresh) user = fresh;
        } catch (error) {
          profileError = error instanceof QishuiError ? `${error.code}${error.stage ? "/" + error.stage : ""}: ${error.message}` : String(error?.message || error);
          if (Number(credential.expiresAt) > 0 && Number(credential.expiresAt) <= Date.now()) {
            return {
              ...base,
              loggedIn: false,
              webSession: false,
              cookieReady: false,
              profileReady: false,
              profile: null,
              profileError,
              message: "Qishui session expired; scan the QR code again"
            };
          }
        }
        return {
          ...base,
          profileReady: Boolean(user?.id),
          profile: userShape(user),
          ...profileError ? { profileError } : {},
          expiresAt: Number(credential.expiresAt) || 0
        };
      },
      async startLogin() {
        const result = await auth.start();
        return { key: result.key, qrDataUrl: result.imageUrl };
      },
      qr: (key) => auth.qr(key).imageUrl,
      checkLogin: (key) => auth.check(key),
      cancelLogin: (key) => {
        auth.cancel(key);
      },
      /**
       * 把当前凭据原样导出，交给渲染层存进 **App 自己**那一份存储。
       *
       * 为什么要有这一手：桥自己那份（隐藏 WebView 的 SharedPreferences /
       * localStorage）在真机上并不总是读得回来 —— 重启后它空了，登录态就凭空没了，
       * 而播放地址那一路也会退回公共令牌（audioMeta 的 account=false，
       * 受保护的曲子只剩试听）。App 主 WebView 的 localStorage 是另一条通道，
       * 网易 / QQ / 酷狗的登录态都靠它跨重启活着，所以凭据在两边各留一份。
       */
      exportSession() {
        return { provider: "qishui", credential: sessions.get() || null };
      },
      /**
       * 灌回一份凭据：启动时桥说没登录，就先把 App 存的那份塞回去再问一次。
       *
       * 只认形状不认内容 —— ticket 与 guardKey 缺一个就签不出请求。
       *
       * ⚠ 不是无条件覆盖：渲染层每次查登录态都会先灌一次（它不知道桥此刻有没有），
       * 而桥这份可能是**刚续过期的**（renew 写过新 ticket）。拿 App 那份旧的盖回去，
       * 等于把一次成功的续期作废。所以只在两种情况下真的写：桥现在没有凭据，
       * 或者灌进来的这份过期时间更晚。
       */
      importSession(credential) {
        const value = credential && typeof credential === "object" ? credential : null;
        if (!value || !value.ticket || !value.guardKey) {
          return { provider: "qishui", restored: false, reason: "the saved session has no ticket or guard key" };
        }
        const current = sessions.get();
        const currentExpiry = Number(current?.expiresAt) || 0;
        const nextExpiry = Number(value.expiresAt) || 0;
        if (current?.ticket && nextExpiry <= currentExpiry) {
          return { provider: "qishui", restored: false, kept: true, reason: "the bridge already holds this session" };
        }
        sessions.set(value);
        coverCache.clear();
        log2("[Qishui] the session kept by the app was put back into the bridge");
        return { provider: "qishui", restored: true };
      },
      logout() {
        auth.logout();
        feed.clear();
        likedReal = null;
        coverCache.clear();
        return { provider: "qishui", loggedIn: false, webSession: false, cookieReady: false, configured: true };
      },
      async search(keywords, limit, offset) {
        const page = await catalog.searchSongs({ query: keywords, limit, offset });
        const songs = toFoliaSongs(page.items);
        return {
          provider: "qishui",
          songs,
          rawCount: page.items.length,
          offset,
          limit,
          nextOffset: page.nextOffset,
          hasMore: page.hasMore
        };
      },
      // 搜索出来的歌单同样带着那个 403 的封面，但一次搜索就是十几张卡片，
      // 逐张再发一次 /playlist/detail/ 换图不划算 —— 点进去看详情时再兜（见上）。
      async searchPlaylists(keywords, limit, offset) {
        const page = await catalog.searchPlaylists({ query: keywords, limit, offset });
        return {
          provider: "qishui",
          playlists: toFoliaPlaylists(page.items),
          nextOffset: page.nextOffset,
          hasMore: page.hasMore
        };
      },
      async songDetail(id) {
        const { track } = await accountTrack(id);
        return { provider: "qishui", song: toFoliaSong(track) };
      },
      async lyrics(id) {
        const { track } = await accountTrack(id);
        const lyrics = lyricsFromTrack(track);
        return {
          provider: "qishui",
          lyric: lyrics.lyric,
          yrc: lyrics.yrc,
          tlyric: lyrics.tlyric,
          source: lyrics.lyric || lyrics.yrc ? "luna-car" : "none"
        };
      },
      async audio(id, quality) {
        const { track, account, accountError, renewed } = await accountTrack(id);
        const audio = await resolveAudio(client, track, quality);
        const player = track?.player_info || {};
        return {
          provider: "qishui",
          ...audio,
          audioMeta: {
            account,
            ...accountError ? { accountError } : {},
            // 这一首是靠「补一次续期」才走上账号那条路的：说明 status 那一问
            // 没能在启动阶段把凭据续上（原生侧的排队修复之前，这是常态）。
            ...renewed ? { renewed } : {},
            playerType: Number.isFinite(Number(player.player_type)) ? Number(player.player_type) : -1,
            fullModel: Boolean(player.full?.video_model_info),
            previewModel: Boolean(player.preview?.video_model_info),
            // full 那套换没换出明文：换不出就会掉到 preview，这是同一现象的
            // 另一半原因（凭据在手也照样只剩试听）。
            gotFull: audio?.trial === false
          }
        };
      },
      /**
       * 我的歌单：真实列表 + 两个虚拟入口（我的喜欢 / 推荐流）。
       * 车机的「我的喜欢」本身就在真实列表里（type 1），这里把它换成统一入口，
       * 免得同一个歌单在界面上出现两次。
       */
      async userPlaylists(limit, offset) {
        const page = await catalog.userPlaylists({ limit: 1e4, offset: 0 });
        const real = page.items.filter((item) => Number(item?.base_info?.type) !== 1);
        const liked = await resolveLiked().catch(() => null);
        const likedTrack = liked ? await firstTrack(liked.id, liked.ownerId) : null;
        const virtual = [
          {
            id: QISHUI_LIKED_ID,
            name: "我的喜欢",
            cover: "",
            description: "",
            trackCount: 0,
            creator: void 0,
            artists: [],
            isOwned: true,
            owned: true,
            virtual: true
          },
          {
            id: QISHUI_FEED_ID,
            name: "汽水推荐",
            cover: "",
            description: "",
            trackCount: 0,
            creator: void 0,
            artists: [],
            isOwned: true,
            owned: true,
            virtual: true,
            playbackMode: "recommend-match"
          }
        ];
        applyCoverFallback(virtual[0], likedTrack);
        const mapped = toFoliaPlaylists(real);
        const pending = [];
        for (let i = 0; i < mapped.length && pending.length < COVER_FALLBACK_BUDGET; i++) {
          pending.push({ index: i, id: String(real[i]?.base_info?.id || ""), ownerId: String(real[i]?.base_info?.owner_id || "") });
        }
        await Promise.all(pending.map(async (entry) => {
          applyCoverFallback(mapped[entry.index], await firstTrack(entry.id, entry.ownerId));
        }));
        const items = [...virtual, ...mapped];
        return {
          provider: "qishui",
          playlists: items.slice(offset, offset + limit),
          total: items.length,
          nextOffset: offset + Math.min(limit, Math.max(0, items.length - offset)),
          hasMore: offset + limit < items.length,
          libraryErrors: liked ? [] : ["liked-playlist: not found"]
        };
      },
      async playlistTracks(id, limit, offset, ownerId = "") {
        const key = text2(id);
        if (key === QISHUI_FEED_ID || key === "qishui-feed") {
          const page2 = await feed.songs({ count: Math.max(limit, 6) });
          const songs = toFoliaSongs(page2.items);
          return {
            provider: "qishui",
            tracks: songs,
            songs,
            total: songs.length,
            offset,
            nextOffset: offset + songs.length,
            hasMore: Boolean(page2.hasMore)
          };
        }
        if (key === QISHUI_LIKED_ID || key === "qishui-liked") {
          const liked = await resolveLiked();
          if (!liked) {
            return {
              provider: "qishui",
              tracks: [],
              songs: [],
              total: 0,
              offset,
              nextOffset: offset,
              hasMore: false,
              libraryErrors: ["liked-playlist: not found"]
            };
          }
          return this.playlistTracks(liked.id, limit, offset, liked.ownerId);
        }
        const page = await catalog.playlistTracks({ id: key, ownerId, limit, offset });
        const tracks = toFoliaSongs(page.items);
        const card = page.collection ? toFoliaPlaylists([page.collection])[0] || null : null;
        applyCoverFallback(card, tracks[0] ? { cover: tracks[0].cover, name: tracks[0].name, artist: tracks[0].artist } : null);
        return {
          provider: "qishui",
          tracks,
          songs: tracks,
          playlist: card,
          total: tracks.length,
          offset,
          nextOffset: page.nextOffset,
          hasMore: page.hasMore
        };
      },
      async artist(artistId, limit, offset) {
        const page = await catalog.artistSongs({ id: artistId, limit: limit || 50, offset: offset || 0 });
        const songs = toFoliaSongs(page.items);
        let artist = null;
        try {
          const info = await catalog.artistDetail({ id: artistId });
          if (info) {
            artist = {
              id: text2(info.id || artistId),
              name: text2(info.name),
              cover: coverFromUrlInfo(info.url_avatar || info.avatar),
              trackCount: Number(info.count_tracks || songs.length) || 0,
              artists: [{ id: text2(info.id || artistId), name: text2(info.name) }]
            };
          }
        } catch (_) {
        }
        return { provider: "qishui", artist, songs, total: page.total, nextOffset: page.nextOffset, hasMore: page.hasMore };
      },
      async feed(limit) {
        const page = await feed.songs({ count: Math.max(limit, 6) });
        const songs = toFoliaSongs(page.items);
        return { provider: "qishui", songs, hasMore: Boolean(page.hasMore) };
      },
      feedModes: () => feed.modes(),
      likedSongs: () => library.likedSongs(),
      recentPlayed: (limit, offset) => library.recentPlayed({ limit, offset }).then((page) => ({
        provider: "qishui",
        songs: toFoliaSongs(page.items),
        hasMore: page.hasMore
      })),
      checkTracks: (ids) => library.checkTracks({ ids }),
      likeSong: (id, liked) => library.likeSong({ id, liked }).then(() => ({ provider: "qishui", success: true })),
      addSongs: (playlistId, ids) => library.editPlaylist({ operation: "add", id: playlistId, ids }).then(() => ({ provider: "qishui", success: true })),
      removeSongs: (playlistId, ids) => library.editPlaylist({ operation: "remove", id: playlistId, ids }).then(() => ({ provider: "qishui", success: true })),
      dislikeSong: (id, disliked) => library.dislikeSong({ id, disliked }).then(() => ({ provider: "qishui", success: true }))
    };
  }

  // src/phone/api.js
  init_globals();
  var import_qishui_web_api = __toESM(require_qishui_web_api(), 1);

  // src/phone/auth.js
  init_globals();
  var import_qrcode = __toESM(require_browser(), 1);

  // src/phone/protocol.js
  init_globals();
  init_crypto();
  var QISHUI_PHONE_API_BASE = "https://api.qishui.com";
  var QISHUI_PHONE_WEB_BASE = "https://www.qishui.com";
  var QISHUI_PHONE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.2.1 Chrome/136.0.7103.59 Electron/36.4.0-rs.22.release.main.1 TTElectron/36.4.0-rs.22.release.main.1 Safari/537.36";
  var PASSPORT_AID = "386088";
  var PASSPORT_APP_VERSION = "3.5.2";
  var PASSPORT_SDK_VERSION = "2.4.13";
  var PASSPORT_SECURE_SDK_VERSION = "3.3.5";
  var PASSPORT_VERIFY_SDK_VERSION = "1.0.29";
  var PASSPORT_BDMS_VERSION = "1.0.0.41";
  var QR_TTL_MS2 = 5 * 60 * 1e3;
  function randomDigits(length, firstMax = 9) {
    let value = String(Math.floor(Math.random() * Math.max(2, firstMax + 1)));
    while (value.length < length) value += String(Math.floor(Math.random() * 10));
    return value;
  }
  function randomHex2(bytes) {
    let out = "";
    for (let i = 0; i < bytes; i++) out += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
    return out;
  }
  var QISHUI_SCAN_LOGIN_URL = "https://bff-pc.qishui.com/light/invoke/scan_login";
  function buildQishuiScanUrl(indexUrl, computerName) {
    let token = "";
    try {
      token = new URL(String(indexUrl || "")).searchParams.get("token") || "";
    } catch (_) {
      return "";
    }
    if (!token) return "";
    const target = new URL(QISHUI_SCAN_LOGIN_URL);
    target.searchParams.set("token", token);
    target.searchParams.set("os", "Windows");
    target.searchParams.set("computer_name", computerName || "Windows-PC");
    return target.toString().replace(/\+/g, "%20");
  }
  function passportCommonParams(identity, extra = {}) {
    return {
      passport_jssdk_version: PASSPORT_SDK_VERSION,
      passport_jssdk_type: "normal",
      is_from_ttaccountsdk: "1",
      aid: PASSPORT_AID,
      language: "zh",
      account_sdk_source: "web",
      p_js_v: PASSPORT_SDK_VERSION,
      p_js_t: "pro",
      p_zt: PASSPORT_SECURE_SDK_VERSION,
      p_ver: PASSPORT_VERIFY_SDK_VERSION,
      request_host: "app%3A%2F%2Fresources",
      p_bd: PASSPORT_BDMS_VERSION,
      biz_trace_id: randomHex2(4),
      is_new_login: "1",
      is_from_iesaccountsaas: "1",
      device_id: identity.deviceId,
      install_id: identity.installId,
      did: identity.deviceId,
      iid: identity.installId,
      device_platform: "PC",
      version_code: PASSPORT_APP_VERSION,
      ...extra
    };
  }
  function passportHeaders(identity, bizTraceId) {
    const traceId = randomHex2(16);
    return {
      Accept: "application/json, text/javascript",
      "User-Agent": QISHUI_PHONE_UA,
      "x-tt-passport-verify-portrait": identity.verifyPortraitId,
      "x-tt-passport-trace-id": bizTraceId,
      "x-tt-trace-id": `00-${traceId}-${traceId.slice(0, 16)}-01`
    };
  }
  async function passportRequest(fetcher, { identity, method = "GET", path, params = {}, body = null, cookie = "" }) {
    const query = passportCommonParams(identity, params);
    const url = new URL(path, QISHUI_PHONE_API_BASE);
    for (const [name, value] of Object.entries(query)) {
      if (value != null) url.searchParams.set(name, String(value));
    }
    const headers = passportHeaders(identity, String(query.biz_trace_id || ""));
    const carried = String(cookie || "").trim();
    if (carried) headers.Cookie = carried;
    let encoded = null;
    if (body != null) {
      const form = new URLSearchParams();
      for (const [name, value] of Object.entries(body)) {
        if (value != null) form.set(name, typeof value === "object" ? JSON.stringify(value) : String(value));
      }
      encoded = form.toString();
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      try {
        headers["x-ss-stub"] = createHash("md5").update(encoded).digest("hex").toUpperCase();
      } catch (_) {
      }
    }
    const response = await fetcher(url.toString(), { method, headers, body: encoded });
    const text5 = await response.text();
    let json = null;
    try {
      json = JSON.parse(text5);
    } catch (_) {
      json = null;
    }
    if (!response.ok || !json) {
      const error = new Error(`Qishui passport ${path} failed (HTTP ${response.status})`);
      error.code = "invalid-response";
      throw error;
    }
    const setCookie = response.headers && typeof response.headers.get === "function" ? String(response.headers.get("set-cookie") || "") : "";
    return { json, setCookie };
  }
  function parseCookieString(raw) {
    const result = {};
    String(raw || "").split(";").forEach((pair) => {
      const index = pair.indexOf("=");
      if (index > 0) result[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
    });
    return result;
  }
  function buildCookieString(values) {
    return Object.entries(values || {}).filter(([name, value]) => name && value !== void 0 && value !== null && String(value) !== "").map(([name, value]) => `${name}=${String(value)}`).join("; ");
  }
  var QISHUI_LOGIN_COOKIE_KEYS = ["sessionid", "sessionid_ss", "sid_guard", "sid_tt", "uid_tt", "uid_tt_ss"];
  function hasLoginCookie(text5) {
    const values = parseCookieString(text5);
    return QISHUI_LOGIN_COOKIE_KEYS.some((name) => Boolean(values[name]));
  }
  function cookieFromSetCookie(raw) {
    return String(raw || "").split(/,(?=[^;]+=)/).map((part) => part.split(";")[0].trim()).filter(Boolean).join("; ");
  }
  function hostCookie(url) {
    try {
      const host = typeof window !== "undefined" ? window.FoliaQishuiHost : null;
      if (!host || typeof host.getCookie !== "function") return "";
      return String(host.getCookie(url) || "");
    } catch (_) {
      return "";
    }
  }
  function hostCookies() {
    return [hostCookie(`${QISHUI_PHONE_API_BASE}/`), hostCookie(`${QISHUI_PHONE_WEB_BASE}/`)].filter(Boolean).join("; ");
  }

  // src/phone/storage.js
  init_globals();
  var PREFIX3 = "folia:qishui:phone:";
  var memory3 = /* @__PURE__ */ new Map();
  function native2() {
    try {
      const host = typeof window !== "undefined" ? window.FoliaQishuiHost : null;
      if (!host || typeof host.getStore !== "function" || typeof host.putStore !== "function") return null;
      return host;
    } catch (_) {
      return null;
    }
  }
  function local2() {
    try {
      return typeof window !== "undefined" ? window.localStorage : null;
    } catch (_) {
      return null;
    }
  }
  var lastRead2 = "none";
  var lastWrite2 = "none";
  var lastParseError2 = "";
  var storageMode2 = () => lastRead2;
  var storageWriteMode2 = () => lastWrite2;
  var storageParseError2 = () => lastParseError2;
  function whereIs2(key) {
    const host = native2();
    if (host) {
      try {
        if (host.getStore(key)) return "native";
      } catch (_) {
      }
    }
    const target = local2();
    if (target) {
      try {
        if (target.getItem(PREFIX3 + key) != null) return "local";
      } catch (_) {
      }
    }
    return memory3.has(key) ? "memory" : "none";
  }
  function readJson2(key, fallback = null) {
    const host = native2();
    if (host) {
      try {
        const text5 = host.getStore(key);
        if (text5) {
          lastRead2 = "native";
          try {
            return JSON.parse(text5);
          } catch (error) {
            lastParseError2 = `native/${key}: ${error?.message || error}`;
          }
        }
      } catch (_) {
      }
    }
    const target = local2();
    if (target) {
      try {
        const text5 = target.getItem(PREFIX3 + key);
        if (text5 != null) {
          lastRead2 = "local";
          try {
            return JSON.parse(text5);
          } catch (error) {
            lastParseError2 = `local/${key}: ${error?.message || error}`;
          }
        }
      } catch (_) {
      }
    }
    if (memory3.has(key)) {
      lastRead2 = "memory";
      return memory3.get(key);
    }
    lastRead2 = "none";
    return fallback;
  }
  function writeJson2(key, value) {
    const text5 = JSON.stringify(value == null ? null : value);
    memory3.set(key, value);
    const host = native2();
    if (host) {
      try {
        host.putStore(key, text5);
        lastWrite2 = "native";
      } catch (_) {
      }
    }
    const target = local2();
    if (target) {
      try {
        target.setItem(PREFIX3 + key, text5);
        if (lastWrite2 !== "native") lastWrite2 = "local";
      } catch (_) {
      }
    }
    if (lastWrite2 === "none") lastWrite2 = "memory";
  }
  function remove2(key) {
    memory3.delete(key);
    const host = native2();
    if (host) {
      try {
        host.putStore(key, null);
      } catch (_) {
      }
    }
    const target = local2();
    if (target) {
      try {
        target.removeItem(PREFIX3 + key);
      } catch (_) {
      }
    }
  }
  var DEVICE_KEY2 = "phone-device-id";
  var SESSION_KEY2 = "phone-session";

  // src/phone/auth.js
  var text3 = (value) => value == null ? "" : String(value);
  function makeComputerName() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let suffix = "";
    for (let i = 0; i < 7; i += 1) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    return `DESKTOP-${suffix}`;
  }
  async function renderQrImage(content) {
    const svg = await import_qrcode.default.toString(content, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 2,
      width: 360,
      color: { dark: "#000000", light: "#ffffff" }
    });
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  }
  function createIdentity() {
    let identity = readJson2(DEVICE_KEY2, null);
    const reused = Boolean(identity && /^\d{19}$/.test(text3(identity.deviceId)));
    if (!reused) {
      identity = {
        deviceId: randomDigits(19),
        installId: randomDigits(15),
        verifyPortraitId: `${randomHex2(8)}.login`,
        computerName: makeComputerName()
      };
      writeJson2(DEVICE_KEY2, identity);
    } else if (!text3(identity.computerName)) {
      identity = { ...identity, computerName: makeComputerName() };
      writeJson2(DEVICE_KEY2, identity);
    }
    return { ...identity, reused };
  }
  function createAuth2(fetcher, { log: log2 = () => {
  } } = {}) {
    const identity = createIdentity();
    const pending = /* @__PURE__ */ new Map();
    const readSession = () => {
      const value = readJson2(SESSION_KEY2, null);
      return value && typeof value === "object" ? value : null;
    };
    const writeSession = (value) => value ? writeJson2(SESSION_KEY2, value) : remove2(SESSION_KEY2);
    const cookie = () => text3(readSession()?.cookie);
    const mergeCookie = (parts) => {
      const merged = parseCookieString(cookie());
      for (const part of parts) {
        Object.assign(merged, parseCookieString(part));
      }
      const next = buildCookieString(merged);
      const session = readSession() || {};
      writeSession({ ...session, cookie: next, savedAt: Date.now() });
      return hasLoginCookie(next);
    };
    const harvestRedirect = async (url) => {
      const target = text3(url);
      if (!/^https?:\/\//i.test(target)) return "";
      try {
        const carried = cookie();
        const response = await fetcher(target, {
          method: "GET",
          headers: {
            Accept: "text/html,application/json;q=0.9,*/*;q=0.8",
            "User-Agent": QISHUI_PHONE_UA,
            ...carried ? { Cookie: carried } : {}
          }
        });
        await response.text().catch(() => "");
        return hostCookies();
      } catch (_) {
        return "";
      }
    };
    const collectAfterConfirm = async (data, envelope, setCookie) => {
      const parts = [];
      const direct = {};
      for (const key of QISHUI_LOGIN_COOKIE_KEYS) {
        const value = data[key] ?? envelope[key];
        if (typeof value === "string" && value) direct[key] = value;
      }
      if (text3(data.session_cookie)) parts.push(data.session_cookie);
      if (Object.keys(direct).length) parts.push(buildCookieString(direct));
      if (setCookie) parts.push(cookieFromSetCookie(setCookie));
      parts.push(hostCookies());
      const redirect = text3(data.redirect_url || data.redirect);
      if (redirect) parts.push(await harvestRedirect(redirect));
      return mergeCookie(parts);
    };
    const clean = () => {
      for (const [key, value] of pending) {
        if (value.expiresAt <= Date.now()) pending.delete(key);
      }
    };
    return {
      identity,
      cookie,
      /** 登录判定：手里有没有真的会话 Cookie（不只是 sid_tt 那种跟踪键）。 */
      isLoggedIn: () => hasLoginCookie(cookie()),
      /**
       * 诊断用：两个登录键各在不在。
       *
       * 「有 sid_tt 但没 sessionid」是这一路最会骗人的中间态 —— 扫码前 sid_tt
       * 就已经下发，登录判定只认「任一登录键命中」就会被它骗过。
       */
      loginKeys: () => {
        const values = parseCookieString(cookie());
        return QISHUI_LOGIN_COOKIE_KEYS.map((name) => `${name}${values[name] ? "=y" : "=n"}`).join(" ");
      },
      cookieKeys: () => Object.keys(parseCookieString(cookie())).join(",") || "(empty)",
      async start() {
        clean();
        const { json, setCookie } = await passportRequest(fetcher, {
          identity,
          method: "GET",
          path: "/passport/web/get_qrcode/",
          params: { next: QISHUI_PHONE_API_BASE, need_logo: "false", need_short_url: "false" },
          cookie: cookie()
        });
        const data = json?.data || {};
        if (json?.message !== "success" || Number(data.error_code) !== 0) {
          const error = new Error(`汽水二维码生成失败：code=${data.error_code} ${text3(data.description)}`);
          error.code = "invalid-response";
          throw error;
        }
        if (setCookie) mergeCookie([cookieFromSetCookie(setCookie), hostCookies()]);
        const scanUrl = buildQishuiScanUrl(data.qrcode_index_url, identity.computerName);
        let imageUrl = text3(data.qrcode);
        if (scanUrl) {
          try {
            imageUrl = await renderQrImage(scanUrl);
          } catch (renderError) {
            log2(
              "[Qishui] drawing the scan QR failed, falling back to the image the server sent:",
              renderError && renderError.message ? renderError.message : renderError
            );
          }
        } else {
          log2("[Qishui] qrcode_index_url carries no token, so the QR falls back to the server image");
        }
        const key = text3(data.token);
        if (!key || !imageUrl) {
          const error = new Error("汽水二维码返回不完整（缺 token 或 qrcode）");
          error.code = "invalid-response";
          throw error;
        }
        const expireSeconds = Number(data.expire_time);
        const expiresAt = Number.isFinite(expireSeconds) && expireSeconds > 1e9 ? expireSeconds * 1e3 : Date.now() + QR_TTL_MS2;
        pending.set(key, { imageUrl, expiresAt });
        return {
          key,
          imageUrl,
          expiresAt,
          scanUrl,
          copywriting: text3(data.copywriting),
          webName: text3(data.web_name)
        };
      },
      qr(key) {
        const entry = pending.get(text3(key));
        if (!entry) {
          const error = new Error("QISHUI_QR_TOKEN_REQUIRED");
          error.code = "invalid-response";
          throw error;
        }
        return { imageUrl: entry.imageUrl, expiresAt: entry.expiresAt };
      },
      async check(key) {
        const token = text3(key);
        if (!token) {
          const error = new Error("QISHUI_QR_TOKEN_REQUIRED");
          error.code = "invalid-response";
          throw error;
        }
        const { json, setCookie } = await passportRequest(fetcher, {
          identity,
          method: "POST",
          path: "/passport/web/check_qrconnect/",
          body: {
            need_logo: "false",
            need_short_url: "false",
            is_frontier: "true",
            token,
            is_new_login: "1",
            next: QISHUI_PHONE_API_BASE
          },
          // 与出码同一个会话（见 protocol.js 里 passportRequest 的说明）：
          // 少了它，服务端眼里「扫码确认」与「轮询」是两台陌生设备。
          cookie: cookie()
        });
        const data = json?.data || {};
        const errorCode = Number(data.error_code || 0);
        const rawStatus = text3(data.status).trim().toLowerCase();
        if (errorCode === 2046) {
          return { state: "error", failure: { case: "refused", message: "汽水要求设备二次验证，请改用其它登录方式" } };
        }
        const confirmed = rawStatus === "3" || rawStatus === "confirmed" || Boolean(data.session_cookie);
        if (confirmed) {
          const ready = await collectAfterConfirm(data, json, setCookie);
          if (!ready) return { state: "scanned", waitingForCookie: true };
          pending.delete(token);
          return { state: "confirmed" };
        }
        if (errorCode === 2 || /^(4|5|expired|timeout)$/.test(rawStatus)) return { state: "expired" };
        if (errorCode === 7) return { state: "error", failure: { case: "rate-limited", message: "扫码过于频繁，请稍后再试" } };
        if (/^(2|scanned|scan)$/.test(rawStatus)) return { state: "scanned" };
        return { state: "waiting" };
      },
      cancel(key) {
        pending.delete(text3(key));
      },
      logout() {
        pending.clear();
        remove2(SESSION_KEY2);
        try {
          const host = typeof window !== "undefined" ? window.FoliaQishuiHost : null;
          if (host && typeof host.clearCookies === "function") host.clearCookies();
        } catch (_) {
        }
        return { provider: "qishui", loggedIn: false };
      },
      /** 交给渲染层在 App 侧再存一份（跨重启用，与车机那套同一条理由）。 */
      exportSession() {
        const session = readSession();
        return { provider: "qishui", protocol: "passport-web", credential: session?.cookie ? session : null };
      },
      /**
       * 灌回一份会话。
       *
       * ⚠ 不是无条件覆盖：渲染层每次查登录态都会先灌一次，而桥这份可能是刚确认过的。
       * 只在「桥现在没有」或「灌进来的这份更晚」时才真的写。
       */
      importSession(credential) {
        const value = credential && typeof credential === "object" ? credential : null;
        if (!value || !hasLoginCookie(text3(value.cookie))) {
          return { provider: "qishui", restored: false, reason: "the saved session has no login cookie" };
        }
        const current = readSession();
        if (hasLoginCookie(text3(current?.cookie)) && Number(value.savedAt || 0) <= Number(current?.savedAt || 0)) {
          return { provider: "qishui", restored: false, kept: true, reason: "the bridge already holds this session" };
        }
        writeSession(value);
        log2("[Qishui] the phone-protocol session kept by the app was put back into the bridge");
        return { provider: "qishui", restored: true };
      },
      /** 直接给一段 Cookie（手动粘贴那一条路：跳过扫码，直接把会话灌进来）。 */
      importCookie(raw) {
        const ready = mergeCookie([text3(raw)]);
        if (!ready) return { provider: "qishui", restored: false, reason: "the pasted cookie has no login key" };
        return { provider: "qishui", restored: true };
      }
    };
  }

  // src/phone/api.js
  var text4 = (value) => value == null ? "" : String(value);
  var STATUS_ENRICH_BUDGET_MS = 15e3;
  var withBudget = async (promise, ms) => {
    let timer = null;
    const timeout = new Promise((resolve2) => {
      timer = setTimeout(() => resolve2(null), ms);
    });
    try {
      return await Promise.race([Promise.resolve(promise).catch(() => null), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  function createQishuiPhone(options = {}) {
    const fetcher = options.fetch || createFetch(options.transport);
    const log2 = options.log || (() => {
    });
    const auth = options.auth || createAuth2(fetcher, { log: log2 });
    const requireSession = () => {
      const cookie = auth.cookie();
      if (!hasLoginCookie(cookie)) {
        throw new QishuiError("auth-required", "Qishui phone protocol needs a signed-in session cookie");
      }
      return cookie;
    };
    return {
      sessions: { get: () => auth.isLoggedIn() ? { cookie: auth.cookie() } : null },
      /**
       * 登录态：只认手里有没有会话 Cookie。
       *
       * 字段与车机那一份对齐（storage / store / cookieKeys / loginKeys），
       * 诊断面板与「重启后账号没了」的排查两边能互相印证。
       */
      async status() {
        const cookie = auth.cookie();
        const loggedIn = hasLoginCookie(cookie);
        const base = {
          provider: "qishui",
          configured: true,
          loggedIn,
          webSession: loggedIn,
          cookieReady: loggedIn,
          protocol: "passport-web",
          cookieKeys: auth.cookieKeys(),
          loginKeys: auth.loginKeys(),
          storage: storageMode2(),
          store: {
            read: storageMode2(),
            write: storageWriteMode2(),
            session: whereIs2("phone-session"),
            deviceId: whereIs2("phone-device-id"),
            deviceIdReused: auth.identity.reused === true,
            ...storageParseError2() ? { parseError: storageParseError2() } : {}
          },
          userId: "",
          libraryReady: loggedIn,
          libraryErrors: []
        };
        if (!loggedIn) {
          return { ...base, profileReady: false, profile: null, message: "未登录：请用汽水/抖音 App 扫码（手机协议）" };
        }
        const enriched = await withBudget(import_qishui_web_api.default.handleQishuiStatus(cookie), STATUS_ENRICH_BUDGET_MS);
        if (!enriched) {
          return {
            ...base,
            profileReady: false,
            profile: null,
            profileError: "the profile read did not finish in time"
          };
        }
        const profile = enriched.profile || {};
        return {
          ...base,
          userId: text4(profile.userId || enriched.userId),
          profileReady: Boolean(profile.profileReady),
          profile: profile.profileReady ? {
            id: text4(profile.userId),
            nickname: text4(profile.nickname),
            avatarUrl: text4(profile.avatar),
            ...Number.isFinite(Number(profile.vipType)) ? { vipType: Number(profile.vipType) } : {}
          } : null,
          ...Array.isArray(enriched.libraryErrors) && enriched.libraryErrors.length ? { libraryErrors: enriched.libraryErrors.map((item) => String(item)) } : {}
        };
      },
      async startLogin() {
        const result = await auth.start();
        return {
          key: result.key,
          qrDataUrl: result.imageUrl,
          expiresAt: result.expiresAt,
          scanUrl: result.scanUrl
        };
      },
      qr: (key) => auth.qr(key).imageUrl,
      checkLogin: (key) => auth.check(key),
      cancelLogin: (key) => {
        auth.cancel(key);
      },
      exportSession: () => auth.exportSession(),
      importSession: (credential) => auth.importSession(credential),
      /** 手动粘贴 Cookie 那一条路：跳过扫码，直接把会话灌进来。 */
      importCookie: (raw) => auth.importCookie(raw),
      logout() {
        auth.logout();
        return { provider: "qishui", loggedIn: false, webSession: false, cookieReady: false, configured: true };
      },
      async search(keywords, limit, offset) {
        const cookie = auth.cookie();
        const data = await import_qishui_web_api.default.handleQishuiSearch(keywords, limit, cookie, offset);
        return { provider: "qishui", ...data, offset, limit };
      },
      async songDetail(id) {
        const data = await import_qishui_web_api.default.handleQishuiSongDetail(text4(id));
        if (!data?.song) {
          throw new QishuiError("invalid-response", text4(data?.error) || "Qishui phone protocol has no such track");
        }
        return { provider: "qishui", ...data };
      },
      async lyrics(id) {
        const data = await import_qishui_web_api.default.handleQishuiLyric(text4(id), auth.cookie());
        return {
          provider: "qishui",
          lyric: text4(data?.lyric),
          tlyric: text4(data?.tlyric),
          // 手机协议只有整行歌词，没有逐字（yrc）：渲染层认没有 yrc 的情况。
          source: text4(data?.source) || "none"
        };
      },
      async audio(id, quality) {
        const cookie = requireSession();
        const data = await import_qishui_web_api.default.handleQishuiSongUrl({ id: text4(id), quality: text4(quality || "standard") }, cookie);
        return {
          provider: "qishui",
          ...data,
          audioMeta: {
            account: true,
            protocol: "passport-web",
            gotFull: data?.trial === false,
            ...data?.restriction?.category ? { category: String(data.restriction.category) } : {}
          }
        };
      },
      async userPlaylists(limit, offset) {
        const cookie = requireSession();
        const data = await import_qishui_web_api.default.handleQishuiUserPlaylists(cookie);
        const playlists = Array.isArray(data?.playlists) ? data.playlists : [];
        return {
          provider: "qishui",
          ...data,
          playlists: playlists.slice(offset, offset + limit),
          total: playlists.length,
          nextOffset: offset + Math.min(limit, Math.max(0, playlists.length - offset)),
          hasMore: offset + limit < playlists.length
        };
      },
      async playlistTracks(id, limit, offset) {
        const cookie = requireSession();
        const data = await import_qishui_web_api.default.handleQishuiPlaylistTracks(text4(id), { limit, offset }, cookie);
        return { provider: "qishui", ...data, songs: data?.tracks || [] };
      },
      /**
       * 歌手页：官方没有「按 id 取歌手」的端点，桌面端那一份是**用歌手名搜索再聚合**，
       * 所以 artistName 是必填（渲染层从搜索结果里记住了名字再传回来，
       * 见 qishuiNormalize 的 rememberQishuiArtist）。
       */
      async artist(artistId, limit, offset, artistName = "") {
        const cookie = requireSession();
        const data = await import_qishui_web_api.default.handleQishuiArtistDetail(
          { artistId: text4(artistId), artistName: text4(artistName), limit: limit || 36 },
          cookie
        );
        if (data?.error && !Array.isArray(data.songs)) {
          throw new QishuiError("invalid-response", text4(data.error));
        }
        return { provider: "qishui", ...data, total: Array.isArray(data?.songs) ? data.songs.length : 0 };
      },
      async feed(limit) {
        const cookie = requireSession();
        const data = await import_qishui_web_api.default.handleQishuiFeed(limit, cookie);
        return { provider: "qishui", ...data };
      },
      likedSongs() {
        const cookie = requireSession();
        return import_qishui_web_api.default.handleQishuiPlaylistTracks("liked", { limit: 50, offset: 0 }, cookie);
      },
      recentPlayed(limit, offset) {
        const cookie = requireSession();
        return import_qishui_web_api.default.handleQishuiPlaylistTracks("recent", { limit: limit || 50, offset: offset || 0 }, cookie).then((data) => ({ provider: "qishui", songs: data?.tracks || [], hasMore: Boolean(data?.hasMore) }));
      },
      checkTracks(ids) {
        const cookie = requireSession();
        return import_qishui_web_api.default.handleQishuiCheckTracksLiked(ids, cookie);
      },
      likeSong(id, liked) {
        const cookie = requireSession();
        return import_qishui_web_api.default.handleQishuiSetTrackLiked(text4(id), liked !== false, cookie).then(() => ({ provider: "qishui", success: true }));
      },
      addSongs(playlistId, ids) {
        const cookie = requireSession();
        return Promise.all((ids || []).map((trackId) => import_qishui_web_api.default.handleQishuiPlaylistAddSong(
          text4(playlistId),
          { id: text4(trackId) },
          cookie
        ))).then(() => ({ provider: "qishui", success: true }));
      },
      removeSongs(playlistId, ids) {
        throw new QishuiError("unsupported", "Qishui phone protocol cannot remove tracks from a playlist");
      },
      dislikeSong(id, disliked) {
        throw new QishuiError("unsupported", "Qishui phone protocol has no dislike endpoint");
      }
    };
  }

  // src/entry.js
  var CAR = "luna-car";
  var PHONE = "passport-web";
  var log = (message) => console.info(message);
  var car = createQishuiCar({ log });
  var phone = null;
  var protocol = CAR;
  var normalizeProtocol = (value) => String(value || "").trim().toLowerCase() === PHONE ? PHONE : CAR;
  var api = () => {
    if (protocol === PHONE) {
      if (!phone) phone = createQishuiPhone({ log });
      return phone;
    }
    return car;
  };
  var altStatus = () => {
    if (protocol === PHONE) return { protocol: CAR, loggedIn: Boolean(car.sessions.get()?.ticket) };
    try {
      if (!phone) phone = createQishuiPhone({ log });
      return { protocol: PHONE, loggedIn: Boolean(phone.sessions.get()?.cookie) };
    } catch (_) {
      return { protocol: PHONE, loggedIn: false };
    }
  };
  function qishuiErrorCode(value) {
    return String(value == null ? "" : value).trim().toLowerCase().replace(/[_\s]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  }
  function qishuiClampInt(value, fallback, min, max) {
    const raw = value === void 0 || value === null || value === "" ? String(fallback) : String(value);
    const parsed = parseInt(raw, 10) || fallback;
    return Math.max(min, Math.min(max, parsed));
  }
  function failureEnvelope(code, message) {
    return {
      ok: false,
      error: {
        code: qishuiErrorCode(code) || "qishui-error",
        message: String(message || code || "Qishui request failed")
      }
    };
  }
  function envelopeFromCarError(error, operation) {
    const code = error && error.code ? qishuiErrorCode(error.code) : "";
    const stage = error && error.stage ? ` (${error.stage})` : "";
    const upstream = error && error.upstreamCode ? ` [${error.upstreamCode}]` : "";
    const message = String(error && error.message || `Qishui ${operation} failed`) + stage + upstream;
    if (code === "auth-required") return failureEnvelope("login-required", message);
    if (code === "network") return failureEnvelope("network", message);
    if (code === "not-playable" || code === "unsupported") return failureEnvelope(code, message);
    return failureEnvelope(code || "qishui-error", message);
  }
  var handlers = {
    // 登录态按**当前协议**问，并顺带给出另一套有没有会话（`alt`）：切了协议之后
    // 「这一套没登录」不等于「这个平台没账号」，渲染层靠 alt 决定认哪一套。
    status: async () => ({ ...await api().status(), alt: altStatus() }),
    /** 当前用的哪一套协议，以及有哪些可选（渲染层据此画「车机 / 手机」的选择）。 */
    "protocol.get": () => ({ provider: "qishui", protocol, available: [CAR, PHONE] }),
    /**
     * 换协议。只在真的换成功时才动状态，并返回换完之后的两套会话情况 ——
     * 渲染层据此决定要不要提示「另一套还登着」。
     */
    "protocol.use": (params) => {
      const wanted = normalizeProtocol(params && params.protocol || "");
      const changed = wanted !== protocol;
      protocol = wanted;
      return { provider: "qishui", protocol, changed, alt: altStatus() };
    },
    /**
     * 手动粘贴 Cookie（手机协议专用）：跳过扫码，直接把一段会话灌进手机协议。
     *
     * 给的是「从汽水客户端 / 浏览器导出来的完整会话」，协议层只认里面有没有
     * sessionid 那几个登录键；没有就明确拒绝，别让用户以为登录成功了。
     */
    "login.cookie": async (params) => {
      const raw = String(params && params.cookie || "").trim();
      if (!raw) {
        return failureEnvelope("missing-cookie", "汽水会话 Cookie 是空的");
      }
      protocol = PHONE;
      const applied = api().importCookie(raw);
      if (!applied?.restored) {
        return failureEnvelope("login-required", String(applied?.reason || "汽水会话 Cookie 里没有登录凭据"));
      }
      const statusData = await api().status();
      return Object.assign({}, statusData, {
        provider: "qishui",
        ok: true,
        loggedIn: true,
        status: "confirmed",
        errorCode: 0,
        error_code: 0,
        message: "登录成功"
      });
    },
    "login.qr": async () => {
      const result = await api().startLogin();
      return {
        provider: "qishui",
        // 这一张码是哪套协议出的：两套的扫码 App 可能一样，但换来的凭据完全不同，
        // 诊断里要能一眼分清（渲染层把它记进 last qr 那一行）。
        protocol,
        token: result.key,
        qrcode: result.qrDataUrl,
        qrDataUrl: result.qrDataUrl,
        // 码里装的那个地址（真机排查用：二维码是一张图，看不出它指向哪）。
        scanUrl: result.scanUrl,
        expireTime: 300,
        message: "请使用抖音/汽水音乐 App 扫码并确认授权"
      };
    },
    "login.check": async (params) => {
      const token = String(params && params.token || "").trim();
      if (!token) {
        const keys = Object.keys(params && typeof params === "object" ? params : {}).join(",") || "(empty)";
        throw Object.assign(new Error("二维码登录 token 缺失（params keys: " + keys + "）"), { code: "missing-token" });
      }
      const result = await api().checkLogin(token);
      if (result.state === "error" && result.failure?.case === "refused") {
        return { provider: "qishui", status: "error", errorCode: 0, message: "授权被拒绝，请重试" };
      }
      const statusMap = { waiting: "waiting", scanned: "scanned", confirmed: "confirmed", expired: "expired" };
      const status = statusMap[result.state] || "waiting";
      if (result.state === "confirmed") {
        const statusData = await api().status();
        return Object.assign({}, statusData, {
          provider: "qishui",
          ok: true,
          status: "confirmed",
          errorCode: 0,
          error_code: 0,
          message: "登录成功"
        });
      }
      return {
        provider: "qishui",
        loggedIn: false,
        status,
        errorCode: 0,
        error_code: 0,
        retryAfterMs: 0,
        message: status === "expired" ? "二维码已过期，请重新生成" : ""
      };
    },
    "login.logout": () => api().logout(),
    // 凭据在 App 侧也留一份（跨重启用）：桥自己那份存储读不回来时，启动时灌回去。
    "session.export": () => api().exportSession(),
    "session.import": (params) => api().importSession(params && params.credential),
    search: (params) => {
      const p = params || {};
      const keywords = String(p.keywords || p.query || "");
      const limit = qishuiClampInt(p.limit, 12, 4, 20);
      const offset = qishuiClampInt(p.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return api().search(keywords, limit, offset);
    },
    // 车机没有专辑端点；专辑入口在这里明确拒绝（上层把它显示为「暂不支持」，
    // 比静默空列表诚实）。单曲详情可以回，专辑聚合不行。
    album: () => {
      throw Object.assign(new Error("汽水车机协议没有专辑接口"), { code: "unsupported" });
    },
    "song.detail": (params) => api().songDetail(String(params && params.id || "")),
    lyric: (params) => api().lyrics(String(params && params.id || "")),
    "song.url": async (params) => {
      const p = params || {};
      return api().audio(String(p.id || ""), String(p.quality || "standard"));
    },
    artist: (params) => {
      const p = params || {};
      const artistId = String(p.artistId || "");
      if (!artistId) {
        throw Object.assign(new Error("汽水音乐需要艺人 ID"), { code: "missing-artist-id" });
      }
      const limit = qishuiClampInt(p.limit, 36, 10, 50);
      return api().artist(artistId, limit, 0, String((p || {}).artistName || ""));
    },
    feed: (params) => api().feed(qishuiClampInt((params || {}).limit, 8, 4, 12)),
    "user.playlists": () => api().userPlaylists(500, 0),
    "playlist.tracks": (params) => {
      const p = params || {};
      const id = String(p.id || "") || QISHUI_FEED_ID;
      const limit = qishuiClampInt(p.limit, 50, 1, Number.MAX_SAFE_INTEGER);
      const offset = qishuiClampInt(p.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return api().playlistTracks(id, limit, offset);
    },
    "track.liked": async (params) => {
      const raw = Array.isArray((params || {}).ids) ? params.ids.join(",") : String((params || {}).ids || "");
      const ids = raw.split(",").map((value) => value.trim()).filter(Boolean);
      const result = await api().checkTracks(ids);
      return {
        provider: "qishui",
        statuses: result.statuses
      };
    },
    "track.like": async (params) => {
      const p = params || {};
      const liked = String(p.liked != null ? p.liked : "true") !== "false";
      return api().likeSong(String(p.id || ""), liked);
    },
    // fork 的渲染层（qishuiMutations.likeSong）用的是 like_song 这个名字 ——
    // 与桌面桥（qishuiApiBridge.cjs）一致。车机协议里同一件事叫 track.like，
    // 缺这个别名时 App 里那颗心点下去只得到 unsupported（「红心点击没反应」）。
    // liked 接受布尔与字符串两种（桌面桥传布尔，渲染层也传布尔）。
    "like_song": async (params) => {
      const p = params || {};
      const liked = !(p.liked === false || String(p.liked) === "false");
      return api().likeSong(String(p.id || ""), liked);
    },
    "playlist.collect": () => {
      throw Object.assign(new Error("汽水车机协议不支持收藏歌单"), { code: "unsupported" });
    },
    "playlist.addSong": async (params) => {
      const p = params || {};
      return api().addSongs(String(p.playlistId || ""), [String(p.trackId || "")].filter(Boolean));
    },
    "album.collect": () => {
      throw Object.assign(new Error("汽水车机协议不支持收藏专辑"), { code: "unsupported" });
    },
    "report.play": () => ({ provider: "qishui", success: true, note: "car protocol has no play report endpoint" }),
    comments: () => {
      throw Object.assign(new Error("汽水车机协议没有评论接口"), { code: "unsupported" });
    },
    "comment.create": () => {
      throw Object.assign(new Error("汽水车机协议没有评论接口"), { code: "unsupported" });
    }
  };
  function normalizeParams(value) {
    if (!value) return {};
    if (typeof value === "object") return value;
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch (_) {
        return {};
      }
    }
    return {};
  }
  async function request2(operation, params) {
    const name = String(operation || "");
    if (!Object.prototype.hasOwnProperty.call(handlers, name)) {
      return failureEnvelope("unsupported", "Unsupported qishui operation: " + name);
    }
    try {
      const data = await handlers[name](params && typeof params === "object" ? params : {});
      return { ok: true, data };
    } catch (error) {
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[FoliaQishui] " + name + " failed:", error && error.message || error);
      }
      return envelopeFromCarError(error, name);
    }
  }
  window.__foliaQishui = {
    async start(operation, params, ticket) {
      const envelope = await request2(operation, normalizeParams(params));
      const host = window.FoliaQishuiHost;
      if (host && typeof host.resolve === "function") {
        try {
          host.resolve(String(ticket), JSON.stringify(envelope));
        } catch (error) {
          host.resolve(String(ticket), '{"ok":false,"error":{"code":"serialize-failed","message":"' + String(error && error.message || error).replace(/[\\"]/g, " ") + '"}}');
        }
      }
    }
  };
  window.__foliaSetMfaVisible = function() {
  };
  (function announceReady() {
    const host = window.FoliaQishuiHost;
    if (host && typeof host.onReady === "function") {
      try {
        host.onReady("");
      } catch (_) {
      }
    }
  })();
})();
