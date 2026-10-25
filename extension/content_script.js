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
    /** A bare arrow may cross posts ONLY at a verified photo boundary. */
    function postShortcutDirection(event) {
        if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.repeat || event.isComposing)
            return null;
        if (event.key === 'ArrowRight')
            return 1;
        if (event.key === 'ArrowLeft')
            return -1;
        return null;
    }
    XMN.postShortcutDirection = postShortcutDirection;
    function galleryBoundaryDirection(event, current, photoCount, nativeNextAvailable = false, nativePreviousAvailable = false) {
        const direction = postShortcutDirection(event);
        if (!direction || current?.kind !== 'photo' || current.mediaIndex === null)
            return null;
        if (direction === -1)
            return current.mediaIndex === 1 && !nativePreviousAvailable ? -1 : null;
        if (nativeNextAvailable)
            return null;
        return photoCount !== null && photoCount >= 1 && current.mediaIndex === photoCount ? 1 : null;
    }
    XMN.galleryBoundaryDirection = galleryBoundaryDirection;
    /** Move across STATUS groups, not between media items belonging to the same post. */
    function adjacentPostIndex(items, currentStatusId, direction) {
        const positions = items.map((item, index) => ({ item, index }))
            .filter(({ item }) => item.statusId === currentStatusId);
        if (positions.length === 0)
            return null;
        const start = direction === 1 ? positions[positions.length - 1].index : positions[0].index;
        for (let i = start + direction; i >= 0 && i < items.length; i += direction) {
            if (items[i].statusId !== currentStatusId) {
                // For backtracking enter the previous post from its last recorded photo.
                return i;
            }
        }
        return null;
    }
    XMN.adjacentPostIndex = adjacentPostIndex;
    /** Only rewrite genuine X image CDN thumbnails. No arbitrary URL/network access. */
    function preloadImageUrl(src) {
        let url;
        try {
            url = new URL(src);
        }
        catch {
            return null;
        }
        if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' ||
            !/^\/media\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
            !/^(jpg|jpeg|png|webp)$/i.test(url.searchParams.get('format') ?? '') ||
            !url.searchParams.has('name'))
            return null;
        url.searchParams.set('name', 'large');
        url.hash = '';
        return url.toString();
    }
    XMN.preloadImageUrl = preloadImageUrl;
})(XMN || (XMN = {}));
/// <reference path="./core.ts" />
/**
 * MV3 content-script controller. No page-world monkeypatches or network requests.
 * Bare arrow keys stay under X's control until a CONFIRMED gallery boundary.
 * Only then is a post-to-post navigation attempted.
 */
