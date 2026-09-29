const https = require('node:https');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

// electron/bodian/http.cjs

const API_ORIGIN = 'https://bd-api.kuwo.cn';
const LYRIC_ORIGIN = 'https://mlyric.kuwo.cn';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const md5 = text => crypto.createHash('md5').update(text).digest('hex');

class BodianError extends Error {
  constructor(code, message, upstreamCode) {
    super(message);
    this.name = 'BodianError';
    this.code = code;
    this.upstreamCode = upstreamCode;
  }
}

// The desktop protocol signs the encoded query and the exact UTF-8 JSON body.
function signQuery(path, params, body = '') {
  const query = new URLSearchParams(params).toString();
  let seed = `kuwotest${Array.from(query).filter(char => /[a-z0-9]/i.test(char)).sort().join('')}`;
  if (body) seed += md5(`${body}kuwotest`);
  return md5(`${seed}${path}`);
}

function desktopHeaders(deviceId) {
  return {
    'User-Agent': 'Dart/3.3 (dart:io)', plat: 'win', channel: 'W1', ver: '1.1.7',
    svrver: '13', 'api-ver': 'application/json', brand: 'Windows', net: 'wifi',
    devid: deviceId, qimei36: deviceId, 'Content-Type': 'application/json',
    'Accept-Encoding': 'gzip',
  };
}

// Bounded requests support the desktop API's GET-with-JSON-body playback endpoints.
function requestJson(url, { method = 'GET', headers = {}, body = '', timeoutMs = 15000, requestFactory } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    const onResponse = response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          finish(new BodianError('invalid-response', 'Bodian response exceeded the size limit'));
          stop();
        } else chunks.push(Buffer.from(chunk));
      });
      response.on('error', () => finish(new BodianError('network', 'Bodian response was interrupted')));
      response.on('end', () => {
        if (settled) return;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          return finish(new BodianError(response.statusCode === 401 ? 'auth-required' : 'network',
            `Bodian HTTP ${response.statusCode}`));
        }
        try {
          const bytes = Buffer.concat(chunks);
          const encoding = String(response.headers['content-encoding'] || '');
          // Chromium net already decompresses responses but retains Content-Encoding.
          const compressed = encoding.includes('gzip') && bytes[0] === 0x1f && bytes[1] === 0x8b;
          const decoded = compressed ? zlib.gunzipSync(bytes, { maxOutputLength: MAX_RESPONSE_BYTES }) : bytes;
          finish(null, JSON.parse(decoded.toString('utf8')));
        } catch {
          finish(new BodianError('invalid-response', 'Bodian returned an unreadable response'));
        }
      });
    };
    const request = requestFactory
      ? requestFactory({ url: url.toString(), method }, onResponse)
      : https.request(url, { method }, onResponse);
    const stop = () => typeof request.destroy === 'function' ? request.destroy() : request.abort();
    const timer = setTimeout(() => {
      finish(new BodianError('network', 'Bodian request timed out'));
      stop();
    }, timeoutMs);
    request.on('error', () => finish(new BodianError('network', 'Bodian request failed')));
    for (const [key, value] of Object.entries(headers)) request.setHeader(key, String(value));
    // Chromium computes Content-Length itself; overriding it produces ERR_INVALID_ARGUMENT.
    if (body && !requestFactory) request.setHeader('Content-Length', String(Buffer.byteLength(body)));
    request.end(body || undefined);
  });
}

function createBodianClient({ deviceId, getSession = () => null, request = requestJson, now = Date.now, requestFactory } = {}) {
  if (!deviceId) throw new Error('Bodian requires a stable device identifier');
  return {
    async call(path, { params = {}, body, method = 'GET', signed = false, anonymous = false, lyric = false } = {}) {
      if (!path.startsWith('/') || path.includes('..')) throw new BodianError('unsupported', 'Invalid Bodian path');
      const session = anonymous ? null : getSession();
      const query = { ...params, uid: String(session?.uid || '-1'), token: session?.token || '' };
      const bodyText = body === undefined ? '' : JSON.stringify(body);
      if (signed) {
        query.timestamp = String(now());
        query.sign = signQuery(path, query, bodyText);
      }
      const url = new URL(path, lyric ? LYRIC_ORIGIN : API_ORIGIN);
      for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
      const headers = desktopHeaders(deviceId);
      if (session) { headers.uid = String(session.uid); headers.token = session.token; }
      const response = await request(url, { method, body: bodyText, headers, requestFactory });
      if (Number(response?.code) !== 200) {
        const code = Number(response?.code);
        throw new BodianError(code === 11012 ? 'auth-required' : code === 20018 ? 'not-playable' : 'invalid-response',
          `Bodian rejected the request (code ${response?.code ?? 'missing'})`, response?.code);
      }
      return response;
    },
  };
}

module.exports = { API_ORIGIN, LYRIC_ORIGIN, BodianError, signQuery, desktopHeaders, requestJson, createBodianClient };
