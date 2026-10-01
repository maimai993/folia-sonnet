const { createBodianApi, BODIAN_OPERATIONS } = require('bodian-music-api');
const { createSessionRepository } = require('./bodian/session.cjs');

// electron/bodianApiBridge.cjs

// Keep Electron persistence, IPC validation and media registration here; the package owns the protocol.
function createBodianApiBridge({ store, safeStorage, requestFactory, onAudioSource = () => {}, now = Date.now,
  warn = console.warn, apiFactory = createBodianApi }) {
  const sessions = createSessionRepository({ store, safeStorage, warn });
  const api = apiFactory({ deviceId: sessions.deviceId, sessions, requestFactory, now });
  return {
    async request(operation, params = {}) {
      try {
        if (!BODIAN_OPERATIONS.includes(operation)) {
          return { ok: false, error: { code: 'unsupported', message: 'Unsupported Bodian operation' } };
        }
        if (!params || typeof params !== 'object' || Array.isArray(params)
          || Object.keys(params).length > 20 || Object.values(params).some(value => value !== undefined && !['string', 'number', 'boolean'].includes(typeof value))) {
          return { ok: false, error: { code: 'invalid-response', message: 'Invalid Bodian request parameters' } };
        }
        const result = await api.request(operation, params);
        if (result.ok && operation === 'audio' && result.data?.url) onAudioSource(result.data.url);
        return result;
      } catch {
        return { ok: false, error: { code: 'invalid-response', message: 'Bodian operation failed' } };
      }
    },
  };
}

module.exports = { createBodianApiBridge };
