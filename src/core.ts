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

  /** Bare ArrowLeft / ArrowRight always belong to X's native image/video UI. */
  export function postShortcutDirection(event: KeyLike): Direction | null {
    if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.isComposing) return null;
    if (event.key === 'ArrowRight') return 1;
    if (event.key === 'ArrowLeft') return -1;
    return null;
  }
}
