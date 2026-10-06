/**
 * fetch 超时包装。
 *
 * 动机是 Android WebView 的后台行为：应用切到后台后，系统会节流 WebView 的网络栈，
 * 表现为请求既不 resolve 也不 reject —— 界面就一直转圈、下一首永远出不来。
 * 原生侧的前台服务（MainActivity + FoliaPlaybackService）已经把大部分这类挂起消掉了，
 * 但设备差异和慢服务器仍然可能让 fetch 长时间无响应，所以这里再加一层超时。
 *
 * 不设超时的 fetch 在 Web 端也有同样的坏处：一个卡死的代理会让切歌永久等待，
 * 上游在 playbackReportGate.ts 里也提到过同样的问题。
 */

/** 歌曲地址这类请求的默认超时：够慢也能成功，但不至于让人一直等。 */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * 在 ms 毫秒后 reject 一个 AbortError。
 *
 * 用 AbortError 而非自定义错误，是为了让上层已有的
 * `error.name === 'AbortError'` 分支继续按「请求被取消」处理。
 */
const createTimeoutSignal = (timeoutMs: number): {
  signal: AbortSignal;
  /** 手动触发超时取消，用于把调用方的 signal 转发进来。 */
  abort: () => void;
  cleanup: () => void;
  timedOut: () => boolean;
} => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    cleanup: () => clearTimeout(timer),
    timedOut: () => timedOut,
  };
};

/**
 * 带超时的 fetch。
 *
 * `init.signal` 与超时信号合并：调用方自己传了 signal（用户切歌导致上一首请求作废）
 * 时，任意一方 abort 都要让请求停下来，否则旧请求会一直挂着占住连接。
 */
export const fetchWithTimeout = async (
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> => {
  const outerSignal = init.signal ?? undefined;
  const timeout = createTimeoutSignal(timeoutMs);

  if (outerSignal) {
    // 已被外部取消就不必发请求了。
    if (outerSignal.aborted) {
      timeout.cleanup();
      throw new DOMException('Aborted', 'AbortError');
    }
    const forwardAbort = () => timeout.abort();
    outerSignal.addEventListener('abort', forwardAbort, { once: true });
    try {
      return await fetch(input, { ...init, signal: timeout.signal });
    } finally {
      outerSignal.removeEventListener('abort', forwardAbort);
      timeout.cleanup();
    }
  }

  try {
    return await fetch(input, { ...init, signal: timeout.signal });
  } catch (error) {
    if (timeout.timedOut()) {
      // 超时和调用方主动取消要能区分开：前者值得重试，后者不。
      throw new Error(`Request timed out after ${timeoutMs}ms: ${String(input)}`, { cause: error });
    }
    throw error;
  } finally {
    timeout.cleanup();
  }
};

/**
 * 带超时与重试的 GET。
 *
 * 只对幂等的取址/取元数据请求使用；带副作用的 POST 不要套这个。
 * 后台节流导致的挂起与临时网络抖动，重试一次通常就好了；
 * 真正持续失败时该走原有的错误上报，不在这里无限重试。
 */
export const fetchJsonWithRetry = async <T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: { timeoutMs?: number; retries?: number; retryDelayMs?: number } = {},
): Promise<T> => {
  const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, retries = 1, retryDelayMs = 800 } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(input, init, timeoutMs);
      if (!response.ok) {
        throw new Error(`Request failed with HTTP ${response.status}: ${String(input)}`);
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      // 调用方主动取消不重试。
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      if (attempt < retries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};
