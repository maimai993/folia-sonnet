const { createBodianClient, BodianError } = require('./bodian/http.cjs');
const { createSessionRepository } = require('./bodian/session.cjs');
const { createAuthOperations } = require('./bodian/auth.cjs');
const { createCatalogOperations } = require('./bodian/catalog.cjs');
const { createPlaybackOperation } = require('./bodian/playback.cjs');
const { createLibraryOperations } = require('./bodian/library.cjs');
const { createMutationOperations } = require('./bodian/mutations.cjs');

// electron/bodianApiBridge.cjs

function createBodianApiBridge({ store, safeStorage, request, requestFactory, onAudioSource = () => {}, now = Date.now, warn = console.warn }) {
  const sessions = createSessionRepository({ store, safeStorage, warn });
  const client = createBodianClient({ deviceId: sessions.deviceId, getSession: () => sessions.get(), request, requestFactory, now });
  const operations = {
    ...createAuthOperations({ client, sessions, now }),
    ...createCatalogOperations(client),
    ...createLibraryOperations({ client, sessions }),
    ...createMutationOperations({ client, sessions }),
    audio: createPlaybackOperation({ client, deviceId: sessions.deviceId, getSession: () => sessions.get(), now }),
  };
  return {
    async request(operation, params = {}) {
      const requestRevision = sessions.revision;
      try {
        if (!Object.hasOwn(operations, operation)) throw new BodianError('unsupported', 'Unsupported Bodian operation');
        if (!params || typeof params !== 'object' || Array.isArray(params)
          || Object.keys(params).length > 20 || Object.values(params).some(value => value !== undefined && !['string', 'number', 'boolean'].includes(typeof value))) {
          throw new BodianError('invalid-response', 'Invalid Bodian request parameters');
        }
        const data = await operations[operation](params);
        if (operation === 'audio' && data?.url) onAudioSource(data.url);
        return { ok: true, data };
      } catch (error) {
        if (error instanceof BodianError && error.code === 'auth-required' && sessions.revision === requestRevision) sessions.clear();
        return { ok: false, error: { code: error instanceof BodianError ? error.code : 'invalid-response',
          message: error instanceof BodianError ? error.message : 'Bodian operation failed' } };
      }
    },
  };
}

module.exports = { createBodianApiBridge };
