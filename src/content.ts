/// <reference path="./core.ts" />

/**
 * MV3 content-script controller. No page-world monkeypatches or network requests.
 * Bare arrow keys stay under X's control until a CONFIRMED gallery boundary.
 * Only then is a post-to-post navigation attempted.
 */
namespace XMN {
  const VIEWER_SELECTOR = '[data-testid="swipe-to-dismiss"]';
  const TILE_SELECTOR = 'li[role="listitem"]';
  // Bounded, progressive future-post prefetch. Never saturate the network.
  const PREFETCH_MAX_IMAGES = 5;
  const PREFETCH_MAX_CONCURRENT = 2;
  const PREFETCH_MAX_RECORDS = 6;
  const PREFETCH_MAX_DECODED_BYTES = 80 * 1024 * 1024;
  // Generic "Next"/"Previous" controls can belong to the POST sidebar,
  // not the photo carousel. Only photo-specific labels prove gallery arrows.
  const NATIVE_NEXT = /^(?:next\s+(?:photo|image|media)(?:\s+image)?|次の(?:画像|写真|メディア)(?:へ)?)$/i;
  const NATIVE_PREVIOUS = /^(?:prev(?:ious)?\s+(?:photo|image|media)(?:\s+image)?|前の(?:画像|写真|メディア)(?:へ)?)$/i;

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
    return !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"], video');
  }

  /** Hidden X carousel controls cannot prove a live gallery boundary. */
  function isHiddenNativeControl(control: HTMLElement): boolean {
    return control.getAttribute('aria-hidden') === 'true' ||
      control.getAttribute('hidden') !== null ||
      control.getAttribute('inert') !== null ||
      !!control.closest?.('[aria-hidden="true"], [hidden], [inert]');
  }

  function usableTileLink(tile: Element, profile: string): { link: HTMLAnchorElement; ref: MediaRef } | null {
    const links = Array.from(tile.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const possibilities = links
      // A quoted post can contain its own media links. They are not the
      // originating profile's media tile, even if the handle matches.
      .filter((link) => !link.closest('[data-testid="quoteTweet"]'))
      .map((link) => ({ link, ref: mediaRefFromHref(link.getAttribute('href') ?? '', profile) }))
      .filter((candidate): candidate is { link: HTMLAnchorElement; ref: MediaRef } => candidate.ref !== null);
    const hasThumbnail = !!tile.querySelector('img, video');
    // Prefer the link actually wrapping the thumbnail, not an unrelated
    // reply/permalink. Ambiguous owners are safer to leave unnumbered.
    const owned = possibilities.filter(({ link }) => !!link.querySelector('img, video'));
    if (owned.length === 1) return owned[0];
    if (owned.length > 1) return null;
    if (new Set(possibilities.map(({ ref }) => ref.statusId)).size > 1) return null;
    const explicit = possibilities.find(({ ref }) => ref.kind !== null);
    // X can leave a not-yet-loaded image placeholder in the grid. Preserve
    // one explicit /photo/N or /video/N link even before the img appears.
    if (!hasThumbnail) return possibilities.length === 1 ? explicit ?? null : null;
    // In older grids, the image sits outside its link. A single owner is still safe.
    return explicit ?? possibilities[0] ?? null;
  }

  /** A downloaded, decoded image may be reused as a very short visual handoff. */
  interface PrefetchedPhoto {
    image: HTMLImageElement;
    ready: boolean;
    loading: boolean;
    bytes: number;
    cancel?: () => void;
  }

  interface VisualHandoff {
    host: HTMLDivElement;
    targetStatus: string;
    targetMediaIndex: number | null;
    targetPhotoIdentity: string;
    timeout: number;
    generation: number;
    shown: boolean;
    revealTimer: number | null;
    sourceViewer: HTMLElement | null;
    observer: MutationObserver | null;
    waitingImage: HTMLImageElement | null;
    waitingLoadHandler: (() => void) | null;
    decodingImage: HTMLImageElement | null;
    decodingSrc: string | null;
    decodedImage: HTMLImageElement | null;
    decodedSrc: string | null;
  }

  /** Maintain a stable ordered list of media refs, never cached DOM nodes. */
  export class Controller {
    private originProfile: string | null = null;
    private originTimeline: string | null = null;
    private pendingGrid: { column: Element | null; firstTiles: Element[]; firstKeys: string[] } | null = null;
    private refs: MediaRef[] = [];
    private indexes = new Map<string, number>();
    private imageSources = new Map<string, string>();
    private imageSourcesRevision = 0;
    private knownPhotoTotals = new Map<string, number>();
    private prefetched = new Map<string, PrefetchedPhoto>();
    private prefetchQueue: string[] = [];
    private prefetchWanted = new Set<string>();
    private prefetchInFlight = 0;
    private prefetchFailed = new Set<string>();
    private prefetchTooLarge = new Set<string>();
    private prefetchFailurePath = '';
    private preopenExpireTimer: number | null = null;
    private handoff: VisualHandoff | null = null;
    private preloadTimer: number | null = null;
    private preloadForPath = '';
    private pendingRightConfirmation: { path: string; signature: string | null; expiresAt: number } | null = null;
    private nativeAdvancedPost: string | null = null;
    private rightProbeTimer: number | null = null;

    private viewer: HTMLElement | null = null;
    private viewObserver: MutationObserver | null = null;
    private modalObserver: MutationObserver | null = null;
    private listObserver: MutationObserver | null = null;
    private observedColumn: Element | null = null;
    private lastPath = '';
    private scanTimer: number | null = null;
    private pendingFullScan = false;
    private pendingSourceTiles = new Set<HTMLElement>();
    private navigationBusy = false;
    private navGeneration = 0;
    private refreshId: number;

    constructor() {
      // Observe actual user keyboard input only when the viewer belongs to a media-tab session.
      document.addEventListener('keydown', (event) => this.onKeyDown(event), true);
      // Preheat adjacent images when a user opens media from the grid, before
      // X has constructed its React modal. This never consumes the click.
      document.addEventListener('click', (event) => this.onMediaTileClick(event), true);
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
      this.imageSourcesRevision++;
      this.knownPhotoTotals.clear();
      this.clearVisualHandoff();
      // A removed media session must not leave background CDN transfers alive.
      this.prefetchQueue = [];
      this.prefetchWanted.clear();
      for (const entry of this.prefetched.values()) entry.cancel?.();
      this.prefetched.clear();
      this.prefetchFailed.clear();
      this.prefetchTooLarge.clear();
      this.prefetchFailurePath = '';
      this.prefetchInFlight = 0;
      if (this.preopenExpireTimer !== null) window.clearTimeout(this.preopenExpireTimer);
      this.preopenExpireTimer = null;
      this.preloadForPath = '';
      this.pendingRightConfirmation = null;
      this.nativeAdvancedPost = null;
      if (this.rightProbeTimer !== null) window.clearTimeout(this.rightProbeTimer);
      this.rightProbeTimer = null;
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
      this.pendingFullScan = false;
      this.pendingSourceTiles.clear();
    }

    /**
     * React's history.pushState does not fire popstate. Detect X's modal
     * insertion/removal through DOM changes instead of waiting up to 450ms.
     * Only inspect nodes added or removed, never rescan the entire page on
     * unrelated feed mutations. The interval remains a route-change fallback.
     */
    private syncModalObserver(): void {
      if (!this.originProfile || !document.body) {
        this.modalObserver?.disconnect();
        this.modalObserver = null;
        return;
      }
      if (this.modalObserver || typeof MutationObserver === 'undefined') return;
      this.modalObserver = new MutationObserver((records) => {
        if (!this.originProfile) return;
        for (const record of records) {
          for (const node of [...record.addedNodes, ...record.removedNodes]) {
            if (!(node instanceof Element)) continue;
            if (node.matches(VIEWER_SELECTOR) || node.querySelector(VIEWER_SELECTOR)) {
              this.tick();
              return;
            }
          }
        }
      });
      this.modalObserver.observe(document.body, { childList: true, subtree: true });
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
          // A modal close initiated by this extension can temporarily drop
          // ?filter=photo. Keep the original session until navigate() checks
          // the actual target. Do not clear refs midway through the operation.
          if (this.navigationBusy) return;
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

      this.syncModalObserver();
      if (path !== this.lastPath) {
        // Track proven native photo changes even if the next key is pressed
        // before the delayed fallback probe completes.
        if (this.originProfile) {
          const previous = mediaRefFromHref(this.lastPath, this.originProfile);
          const displayed = mediaRefFromHref(path, this.originProfile);
          if (previous?.kind === 'photo' && displayed?.kind === 'photo' &&
              previous.statusId === displayed.statusId &&
              previous.mediaIndex !== displayed.mediaIndex) {
            this.nativeAdvancedPost = displayed.statusId;
          }
        }
        this.pendingRightConfirmation = null;
        this.lastPath = path;
      }
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
      this.pendingSourceTiles ??= new Set();
      this.listObserver = new MutationObserver((records) => {
        let relevant = false;
        for (const record of records) {
          if (record.type === 'attributes') {
            // A late-loading thumbnail only requires updating its own URL.
            const tile = record.target instanceof Element
              ? record.target.closest<HTMLElement>(TILE_SELECTOR) : null;
            if (tile) {
              this.pendingSourceTiles.add(tile);
              relevant = true;
            }
          } else if (record.type === 'childList') {
            // Rescan for actual media additions/removals, but not our badges
            // or unrelated spinner/comment mutations outside media tiles.
            const insideTile = record.target instanceof Element
              ? record.target.closest(TILE_SELECTOR) : null;
            const changed = [...record.addedNodes, ...record.removedNodes];
            const mediaChanged = changed.some((node) => node instanceof Element &&
              (node.matches(TILE_SELECTOR) || !!node.querySelector(TILE_SELECTOR) ||
                (!!insideTile && (node.matches('a[href], img, video') ||
                  !!node.querySelector('a[href], img, video')))));
            if (mediaChanged) {
              this.pendingFullScan = true;
              relevant = true;
            }
          }
        }
        if (!relevant || this.scanTimer !== null) return;
        this.scanTimer = window.setTimeout(() => {
          this.scanTimer = null;
          const full = this.pendingFullScan;
          const changed = [...this.pendingSourceTiles];
          this.pendingFullScan = false;
          this.pendingSourceTiles.clear();
          if (mediaProfileFromPath(window.location.pathname) !== this.originProfile) return;
          if (this.pendingGrid && this.hasGridTurnedOver(this.pendingGrid)) this.pendingGrid = null;
          if (this.pendingGrid) return;
          if (full) this.scanTiles();
          else for (const tile of changed) this.refreshKnownTileSource(tile);
        }, 100);
      });
      this.listObserver.observe(column, {
        childList: true, subtree: true,
        attributes: true, attributeFilter: ['src', 'srcset'],
      });
      return true;
    }

    /** Update only the changed thumbnail without rescanning the whole media grid. */
    private recordTileImageSource(
      tile: HTMLElement, found: { link: HTMLAnchorElement; ref: MediaRef },
    ): void {
      const ownedImage = found.link.querySelector<HTMLImageElement>('img[src]');
      const allImages = tile.querySelectorAll<HTMLImageElement>('img[src]');
      const thumbnail = ownedImage ?? (allImages.length === 1 ? allImages[0] : null);
      // currentSrc may still be a data: placeholder immediately after a
      // lazy src update. Try the actual src as a second, validated candidate.
      const url = thumbnail
        ? preloadImageUrl(thumbnail.currentSrc || '') ?? preloadImageUrl(thumbnail.src || '')
        : null;
      if (!url || !this.imageSources || this.imageSources.get(found.ref.key) === url) return;
      this.imageSources.delete(found.ref.key);
      this.imageSources.set(found.ref.key, url);
      this.imageSourcesRevision = (this.imageSourcesRevision ?? 0) + 1;
      while (this.imageSources.size > 128) {
        const oldest = this.imageSources.keys().next().value;
        if (oldest === undefined) break;
        this.imageSources.delete(oldest);
      }
    }

    private refreshKnownTileSource(tile: HTMLElement): void {
      if (!tile.isConnected || !this.originProfile || this.pendingGrid ||
          mediaProfileFromPath(window.location.pathname) !== this.originProfile) return;
      const found = usableTileLink(tile, this.originProfile);
      if (found && this.indexes?.has(found.ref.key)) this.recordTileImageSource(tile, found);
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
        this.recordTileImageSource(tile, found);
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
      this.pendingRightConfirmation = null;
      if (this.rightProbeTimer !== null) window.clearTimeout(this.rightProbeTimer);
      this.rightProbeTimer = null;
      if (this.viewer) {
        this.viewer.querySelectorAll('.xmn-nav-button, .xmn-status').forEach((element) => element.remove());
        this.viewer = null;
      }
    }

    private syncViewer(viewer: HTMLElement): void {
      if (viewer !== this.viewer) {
        this.removeViewerUI();
        this.viewer = viewer;
        this.viewObserver = new MutationObserver((changes) => {
          if (!this.viewer?.isConnected) return;
          // React may reuse an existing <img> and swap only its src/srcset.
          // React render/remount uses childList. Ignore our own button/status
          // decoration whenever possible to avoid repeated full UI updates.
          const photoAttributeChange = changes.some((change) =>
            change.type === 'attributes' &&
            change.target instanceof HTMLImageElement &&
            (change.attributeName === 'src' || change.attributeName === 'srcset'));
          const structuralChange = changes.some((change) =>
            change.type === 'childList' &&
            [...change.addedNodes, ...change.removedNodes].some((node) =>
              node instanceof Element &&
              (node.matches('img, picture, video') ||
                !!node.querySelector('img, picture, video'))));
          if (structuralChange) this.ensureViewerButtons();
          if (structuralChange || photoAttributeChange) this.finishVisualHandoff(this.viewer);
        });
        this.viewObserver.observe(viewer, {
          childList: true, subtree: true,
          attributes: true, attributeFilter: ['src', 'srcset'],
        });
      }
      this.ensureViewerButtons();
      this.finishVisualHandoff(viewer);
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
      if (prev) prev.disabled = this.navigationBusy || !currentRef || adjacentPostIndex(this.refs, currentRef.statusId, -1, current ?? undefined) === null;
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
     * Prove the actual media count from accessibility metadata or the official
     * four-attachment limit. A carousel may mount only its visible photos;
     * one to three tweetPhoto nodes never prove that there are no more photos.
     */
    private photoCount(viewer: HTMLElement, statusId: string): number | null {
      const profile = this.originProfile;
      if (!profile) return null;
      const displayed = mediaRefFromHref(window.location.pathname, profile);
      const known = this.knownPhotoTotals?.get(statusId);
      if (known && displayed?.kind === 'photo' && displayed.mediaIndex !== null &&
          displayed.statusId === statusId && displayed.mediaIndex <= known) return known;
      const root = viewer.closest('[role="dialog"]') ?? viewer.parentElement;
      if (!root) return null;
      // X can render a gallery counter. Confirm it belongs to the displayed photo,
      // rather than matching a number in an unrelated reply or recommended post.
      if (displayed?.kind === 'photo' && displayed.statusId === statusId) {
        for (const node of viewer.querySelectorAll<HTMLElement>('[aria-label], [title], [aria-setsize][aria-posinset]')) {
          if (node.closest('.xmn-nav-button, .xmn-status')) continue;
          for (const label of [node.getAttribute('aria-label'), node.getAttribute('title')]) {
            const count = label && parseGalleryCounter(label);
            if (count && count.current === displayed.mediaIndex) {
              this.rememberPhotoTotal(statusId, count.total);
              return count.total;
            }
          }
          // Carousels commonly expose the size of a set even when they only
          // mount the current slide. Never infer size from mounted children.
          const position = Number(node.getAttribute('aria-posinset'));
          const size = Number(node.getAttribute('aria-setsize'));
          if (Number.isInteger(size) && size >= 1 && size <= 4 &&
              position === displayed.mediaIndex && size >= position) {
            this.rememberPhotoTotal(statusId, size);
            return size;
          }
        }
        if (displayed.mediaIndex === 4) {
          this.rememberPhotoTotal(statusId, 4);
          return 4;
        }
      }
      // Official X rules cap photos at four; seeing all four distinct photo URLs
      // is therefore complete evidence. One, two, or three visible thumbnails
      // are NOT proof that the post contains no additional hidden photos.
      const indexes = new Set<number>();
      for (const article of root.querySelectorAll('article[data-testid="tweet"]')) {
        for (const link of article.querySelectorAll('a[href*="/photo/"]')) {
          const ref = mediaRefFromHref(link.getAttribute('href') ?? '', profile);
          if (ref?.statusId === statusId && ref.kind === 'photo' && ref.mediaIndex !== null) indexes.add(ref.mediaIndex);
        }
      }
      if (completeFourPhotoSet(indexes)) {
        this.rememberPhotoTotal(statusId, 4);
        return 4;
      }
      return null;
    }

    /** Cache only counts supported by explicit X evidence or a confirmed edge. */
    private rememberPhotoTotal(statusId: string, total: number | null): void {
      if (!total || !Number.isInteger(total) || total < 1 || total > 4) return;
      if (!this.knownPhotoTotals) this.knownPhotoTotals = new Map();
      this.knownPhotoTotals.delete(statusId);
      this.knownPhotoTotals.set(statusId, total);
      while (this.knownPhotoTotals.size > 128) {
        const first = this.knownPhotoTotals.keys().next().value;
        if (!first) break;
        this.knownPhotoTotals.delete(first);
      }
    }

    private nativeGalleryArrowAvailable(viewer: HTMLElement, direction: Direction): boolean {
      const root = viewer.closest('[role="dialog"]') ?? viewer;
      const pattern = direction === 1 ? NATIVE_NEXT : NATIVE_PREVIOUS;
      for (const button of root.querySelectorAll<HTMLElement>('[aria-label], [title]')) {
        if (button.closest('.xmn-nav-button') || isHiddenNativeControl(button)) continue;
        const label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').trim();
        if (pattern.test(label) && button.getAttribute('aria-disabled') !== 'true' &&
            !(button instanceof HTMLButtonElement && button.disabled)) return true;
      }
      return false;
    }

    /** An explicitly disabled PHOTO-next button is positive end-of-gallery evidence. */
    private nativeGalleryArrowDisabled(viewer: HTMLElement): boolean {
      if (typeof viewer.closest !== 'function' || typeof viewer.querySelectorAll !== 'function') return false;
      const root = viewer.closest('[role="dialog"]') ?? viewer;
      let disabledPhotoNextSeen = false;
      for (const button of root.querySelectorAll<HTMLElement>('[aria-label], [title]')) {
        if (button.closest('.xmn-nav-button') || isHiddenNativeControl(button)) continue;
        const label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').trim();
        // A generic disabled "Next" could belong to the sidebar, not photos.
        if (!/next\s*(?:photo|image)|次の(?:画像|写真)/i.test(label)) continue;
        const disabled = button.getAttribute('aria-disabled') === 'true' ||
          (button instanceof HTMLButtonElement && button.disabled);
        // Mixed native controls are ambiguous, never proof of gallery end.
        if (!disabled) return false;
        disabledPhotoNextSeen = true;
      }
      return disabledPhotoNextSeen;
    }

    private onKeyDown(event: KeyboardEvent): void {
      if (!this.viewer?.isConnected || !this.originProfile ||
          isEditingTarget(event.target) || this.navigationBusy) return;
      const currentIndex = this.activeIndex();
      if (currentIndex === null) return;
      const current = mediaRefFromHref(window.location.pathname, this.originProfile);
      const count = current ? this.photoCount(this.viewer, current.statusId) : null;
      const photoCount = count ?? (current?.kind === 'photo' &&
        this.nativeGalleryArrowDisabled?.(this.viewer) ? current.mediaIndex : null);
      const nativeNext = this.nativeGalleryArrowAvailable(this.viewer, 1);
      const direction = galleryBoundaryDirection(
        event, current, photoCount,
        nativeNext,
        this.nativeGalleryArrowAvailable(this.viewer, -1),
      );
      if (direction === null) {
        // X may not expose a gallery counter. Give its own ArrowRight handler
        // first chance to change photos, then offer a non-skipping fallback.
        if (current && current.kind === 'photo' && event.key === 'ArrowRight' &&
            postShortcutDirection(event) === 1 && !nativeNext) {
          this.handleUnknownRightBoundary(event, current);
        }
        return;
      }
      if (direction === -1 && current && adjacentPostIndex(this.refs, current.statusId, -1, currentIndex) === null) return;
      this.pendingRightConfirmation = null;
      if (direction === 1 && current?.kind === 'photo' && current.mediaIndex !== null &&
          (photoCount === current.mediaIndex)) this.rememberPhotoTotal?.(current.statusId, photoCount);
      event.preventDefault();
      event.stopImmediatePropagation();
      void this.navigate(direction);
    }

    /**
     * Find the primary displayed photo, not every thumbnail/quoted photo in
     * the X viewer. Prefer the single large on-screen candidate. If the layout
     * is ambiguous, abstain rather than skipping an unseen gallery photo.
     */
    private displayedPhoto(): HTMLImageElement | null {
      const viewer = this.viewer;
      if (!viewer || typeof viewer.querySelectorAll !== 'function') return null;
      const photos = [...viewer.querySelectorAll<HTMLImageElement>('img[src], img[srcset]')]
        .filter((img) => photoCdnIdentity(img.currentSrc || '') ||
          photoCdnIdentity(img.src || ''));
      if (photos.length === 1) return photos[0];
      const ranked = photos.map((img) => {
        const rect = typeof img.getBoundingClientRect === 'function'
          ? img.getBoundingClientRect() : null;
        const visible = rect && rect.width >= 100 && rect.height >= 100 &&
          rect.right > 0 && rect.bottom > 0 &&
          (typeof window.innerWidth !== 'number' || rect.left < window.innerWidth) &&
          (typeof window.innerHeight !== 'number' || rect.top < window.innerHeight);
        return { img, area: visible ? rect.width * rect.height : 0 };
      }).filter((item) => item.area > 0).sort((a, b) => b.area - a.area);
      if (!ranked.length || (ranked.length > 1 &&
          ranked[1].area >= ranked[0].area * 0.65)) return null;
      return ranked[0].img;
    }

    /** Observe only the active X photo, not unrelated images in the dialog. */
    private currentPhotoSignature(): string | null {
      const image = this.displayedPhoto();
      return image
        ? `${image.currentSrc || ''}|${image.src || ''}|${image.complete ? 1 : 0}|${image.naturalWidth || 0}`
        : null;
    }

    /** A pending native photo download must never be mistaken for gallery end. */
    private currentPhotoReady(): boolean {
      if (!this.viewer || typeof this.viewer.querySelector !== 'function') return false;
      // Do not mistake an X-internal loading state for the end of its gallery.
      if (this.viewer.querySelector('[aria-busy="true"], [role="progressbar"]')) return false;
      const image = this.displayedPhoto();
      if (!image || !image.complete || image.naturalWidth < 1) return false;
      const selectedId = photoCdnIdentity(image.currentSrc || '') ||
        photoCdnIdentity(image.src || '');
      const assignedId = photoCdnIdentity(image.src || '');
      return selectedId !== null && (!assignedId || selectedId === assignedId);
    }

    /**
     * Let X handle the FIRST right-arrow. If it has not changed the displayed
     * photo or route after the bounded probe, continue to the next POST.
     * Never do that while an image is still loading, an explicit next photo
     * is indexed, or X exposes an enabled photo-next control.
     * If no reliable photo signature exists, retain the manual confirmation.
     */
    private handleUnknownRightBoundary(event: KeyboardEvent, current: MediaRef): void {
      if (!this.viewer || this.navigationBusy || current.mediaIndex === null) return;
      // An observed later photo is positive evidence we are NOT at the end.
      const hasLaterPhoto = this.refs?.some((ref) => ref.statusId === current.statusId &&
        ref.kind === 'photo' && ref.mediaIndex !== null &&
        ref.mediaIndex > current.mediaIndex!);
      if (hasLaterPhoto) return;
      const path = window.location.pathname;
      const signature = this.currentPhotoSignature();
      const readyBefore = signature !== null && this.currentPhotoReady();
      const pending = this.pendingRightConfirmation;
      if (!readyBefore && pending && pending.path === path && pending.signature === signature &&
          Date.now() < pending.expiresAt) {
        // A second press is not proof of an album edge while the image is
        // unready. Keep the key native; never skip a slow-loading photo.
        return;
      }
      this.pendingRightConfirmation = null;
      if (this.rightProbeTimer !== null) window.clearTimeout(this.rightProbeTimer);
      const generation = this.navGeneration;
      const viewer = this.viewer;
      this.rightProbeTimer = window.setTimeout(() => {
        this.rightProbeTimer = null;
        if (generation !== this.navGeneration || viewer !== this.viewer ||
            !viewer.isConnected || this.navigationBusy) return;
        const after = this.originProfile
          ? mediaRefFromHref(window.location.pathname, this.originProfile) : null;
        if (!after || after.statusId !== current.statusId) return;
        if (window.location.pathname !== path || this.currentPhotoSignature() !== signature) {
          if (after.mediaIndex !== null && after.mediaIndex !== current.mediaIndex) {
            this.nativeAdvancedPost = current.statusId;
          }
          return;
        }
        if (this.nativeGalleryArrowAvailable(viewer, 1)) return;
        if (this.refs?.some((ref) => ref.statusId === current.statusId &&
            ref.kind === 'photo' && ref.mediaIndex !== null &&
            ref.mediaIndex > current.mediaIndex!)) return;
        const nativeReachedHere = current.mediaIndex !== null &&
          current.mediaIndex > 1 && this.nativeAdvancedPost === current.statusId;
        if ((readyBefore && this.currentPhotoReady()) || nativeReachedHere) {
          // One keystroke, delayed only until X has had a chance to handle
          // its own gallery. This is an observed no-op, NOT proof of total count.
          this.pendingRightConfirmation = null;
          void this.navigate(1);
          return;
        }
        this.pendingRightConfirmation = {
          path, signature, expiresAt: Date.now() + 2600,
        };
        this.toast('画像の状態を確認できません。もう一度→で次の投稿へ');
      }, 1050);
    }

    private schedulePreload(): void {
      if (!this.originProfile || !this.viewer || document.hidden) return;
      const key = `${this.originTimeline ?? ''}|${window.location.pathname}|${this.refs.length}|${this.imageSources.size}|${this.imageSourcesRevision ?? 0}`;
      if (key === this.preloadForPath) return;
      this.preloadForPath = key;
      if (this.preloadTimer !== null) window.clearTimeout(this.preloadTimer);
      // Start immediately after X mounts the viewer; a 350ms debounce used
      // to miss the entire next-post transition on fast arrow navigation.
      // The timeline/path key above already deduplicates repeated DOM updates.
      this.preloadTimer = window.setTimeout(() => {
        this.preloadTimer = null;
        this.preloadAdjacentImages();
      }, 0);
    }

    /** Prefetch before X opens the modal, but only after a real media-tile click. */
    private onMediaTileClick(event: MouseEvent): void {
      if (!this.originProfile || this.pendingGrid || this.navigationBusy ||
          event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey ||
          mediaProfileFromPath(window.location.pathname) !== this.originProfile ||
          !(event.target instanceof Element)) return;
      // On slower connections let X load the *current* photo first. Early
      // background transfers must not compete with its initial modal render.
      const connection = (navigator as Navigator & { connection?: { effectiveType?: string; saveData?: boolean };
        deviceMemory?: number }).connection;
      const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      if (connection?.saveData || /^(slow-2g|2g|3g)$/.test(connection?.effectiveType ?? '') ||
          (memory !== undefined && memory <= 4)) return;
      const tile = event.target.closest(TILE_SELECTOR);
      const clickedLink = event.target.closest('a[href]');
      if (!tile || !clickedLink) return;
      const found = usableTileLink(tile, this.originProfile);
      if (!found || found.link !== clickedLink || !found.link.isConnected) return;
      const index = this.indexes.get(found.ref.key);
      if (index === undefined || this.refs[index]?.key !== found.ref.key) return;
      this.preloadAdjacentImages({ index, current: found.ref });
      if (this.preopenExpireTimer !== null) window.clearTimeout(this.preopenExpireTimer);
      this.preopenExpireTimer = window.setTimeout(() => {
        this.preopenExpireTimer = null;
        // If the browser never opened a viewer, do not continue loading five
        // future photos just because someone clicked a media link.
        if (!this.viewer?.isConnected) {
          this.prefetchQueue = [];
          this.prefetchWanted.clear();
        }
      }, 2000);
    }

    private preloadAdjacentImages(preopen?: { index: number; current: MediaRef }): void {
      if ((!this.viewer?.isConnected && !preopen) || !this.originProfile || document.hidden ||
          (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
      if (connection?.saveData || /^(slow-2g|2g)$/.test(connection?.effectiveType ?? '')) return;
      const index = preopen?.index ?? this.activeIndex();
      const current = preopen?.current ?? mediaRefFromHref(window.location.pathname, this.originProfile);
      if (index === null || !current || this.refs[index]?.statusId !== current.statusId) return;
      this.prefetchTooLarge ??= new Set(); // Supports lightweight test controllers.
      const failureScope = preopen?.current.href ?? window.location.pathname;
      if (this.prefetchFailurePath !== failureScope) {
        // Retry transient CDN errors once the user actually navigates away.
        // Never spin on the same missing image while a modal stays open.
        this.prefetchFailed.clear();
        this.prefetchFailurePath = failureScope;
      }
      const targets: MediaRef[] = [];
      // 1. All already indexed later photos of this very post.
      for (let i = index + 1; i < this.refs.length && this.refs[i].statusId === current.statusId; i++) {
        if (this.refs[i].kind === 'photo') targets.push(this.refs[i]);
      }
      // 2. Several future POSTS, while preserving the observed media order.
      let cursor = index;
      for (let hops = 0; hops < 8 && targets.length < PREFETCH_MAX_IMAGES + 3; hops++) {
        const next = adjacentPostIndex(this.refs, this.refs[cursor].statusId, 1, cursor);
        if (next === null) break;
        cursor = next;
        if (this.refs[cursor].kind === 'photo') targets.push(this.refs[cursor]);
      }
      // 3. Backtracking after future media are queued.
      const back = this.refs[index - 1];
      if (back?.kind === 'photo' && back.statusId === current.statusId) targets.push(back);
      else {
        const previous = adjacentPostIndex(this.refs, current.statusId, -1, index);
        if (previous !== null && this.refs[previous].kind === 'photo') targets.push(this.refs[previous]);
      }
      const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      const max = connection?.effectiveType === '3g' || (memory !== undefined && memory <= 4)
        ? 2 : PREFETCH_MAX_IMAGES;
      const urls = targets.map((ref) => this.imageSources.get(ref.key)).filter((url): url is string => !!url);
      const unique = [...new Set(urls)].slice(0, max);
      this.prefetchWanted = new Set(unique);
      // Preserve decoded nearby images instead of dropping/re-downloading them
      // for every arrow press. The queue starts at most two transfers at once.
      for (const url of unique) {
        const cached = this.prefetched.get(url);
        if (cached) {
          this.prefetched.delete(url);
          this.prefetched.set(url, cached);
        }
      }
      this.prefetchQueue = unique.filter((url) => !this.prefetched.has(url) &&
        !this.prefetchFailed.has(url) && !this.prefetchTooLarge.has(url));
      // In-flight photos from a previous post may occupy both slots after
      // fast navigation. Free only obsolete requests, never a visible handoff.
      for (const [url, entry] of [...this.prefetched]) {
        if (entry.loading && !this.prefetchWanted.has(url) &&
            !this.handoff?.host.contains(entry.image)) entry.cancel?.();
      }
      this.drainPrefetchQueue(!!preopen);
    }

    private trimPrefetched(): void {
      let bytes = [...this.prefetched.values()].reduce((sum, value) => sum + value.bytes, 0);
      while (this.prefetched.size > PREFETCH_MAX_RECORDS || bytes > PREFETCH_MAX_DECODED_BYTES) {
        const candidates = [...this.prefetched].filter(([url, item]) =>
          !item.loading && (!this.handoff || !this.handoff.host.contains(item.image)));
        const victim = candidates.find(([url]) => !this.prefetchWanted.has(url)) ?? candidates[0];
        if (!victim) break; // Only in-flight or currently displayed images remain.
        this.prefetched.delete(victim[0]);
        bytes -= victim[1].bytes;
      }
    }

    private drainPrefetchQueue(allowMediaGrid = false): void {
      const activeModal = !!this.viewer?.isConnected;
      const openedFromGrid = allowMediaGrid &&
        mediaProfileFromPath(window.location.pathname) === this.originProfile;
      if (document.hidden || (!activeModal && !openedFromGrid) || this.navigationBusy) return;
      while (this.prefetchInFlight < PREFETCH_MAX_CONCURRENT && this.prefetchQueue.length) {
        const url = this.prefetchQueue.shift()!;
        if (!this.prefetchWanted.has(url) || this.prefetched.has(url) ||
            this.prefetchFailed.has(url) || this.prefetchTooLarge.has(url)) continue;
        const image = new Image();
        const record: PrefetchedPhoto = { image, ready: false, loading: true, bytes: 0 };
        const generation = this.navGeneration;
        let settled = false;
        let cancelled = false;
        let watchdog: number | null = null;
        const finish = (success: boolean): void => {
          if (watchdog !== null && typeof window.clearTimeout === 'function') {
            window.clearTimeout(watchdog);
            watchdog = null;
          }
          if (settled) return;
          settled = true;
          if (generation !== this.navGeneration) return;
          this.prefetchInFlight = Math.max(0, this.prefetchInFlight - 1);
          if (this.prefetched.get(url) === record) {
            record.loading = false;
            record.ready = success && image.naturalWidth > 0;
            if (!record.ready) {
              this.prefetched.delete(url);
              if (!cancelled) this.prefetchFailed.add(url);
              if (this.prefetchFailed.size > 64) this.prefetchFailed.delete(this.prefetchFailed.values().next().value!);
            } else {
              const estimate = (image.naturalWidth || 0) * (image.naturalHeight || 0) * 4;
              record.bytes = Number.isFinite(estimate) ? estimate : 0;
              if (record.bytes > PREFETCH_MAX_DECODED_BYTES) {
                // A single giant decoded photo cannot fit in the memory budget.
                // Do not evict it and then download it again on every scan.
                this.prefetched.delete(url);
                this.prefetchTooLarge.add(url);
                if (this.prefetchTooLarge.size > 64) {
                  this.prefetchTooLarge.delete(this.prefetchTooLarge.values().next().value!);
                }
              }
            }
          }
          this.trimPrefetched();
          // A pre-open click may launch the first two requests. Do not drain
          // the remaining queue until the actual gallery is visible.
          this.drainPrefetchQueue();
        };
        record.cancel = () => {
          if (settled) return;
          cancelled = true;
          image.onload = null;
          image.onerror = null;
          try {
            // Never reset to an empty URL, which could request the page itself.
            if (typeof image.removeAttribute === 'function') image.removeAttribute('src');
            else image.src = 'data:,';
          } catch { /* The record and slot must still be released. */ }
          finish(false);
        };
        if (typeof window.setTimeout === 'function' && typeof window.clearTimeout === 'function') {
          // Failed/never-resolving image loads must not block the next post.
          watchdog = window.setTimeout(() => {
            this.prefetchFailed.add(url);
            record.cancel?.();
          }, 12000);
        }
        image.decoding = 'async';
        image.fetchPriority = 'low';
        image.onerror = () => finish(false);
        image.onload = () => {
          if (typeof image.decode !== 'function') finish(true);
        };
        this.prefetched.set(url, record);
        this.prefetchInFlight++;
        image.src = url;
        if (typeof image.decode === 'function') {
          void image.decode().then(() => finish(true)).catch(() => finish(false));
        }
        this.trimPrefetched();
      }
    }

    /**
     * Visual-only handoff while X closes and reopens its SPA photo viewer.
     * X still owns the URL, history and modal; this only paints an already
     * decoded, low-priority CDN image for <= 1.8s. No extra network request.
     */
    private beginVisualHandoff(target: MediaRef): boolean {
      if (target.kind !== 'photo' || this.handoff || !this.originProfile || document.hidden) return false;
      if (typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
      const url = this.imageSources?.get(target.key);
      const record = url ? this.prefetched?.get(url) : undefined;
      const targetPhotoIdentity = url ? photoCdnIdentity(url) : null;
      if (!url || !targetPhotoIdentity || preloadImageUrl(url) !== url ||
          !record?.ready || record.image.naturalWidth < 1) return false;
      let host: HTMLDivElement | null = null;
      try {
        host = document.createElement('div');
        host.className = 'xmn-visual-handoff';
        host.setAttribute('aria-hidden', 'true');
        // X's right-hand conversation panel must never be blacked out.
        // If swipe-to-dismiss spans the entire modal, fall back to its photo.
        // Without trustworthy geometry, skip the optional overlay entirely.
        const viewportWidth = window.innerWidth;
        const maxRight = typeof viewportWidth === 'number' && viewportWidth >= 900
          ? viewportWidth - Math.min(250, viewportWidth * 0.2) : viewportWidth;
        const candidates = [
          this.viewer?.getBoundingClientRect?.(),
          this.viewer?.querySelector<HTMLImageElement>('img[src]')?.getBoundingClientRect?.(),
        ];
        const bounds = candidates.find((b) => b &&
          b.width > 100 && b.height > 100 &&
          Number.isFinite(b.left) && Number.isFinite(b.top) &&
          (typeof maxRight !== 'number' || b.right <= maxRight + 5));
        if (!bounds) return false;
        host.style.setProperty('inset', 'auto');
        host.style.setProperty('left', `${bounds.left}px`);
        host.style.setProperty('top', `${bounds.top}px`);
        host.style.setProperty('width', `${bounds.width}px`);
        host.style.setProperty('height', `${bounds.height}px`);
        record.image.classList.add('xmn-handoff-image');
        host.appendChild(record.image);
        document.body.appendChild(host);
        const timeout = window.setTimeout(() => this.clearVisualHandoff(), 1800);
        const handoff: VisualHandoff = {
          host,
          targetStatus: target.statusId,
          targetMediaIndex: target.mediaIndex,
          targetPhotoIdentity,
          timeout,
          generation: this.navGeneration,
          shown: false,
          revealTimer: null,
          sourceViewer: this.viewer,
          observer: null,
          waitingImage: null,
          waitingLoadHandler: null,
          decodingImage: null,
          decodingSrc: null,
          decodedImage: null,
          decodedSrc: null,
        };
        this.handoff = handoff;
        // Only for the short handoff window: detect the new SPA modal as
        // soon as it mounts rather than waiting for the 450ms route poll.
        if (typeof MutationObserver !== 'undefined') {
          const observer = new MutationObserver(() => {
            if (this.handoff !== handoff) return;
            const opened = document.querySelector<HTMLElement>(VIEWER_SELECTOR);
            if (opened && opened !== handoff.sourceViewer && this.originProfile &&
                profileStatusFromPath(window.location.pathname, this.originProfile)) {
              this.syncViewer(opened);
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
          handoff.observer = observer;
        }
        return true;
      } catch {
        // A failed MutationObserver setup can happen AFTER the overlay was
        // attached and this.handoff assigned. Dispose both together.
        if (host && this.handoff?.host === host) this.clearVisualHandoff();
        else host?.remove();
        return false; // Handoff is optional; never interrupt native SPA navigation.
      }
    }

    /** Attach at most one load listener, and detach it if the SPA swaps images. */
    private watchHandoffImageLoad(
      handoff: VisualHandoff, image: HTMLImageElement, viewer: HTMLElement,
    ): void {
      if (handoff.waitingImage === image && handoff.waitingLoadHandler) return;
      if (handoff.waitingImage && handoff.waitingLoadHandler) {
        handoff.waitingImage.removeEventListener('load', handoff.waitingLoadHandler);
      }
      const handler = (): void => {
        if (handoff.waitingImage === image && handoff.waitingLoadHandler === handler) {
          handoff.waitingImage = null;
          handoff.waitingLoadHandler = null;
        }
        if (this.handoff === handoff) this.finishVisualHandoff(viewer);
      };
      handoff.waitingImage = image;
      handoff.waitingLoadHandler = handler;
      image.addEventListener('load', handler, { once: true });
    }

    /** Reveal the decoded image only once the old native modal has closed. */
    private showVisualHandoff(): void {
      const handoff = this.handoff;
      if (handoff && handoff.generation === this.navGeneration && !handoff.shown) {
        handoff.shown = true;
        // The old modal can take most of the original 1.8s to close.
        // Start the visible handoff window only after that close finishes.
        window.clearTimeout(handoff.timeout);
        handoff.timeout = window.setTimeout(() => this.clearVisualHandoff(), 1800);
        handoff.host.classList.add('xmn-handoff-visible');
      }
    }

    private finishVisualHandoff(viewer: HTMLElement): void {
      const handoff = this.handoff;
      if (!handoff || handoff.revealTimer !== null || !viewer.isConnected ||
          handoff.generation !== this.navGeneration || !this.originProfile) return;
      const shown = mediaRefFromHref(window.location.pathname, this.originProfile);
      if (!shown || shown.statusId !== handoff.targetStatus ||
          (handoff.targetMediaIndex !== null && shown.mediaIndex !== null &&
           handoff.targetMediaIndex !== shown.mediaIndex)) return;
      // A mounted X viewer can first show avatars or another photo. Match
      // the actual CDN *media identity* before removing the decoded handoff.
      // The display may use name=orig while prefetch used name=large.
      const candidates = [...viewer.querySelectorAll<HTMLImageElement>('img[src], img[srcset]')];
      const actualImage = candidates.find((img) => {
        // A new src may be assigned while currentSrc still displays the OLD
        // image. Never accept that loading target as rendered and decoded.
        const displayed = img.currentSrc || '';
        return displayed
          ? photoCdnIdentity(displayed) === handoff.targetPhotoIdentity
          : photoCdnIdentity(img.src || '') === handoff.targetPhotoIdentity;
      });
      if (!actualImage) {
        // The target may already be assigned to the same <img> whose currentSrc
        // still points to the previous photo. Subscribe to its next load event.
        const pendingTarget = candidates.find((img) =>
          photoCdnIdentity(img.src || '') === handoff.targetPhotoIdentity);
        if (pendingTarget) this.watchHandoffImageLoad(handoff, pendingTarget, viewer);
        return;
      }
      if (!actualImage.complete || actualImage.naturalWidth < 1) {
        if (actualImage) this.watchHandoffImageLoad(handoff, actualImage, viewer);
        return;
      }
      // X can report a loaded image before its pixels are decoded. Wait
      // for the matching full-size image's decode(), never an avatar/old photo.
      // The 1.8s failsafe still removes the overlay on stalled decoding.
      const displayedSrc = actualImage.currentSrc || actualImage.src || '';
      if (typeof actualImage.decode === 'function' &&
          (handoff.decodedImage !== actualImage || handoff.decodedSrc !== displayedSrc)) {
        if (handoff.decodingImage === actualImage && handoff.decodingSrc === displayedSrc) return;
        handoff.decodingImage = actualImage;
        handoff.decodingSrc = displayedSrc;
        void actualImage.decode().catch(() => {
          // If decode() rejects for an already loaded image, avoid a permanent
          // visual stall; X will render it itself.
        }).then(() => {
          if (this.handoff !== handoff || handoff.decodingImage !== actualImage ||
              handoff.decodingSrc !== displayedSrc) return;
          handoff.decodingImage = null;
          handoff.decodingSrc = null;
          handoff.decodedImage = actualImage;
          handoff.decodedSrc = displayedSrc;
          this.finishVisualHandoff(viewer);
        });
        return;
      }
      if (typeof actualImage.decode !== 'function') {
        handoff.decodedImage = actualImage;
        handoff.decodedSrc = displayedSrc;
      }
      handoff.revealTimer = window.setTimeout(() => {
        if (this.handoff !== handoff) return;
        const stillVisible = handoff.decodedImage &&
          handoff.decodedImage.isConnected !== false &&
          viewer.isConnected && handoff.decodedImage.complete &&
          handoff.decodedImage.naturalWidth > 0 &&
          (handoff.decodedImage.currentSrc || handoff.decodedImage.src || '') === handoff.decodedSrc &&
          photoCdnIdentity(handoff.decodedSrc || '') === handoff.targetPhotoIdentity;
        if (stillVisible) {
          this.clearVisualHandoff();
        } else {
          // React can recycle the image again during this 90ms paint window.
          // Avoid exposing an unrelated image; the 1.8s failsafe still expires.
          handoff.revealTimer = null;
          handoff.decodedImage = null;
          handoff.decodedSrc = null;
          this.finishVisualHandoff(viewer);
        }
      }, 90);
    }

    private clearVisualHandoff(): void {
      const handoff = this.handoff;
      if (!handoff) return;
      this.handoff = null;
      window.clearTimeout(handoff.timeout);
      if (handoff.revealTimer !== null) window.clearTimeout(handoff.revealTimer);
      handoff.observer?.disconnect();
      if (handoff.waitingImage && handoff.waitingLoadHandler) {
        handoff.waitingImage.removeEventListener('load', handoff.waitingLoadHandler);
      }
      handoff.waitingImage = null;
      handoff.waitingLoadHandler = null;
      handoff.host.remove();
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
      // Keep the same 1.5s timeout but avoid a 125ms blank gap between
      // X closing its modal and the prefetched-photo handoff appearing.
      for (let i = 0; i < 30; i++) {
        if (!viewer.isConnected || !document.querySelector(VIEWER_SELECTOR)) return true;
        await pause(50);
      }
      return !viewer.isConnected;
    }

    /** Wait for a DIFFERENT post; new images of the current post are not enough. */
    private async loadNextPost(statusId: string, generation: number, fromIndex?: number): Promise<MediaRef | null> {
      for (let attempt = 0; attempt < 20; attempt++) {
        if (generation !== this.navGeneration) return null;
        this.scanTiles();
        const nextIndex = adjacentPostIndex(this.refs, statusId, 1, fromIndex);
        if (nextIndex !== null) return this.refs[nextIndex];
        // Prefer scrolling the final *visible media tile*. scrollIntoView also
        // reaches nested scroll containers, unlike window.scrollTo alone.
        if (attempt % 3 === 0) {
          const tiles = mediaColumn()?.querySelectorAll<HTMLElement>(TILE_SELECTOR);
          const last = tiles?.length ? tiles[tiles.length - 1] : null;
          if (last && typeof last.scrollIntoView === 'function') {
            last.scrollIntoView({ block: 'end', behavior: 'auto' });
          }
          // Some timelines listen for window scroll instead of item visibility.
          // Keep the original scroll fallback even when the nested scroll succeeds.
          window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        }
        await pause(200);
      }
      this.scanTiles();
      const nextIndex = adjacentPostIndex(this.refs, statusId, 1, fromIndex);
      return nextIndex === null ? null : this.refs[nextIndex];
    }

    /**
     * Try X's own media-tile SPA link before dismissing its dialog.
     * No URL/history writes, React hooks, GraphQL calls or new permissions.
     * A changed route is X-owned; never close/reopen it a second time.
     */
    private async tryNativeInModalNavigation(
      target: MediaRef, link: HTMLAnchorElement, viewer: HTMLElement, generation: number,
    ): Promise<'retained' | 'navigated' | 'fallback' | 'abort'> {
      const profile = this.originProfile;
      const sourcePath = window.location.pathname;
      const oldDialog = viewer.closest?.('[role="dialog"]');
      const href = link.getAttribute?.('href') ?? '';
      const linkRef = profile ? mediaRefFromHref(href, profile) : null;
      if (!profile || !link.isConnected || !viewer.isConnected || linkRef?.key !== target.key ||
          (link.target && link.target !== '_self') || link.hasAttribute?.('download')) return 'fallback';

      // Let X's delegated SPA listener handle the link, but cancel a browser
      // document navigation if it does not. X's root handler runs before
      // this temporary window-bubble fallback guard.
      const guard = (event: MouseEvent): void => {
        const node = event.target;
        if (node instanceof Node && (node === link || link.contains(node))) event.preventDefault();
      };
      window.addEventListener('click', guard);
      try {
        link.click();
      } finally {
        window.removeEventListener('click', guard);
      }

      // X normally writes the SPA URL immediately; a short bounded allowance
      // covers deferred router work without penalizing every failed attempt.
      for (let i = 0; i < 7; i++) {
        if (generation !== this.navGeneration || this.originProfile !== profile) return 'abort';
        const route = mediaRefFromHref(window.location.pathname, profile);
        if (route?.key === target.key) {
          const activeViewer = document.querySelector<HTMLElement>(VIEWER_SELECTOR);
          const dialogRetained = oldDialog && oldDialog.isConnected &&
            activeViewer?.closest?.('[role="dialog"]') === oldDialog;
          return (activeViewer === viewer && viewer.isConnected) || dialogRetained
            ? 'retained' : 'navigated';
        }
        if (window.location.pathname !== sourcePath || !viewer.isConnected || !link.isConnected) {
          // X already changed the route or dialog unexpectedly: no second click.
          return 'abort';
        }
        if (i < 6) await pause(50);
      }
      return 'fallback';
    }

    private async navigate(direction: Direction): Promise<void> {
      const currentIndex = this.activeIndex();
      const oldViewer = this.viewer;
      if (this.navigationBusy || currentIndex === null || !oldViewer || !this.originProfile) return;
      const currentRef = this.refs[currentIndex];
      const nextIndex = adjacentPostIndex(this.refs, currentRef.statusId, direction, currentIndex);
      if (direction === -1 && nextIndex === null) return;
      const generation = this.navGeneration;
      const profile = this.originProfile;
      const initialDestination = nextIndex === null ? null : this.findLiveLink(this.refs[nextIndex]);
      const startingGrid = nextIndex === null && this.originTimeline ? this.captureGrid() : null;

      // An old media-timeline entry may have been evicted from X's virtualized DOM.
      // Do not close the active viewer when the known destination is no longer clickable.
      if (nextIndex !== null && !initialDestination) {
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
      let destinationOpened = false;
      try {
        // First let X navigate directly between observed photo links. If its
        // modal survives, the right tweet/replies panel is never dismissed.
        if (nextIndex !== null && initialDestination &&
            currentRef.kind === 'photo' && this.refs[nextIndex].kind === 'photo' &&
            typeof this.tryNativeInModalNavigation === 'function') {
          const result = await this.tryNativeInModalNavigation(
            this.refs[nextIndex], initialDestination, oldViewer, generation);
          if (result === 'retained' || result === 'navigated') {
            destinationOpened = true;
            this.clearVisualHandoff();
            return;
          }
          if (result === 'abort') return;
        }
        if (generation !== this.navGeneration || !oldViewer.isConnected ||
            !profileStatusFromPath(window.location.pathname, profile)) return;
        // The direct route was ignored by X. Only now use the proven
        // close-and-reopen fallback and its decoded photo bridge.
        if (nextIndex !== null) this.beginVisualHandoff(this.refs[nextIndex]);
        closeButton.click();
        if (!await this.waitForViewerToClose(oldViewer)) {
          this.toast('ビューアを閉じられませんでした');
          return;
        }
        if (generation !== this.navGeneration || mediaProfileFromPath(window.location.pathname) !== profile) return;
        // SPA navigation may return to a different Photos/Videos filter than the
        // timeline that supplied these refs. Never open a ref from the wrong grid.
        const returnedTimeline = mediaTimelineKey(window.location.pathname, window.location.search);
        if (this.originTimeline && returnedTimeline !== this.originTimeline) {
          // Some X routes drop ?filter=photo on modal close. Accept that
          // normalization only when the EXACT same observed destination link
          // remains connected; an explicit switch to video is never accepted.
          const droppedFilter = returnedTimeline === `${profile}|default` &&
            this.originTimeline !== `${profile}|default`;
          const unchangedTarget = initialDestination && nextIndex !== null &&
            this.findLiveLink(this.refs[nextIndex]) === initialDestination &&
            initialDestination.isConnected;
          const retainedGrid = startingGrid !== null && startingGrid.firstTiles.length > 0 &&
            !this.hasGridTurnedOver(startingGrid);
          if (!droppedFilter || !(unchangedTarget || retainedGrid)) {
            this.toast('一覧の種類が切り替わったため、移動を中止しました');
            return;
          }
        }
        let destination = nextIndex === null ? null : this.refs[nextIndex];
        // At the end, only click an observed, different post. Never guess a URL.
        if (!destination && direction === 1) {
          destination = await this.loadNextPost(currentRef.statusId, generation, currentIndex);
        }
        if (generation !== this.navGeneration) return;
        const link = destination && destination.statusId !== currentRef.statusId ? this.findLiveLink(destination) : null;
        if (link) {
          // The old X viewer is now closed. Keep its own photo visible
          // until this point; showing the next image early caused a flash.
          this.showVisualHandoff?.();
          link.click();
          destinationOpened = true;
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
        if (!destinationOpened) this.clearVisualHandoff();
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
