const os = require('os');

// electron/neteaseLoginDiagnostics.cjs
// 扫码登录只在少数用户、少数时候失败，开发机上复现不了，只能让用户把现场带回来。
// 必须记在主进程的请求层：上游 login_qr_check 出错时会把网易的真实返回码（风控 8821 等）吞成
// 一个 404，渲染进程拿到的永远只是「Not Found」。这里只记登录相关的请求，而且只记能公开贴出来的
// 东西：返回码、耗时、带没带来源 IP 头、cookie 里有没有凭据——不记 cookie、token 和 IP 本身。

const LOGIN_URI_PATTERN = /^\/api\/(login\/|register\/anonimous|w\/nuser\/account\/get|nuser\/account\/get)/;
const MAX_ENTRIES = 40;
const MAX_MESSAGE_LENGTH = 200;
// deviceId 只留末尾几位：足够看出前后两次请求是不是同一个设备，又不至于把整个标识贴到 issue 里。
const DEVICE_ID_TAIL_LENGTH = 6;

const truncate = (value) => {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
};

const readCookieField = (cookie, name) => {
  if (typeof cookie === 'string') {
    return new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(cookie)?.[1] || '';
  }
  if (cookie && typeof cookie === 'object' && typeof cookie[name] === 'string') {
    return cookie[name];
  }
  return '';
};

// 与 util/request.js 取来源 IP 的优先级一致（realIP 优先于 ip），记录的是最终真正会发出去的那个头。
const describeIpHeader = (options) => {
  if (options.realIP) return 'real-ip';
  if (!options.ip) return 'none';
  return options.randomCNIP ? 'random-cn' : 'client';
};

// 成功时 request 返回 { status, body }；失败时 reject 的也是同样形状的 answer，网络错误则 body 为 { code: 502, msg }。
const describeOutcome = (settled, value) => {
  if (value && typeof value === 'object' && ('status' in value || 'body' in value)) {
    const body = value.body && typeof value.body === 'object' ? value.body : {};
    return {
      settled,
      status: Number(value.status) || null,
      code: body.code ?? null,
      message: truncate(body.message || body.msg || ''),
    };
  }
  return {
    settled,
    status: null,
    code: null,
    message: truncate(value instanceof Error ? `${value.name}: ${value.message}` : value),
  };
};

const isGlobalIpv6 = (address) => !/^(fe80|fc|fd)/i.test(address) && address !== '::1';

// 只报网卡名和有没有可用地址，不报地址本身。有公网 IPv6、以及存在 TUN 一类的代理网卡，都是排查时要先问的。
const describeNetwork = (networkInterfaces) => {
  let interfaces = {};
  try {
    interfaces = networkInterfaces() || {};
  } catch {
    return { interfaces: [], globalIpv6Count: 0 };
  }
  let globalIpv6Count = 0;
  const summary = Object.entries(interfaces).flatMap(([name, addresses]) => {
    const external = (addresses || []).filter(item => !item.internal);
    if (external.length === 0) return [];
    const globalIpv6 = external.filter(item => (item.family === 'IPv6' || item.family === 6) && isGlobalIpv6(item.address)).length;
    globalIpv6Count += globalIpv6;
    return [{
      name,
      ipv4: external.some(item => item.family === 'IPv4' || item.family === 4),
      globalIpv6: globalIpv6 > 0,
    }];
  });
  return { interfaces: summary, globalIpv6Count };
};

// 创建一份登录诊断记录：wrapRequest 包住上游 request，snapshot 给渲染进程生成诊断报告。
function createNeteaseLoginDiagnostics({
  now = Date.now,
  getDefaultDeviceId = () => global.deviceId,
  networkInterfaces = os.networkInterfaces,
  logger = console,
} = {}) {
  const entries = [];
  const startup = {};

  const record = (entry) => {
    entries.push(entry);
    if (entries.length > MAX_ENTRIES) entries.shift();
  };

  // 必须包在 withoutImplicitClientIp 里面，看到的才是最终发出去的 options。
  const wrapRequest = (request) => (uri, data, options = {}) => {
    if (typeof uri !== 'string' || !LOGIN_URI_PATTERN.test(uri)) {
      return request(uri, data, options);
    }

    const startedAt = now();
    const cookie = options.cookie;
    const deviceId = readCookieField(cookie, 'deviceId') || getDefaultDeviceId() || '';
    const entry = {
      at: startedAt,
      uri,
      crypto: options.crypto || '',
      ipHeader: describeIpHeader(options),
      deviceIdTail: deviceId ? deviceId.slice(-DEVICE_ID_TAIL_LENGTH) : '',
      hasMusicU: Boolean(readCookieField(cookie, 'MUSIC_U')),
      hasMusicA: Boolean(readCookieField(cookie, 'MUSIC_A')),
      durationMs: null,
      outcome: { settled: 'pending', status: null, code: null, message: '' },
    };
    record(entry);

    const finish = (settled, value) => {
      entry.durationMs = now() - startedAt;
      entry.outcome = describeOutcome(settled, value);
      logger.info('[Netease API] login request', {
        uri,
        settled,
        status: entry.outcome.status,
        code: entry.outcome.code,
        message: entry.outcome.message,
        durationMs: entry.durationMs,
        ipHeader: entry.ipHeader,
        deviceIdTail: entry.deviceIdTail,
      });
    };

    return Promise.resolve(request(uri, data, options)).then(
      (result) => {
        finish('resolved', result);
        return result;
      },
      (error) => {
        finish('rejected', error);
        throw error;
      },
    );
  };

  const noteStartup = (patch) => {
    Object.assign(startup, patch);
  };

  const snapshot = () => ({
    capturedAt: now(),
    startup: { ...startup },
    network: describeNetwork(networkInterfaces),
    requests: entries.map(entry => ({ ...entry, outcome: { ...entry.outcome } })),
  });

  return { wrapRequest, noteStartup, snapshot };
}

module.exports = {
  createNeteaseLoginDiagnostics,
};
