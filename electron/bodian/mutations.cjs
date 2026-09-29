const { BodianError } = require('./http.cjs');
const { mediaId } = require('./catalog.cjs');
const { requireSession } = require('./library.cjs');

// electron/bodian/mutations.cjs

function numericId(value) {
  const number = Number(mediaId(value));
  if (!Number.isSafeInteger(number)) throw new BodianError('invalid-response', 'Unsafe Bodian media id');
  return number;
}

// Ownership is checked in the main process using the current session, never a renderer-supplied user ID.
function createMutationOperations({ client, sessions }) {
  const update = async (playlistId, tracks, remove, revision) => {
    if (sessions.revision !== revision) throw new BodianError('auth-required', 'Bodian account changed');
    await client.call(`/api/service/playlist/music${remove ? '/delete' : ''}`, {
      method: 'POST', signed: true, body: { playListId: playlistId, musicIdList: tracks },
    });
    return null;
  };
  const playlistTracks = async (params, remove) => {
    const { uid } = requireSession(sessions);
    const revision = sessions.revision;
    const id = numericId(params.id);
    if (typeof params.trackIds !== 'string' || params.trackIds.length > 2200) {
      throw new BodianError('invalid-response', 'Invalid Bodian track list');
    }
    const tracks = [...new Set(params.trackIds.split(',').map(numericId))];
    if (!tracks.length || tracks.length > 100) throw new BodianError('invalid-response', 'Invalid Bodian track count');
    const { data } = await client.call('/api/service/playlist/userCreate', { params: { userId: uid } });
    const owned = Array.isArray(data?.playLists)
      && data.playLists.some(item => String(item.id) === String(id));
    if (!owned) {
      // The built-in 我喜欢 list is returned separately from userCreate and is rejected by
      // the ownership check above. It still uses the same playlist mutation endpoint once its
      // id is verified against the current account's fond playlist.
      const { data: liked } = await client.call('/api/service/playlist/fond', { params: { userId: uid } });
      if (String(liked?.id) !== String(id)) {
        throw new BodianError('unsupported', 'Bodian playlist is not owned by the current account');
      }
    }
    return update(id, tracks, remove, revision);
  };
  return {
    playlist_tracks_add: params => playlistTracks(params, false),
    playlist_tracks_del: params => playlistTracks(params, true),
    async like_song(params) {
      const { uid } = requireSession(sessions);
      const revision = sessions.revision;
      const id = numericId(params.id);
      if (typeof params.liked !== 'boolean') throw new BodianError('invalid-response', 'Invalid Bodian like state');
      const { data } = await client.call('/api/service/playlist/fond', { params: { userId: uid } });
      return update(numericId(data?.id), [id], !params.liked, revision);
    },
  };
}

module.exports = { createMutationOperations };
