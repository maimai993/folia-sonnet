import CryptoJS from '../vendor/crypto-es.mjs';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const IV = '0102030405060708';
const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// 网易云 weapi 的 RSA 公钥模数（1024 bit / 256 位十六进制）。
// 这个值必须与官方一致：写坏后服务端解不开 encSecKey，会回「HTTP 200 + 空 body」，
// 界面上表现为整页空白（探索、专辑、歌手全都读不到数据），而代码里看不到任何报错。
const RSA_MODULUS = BigInt(
  '0x00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7',
);
const RSA_EXP = BigInt(65537);

function modPow(base, exp, mod) {
  let result = BigInt(1);
  let b = base % mod;
  let e = exp;
  while (e > BigInt(0)) {
    if (e % BigInt(2) === BigInt(1)) result = (result * b) % mod;
    b = (b * b) % mod;
    e /= BigInt(2);
  }
  return result;
}

function rsaEncrypt(text) {
  const reversed = String(text || '').split('').reverse().join('');
  let x = BigInt(0);
  for (let i = 0; i < reversed.length; i++) {
    x = (x << BigInt(8)) + BigInt(reversed.charCodeAt(i));
  }
  const y = modPow(x, RSA_EXP, RSA_MODULUS);
  return y.toString(16).padStart(256, '0');
}

function aesEncrypt(text, key, iv) {
  return CryptoJS.AES.encrypt(
    CryptoJS.enc.Utf8.parse(text),
    CryptoJS.enc.Utf8.parse(key),
    {
      iv: CryptoJS.enc.Utf8.parse(iv),
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    },
  ).toString();
}

export function weapiEncrypt(object) {
  const text = JSON.stringify(object || {});
  let secretKey = '';
  for (let i = 0; i < 16; i++) secretKey += BASE62.charAt(Math.floor(Math.random() * BASE62.length));
  return {
    params: aesEncrypt(aesEncrypt(text, PRESET_KEY, IV), secretKey, IV),
    encSecKey: rsaEncrypt(secretKey),
  };
}

// weapi 的网关主机。
//
// 选了 `interface.music.163.com` 而不是 `music.163.com`：安卓桥上只有这个主机在白名单里
// （见 src/services/nativeAndroidBridge.ts 的 API_HOSTS）。发到 music.163.com 的请求会落进
// WebView 自己的 fetch，那里面按 Fetch 规范**读不到** Set-Cookie —— 而扫码登录要的 p_skey 正是
// 从这里那张 302 上下发的。同一个接口上两个主机答得一样（eapi.js 一直用的就是这一个）。
const WEAPI_BASE = 'https://interface.music.163.com';

export async function weapiRequest(path, data, cookieHeader) {
  const apiPath = String(path || '').replace(/^\/+/, '').replace(/^weapi\//, '').replace(/^api\//, '');
  const encrypted = weapiEncrypt(data || {});
  const resp = await fetch(`${WEAPI_BASE}/weapi/${apiPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Referer: 'https://music.163.com/',
      Cookie: cookieHeader || '',
    },
    body: new URLSearchParams(encrypted).toString(),
  });
  try {
    return await resp.json();
  } catch (_) {
    return {};
  }
}