var XMN;
(function (XMN) {
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
            this.imageSources = new Map();
            this.prefetched = new Map();
            this.preloadTimer = null;
            this.preloadForPath = '';
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
            this.imageSources.clear();
            this.prefetched.clear();
            this.preloadForPath = '';
            if (this.preloadTimer !== null)
                window.clearTimeout(this.preloadTimer);
            this.preloadTimer = null;
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
                // Capture only CDN image locations from the already-rendered media tiles.
                const thumbnail = tile.querySelector('img[src]');
                const imageUrl = thumbnail ? XMN.preloadImageUrl(thumbnail.currentSrc || thumbnail.src || '') : null;
                if (imageUrl)
                    this.imageSources.set(ref.key, imageUrl);
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
                [-1, 'xmn-prev', '◀', '前の投稿へ（最初の画像では←でも移動）'],
                [1, 'xmn-next', '▶', '次の投稿へ（最後の画像では→でも移動）'],
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
            this.schedulePreload();
        }
        activeIndex() {
            if (!this.originProfile)
                return null;
            const exact = XMN.findCurrentIndex(this.refs, window.location.pathname, this.originProfile);
            if (exact !== null)
                return exact;
            // A media tab may offer only one link for a post with several photos.
            const current = XMN.mediaRefFromHref(window.location.pathname, this.originProfile);
            const matches = current ? this.refs.map((ref, i) => ({ ref, i }))
                .filter(({ ref }) => ref.statusId === current.statusId) : [];
            return matches.length ? matches[0].i : null;
        }
        updateViewerState() {
            const viewer = this.viewer;
            if (!viewer)
                return;
            const current = this.activeIndex();
            const prev = viewer.querySelector('.xmn-prev');
            const next = viewer.querySelector('.xmn-next');
            const currentRef = current !== null ? this.refs[current] : null;
            if (prev)
                prev.disabled = this.navigationBusy || !currentRef || XMN.adjacentPostIndex(this.refs, currentRef.statusId, -1) === null;
            // At the last known post clicking the next button may load more media.
            if (next)
                next.disabled = this.navigationBusy || !currentRef;
            const indicator = viewer.querySelector('.xmn-status');
            if (indicator) {
                const statuses = Array.from(new Set(this.refs.map((ref) => ref.statusId)));
                const index = currentRef ? statuses.indexOf(currentRef.statusId) : -1;
                const label = index < 0 ? '投稿の位置を確認中' : `投稿 ${index + 1} / ${statuses.length}`;
                if (indicator.textContent !== label)
                    indicator.textContent = label;
            }
        }
        /**
         * A positive gallery-size hint from the original post's media thumbnails.
         * Do not count media from unrelated replies or quoted posts.
         * If X changes its DOM or count is uncertain, do not take over ArrowRight.
         */
        photoCount(viewer, statusId) {
            const root = viewer.closest('[role="dialog"]') ?? viewer.parentElement;
            if (!root || !this.originProfile)
                return null;
            for (const article of root.querySelectorAll('article[data-testid="tweet"]')) {
                const photos = Array.from(article.querySelectorAll('[data-testid="tweetPhoto"] a[href], a[href*="/photo/"]'));
                const indexes = new Set();
                for (const link of photos) {
                    const ref = XMN.mediaRefFromHref(link.getAttribute('href') ?? '', this.originProfile);
                    if (ref?.kind === 'photo' && ref.statusId === statusId && ref.mediaIndex !== null)
                        indexes.add(ref.mediaIndex);
                }
                const max = Math.max(0, ...indexes);
                if (max > 0 && indexes.size === max)
                    return max;
            }
            // A full run of contiguous media-tab tiles is a useful fallback, but
            // only if the next registered tile is a DIFFERENT post.
            const group = this.refs.filter((ref) => ref.statusId === statusId && ref.kind === 'photo');
            const indexes = new Set(group.map((ref) => ref.mediaIndex).filter((i) => i !== null));
            const max = Math.max(0, ...indexes);
            let groupEnd = -1;
            for (let i = this.refs.length - 1; i >= 0; i--) {
                if (this.refs[i].statusId === statusId) {
                    groupEnd = i;
                    break;
                }
            }
            if (max > 0 && indexes.size === max && groupEnd >= 0 &&
                groupEnd < this.refs.length - 1 && this.refs[groupEnd + 1].statusId !== statusId)
                return max;
            return null;
        }
        nativeGalleryArrowAvailable(viewer, direction) {
            const root = viewer.closest('[role="dialog"]') ?? viewer;
            const pattern = direction === 1 ? NATIVE_NEXT : NATIVE_PREVIOUS;
            for (const button of root.querySelectorAll('[aria-label], [title]')) {
                if (button.closest('.xmn-nav-button'))
                    continue;
                const label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').trim();
                if (pattern.test(label) && button.getAttribute('aria-disabled') !== 'true' &&
                    !(button instanceof HTMLButtonElement && button.disabled))
                    return true;
            }
            return false;
        }
        onKeyDown(event) {
            if (!this.viewer?.isConnected || !this.originProfile ||
                isEditingTarget(event.target) || this.navigationBusy ||
                this.activeIndex() === null)
                return;
            const current = XMN.mediaRefFromHref(window.location.pathname, this.originProfile);
            const direction = XMN.galleryBoundaryDirection(event, current, current ? this.photoCount(this.viewer, current.statusId) : null, this.nativeGalleryArrowAvailable(this.viewer, 1), this.nativeGalleryArrowAvailable(this.viewer, -1));
            if (direction === null)
                return; // Preserve the native X photo/video operation.
            if (direction === -1 && current && XMN.adjacentPostIndex(this.refs, current.statusId, -1) === null)
                return;
            event.preventDefault();
            event.stopImmediatePropagation();
            void this.navigate(direction);
        }
        schedulePreload() {
            if (!this.originProfile || !this.viewer || document.hidden)
                return;
            if (window.location.pathname === this.preloadForPath)
                return;
            this.preloadForPath = window.location.pathname;
            if (this.preloadTimer !== null)
                window.clearTimeout(this.preloadTimer);
            this.preloadTimer = window.setTimeout(() => {
                this.preloadTimer = null;
                this.preloadAdjacentImages();
            }, 350);
        }
        preloadAdjacentImages() {
            if (!this.viewer?.isConnected || !this.originProfile || document.hidden ||
                (typeof navigator !== 'undefined' && navigator.onLine === false))
                return;
            const connection = navigator.connection;
            if (connection?.saveData || /^(slow-2g|2g)$/.test(connection?.effectiveType ?? ''))
                return;
            const index = this.activeIndex();
            const current = XMN.mediaRefFromHref(window.location.pathname, this.originProfile);
            if (index === null || !current)
                return;
            const targets = [];
            // Native next/previous photos are preheated first; otherwise adjacent posts.
            for (const direction of [1, -1]) {
                const neighbor = this.refs[index + direction];
                const post = XMN.adjacentPostIndex(this.refs, current.statusId, direction);
                const photoCandidate = neighbor?.statusId === current.statusId &&
                    neighbor.kind === 'photo' && neighbor.mediaIndex !== null && current.mediaIndex !== null &&
                    (neighbor.mediaIndex - current.mediaIndex) * direction > 0 ? neighbor : null;
                const candidate = photoCandidate ?? (post !== null ? this.refs[post] : null);
                if (candidate)
                    targets.push(candidate);
            }
            const urls = targets.map((ref) => this.imageSources.get(ref.key)).filter((url) => !!url);
            const unique = [...new Set(urls)].slice(0, 2);
            for (const [url] of this.prefetched) {
                if (!unique.includes(url))
                    this.prefetched.delete(url);
            }
            for (const url of unique) {
                if (this.prefetched.has(url))
                    continue;
                const image = new Image();
                image.decoding = 'async';
                image.fetchPriority = 'low';
                image.src = url;
                this.prefetched.set(url, image);
            }
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
        /** Wait for a DIFFERENT post; new images of the current post are not enough. */
        async loadNextPost(statusId, generation) {
            for (let attempt = 0; attempt < 20; attempt++) {
                if (generation !== this.navGeneration)
                    return null;
                this.scanTiles();
                const nextIndex = XMN.adjacentPostIndex(this.refs, statusId, 1);
                if (nextIndex !== null)
                    return this.refs[nextIndex];
                // X owns infinite scrolling. Only scroll the already-open media timeline.
                if (attempt % 3 === 0)
                    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
                await pause(200);
            }
            this.scanTiles();
            const nextIndex = XMN.adjacentPostIndex(this.refs, statusId, 1);
            return nextIndex === null ? null : this.refs[nextIndex];
        }
        async navigate(direction) {
            const currentIndex = this.activeIndex();
            const oldViewer = this.viewer;
            if (this.navigationBusy || currentIndex === null || !oldViewer || !this.originProfile)
                return;
            const currentRef = this.refs[currentIndex];
            const nextIndex = XMN.adjacentPostIndex(this.refs, currentRef.statusId, direction);
            if (direction === -1 && nextIndex === null)
                return;
            const generation = this.navGeneration;
            const profile = this.originProfile;
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
                let destination = nextIndex === null ? null : this.refs[nextIndex];
                // At the end, only click an observed, different post. Never guess a URL.
                if (!destination && direction === 1) {
                    destination = await this.loadNextPost(currentRef.statusId, generation);
                }
                if (generation !== this.navGeneration)
                    return;
                const link = destination && destination.statusId !== currentRef.statusId ? this.findLiveLink(destination) : null;
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
