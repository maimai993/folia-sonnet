// electron/updateChannels.cjs
// Resolves the user-facing release lane to the electron-updater channel stored in packaged metadata.

const RELEASE_CHANNELS = {
  realeco: {
    id: 'realeco',
    label: 'Realeco',
    updaterChannel: 'latest',
    allowPrerelease: false,
    updateEnabled: true,
    rollingReleaseTag: null,
  },
  limo: {
    id: 'limo',
    label: 'Limo',
    updaterChannel: 'beta',
    allowPrerelease: true,
    updateEnabled: true,
    rollingReleaseTag: 'limo',
  },
  cielo: {
    id: 'cielo',
    label: 'Cielo',
    updaterChannel: 'alpha',
    allowPrerelease: true,
    updateEnabled: true,
    rollingReleaseTag: 'cielo',
  },
  internal: {
    id: 'internal',
    label: 'Internal',
    updaterChannel: null,
    allowPrerelease: false,
    updateEnabled: false,
    rollingReleaseTag: null,
  },
};

function normalizeReleaseChannel(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function resolveReleaseChannel(version, declaredChannel) {
  const declared = normalizeReleaseChannel(declaredChannel);
  if (RELEASE_CHANNELS[declared]) {
    return RELEASE_CHANNELS[declared];
  }

  const normalizedVersion = typeof version === 'string' ? version.toLowerCase() : '';
  if (/-alpha(?:[.\-]|$)/.test(normalizedVersion)) {
    return RELEASE_CHANNELS.cielo;
  }
  if (/-beta(?:[.\-]|$)/.test(normalizedVersion)) {
    return RELEASE_CHANNELS.limo;
  }
  return RELEASE_CHANNELS.realeco;
}

function getReleaseUrl(channel, version, releasesUrl) {
  const release = resolveReleaseChannel(version, channel);
  if (release.rollingReleaseTag) {
    return `${releasesUrl}/tag/${release.rollingReleaseTag}`;
  }

  const normalizedVersion = typeof version === 'string' ? version.trim().replace(/^v/i, '') : '';
  return normalizedVersion ? `${releasesUrl}/tag/v${normalizedVersion}` : releasesUrl;
}

module.exports = {
  RELEASE_CHANNELS,
  getReleaseUrl,
  resolveReleaseChannel,
};
