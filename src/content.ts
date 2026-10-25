/// <reference path="./core.ts" />

/**
 * MV3 content-script controller. No page-world monkeypatches or network requests.
 * Bare arrow keys stay under X's control until a CONFIRMED gallery boundary.
 * Only then is a post-to-post navigation attempted.
 */
namespace XMN {
  const VIEWER_SELECTOR = '[data-testid="swipe-to-dismiss"]';
  const TILE_SELECTOR = 'li[role="listitem"]';
  const NATIVE_NEXT = /^(next( (photo|image))?|次の(画像|写真)|次へ)$/i;
  const NATIVE_PREVIOUS = /^(prev(ious)?( (photo|image))?|前の(画像|写真)|前へ)$/i;

  const CLOSE_SELECTOR = [
    'button[data-testid="app-bar-close"]',
    '[role="button"][data-testid="app-bar-close"]',
    'button[aria-label="閉じる"]',
    '[role="button"][aria-label="閉じる"]',
    'button[aria-label="Close"]',
    '[role="button"][aria-label="Close"]',
  ].join(',');

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function mediaColumn(): Element | null {
    return document.querySelector('main [data-testid="primaryColumn"]') ?? document.querySelector('main');
  }

  function isEditingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    return !!target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="slider"], video');
  }

  function usableTileLink(tile: Element, profile: string): { link: HTMLAnchorElement; ref: MediaRef } | null {
    const links = Array.from(tile.querySelectorAll<HTMLAnchorElement>('a[href]'));
    // An explicit photo/video position is less ambiguous than a generic status link.
    const possibilities = links.map((link) => ({ link, ref: mediaRefFromHref(link.getAttribute('href') ?? '', profile) }))
      .filter((candidate): candidate is { link: HTMLAnchorElement; ref: MediaRef } => candidate.ref !== null);
    const specific = possibilities.find(({ ref }) => ref.kind !== null);
    if (specific) return specific;
    // X sometimes uses a plain status URL in an image/video tile.
    const generic = possibilities[0];
    if (generic && tile.querySelector('img, video')) return generic;
    return null;
  }

  /** Maintain a stable ordered list of media refs, never cached DOM nodes. */
  export class Controller {
    private originProfile: string | null = null;
    private originTimeline: string | null = null;
    private pendingGrid: { column: Element | null; firstTiles: Element[]; firstKeys: string[] } | null = null;
    private refs: MediaRef[] = [];
    private indexes = new Map<string, number>();
    private imageSources = new Map<string, string>();
    private prefetched = new Map<string, HTMLImageElement>();
    private preloadTimer: number | null = null;
    private preloadForPath = '';

    private viewer: HTMLElement | null = null;
    private viewObserver: MutationObserver | null = null;
    private listObserver: MutationObserver | null = null;
    private observedColumn: Element | null = null;
    private lastPath = '';
    private scanTimer: number | null = null;
    private navigationBusy = false;
    private navGeneration = 0;
    private refreshId: number;

    constructor() {
      // Observe actual user keyboard input only when the viewer belongs to a media-tab session.
      document.addEventListener('keydown', (event) => this.onKeyDown(event), true);
      this.refreshId = window.setInterval(() => this.tick(), 450);
      this.tick();
    }

    private resetSession(): void {
      this.navGeneration++;
      this.navigationBusy = false;
      this.pendingGrid = null;
      this.refs = [];
      this.indexes.clear();
      this.imageSources.clear();
      this.prefetched.clear();
      this.preloadForPath = '';
      if (this.preloadTimer !== null) window.clearTimeout(this.preloadTimer);
      this.preloadTimer = null;
      this.removeViewerUI();
      this.stopListObserver();
      document.querySelectorAll('.xmn-tile-badge').forEach((element) => element.remove());
      document.querySelectorAll('.xmn-numbered-tile').forEach((element) => element.classList.remove('xmn-numbered-tile'));
    }

    private stopListObserver(): void {
      this.listObserver?.disconnect();
      this.listObserver = null;
      this.observedColumn = null;
      if (this.scanTimer !== null) window.clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }

    private tick(): void {
      const path = window.location.pathname;
      const atMedia = mediaProfileFromPath(path);
      const timeline = mediaTimelineKey(path, window.location.search);
      if (atMedia && timeline) {
        let scanRequired = false;
        if (this.originProfile !== atMedia) {
          this.resetSession();
          this.originProfile = atMedia;
          this.originTimeline = timeline;
          scanRequired = true;
        } else if (this.originTimeline !== timeline) {
          // The URL can change before X paints the new filter results. Never collect
          // stale photos into the new video timeline (or vice versa).
          const snapshot = this.captureGrid();
          this.resetSession();
          this.originProfile = atMedia;
          this.originTimeline = timeline;
          this.pendingGrid = snapshot;
        }
        const observerAdded = this.ensureListObserver();
        if (this.pendingGrid && this.hasGridTurnedOver(this.pendingGrid)) {
          this.pendingGrid = null;
          scanRequired = true;
        }
        // The observer handles subsequent DOM changes. Avoid O(N) scanning of a
        // long media timeline every 450ms when nothing has changed.
        if (!this.pendingGrid && (scanRequired || observerAdded)) this.scanTiles();
      } else if (!this.originProfile || !profileStatusFromPath(path, this.originProfile)) {
        if (this.originProfile !== null) {
          this.resetSession();
          this.originProfile = null;
          this.originTimeline = null;
        }
      } else {
        // The timeline is a retained DOM tree beneath the modal. Do NOT index the
        // status-page recommendations as though they were the originating media tab.
        this.stopListObserver();
      }

      if (path !== this.lastPath) this.lastPath = path;
      const viewer = this.originProfile && profileStatusFromPath(path, this.originProfile)
        ? document.querySelector<HTMLElement>(VIEWER_SELECTOR) : null;
      if (viewer && this.originProfile) {
        this.syncViewer(viewer);
      } else {
        this.removeViewerUI();
      }
    }

    /** First few anchors and DOM nodes distinguish X's data swap from our badge cleanup. */
    private captureGrid(): { column: Element | null; firstTiles: Element[]; firstKeys: string[] } {
      const column = mediaColumn();
      const firstTiles = column ? Array.from(column.querySelectorAll(TILE_SELECTOR)).slice(0, 8) : [];
      const firstKeys = firstTiles.map((tile) => {
        const link = this.originProfile ? usableTileLink(tile, this.originProfile) : null;
        return link?.ref.key ?? '';
      });
      return { column, firstTiles, firstKeys };
    }

    private hasGridTurnedOver(previous: { column: Element | null; firstTiles: Element[]; firstKeys: string[] }): boolean {
      const current = this.captureGrid();
      if (current.firstTiles.length === 0) return false;
      // Waiting for X's actual list replacement is safer than a fixed delay.
      if (current.column !== previous.column) return true;
      const replaced = current.firstTiles.some((tile, index) => tile !== previous.firstTiles[index]);
      const keysChanged = current.firstKeys.some((key, index) => key !== previous.firstKeys[index]);
      return replaced || keysChanged;
    }

    private ensureListObserver(): boolean {
      const column = mediaColumn();
      if (!column || column === this.observedColumn) return false;
      this.stopListObserver();
      this.observedColumn = column;
      this.listObserver = new MutationObserver(() => {
        if (this.scanTimer !== null) return;
        this.scanTimer = window.setTimeout(() => {
          this.scanTimer = null;
          if (mediaProfileFromPath(window.location.pathname) === this.originProfile) {
            if (this.pendingGrid && this.hasGridTurnedOver(this.pendingGrid)) this.pendingGrid = null;
            if (!this.pendingGrid) this.scanTiles();
          }
        }, 100);
      });
      this.listObserver.observe(column, { childList: true, subtree: true });
      return true;
    }

    private scanTiles(): void {
      if (!this.originProfile || this.pendingGrid ||
          mediaProfileFromPath(window.location.pathname) !== this.originProfile) return;
      const root = mediaColumn();
      if (!root) return;
      for (const tile of Array.from(root.querySelectorAll<HTMLElement>(TILE_SELECTOR))) {
        const found = usableTileLink(tile, this.originProfile);
        if (!found) continue;
        const { ref } = found;
        // Capture only CDN image locations from the already-rendered media tiles.
        const thumbnail = tile.querySelector<HTMLImageElement>('img[src]');
        const imageUrl = thumbnail ? preloadImageUrl(thumbnail.currentSrc || thumbnail.src || '') : null;
        if (imageUrl) {
          // Keep only nearby/recent thumbnail URLs in memory during long timelines.
          this.imageSources.delete(ref.key);
          this.imageSources.set(ref.key, imageUrl);
          while (this.imageSources.size > 128) {
            const oldest = this.imageSources.keys().next().value;
            if (oldest === undefined) break;
            this.imageSources.delete(oldest);
          }
        }
        let index = this.indexes.get(ref.key);
        if (index === undefined) {
          index = this.refs.length;
          this.indexes.set(ref.key, index);
          this.refs.push(ref);
        } else {
          // Refresh references by value. Old DOM nodes are never persisted.
          this.refs[index] = ref;
        }
        let badge = tile.querySelector<HTMLElement>(':scope > .xmn-tile-badge');
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'xmn-tile-badge';
          badge.setAttribute('aria-hidden', 'true');
          tile.classList.add('xmn-numbered-tile');
          tile.appendChild(badge);
        }
        const label = String(index + 1);
        if (badge.textContent !== label) badge.textContent = label;
      }
    }

    private removeViewerUI(): void {
      this.viewObserver?.disconnect();
      this.viewObserver = null;
      if (this.viewer) {
        this.viewer.querySelectorAll('.xmn-nav-button, .xmn-status').forEach((element) => element.remove());
        this.viewer = null;
      }
    }

    private syncViewer(viewer: HTMLElement): void {
      if (viewer !== this.viewer) {
        this.removeViewerUI();
        this.viewer = viewer;
        this.viewObserver = new MutationObserver(() => {
          // X may replace viewer children during /photo/N transitions.
          if (this.viewer?.isConnected) this.ensureViewerButtons();
        });
        this.viewObserver.observe(viewer, { childList: true, subtree: true });
      }
      this.ensureViewerButtons();
    }

    private ensureViewerButtons(): void {
      const viewer = this.viewer;
      if (!viewer || !viewer.isConnected) return;
      for (const [direction, className, text, label] of [
        [-1, 'xmn-prev', '◀', '前の投稿へ（最初の画像では←でも移動）'],
        [1, 'xmn-next', '▶', '次の投稿へ（最後の画像では→でも移動）'],
      ] as const) {
        let button = viewer.querySelector<HTMLButtonElement>(`.${className}`);
        if (!button) {
          button = document.createElement('button');
          button.type = 'button';
          button.className = `xmn-nav-button ${className}`;
          button.textContent = text;
          button.title = label;
          button.setAttribute('aria-label', label);
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.navigate(direction);
          });
          viewer.appendChild(button);
        }
      }
      let status = viewer.querySelector<HTMLElement>('.xmn-status');
      if (!status) {
        status = document.createElement('div');
        status.className = 'xmn-status';
        status.setAttribute('aria-live', 'polite');
        viewer.appendChild(status);
      }
      this.updateViewerState();
      this.schedulePreload();
    }

    private activeIndex(): number | null {
      if (!this.originProfile) return null;
      const exact = findCurrentIndex(this.refs, window.location.pathname, this.originProfile);
      if (exact !== null) return exact;
      // A media tab may offer only one link for a post with several photos.
      const current = mediaRefFromHref(window.location.pathname, this.originProfile);
      const matches = current ? this.refs.map((ref, i) => ({ ref, i }))
        .filter(({ ref }) => ref.statusId === current.statusId) : [];
      return matches.length ? matches[0].i : null;
    }

    private updateViewerState(): void {
      const viewer = this.viewer;
      if (!viewer) return;
      const current = this.activeIndex();
      const prev = viewer.querySelector<HTMLButtonElement>('.xmn-prev');
      const next = viewer.querySelector<HTMLButtonElement>('.xmn-next');
      const currentRef = current !== null ? this.refs[current] : null;
      if (prev) prev.disabled = this.navigationBusy || !currentRef || adjacentPostIndex(this.refs, currentRef.statusId, -1) === null;
      // At the last known post clicking the next button may load more media.
      if (next) next.disabled = this.navigationBusy || !currentRef;
      const indicator = viewer.querySelector<HTMLElement>('.xmn-status');
      if (indicator) {
        const statuses = Array.from(new Set(this.refs.map((ref) => ref.statusId)));
        const index = currentRef ? statuses.indexOf(currentRef.statusId) : -1;
        const label = index < 0 ? '投稿の位置を確認中' : `投稿 ${index + 1} / ${statuses.length}`;
        if (indicator.textContent !== label) indicator.textContent = label;
      }
    }

    /**
     * A positive gallery-size hint from the original post's media thumbnails.
     * Do not count media from unrelated replies or quoted posts.
     * If X changes its DOM or count is uncertain, do not take over ArrowRight.
     */
    private photoCount(viewer: HTMLElement, statusId: string): number | null {
      const root = viewer.closest('[role="dialog"]') ?? viewer.parentElement;
      if (!root || !this.originProfile) return null;
      const displayed = mediaRefFromHref(window.location.pathname, this.originProfile);
      // X can render a gallery counter. Confirm it belongs to the displayed photo,
      // rather than matching a number in an unrelated reply or recommended post.
      if (displayed?.kind === 'photo' && displayed.statusId === statusId) {
        for (const node of viewer.querySelectorAll<HTMLElement>('[aria-label], [title]')) {
          if (node.closest('.xmn-nav-button, .xmn-status')) continue;
          for (const label of [node.getAttribute('aria-label'), node.getAttribute('title')]) {
            const count = label && parseGalleryCounter(label);
            if (count && count.current === displayed.mediaIndex) return count.total;
          }
        }
      }
      // Official X rules cap photos at four; seeing all four distinct photo URLs
      // is therefore complete evidence. One, two, or three visible thumbnails
      // are NOT proof that the post contains no additional hidden photos.
      const indexes = new Set<number>();
      for (const article of root.querySelectorAll('article[data-testid="tweet"]')) {
        for (const link of article.querySelectorAll('a[href*="/photo/"]')) {
          const ref = mediaRefFromHref(link.getAttribute('href') ?? '', this.originProfile);
          if (ref?.statusId === statusId && ref.kind === 'photo' && ref.mediaIndex !== null) indexes.add(ref.mediaIndex);
        }
      }
      return completeFourPhotoSet(indexes) ? 4 : null;
    }

    private nativeGalleryArrowAvailable(viewer: HTMLElement, direction: Direction): boolean {
      const root = viewer.closest('[role="dialog"]') ?? viewer;
      const pattern = direction === 1 ? NATIVE_NEXT : NATIVE_PREVIOUS;
      for (const button of root.querySelectorAll<HTMLElement>('[aria-label], [title]')) {
        if (button.closest('.xmn-nav-button')) continue;
        const label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').trim();
        if (pattern.test(label) && button.getAttribute('aria-disabled') !== 'true' &&
            !(button instanceof HTMLButtonElement && button.disabled)) return true;
      }
      return false;
    }

    private onKeyDown(event: KeyboardEvent): void {
      if (!this.viewer?.isConnected || !this.originProfile ||
          isEditingTarget(event.target) || this.navigationBusy ||
          this.activeIndex() === null) return;
      const current = mediaRefFromHref(window.location.pathname, this.originProfile);
      const direction = galleryBoundaryDirection(
        event, current, current ? this.photoCount(this.viewer, current.statusId) : null,
        this.nativeGalleryArrowAvailable(this.viewer, 1),
        this.nativeGalleryArrowAvailable(this.viewer, -1),
      );
      if (direction === null) return; // Preserve the native X photo/video operation.
      if (direction === -1 && current && adjacentPostIndex(this.refs, current.statusId, -1) === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void this.navigate(direction);
    }

    private schedulePreload(): void {
      if (!this.originProfile || !this.viewer || document.hidden) return;
      if (window.location.pathname === this.preloadForPath) return;
      this.preloadForPath = window.location.pathname;
      if (this.preloadTimer !== null) window.clearTimeout(this.preloadTimer);
      this.preloadTimer = window.setTimeout(() => {
        this.preloadTimer = null;
        this.preloadAdjacentImages();
      }, 350);
    }

    private preloadAdjacentImages(): void {
      if (!this.viewer?.isConnected || !this.originProfile || document.hidden ||
          (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
      if (connection?.saveData || /^(slow-2g|2g)$/.test(connection?.effectiveType ?? '')) return;
      const index = this.activeIndex();
      const current = mediaRefFromHref(window.location.pathname, this.originProfile);
      if (index === null || !current) return;
      const targets: MediaRef[] = [];
      // Native next/previous photos are preheated first; otherwise adjacent posts.
      for (const direction of [1, -1] as Direction[]) {
        const neighbor = this.refs[index + direction];
        const post = adjacentPostIndex(this.refs, current.statusId, direction);
        const photoCandidate = neighbor?.statusId === current.statusId &&
          neighbor.kind === 'photo' && neighbor.mediaIndex !== null && current.mediaIndex !== null &&
          (neighbor.mediaIndex - current.mediaIndex) * direction > 0 ? neighbor : null;
        const candidate = photoCandidate ?? (post !== null ? this.refs[post] : null);
        if (candidate) targets.push(candidate);
      }
      const urls = targets.map((ref) => this.imageSources.get(ref.key)).filter((url): url is string => !!url);
      const unique = [...new Set(urls)].slice(0, 2);
      for (const [url] of this.prefetched) {
        if (!unique.includes(url)) this.prefetched.delete(url);
      }
      for (const url of unique) {
        if (this.prefetched.has(url)) continue;
        const image = new Image();
        image.decoding = 'async';
        image.fetchPriority = 'low';
        image.src = url;
        this.prefetched.set(url, image);
        // Decode proactively when supported, but never block X's own UI.
        if (typeof image.decode === 'function') {
          void image.decode().catch(() => {
            if (this.prefetched.get(url) === image) this.prefetched.delete(url);
          });
        }
      }
    }

    private findCloseButton(viewer: Element): HTMLElement | null {
      const dialog = viewer.closest('[role="dialog"]');
      const local = dialog?.querySelector<HTMLElement>(CLOSE_SELECTOR);
      if (local) return local;
      // Do not click an unrelated button if the global query is ambiguous.
      const matches = document.querySelectorAll<HTMLElement>(CLOSE_SELECTOR);
      return matches.length === 1 ? matches[0] : null;
    }

    private findLiveLink(ref: MediaRef): HTMLAnchorElement | null {
      if (!this.originProfile) return null;
      const column = mediaColumn();
      if (!column) return null;
      for (const tile of column.querySelectorAll(TILE_SELECTOR)) {
        const found = usableTileLink(tile, this.originProfile);
        if (found?.ref.key === ref.key && found.link.isConnected) return found.link;
      }
      return null;
    }

    private toast(message: string): void {
      let element = document.querySelector<HTMLElement>('.xmn-toast');
      if (!element) {
        element = document.createElement('div');
        element.className = 'xmn-toast';
        element.setAttribute('role', 'status');
        document.body.appendChild(element);
      }
      element.textContent = message;
      window.setTimeout(() => {
        if (element?.textContent === message) element.remove();
      }, 2800);
    }

    private async waitForViewerToClose(viewer: HTMLElement): Promise<boolean> {
      for (let i = 0; i < 12; i++) {
        if (!viewer.isConnected || !document.querySelector(VIEWER_SELECTOR)) return true;
        await pause(125);
      }
      return !viewer.isConnected;
    }

    /** Wait for a DIFFERENT post; new images of the current post are not enough. */
    private async loadNextPost(statusId: string, generation: number): Promise<MediaRef | null> {
      for (let attempt = 0; attempt < 20; attempt++) {
        if (generation !== this.navGeneration) return null;
        this.scanTiles();
        const nextIndex = adjacentPostIndex(this.refs, statusId, 1);
        if (nextIndex !== null) return this.refs[nextIndex];
        // X owns infinite scrolling. Only scroll the already-open media timeline.
        if (attempt % 3 === 0) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        await pause(200);
      }
      this.scanTiles();
      const nextIndex = adjacentPostIndex(this.refs, statusId, 1);
      return nextIndex === null ? null : this.refs[nextIndex];
    }

    private async navigate(direction: Direction): Promise<void> {
      const currentIndex = this.activeIndex();
      const oldViewer = this.viewer;
      if (this.navigationBusy || currentIndex === null || !oldViewer || !this.originProfile) return;
      const currentRef = this.refs[currentIndex];
      const nextIndex = adjacentPostIndex(this.refs, currentRef.statusId, direction);
      if (direction === -1 && nextIndex === null) return;
      const generation = this.navGeneration;
      const profile = this.originProfile;
      // An old media-timeline entry may have been evicted from X's virtualized DOM.
      // Do not close the active viewer when the known destination is no longer clickable.
      if (nextIndex !== null && !this.findLiveLink(this.refs[nextIndex])) {
        this.toast('移動先が一覧から消えています。ビューアは閉じません');
        return;
      }
      const closeButton = this.findCloseButton(oldViewer);
      if (!closeButton) {
        this.toast('Xの閉じるボタンが見つからず、移動を中止しました');
        return;
      }
      this.navigationBusy = true;
      this.updateViewerState();
      try {
        closeButton.click();
        if (!await this.waitForViewerToClose(oldViewer)) {
          this.toast('ビューアを閉じられませんでした');
          return;
        }
        if (generation !== this.navGeneration || mediaProfileFromPath(window.location.pathname) !== profile) return;
        // SPA navigation may return to a different Photos/Videos filter than the
        // timeline that supplied these refs. Never open a ref from the wrong grid.
        if (this.originTimeline && mediaTimelineKey(window.location.pathname, window.location.search) !== this.originTimeline) {
          this.toast('一覧の種類が切り替わったため、移動を中止しました');
          return;
        }
        let destination = nextIndex === null ? null : this.refs[nextIndex];
        // At the end, only click an observed, different post. Never guess a URL.
        if (!destination && direction === 1) {
          destination = await this.loadNextPost(currentRef.statusId, generation);
        }
        if (generation !== this.navGeneration) return;
        const link = destination && destination.statusId !== currentRef.statusId ? this.findLiveLink(destination) : null;
        if (link) {
          link.click();
        } else {
          // Don't navigate to a guessed URL or re-open an unrelated status.
          this.toast('次の項目を見つけられませんでした。一覧で続きを読み込んでください');
          // Restore current viewer when its source is still present.
          this.findLiveLink(currentRef)?.click();
        }
      } catch (error) {
        console.warn('X Media Navigator navigation cancelled:', error);
        this.toast('メディアの切り替えに失敗しました');
      } finally {
        this.navigationBusy = false;
        this.updateViewerState();
      }
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new XMN.Controller(), { once: true });
} else {
  new XMN.Controller();
}
