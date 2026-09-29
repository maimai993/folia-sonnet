const { BodianError } = require('./http.cjs');
const { mediaId } = require('./catalog.cjs');

// electron/bodian/playback.cjs

const QUALITIES = {
  standard: { format: 'mp3', br: '128kmp3' },
  high: { format: 'mp3', br: '320kmp3' },
  lossless: { format: 'flac', br: '2000kflac' },
};

function validateAudioUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.toString();
  } catch { throw new BodianError('invalid-response', 'Bodian returned an invalid audio URL'); }
}

function createPlaybackOperation({ client, deviceId, getSession, now = Date.now }) {
  return async params => {
    const id = mediaId(params.id);
    const quality = params.quality === 'hires' ? 'lossless' : params.quality || 'high';
    if (!QUALITIES[quality]) throw new BodianError('unsupported', 'Unsupported Bodian audio quality');
    const freeSign = typeof params.freeSign === 'string' ? params.freeSign : '';
    if (freeSign.length > 4096) throw new BodianError('invalid-response', 'Invalid Bodian playback context');
    const rightBody = { musicId: Number(id), freeSign };
    const right = (await client.call('/api/play/music/v2/checkRight', {
      params: { musicId: id, freeSign }, body: rightBody, signed: true,
    })).data;
    if (Number(right?.status) === 3) {
      const preview = right.audition;
      if (!preview || !Number.isFinite(Number(preview.start)) || !Number.isFinite(Number(preview.end))) {
        throw new BodianError('not-playable', 'Bodian preview is unavailable');
      }
      return { url: validateAudioUrl(preview.https || preview.url), quality: 'standard', fetchedAt: now(),
        preview: { startTime: Number(preview.start), endTime: Number(preview.end) } };
    }
    // The final audio endpoint enforces entitlement; surface known extra-action states before requesting it.
    if (Number(right?.status) === 7) {
      throw new BodianError(getSession() ? 'not-playable' : 'auth-required', 'Bodian requires additional playback rights');
    }
    if (right?.status === undefined) {
      throw new BodianError(getSession() ? 'not-playable' : 'auth-required', 'Bodian playback rights are unavailable');
    }
    const format = QUALITIES[quality];
    const body = { devId: deviceId, musicId: Number(id), ...format, freeSign };
    const audio = (await client.call('/api/play/music/v2/audioUrl', {
      params: { ...body, musicId: id }, body, signed: true,
    })).data;
    return { url: validateAudioUrl(audio?.audioHttpsUrl || audio?.audioUrl), quality, fetchedAt: now() };
  };
}

module.exports = { QUALITIES, validateAudioUrl, createPlaybackOperation };
