/// <reference path="./core.ts" />

/**
 * MV3 content-script controller. No page-world monkeypatches or network requests.
 * Bare arrow keys intentionally remain under X's control.
 */
namespace XMN {
  const VIEWER_SELECTOR = '[data-testid="swipe-to-dismiss"]';
  const TILE_SELECTOR = 'li[role="listitem"]';
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
    private refs: MediaRef[] = [];
    private indexes = new Map<string, number>();
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
      this.refs = [];
      this.indexes.clear();
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
      if (atMedia) {
        if (this.originProfile !== atMedia) {
          this.resetSession();
          this.originProfile = atMedia;
        }
        this.ensureListObserver();
        this.scanTiles();
      } else if (!this.originProfile || !profileStatusFromPath(path, this.originProfile)) {
        if (this.originProfile !== null) {
          this.resetSession();
          this.originProfile = null;
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

    private ensureListObserver(): void {
      const column = mediaColumn();
      if (!column || column === this.observedColumn) return;
      this.stopListObserver();
      this.observedColumn = column;
      this.listObserver = new MutationObserver(() => {
        if (this.scanTimer !== null) return;
        this.scanTimer = window.setTimeout(() => {
          this.scanTimer = null;
          if (mediaProfileFromPath(window.location.pathname) === this.originProfile) this.scanTiles();
        }, 100);
      });
      this.listObserver.observe(column, { childList: true, subtree: true });
    }

    private scanTiles(): void {
      if (!this.originProfile || mediaProfileFromPath(window.location.pathname) !== this.originProfile) return;
      const root = mediaColumn();
      if (!root) return;
      for (const tile of Array.from(root.querySelectorAll<HTMLElement>(TILE_SELECTOR))) {
        const found = usableTileLink(tile, this.originProfile);
        if (!found) continue;
        const { ref } = found;
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
        [-1, 'xmn-prev', '◀', '前のメディア一覧項目へ (Shift+←)'],
        [1, 'xmn-next', '▶', '次のメディア一覧項目へ (Shift+→)'],
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
    }

    private activeIndex(): number | null {
      return this.originProfile ? findCurrentIndex(this.refs, window.location.pathname, this.originProfile) : null;
    }

    private updateViewerState(): void {
      const viewer = this.viewer;
      if (!viewer) return;
      const current = this.activeIndex();
      const prev = viewer.querySelector<HTMLButtonElement>('.xmn-prev');
      const next = viewer.querySelector<HTMLButtonElement>('.xmn-next');
      if (prev) prev.disabled = this.navigationBusy || current === null || current === 0;
      // At the last known tile a click may attempt to load additional items.
      if (next) next.disabled = this.navigationBusy || current === null;
      const indicator = viewer.querySelector<HTMLElement>('.xmn-status');
      if (indicator) {
        const label = current === null ? '一覧位置を確認中' : `${current + 1} / ${this.refs.length}`;
        if (indicator.textContent !== label) indicator.textContent = label;
      }
    }

    private onKeyDown(event: KeyboardEvent): void {
      const direction = postShortcutDirection(event);
      if (direction === null || !this.viewer?.isConnected || !this.originProfile ||
          isEditingTarget(event.target) || this.navigationBusy) return;
      if (this.activeIndex() === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void this.navigate(direction);
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

    /** Only called after closing viewer; load by observing new entries, never by a fixed 300ms guess. */
    private async loadNext(targetIndex: number, generation: number): Promise<MediaRef | null> {
      for (let attempt = 0; attempt < 20; attempt++) {
        if (generation !== this.navGeneration) return null;
        this.scanTiles();
        if (this.refs[targetIndex]) return this.refs[targetIndex];
        // The content column may be virtualized or the page may already be at its end.
        if (attempt % 3 === 0) window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
        await pause(200);
      }
      this.scanTiles();
      return this.refs[targetIndex] ?? null;
    }

    private async navigate(direction: Direction): Promise<void> {
      const currentIndex = this.activeIndex();
      const oldViewer = this.viewer;
      if (this.navigationBusy || currentIndex === null || !oldViewer || !this.originProfile) return;
      const nextIndex = currentIndex + direction;
      if (nextIndex < 0) return;
      const generation = this.navGeneration;
      const profile = this.originProfile;
      const currentRef = this.refs[currentIndex];
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
        const destination = this.refs[nextIndex] ?? (direction === 1 ? await this.loadNext(nextIndex, generation) : null);
        if (generation !== this.navGeneration) return;
        const link = destination ? this.findLiveLink(destination) : null;
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
