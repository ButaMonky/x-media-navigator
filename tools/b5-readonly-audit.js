/**
 * X Media Navigator B5: on-demand, privacy-conserving DevTools Snippet.
 * Run manually AFTER opening an X photo; read-only, no storage or network.
 * It reports counts and booleans, never media URLs, post IDs, user handles,
 * replies, cookies, browsing history, resource names, or credentials.
 * A visible DOM image does NOT prove actual screen paint.
 */
(() => {
  'use strict';
  const safe = (callback, fallback) => {
    try { return callback(); } catch { return fallback; }
  };
  const numeric = (number) =>
    Number.isFinite(number) && number >= 0 ? number : 0;
  const rectVisible = (element) => {
    const r = safe(() => element.getBoundingClientRect(), null);
    return !!r && r.width > 0 && r.height > 0 &&
      r.left < innerWidth && r.right > 0 &&
      r.top < innerHeight && r.bottom > 0;
  };
  const controls = document.querySelector('.xmn-controls-layer');
  const viewer = document.querySelector('[data-testid="swipe-to-dismiss"]');
  const prev = controls?.querySelector('.xmn-prev') ?? null;
  const next = controls?.querySelector('.xmn-next') ?? null;
  const badge = controls?.querySelector('.xmn-status') ?? null;
  const count = /^投稿\s*(\d{1,6})\s*\/\s*(\d{1,6})(\+)?$/u.exec(
    badge?.textContent?.trim() ?? '');
  const visibleImages = [...(viewer?.querySelectorAll('img') ?? [])]
    .filter((img) => rectVisible(img));
  const decodedImages = visibleImages.filter((img) =>
    img.complete === true && numeric(img.naturalWidth) > 0 &&
    numeric(img.naturalHeight) > 0).length;
  const resourceEntries = safe(() =>
    performance.getEntriesByType('resource'), []);
  let cdnMediaLoads = 0, reportedTransfers = 0;
  let confirmedBrowserCache = 0, timingUnavailable = 0;
  const timings = [];
  // Resource names are parsed for ownership only, never retained or logged.
  for (const entry of resourceEntries) {
    const isCdnPhoto = safe(() => {
      const url = new URL(entry.name);
      return url.protocol === 'https:' &&
        url.hostname === 'pbs.twimg.com' && !url.port &&
        /^\/media\/[A-Za-z0-9_-]+(?:\.(?:jpg|jpeg|png|webp))?$/i.test(url.pathname);
    }, false);
    if (!isCdnPhoto) continue;
    cdnMediaLoads++;
    if (numeric(entry.transferSize) > 0) reportedTransfers++;
    else if (numeric(entry.decodedBodySize) > 0 ||
        entry.deliveryType === 'cache') confirmedBrowserCache++;
    else timingUnavailable++;
    if (numeric(entry.duration) > 0) timings.push(entry.duration);
  }
  timings.sort((a, b) => a - b);
  const medianMs = timings.length
    ? Math.round(timings[Math.floor(timings.length / 2)] * 10) / 10
    : null;
  const overlays = [...document.querySelectorAll('.xmn-visual-handoff')];
  const visibleOverlays = overlays.filter(rectVisible).length;
  const clickThrough = safe(() =>
    controls ? getComputedStyle(controls).pointerEvents === 'none' : null,
    null);
  const summary = Object.freeze({
    schemaVersion: 1,
    controlLayerFound: !!controls,
    controlLayerClickThrough: clickThrough,
    viewerFound: !!viewer,
    previousButtonEnabled: !!prev && !prev.disabled,
    nextButtonEnabled: !!next && !next.disabled,
    parsedPostNumber: count ? numeric(Number(count[1])) : null,
    parsedLoadedPostCount: count ? numeric(Number(count[2])) : null,
    continuationIndicatorPresent: !!count?.[3],
    visibleImages: visibleImages.length,
    visibleDecodedImages: decodedImages,
    visualHandoffElements: overlays.length,
    visibleHandoffElements: visibleOverlays,
    observedCdnMediaResources: cdnMediaLoads,
    observedCdnMediaTransfers: reportedTransfers,
    browserSupportedCacheEvidence: confirmedBrowserCache,
    unknownTransferFromMissingTiming: timingUnavailable,
    medianCdnResourceDurationMs: medianMs,
    caveat: 'DOM/rendered image counts do not prove Paint. Cross-origin 0-byte timing does not prove cache. No profile, URL, message text or token is reported.'
  });
  console.info('XMN B5 read-only acceptance audit (aggregate only)', summary);
  return summary;
})();
