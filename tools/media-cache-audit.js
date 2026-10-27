/**
 * X Media Navigator: read-only, one-shot Chromium DevTools Snippet.
 * Run manually on the X media viewer, then navigate and run again.
 * No permissions, credentials, raw media URLs, recording, storage or network.
 * Timing-Allow-Origin may hide cross-origin transferred bytes; 0 != cache hit.
 */
(() => {
  const parse = (raw) => {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || u.hostname !== 'pbs.twimg.com' ||
          u.port || u.username || u.password) return null;
      const media = /^\/media\/([A-Za-z0-9_-]+)(?:\.(?:jpg|jpeg|png|webp))?$/i.exec(u.pathname);
      if (!media) return null;
      return { id: media[1], variant: u.searchParams.get('name') || 'unspecified' };
    } catch { return null; }
  };
  const entries = performance.getEntriesByType('resource');
  const resourceById = new Map();
  let mediaResources = 0;
  let positiveTransfers = 0;
  let provenCache = 0;
  let opaqueSize = 0;
  let reportedCache = 0;
  const durations = [];
  for (const e of entries) {
    const media = parse(e.name);
    if (!media) continue;
    mediaResources++;
    let set = resourceById.get(media.id);
    if (!set) { set = new Set(); resourceById.set(media.id, set); }
    set.add(media.variant);
    if (e.transferSize > 0) positiveTransfers++;
    else if (e.transferSize === 0 && e.decodedBodySize > 0) provenCache++;
    else opaqueSize++;
    if (e.deliveryType === 'cache') reportedCache++;
    if (Number.isFinite(e.duration) && e.duration > 0) durations.push(e.duration);
  }
  const visibleImages = [...document.querySelectorAll('[data-testid="swipe-to-dismiss"] img')]
    .filter((img) => {
      if (img.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
      const rect = img.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 &&
        rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    });
  let displayedCdnPhotos = 0, displayedWithTiming = 0, displayedMissingTiming = 0;
  for (const img of visibleImages) {
    const media = parse(img.currentSrc || img.src);
    if (!media) continue;
    displayedCdnPhotos++;
    if (resourceById.has(media.id)) displayedWithTiming++;
    else displayedMissingTiming++;
  }
  const variantOverlap = [...resourceById.values()]
    .filter((variants) => variants.size > 1).length;
  durations.sort((a, b) => a - b);
  const median = durations.length
    ? Math.round(durations[Math.floor(durations.length / 2)] * 10) / 10 : null;
  const report = {
    observedResourceEntries: entries.length,
    observedMediaResources: mediaResources,
    uniqueMediaIds: resourceById.size,
    mediaIdsWithMultipleNameVariants: variantOverlap,
    measuredTransfers: positiveTransfers,
    cacheHitsWithDecodedSizeEvidence: provenCache,
    unknownTransferDueToMissingTiming: opaqueSize,
    browserReportedCache: reportedCache,
    visibleCdnImages: displayedCdnPhotos,
    visibleImagesWithObservedResource: displayedWithTiming,
    visibleImagesWithoutObservedResource: displayedMissingTiming,
    medianObservedResourceDurationMs: median,
    caveat: 'CDN name=large/orig may have distinct HTTP cache keys. transferSize=0 and decodedBodySize=0 is UNKNOWN, not a cache hit. The browser may omit older resource entries.'
  };
  console.info('XMN one-shot cache audit (counts only, no URLs)', report);
  return report;
})();
