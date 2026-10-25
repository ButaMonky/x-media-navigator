"use strict";
/**
 * X Media Navigator: deterministic helpers. This namespace has no browser-side effects.
 * It is compiled together with content.ts into a single MV3 content script.
 */
var XMN;
(function (XMN) {
    const HANDLE_RE = /^[a-zA-Z0-9_]{1,15}$/;
    const MEDIA_ROUTE_RE = /^\/([^/?#]+)\/media\/?$/;
    const POST_ROUTE_RE = /^\/([^/?#]+)\/status\/(\d+)(?:\/(photo|video)\/(\d+))?\/?$/;
    const HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);
    function mediaProfileFromPath(pathname) {
        const match = MEDIA_ROUTE_RE.exec(pathname);
        if (!match || !HANDLE_RE.test(match[1]))
            return null;
        return match[1].toLowerCase();
    }
    XMN.mediaProfileFromPath = mediaProfileFromPath;
    function profileStatusFromPath(pathname, profile) {
        const match = POST_ROUTE_RE.exec(pathname);
        return !!match && match[1].toLowerCase() === profile.toLowerCase();
    }
    XMN.profileStatusFromPath = profileStatusFromPath;
    /**
     * Resolve only links belonging to the active profile. Strip query/fragment to make
     * the key stable across tracking parameters; include photo/video position.
     */
    function mediaRefFromHref(href, profile) {
        if (!HANDLE_RE.test(profile))
            return null;
        let url;
        try {
            url = new URL(href, 'https://x.com');
        }
        catch {
            return null;
        }
        if (!HOSTS.has(url.hostname.toLowerCase()) || !['https:', 'http:'].includes(url.protocol))
            return null;
        const match = POST_ROUTE_RE.exec(url.pathname);
        if (!match || match[1].toLowerCase() !== profile.toLowerCase())
            return null;
        const kind = match[3] ?? null;
        const mediaIndex = match[4] === undefined ? null : Number(match[4]);
        if (mediaIndex !== null && (!Number.isSafeInteger(mediaIndex) || mediaIndex < 1 || mediaIndex > 100))
            return null;
        const key = `${match[2]}:${kind ?? 'post'}:${mediaIndex ?? 0}`;
        return { key, statusId: match[2], profile: profile.toLowerCase(), kind, mediaIndex, href: url.pathname };
    }
    XMN.mediaRefFromHref = mediaRefFromHref;
    function adjacentIndex(index, size, direction) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= size)
            return null;
        const next = index + direction;
        return next < 0 || next >= size ? null : next;
    }
    XMN.adjacentIndex = adjacentIndex;
    function findCurrentIndex(items, pathname, profile) {
        const current = mediaRefFromHref(pathname, profile);
        if (!current)
            return null;
        const exact = items.findIndex((item) => item.key === current.key);
        if (exact >= 0)
            return exact;
        // URLs without /photo/N can only be resolved safely when the status has one item.
        const sameStatus = items.map((item, i) => ({ item, i })).filter(({ item }) => item.statusId === current.statusId);
        if (sameStatus.length === 1)
            return sameStatus[0].i;
        return null;
    }
    XMN.findCurrentIndex = findCurrentIndex;
    /** Bare ArrowLeft / ArrowRight always belong to X's native image/video UI. */
    function postShortcutDirection(event) {
        if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.isComposing)
            return null;
        if (event.key === 'ArrowRight')
            return 1;
        if (event.key === 'ArrowLeft')
            return -1;
        return null;
    }
    XMN.postShortcutDirection = postShortcutDirection;
})(XMN || (XMN = {}));
/// <reference path="./core.ts" />
/**
 * MV3 content-script controller. No page-world monkeypatches or network requests.
 * Bare arrow keys intentionally remain under X's control.
 */
