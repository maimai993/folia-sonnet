const { mediaId } = require('../../electron/bodian/catalog.cjs');

// test/helpers/bodianTestPlaylistRoundtrip.cjs
// Only the uniquely named owned test playlist may be modified, with the original membership restored.

async function testPlaylistRoundtrip({ client, library, mutations, expectedName, songId }) {
  if (!expectedName) throw new Error('Expected test playlist name is required');
  const data = await library.user_playlists({ limit: 100, offset: 0 });
  const matches = (data.owned?.playLists || []).filter(item =>
    item.name?.replace(/\s/g, '') === expectedName.replace(/\s/g, ''));
  if (matches.length !== 1) throw new Error('Test playlist must be uniquely identified');
  const playlist = matches[0];
  const playlistId = mediaId(playlist.id);
  const trackId = mediaId(songId);
  if (![playlistId, trackId].every(value => Number.isSafeInteger(Number(value)))) throw new Error('Unsafe numeric ID');
  const source = playlist.sourceType ?? 5;
  const read = async () => {
    const page = (await client.call(`/api/service/playlist/${playlistId}/musicList`, {
      params: { source, pn: 1, rn: 100 },
    })).data;
    if (!Array.isArray(page?.list) || Number(page.total) !== page.list.length) throw new Error('Incomplete baseline');
    return page.list.map(song => String(song.id));
  };
  const baseline = await read();
  if (baseline.includes(trackId)) throw new Error('Test song already exists; leave it untouched');
  const mutate = action => mutations ? mutations[action === 'del' ? 'playlist_tracks_del' : 'playlist_tracks_add']({
    id: playlistId, trackIds: trackId,
  }) : client.call(`/api/service/playlist/music${action === 'del' ? '/delete' : ''}`, {
    method: 'POST', signed: true,
    body: { playListId: Number(playlistId), musicIdList: [Number(trackId)] },
  });
  let added = false;
  try {
    await mutate('add');
    const afterAdd = await read();
    added = afterAdd.includes(trackId) && afterAdd.length === baseline.length + 1;
    if (!added) throw new Error('Song addition was not observed');
  } finally {
    // Even an interrupted add may have reached the server. Remove only the song absent from the baseline.
    const current = await read();
    if (current.includes(trackId)) await mutate('del');
    const restored = await read();
    if (JSON.stringify([...restored].sort()) !== JSON.stringify([...baseline].sort())) {
      throw new Error('Test playlist restoration needs attention');
    }
  }
  return { added, restored: true, originalCount: baseline.length };
}

// Exercise the actual mutation module, preserving the complete pre-test liked-song membership.
async function testLikeRoundtrip({ library, mutations, songId }) {
  const id = mediaId(songId);
  const read = async () => {
    const data = await library.liked_songs({ limit: 100, offset: 0 });
    if (!Array.isArray(data?.list) || Number(data.total) !== data.list.length) throw new Error('Incomplete liked-song baseline');
    return data.list.map(song => String(song.id));
  };
  const baseline = await read();
  if (baseline.includes(id)) throw new Error('Test song is already liked');
  let added = false;
  try {
    await mutations.like_song({ id, liked: true });
    const afterAdd = await read();
    added = afterAdd.includes(id) && afterAdd.length === baseline.length + 1;
    if (!added) throw new Error('Like was not observed');
  } finally {
    if ((await read()).includes(id)) await mutations.like_song({ id, liked: false });
    if (JSON.stringify((await read()).sort()) !== JSON.stringify([...baseline].sort())) {
      throw new Error('Liked-song restoration needs attention');
    }
  }
  return { added, restored: true, originalCount: baseline.length };
}

module.exports = { testPlaylistRoundtrip, testLikeRoundtrip };
