const { BodianError } = require('./http.cjs');

// electron/bodian/catalog.cjs

function mediaId(value) {
  const id = String(value ?? '');
  if (!/^\d{1,20}$/.test(id) || /^0+$/.test(id)) throw new BodianError('invalid-response', 'Invalid Bodian media id');
  return id;
}

function pagination(params, firstPage = 0) {
  const limit = Number(params.limit ?? 50), offset = Number(params.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) {
    throw new BodianError('invalid-response', 'Invalid Bodian pagination');
  }
  return { pn: Math.floor(offset / limit) + firstPage, rn: limit };
}

// Server pages can omit unavailable songs. Advance by the requested page boundary, not returned row count.
function pageData(data, params, field) {
  if (!Array.isArray(data?.[field])) return data;
  const limit = Number(params.limit ?? 50), offset = Number(params.offset ?? 0);
  const raw = data[field];
  const items = raw.slice(offset % limit);
  const pageEnd = (Math.floor(offset / limit) + 1) * limit;
  const total = Number(data.total);
  const knownTotal = data.total != null && Number.isSafeInteger(total) && total >= 0;
  const hasMore = raw.length > 0 && (knownTotal ? pageEnd < total : raw.length === limit);
  return { ...data, [field]: items, bodianPagination: {
    nextOffset: hasMore ? pageEnd : Math.max(offset + items.length, knownTotal ? Math.min(pageEnd, total) : offset + items.length),
    hasMore,
  } };
}

// Each operation maps to a known endpoint; renderer callers cannot supply URLs, auth or arbitrary headers.
function createCatalogOperations(client) {
  const call = async (path, params) => (await client.call(`/api/${path}`, { params })).data;
  const page = async (path, params, field, firstPage = 0, extra = {}) => {
    const data = await call(path, { ...extra, ...pagination(params, firstPage) });
    return pageData(data, params, field);
  };
  return {
    search: params => {
      if (typeof params.query !== 'string' || !params.query.trim() || params.query.length > 500) {
        throw new BodianError('invalid-response', 'Invalid Bodian search query');
      }
      return page('search/music/list', params, 'resultList', 0, { keyword: params.query.trim(), correct: 1 });
    },
    song_detail: params => call('service/music/info', { musicId: mediaId(params.id) }),
    playlist_detail: params => call(`service/playlist/info/${mediaId(params.id)}`, { source: playlistSource(params.source) }),
    playlist_tracks: params => page(`service/playlist/${mediaId(params.id)}/musicList`, params, 'list', 1, { source: playlistSource(params.source) }),
    album_detail: params => call(`service/album/${mediaId(params.id)}`),
    album_tracks: params => page(`service/album/music/${mediaId(params.id)}`, params, 'resultList'),
    artist_detail: params => call(`service/artist/${mediaId(params.id)}`),
    artist_songs: params => page(`service/artist/music/${mediaId(params.id)}`, params, 'resultList'),
    artist_albums: params => page(`service/artist/album/${mediaId(params.id)}`, params, 'resultList'),
    recommendations: () => call('service/finds/playlist'),
    home_module: params => call('service/home/module', { moduleId: moduleId(params.moduleId) }),
    ai_playlist_detail: params => call('service/home/aiPlaylistDetail', { index: discoverIndex(params.index) }),
    personal_fm: () => call('service/music/recommendList'),
    lyrics: async params => {
      const query = `type=lyric&req=2&lrcx=1&rid=${mediaId(params.id)}&songname=&artist=&corp=kuwo&fromchannel=bodian`;
      const result = await client.call('/mobi.s', { lyric: true, params: { f: 'bodian', q: Buffer.from(query).toString('base64') } });
      if (typeof result.data?.content !== 'string') throw new BodianError('invalid-response', 'Bodian lyric content is missing');
      return { content: Buffer.from(result.data.content, 'base64').toString('utf8') };
    },
  };
}

function moduleId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 0 || id > 100) throw new BodianError('invalid-response', 'Invalid Bodian home module id');
  return id;
}

function discoverIndex(value) {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0 || index > 100) throw new BodianError('invalid-response', 'Invalid Bodian Discover index');
  return index;
}

function playlistSource(value) {
  const source = Number(value ?? 4);
  if (![1, 2, 3, 4, 5, 6].includes(source)) throw new BodianError('invalid-response', 'Invalid Bodian playlist source');
  return source;
}

module.exports = { mediaId, pagination, pageData, playlistSource, moduleId, discoverIndex, createCatalogOperations };
