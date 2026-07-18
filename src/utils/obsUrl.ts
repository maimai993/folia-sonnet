// src/utils/obsUrl.ts
// Small helpers to build/parse OBS URLs (pure strings, no external deps - avoids a
// cycle with the appearance codec / settings component).

// Extract the appearance shortcode from user input: the input may be a full OBS URL
// (with a cfg query param) or a bare shortcode / JSON. If it is a URL carrying cfg,
// return the decoded cfg value; otherwise return the input unchanged (decompressConfig
// handles it).
export function extractCfgFromInput(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    const cfg = url.searchParams.get('cfg');
    if (cfg) return cfg;
  } catch {
    // Not a URL: treat as a bare shortcode / JSON.
  }
  return trimmed;
}

// Build an OBS overlay URL for a given web source: burn the appearance shortcode and the
// endpoint into a link. Source-neutral - obsSource selects the browser-direct source
// (e.g. 'now-playing', later 'playercap'). Host may be empty to use the page default.
export function buildObsSourceUrl(obsSource: string, cfg: string, host: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/';
  const params = new URLSearchParams();
  params.set('obs', '1');
  params.set('obsSource', obsSource);
  if (host) params.set('host', host);
  if (cfg) params.set('cfg', cfg);
  return `${origin}${pathname}?${params.toString()}`;
}