var XMN;
(function (XMN) {
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
    function pause(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }
    function mediaColumn() {
        return document.querySelector('main [data-testid="primaryColumn"]') ?? document.querySelector('main');
    }
    function isEditingTarget(target) {
        if (!(target instanceof Element))
            return false;
        return !!target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="slider"], video');
    }
    function usableTileLink(tile, profile) {
        const links = Array.from(tile.querySelectorAll('a[href]'));
        // An explicit photo/video position is less ambiguous than a generic status link.
        const possibilities = links.map((link) => ({ link, ref: XMN.mediaRefFromHref(link.getAttribute('href') ?? '', profile) }))
            .filter((candidate) => candidate.ref !== null);
        const specific = possibilities.find(({ ref }) => ref.kind !== null);
        if (specific)
            return specific;
        // X sometimes uses a plain status URL in an image/video tile.
        const generic = possibilities[0];
        if (generic && tile.querySelector('img, video'))
            return generic;
        return null;
    }
    /** Maintain a stable ordered list of media refs, never cached DOM nodes. */
    class Controller {
        constructor() {
            this.originProfile = null;
            this.refs = [];
            this.indexes = new Map();
            this.viewer = null;
            this.viewObserver = null;
            this.listObserver = null;
            this.observedColumn = null;
            this.lastPath = '';
            this.scanTimer = null;
            this.navigationBusy = false;
            this.navGeneration = 0;
            // Observe actual user keyboard input only when the viewer belongs to a media-tab session.
            document.addEventListener('keydown', (event) => this.onKeyDown(event), true);
            this.refreshId = window.setInterval(() => this.tick(), 450);
            this.tick();
        }
        resetSession() {
            this.navGeneration++;
            this.navigationBusy = false;
            this.refs = [];
            this.indexes.clear();
            this.removeViewerUI();
            this.stopListObserver();
            document.querySelectorAll('.xmn-tile-badge').forEach((element) => element.remove());
            document.querySelectorAll('.xmn-numbered-tile').forEach((element) => element.classList.remove('xmn-numbered-tile'));
        }
        stopListObserver() {
            this.listObserver?.disconnect();
            this.listObserver = null;
            this.observedColumn = null;
            if (this.scanTimer !== null)
                window.clearTimeout(this.scanTimer);
            this.scanTimer = null;
        }
        tick() {
            const path = window.location.pathname;
            const atMedia = XMN.mediaProfileFromPath(path);
            if (atMedia) {
                if (this.originProfile !== atMedia) {
                    this.resetSession();
                    this.originProfile = atMedia;
                }
                this.ensureListObserver();
                this.scanTiles();
            }
            else if (!this.originProfile || !XMN.profileStatusFromPath(path, this.originProfile)) {
                if (this.originProfile !== null) {
                    this.resetSession();
                    this.originProfile = null;
                }
            }
            else {
                // The timeline is a retained DOM tree beneath the modal. Do NOT index the
                // status-page recommendations as though they were the originating media tab.
                this.stopListObserver();
            }
            if (path !== this.lastPath)
                this.lastPath = path;
            const viewer = this.originProfile && XMN.profileStatusFromPath(path, this.originProfile)
                ? document.querySelector(VIEWER_SELECTOR) : null;
            if (viewer && this.originProfile) {
                this.syncViewer(viewer);
            }
            else {
                this.removeViewerUI();
            }
        }
        ensureListObserver() {
            const column = mediaColumn();
            if (!column || column === this.observedColumn)
                return;
            this.stopListObserver();
            this.observedColumn = column;
            this.listObserver = new MutationObserver(() => {
                if (this.scanTimer !== null)
                    return;
                this.scanTimer = window.setTimeout(() => {
                    this.scanTimer = null;
                    if (XMN.mediaProfileFromPath(window.location.pathname) === this.originProfile)
                        this.scanTiles();
                }, 100);
            });
            this.listObserver.observe(column, { childList: true, subtree: true });
        }
        scanTiles() {
            if (!this.originProfile || XMN.mediaProfileFromPath(window.location.pathname) !== this.originProfile)
                return;
            const root = mediaColumn();
            if (!root)
                return;
            for (const tile of Array.from(root.querySelectorAll(TILE_SELECTOR))) {
                const found = usableTileLink(tile, this.originProfile);
                if (!found)
                    continue;
                const { ref } = found;
                let index = this.indexes.get(ref.key);
                if (index === undefined) {
                    index = this.refs.length;
                    this.indexes.set(ref.key, index);
                    this.refs.push(ref);
                }
                else {
                    // Refresh references by value. Old DOM nodes are never persisted.
                    this.refs[index] = ref;
                }
                let badge = tile.querySelector(':scope > .xmn-tile-badge');
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'xmn-tile-badge';
                    badge.setAttribute('aria-hidden', 'true');
                    tile.classList.add('xmn-numbered-tile');
                    tile.appendChild(badge);
                }
                const label = String(index + 1);
                if (badge.textContent !== label)
                    badge.textContent = label;
            }
        }
        removeViewerUI() {
            this.viewObserver?.disconnect();
            this.viewObserver = null;
            if (this.viewer) {
                this.viewer.querySelectorAll('.xmn-nav-button, .xmn-status').forEach((element) => element.remove());
                this.viewer = null;
            }
        }
        syncViewer(viewer) {
            if (viewer !== this.viewer) {
                this.removeViewerUI();
                this.viewer = viewer;
                this.viewObserver = new MutationObserver(() => {
                    // X may replace viewer children during /photo/N transitions.
                    if (this.viewer?.isConnected)
                        this.ensureViewerButtons();
                });
                this.viewObserver.observe(viewer, { childList: true, subtree: true });
            }
            this.ensureViewerButtons();
        }
        ensureViewerButtons() {
            const viewer = this.viewer;
            if (!viewer || !viewer.isConnected)
                return;
            for (const [direction, className, text, label] of [
                [-1, 'xmn-prev', '◀', '前のメディア一覧項目へ (Shift+←)'],
                [1, 'xmn-next', '▶', '次のメディア一覧項目へ (Shift+→)'],
            ]) {
                let button = viewer.querySelector(`.${className}`);
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
            let status = viewer.querySelector('.xmn-status');
            if (!status) {
                status = document.createElement('div');
                status.className = 'xmn-status';
                status.setAttribute('aria-live', 'polite');
                viewer.appendChild(status);
            }
            this.updateViewerState();
        }
        activeIndex() {
            return this.originProfile ? XMN.findCurrentIndex(this.refs, window.location.pathname, this.originProfile) : null;
        }
        updateViewerState() {
            const viewer = this.viewer;
            if (!viewer)
                return;
            const current = this.activeIndex();
            const prev = viewer.querySelector('.xmn-prev');
            const next = viewer.querySelector('.xmn-next');
            if (prev)
                prev.disabled = this.navigationBusy || current === null || current === 0;
            // At the last known tile a click may attempt to load additional items.
            if (next)
                next.disabled = this.navigationBusy || current === null;
            const indicator = viewer.querySelector('.xmn-status');
            if (indicator) {
                const label = current === null ? '一覧位置を確認中' : `${current + 1} / ${this.refs.length}`;
                if (indicator.textContent !== label)
                    indicator.textContent = label;
            }
        }
        onKeyDown(event) {
            const direction = XMN.postShortcutDirection(event);
            if (direction === null || !this.viewer?.isConnected || !this.originProfile ||
                isEditingTarget(event.target) || this.navigationBusy)
                return;
            if (this.activeIndex() === null)
                return;
            event.preventDefault();
            event.stopImmediatePropagation();
            void this.navigate(direction);
        }
        findCloseButton(viewer) {
            const dialog = viewer.closest('[role="dialog"]');
            const local = dialog?.querySelector(CLOSE_SELECTOR);
            if (local)
                return local;
            // Do not click an unrelated button if the global query is ambiguous.
            const matches = document.querySelectorAll(CLOSE_SELECTOR);
            return matches.length === 1 ? matches[0] : null;
        }
        findLiveLink(ref) {
            if (!this.originProfile)
                return null;
            const column = mediaColumn();
            if (!column)
                return null;
            for (const tile of column.querySelectorAll(TILE_SELECTOR)) {
                const found = usableTileLink(tile, this.originProfile);
                if (found?.ref.key === ref.key && found.link.isConnected)
                    return found.link;
            }
            return null;
        }
        toast(message) {
            let element = document.querySelector('.xmn-toast');
            if (!element) {
                element = document.createElement('div');
                element.className = 'xmn-toast';
                element.setAttribute('role', 'status');
                document.body.appendChild(element);
            }
            element.textContent = message;
            window.setTimeout(() => {
                if (element?.textContent === message)
                    element.remove();
            }, 2800);
        }
        async waitForViewerToClose(viewer) {
            for (let i = 0; i < 12; i++) {
                if (!viewer.isConnected || !document.querySelector(VIEWER_SELECTOR))
                    return true;
                await pause(125);
            }
            return !viewer.isConnected;
        }
        /** Only called after closing viewer; load by observing new entries, never by a fixed 300ms guess. */
        async loadNext(targetIndex, generation) {
            for (let attempt = 0; attempt < 20; attempt++) {
                if (generation !== this.navGeneration)
                    return null;
                this.scanTiles();
                if (this.refs[targetIndex])
                    return this.refs[targetIndex];
                // The content column may be virtualized or the page may already be at its end.
                if (attempt % 3 === 0)
                    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
                await pause(200);
            }
            this.scanTiles();
            return this.refs[targetIndex] ?? null;
        }
        async navigate(direction) {
            const currentIndex = this.activeIndex();
            const oldViewer = this.viewer;
            if (this.navigationBusy || currentIndex === null || !oldViewer || !this.originProfile)
                return;
            const nextIndex = currentIndex + direction;
            if (nextIndex < 0)
                return;
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
                if (generation !== this.navGeneration || XMN.mediaProfileFromPath(window.location.pathname) !== profile)
                    return;
                const destination = this.refs[nextIndex] ?? (direction === 1 ? await this.loadNext(nextIndex, generation) : null);
                if (generation !== this.navGeneration)
                    return;
                const link = destination ? this.findLiveLink(destination) : null;
                if (link) {
                    link.click();
                }
                else {
                    // Don't navigate to a guessed URL or re-open an unrelated status.
                    this.toast('次の項目を見つけられませんでした。一覧で続きを読み込んでください');
                    // Restore current viewer when its source is still present.
                    this.findLiveLink(currentRef)?.click();
                }
            }
            catch (error) {
                console.warn('X Media Navigator navigation cancelled:', error);
                this.toast('メディアの切り替えに失敗しました');
            }
            finally {
                this.navigationBusy = false;
                this.updateViewerState();
            }
        }
    }
    XMN.Controller = Controller;
})(XMN || (XMN = {}));
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => new XMN.Controller(), { once: true });
}
else {
    new XMN.Controller();
}
