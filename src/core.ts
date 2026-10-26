/**
 * X Media Navigator: deterministic helpers. This namespace has no browser-side effects.
 * It is compiled together with content.ts into a single MV3 content script.
 */
namespace XMN {
  export type Direction = -1 | 1;
  export type MediaKind = 'photo' | 'video' | null;

  export interface MediaRef {
    key: string;
    statusId: string;
    profile: string;
    kind: MediaKind;
    mediaIndex: number | null;
    href: string;
  }

  const HANDLE_RE = /^[a-zA-Z0-9_]{1,15}$/;
  const MEDIA_ROUTE_RE = /^\/([^/?#]+)\/media\/?$/;
  const POST_ROUTE_RE = /^\/([^/?#]+)\/status\/(\d+)(?:\/(photo|video)\/(\d+))?\/?$/;
  const HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);

  export function mediaProfileFromPath(pathname: string): string | null {
    const match = MEDIA_ROUTE_RE.exec(pathname);
    if (!match || !HANDLE_RE.test(match[1])) return null;
    return match[1].toLowerCase();
  }

  /**
   * Media tab URL may keep the same pathname when the Photos/Videos dropdown changes.
   * An absent filter is NOT assumed to mean video: record it independently.
   * Unrelated query params are deliberately ignored.
   */
  export function mediaTimelineKey(pathname: string, search: string): string | null {
    const profile = mediaProfileFromPath(pathname);
    if (!profile) return null;
    const filters = new URLSearchParams(search).getAll('filter').map((value) => value.trim().toLowerCase());
    const mode = filters.length === 0 ? 'default'
      : filters.length === 1 ? (filters[0] || 'empty') : `multi:${filters.join(',')}`;
    return `${profile}|${encodeURIComponent(mode)}`;
  }

  /** Only a complete 4-photo set proves album completion without a gallery counter. */
  export function completeFourPhotoSet(indexes: ReadonlySet<number>): boolean {
    return indexes.size === 4 && [1, 2, 3, 4].every((index) => indexes.has(index));
  }

  /** Parse only explicit media counters; Japanese "N枚中M枚目" lists total first. */
  export function parseGalleryCounter(label: string): { current: number; total: number } | null {
    const text = label.trim().normalize('NFKC');
    const japanese = /^(?:全\s*)?(\d+)\s*枚中\s*(\d+)\s*枚目$/.exec(text);
    const standard = /^(?:(?:image|photo|picture|画像|写真)\s*)?(\d+)\s*(?:\/|of)\s*(\d+)\s*(?:枚目|枚)?$/i.exec(text);
    if (!japanese && !standard) return null;
    const current = Number(japanese ? japanese[2] : standard![1]);
    const total = Number(japanese ? japanese[1] : standard![2]);
    return Number.isInteger(current) && Number.isInteger(total) && current >= 1 &&
      total >= current && total <= 4 ? { current, total } : null;
  }

  export function profileStatusFromPath(pathname: string, profile: string): boolean {
    const match = POST_ROUTE_RE.exec(pathname);
    return !!match && match[1].toLowerCase() === profile.toLowerCase();
  }

  /**
   * Resolve only links belonging to the active profile. Strip query/fragment to make
   * the key stable across tracking parameters; include photo/video position.
   */
  export function mediaRefFromHref(href: string, profile: string): MediaRef | null {
    if (!HANDLE_RE.test(profile)) return null;
    let url: URL;
    try {
      url = new URL(href, 'https://x.com');
    } catch {
      return null;
    }
    if (!HOSTS.has(url.hostname.toLowerCase()) || !['https:', 'http:'].includes(url.protocol)) return null;
    const match = POST_ROUTE_RE.exec(url.pathname);
    if (!match || match[1].toLowerCase() !== profile.toLowerCase()) return null;
    const kind = (match[3] as MediaKind | undefined) ?? null;
    const mediaIndex = match[4] === undefined ? null : Number(match[4]);
    if (mediaIndex !== null && (!Number.isSafeInteger(mediaIndex) || mediaIndex < 1 || mediaIndex > 100)) return null;
    const key = `${match[2]}:${kind ?? 'post'}:${mediaIndex ?? 0}`;
    return { key, statusId: match[2], profile: profile.toLowerCase(), kind, mediaIndex, href: url.pathname };
  }

  export function adjacentIndex(index: number, size: number, direction: Direction): number | null {
    if (!Number.isSafeInteger(index) || index < 0 || index >= size) return null;
    const next = index + direction;
    return next < 0 || next >= size ? null : next;
  }

  export function findCurrentIndex(items: readonly MediaRef[], pathname: string, profile: string): number | null {
    const current = mediaRefFromHref(pathname, profile);
    if (!current) return null;
    const exact = items.findIndex((item) => item.key === current.key);
    if (exact >= 0) return exact;
    // URLs without /photo/N can only be resolved safely when the status has one item.
    const sameStatus = items.map((item, i) => ({ item, i })).filter(({ item }) => item.statusId === current.statusId);
    if (sameStatus.length === 1) return sameStatus[0].i;
    return null;
  }

  export interface KeyLike {
    key: string;
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    repeat?: boolean;
    isComposing?: boolean;
  }

  /** A bare arrow may cross posts ONLY at a verified photo boundary. */
  export function postShortcutDirection(event: KeyLike): Direction | null {
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.isComposing) return null;
    if (event.key === 'ArrowRight') return 1;
    if (event.key === 'ArrowLeft') return -1;
    return null;
  }

  export function galleryBoundaryDirection(
    event: KeyLike, current: MediaRef | null, photoCount: number | null,
    nativeNextAvailable = false, nativePreviousAvailable = false,
  ): Direction | null {
    const direction = postShortcutDirection(event);
    if (!direction || current?.kind !== 'photo' || current.mediaIndex === null) return null;
    if (direction === -1) return current.mediaIndex === 1 && !nativePreviousAvailable ? -1 : null;
    if (nativeNextAvailable) return null;
    return photoCount !== null && photoCount >= 1 && current.mediaIndex === photoCount ? 1 : null;
  }

  /**
   * Move across the CONTIGUOUS status group at the active position, not the last
   * occurrence of that ID anywhere in the timeline. A repeated status can appear
   * again after another post; skipping every occurrence would skip entire posts.
   */
  export function adjacentPostIndex(
    items: readonly MediaRef[], currentStatusId: string, direction: Direction, activePosition?: number,
  ): number | null {
    const anchored = activePosition !== undefined && Number.isSafeInteger(activePosition) &&
      activePosition >= 0 && activePosition < items.length &&
      items[activePosition].statusId === currentStatusId;
    let start = anchored ? activePosition! : -1;
    if (!anchored) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].statusId !== currentStatusId) continue;
        start = i;
        if (direction === 1) break;
      }
    }
    if (start < 0) return null;
    for (let i = start + direction; i >= 0 && i < items.length; i += direction) {
      if (items[i].statusId !== currentStatusId) return i;
    }
    return null;
  }

  /**
   * Stable X photo identity across small/large/orig variants of the same CDN
   * image. This does NOT download a URL or authorize an arbitrary image origin.
   * It is used only to decide when the X viewer has rendered our target.
   */
  export function photoCdnIdentity(src: string): string | null {
    let url: URL;
    try { url = new URL(src); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' ||
        url.username !== '' || url.password !== '' || url.port !== '') return null;
    const matched = /^\/media\/([A-Za-z0-9_-]+)(?:\.(?:jpg|jpeg|png|webp))?(?::(?:thumb|small|medium|large|orig|4096x4096))?$/i
      .exec(url.pathname);
    return matched ? matched[1] : null;
  }

  /** Only rewrite genuine X image CDN thumbnails. No arbitrary URL/network access. */
  export function preloadImageUrl(src: string): string | null {
    let url: URL;
    try { url = new URL(src); } catch { return null; }
    if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' ||
        !/^\/media\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
        !/^(jpg|jpeg|png|webp)$/i.test(url.searchParams.get('format') ?? '') ||
        !url.searchParams.has('name')) return null;
    url.searchParams.set('name', 'large');
    url.hash = '';
    return url.toString();
  }
}
