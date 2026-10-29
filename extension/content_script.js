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
    /**
     * Media tab URL may keep the same pathname when the Photos/Videos dropdown changes.
     * An absent filter is NOT assumed to mean video: record it independently.
     * Unrelated query params are deliberately ignored.
     */
    function mediaTimelineKey(pathname, search) {
        const profile = mediaProfileFromPath(pathname);
        if (!profile)
            return null;
        const filters = new URLSearchParams(search).getAll('filter').map((value) => value.trim().toLowerCase());
        const mode = filters.length === 0 ? 'default'
            : filters.length === 1 ? (filters[0] || 'empty') : `multi:${filters.join(',')}`;
        return `${profile}|${encodeURIComponent(mode)}`;
    }
    XMN.mediaTimelineKey = mediaTimelineKey;
    /** Only a complete 4-photo set proves album completion without a gallery counter. */
    function completeFourPhotoSet(indexes) {
        return indexes.size === 4 && [1, 2, 3, 4].every((index) => indexes.has(index));
    }
    XMN.completeFourPhotoSet = completeFourPhotoSet;
    /** Parse only explicit media counters; Japanese "N枚中M枚目" lists total first. */
    function parseGalleryCounter(label) {
        const text = label.trim().normalize('NFKC');
        const japanese = /^(?:全\s*)?(\d+)\s*枚中\s*(\d+)\s*枚目$/.exec(text);
        const standard = /^(?:(?:image|photo|picture|画像|写真)\s*)?(\d+)\s*(?:\/|of)\s*(\d+)\s*(?:枚目|枚)?$/i.exec(text);
        if (!japanese && !standard)
            return null;
        const current = Number(japanese ? japanese[2] : standard[1]);
        const total = Number(japanese ? japanese[1] : standard[2]);
        return Number.isInteger(current) && Number.isInteger(total) && current >= 1 &&
            total >= current && total <= 4 ? { current, total } : null;
    }
    XMN.parseGalleryCounter = parseGalleryCounter;
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
        // One pass, no temporary O(N) map/filter arrays on large media feeds.
        // An exact photo key always wins; status-only fallback needs one owner.
        let onlyStatusIndex = null;
        let ambiguousStatus = false;
        for (let i = 0; i < items.length; i++) {
            const ref = items[i];
            if (ref.key === current.key)
                return i;
            if (ref.statusId !== current.statusId)
                continue;
            if (onlyStatusIndex === null)
                onlyStatusIndex = i;
            else
                ambiguousStatus = true;
        }
        return ambiguousStatus ? null : onlyStatusIndex;
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
        // /photo/1 is the first photo by definition. Generic X Previous buttons
        // may navigate between POSTS, not photos, so never require an extra press.
        if (direction === -1)
            return current.mediaIndex === 1 ? -1 : null;
        if (nativeNextAvailable)
            return null;
        return photoCount !== null && photoCount >= 1 && current.mediaIndex === photoCount ? 1 : null;
    }
    XMN.galleryBoundaryDirection = galleryBoundaryDirection;
    /**
     * Move across the CONTIGUOUS status group at the active position, not the last
     * occurrence of that ID anywhere in the timeline. A repeated status can appear
     * again after another post; skipping every occurrence would skip entire posts.
     */
    function adjacentPostIndex(items, currentStatusId, direction, activePosition) {
        const anchored = activePosition !== undefined && Number.isSafeInteger(activePosition) &&
            activePosition >= 0 && activePosition < items.length &&
            items[activePosition].statusId === currentStatusId;
        let start = anchored ? activePosition : -1;
        if (!anchored) {
            for (let i = 0; i < items.length; i++) {
                if (items[i].statusId !== currentStatusId)
                    continue;
                start = i;
                if (direction === 1)
                    break;
            }
        }
        if (start < 0)
            return null;
        for (let i = start + direction; i >= 0 && i < items.length; i += direction) {
            if (items[i].statusId !== currentStatusId)
                return i;
        }
        return null;
    }
    XMN.adjacentPostIndex = adjacentPostIndex;
    /**
     * Stable X photo identity across small/large/orig variants of the same CDN
     * image. This does NOT download a URL or authorize an arbitrary image origin.
     * It is used only to decide when the X viewer has rendered our target.
     */
    function photoCdnIdentity(src) {
        let url;
        try {
            url = new URL(src);
        }
        catch {
            return null;
        }
        if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' ||
            url.username !== '' || url.password !== '' || url.port !== '')
            return null;
        const matched = /^\/media\/([A-Za-z0-9_-]+)(?:\.(?:jpg|jpeg|png|webp))?(?::(?:thumb|small|medium|large|orig|4096x4096))?$/i
            .exec(url.pathname);
        return matched ? matched[1] : null;
    }
    XMN.photoCdnIdentity = photoCdnIdentity;
    /** Normalize an actual FxEmbed photo CDN URL. Its API returns
     * `/media/ID.jpg?name=orig`, which the X DOM thumbnail normalizer (with
     * `?format=...`) intentionally rejects. Accept ONLY an exact CDN image.
     */
    function normalizePublicPhotoUrl(src) {
        let url;
        try {
            url = new URL(src);
        }
        catch {
            return null;
        }
        if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' ||
            url.port || url.username || url.password)
            return null;
        const matched = /^\/media\/([A-Za-z0-9_-]+)(?:\.(jpg|jpeg|png|webp))?$/i.exec(url.pathname);
        if (!matched)
            return null;
        const suffix = matched[2]?.toLowerCase() ?? null;
        const format = url.searchParams.get('format')?.toLowerCase() ?? suffix;
        if (!format || !/^(jpg|jpeg|png|webp)$/.test(format) ||
            (suffix && format !== suffix))
            return null;
        const normalized = new URL(`https://pbs.twimg.com/media/${matched[1]}`);
        normalized.searchParams.set('format', format);
        normalized.searchParams.set('name', 'large');
        return normalized.toString();
    }
    XMN.normalizePublicPhotoUrl = normalizePublicPhotoUrl;
    /**
     * FxEmbed's PUBLIC media feed is third-party, not X's authenticated API.
     * This is pure defensive parsing: never accepts external post owners or
     * unvalidated CDN URLs as native media links.
     */
    function parsePublicMediaPage(input, profile) {
        if (!HANDLE_RE.test(profile) || typeof input !== 'object' || input === null)
            return null;
        const data = input;
        if (data.code !== 200 || !Array.isArray(data.results) || data.results.length > 100)
            return null;
        const handle = profile.toLowerCase();
        const refs = [];
        const photos = [];
        const seen = new Set();
        for (const entry of data.results) {
            if (!entry || typeof entry !== 'object')
                continue;
            const post = entry;
            const id = post.id;
            if (post.type !== 'status' || typeof id !== 'string' ||
                !/^\d{1,19}$/.test(id) || seen.has(id) ||
                typeof post.author?.screen_name !== 'string' ||
                post.author.screen_name.toLowerCase() !== handle)
                continue;
            const claimed = mediaRefFromHref(post.url, handle);
            if (!claimed || claimed.statusId !== id || claimed.kind !== null)
                continue;
            const attachments = post.media?.all;
            if (!Array.isArray(attachments) || attachments.length < 1 || attachments.length > 4)
                continue;
            const photoOnly = attachments.every((asset) => asset?.type === 'photo');
            const videoOnly = attachments.length === 1 &&
                (attachments[0]?.type === 'video' || attachments[0]?.type === 'gif' ||
                    attachments[0]?.type === 'animated_gif');
            if (!photoOnly && !videoOnly)
                continue;
            const urls = photoOnly
                ? attachments.map((asset) => typeof asset.url === 'string' ? normalizePublicPhotoUrl(asset.url) : null)
                : [];
            if (photoOnly && urls.some((url) => !url))
                continue;
            seen.add(id);
            if (photoOnly) {
                for (let i = 0; i < attachments.length; i++) {
                    const ref = mediaRefFromHref(`/${handle}/status/${id}/photo/${i + 1}`, handle);
                    if (!ref)
                        continue;
                    refs.push(ref);
                    photos.push([ref.key, urls[i]]);
                }
            }
            else {
                const ref = mediaRefFromHref(`/${handle}/status/${id}/video/1`, handle);
                if (ref)
                    refs.push(ref);
            }
        }
        const cursorObj = data.cursor;
        if (!cursorObj || typeof cursorObj !== 'object' ||
            Array.isArray(cursorObj) ||
            !Object.prototype.hasOwnProperty.call(cursorObj, 'bottom'))
            return null;
        const bottom = cursorObj.bottom;
        if (bottom !== null && (typeof bottom !== 'string' ||
            bottom.length < 1 || bottom.length > 1024))
            return null;
        return { refs, photos, cursor: bottom };
    }
    XMN.parsePublicMediaPage = parsePublicMediaPage;
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
        // Query parameter order is not part of X's media identity. Canonicalize
        // the same parameter set so reversed name/format order shares a prefetch
        // queue entry instead of transferring one photo twice.
        url.searchParams.sort();
        url.hash = '';
        return url.toString();
    }
    XMN.preloadImageUrl = preloadImageUrl;
    /** B2: immutable, whole-post working window; no guessed X navigation. */
    function planMediaWindow(refs, activeKey, maxRefs = 450) {
        if (!Number.isInteger(maxRefs) || maxRefs < 4 || !refs.length)
            return null;
        const groups = [];
        const seenKeys = new Set(), seenPosts = new Set();
        let active = -1;
        for (let i = 0; i < refs.length; i++) {
            const r = refs[i];
            if (!r || seenKeys.has(r.key))
                return null;
            seenKeys.add(r.key);
            if (r.key === activeKey)
                active = i;
            const last = groups[groups.length - 1];
            if (!last || last.id !== r.statusId) {
                if (seenPosts.has(r.statusId))
                    return null;
                seenPosts.add(r.statusId);
                groups.push({ id: r.statusId, start: i, end: i + 1 });
            }
            else
                last.end = i + 1;
        }
        if (active < 0)
            return null;
        let center = groups.findIndex(g => g.start <= active && active < g.end);
        if (center < 0)
            return null;
        let left = center, right = center, total = groups[center].end - groups[center].start;
        if (total > maxRefs)
            return null;
        let blockedLeft = false, blockedRight = false;
        while (!blockedLeft || !blockedRight) {
            const leftSpan = center - left, rightSpan = right - center;
            const goLeft = !blockedLeft && (blockedRight || leftSpan <= rightSpan);
            if (goLeft) {
                const g = groups[left - 1];
                if (!g || total + g.end - g.start > maxRefs)
                    blockedLeft = true;
                else {
                    left--;
                    total += g.end - g.start;
                }
            }
            else {
                const g = groups[right + 1];
                if (!g || total + g.end - g.start > maxRefs)
                    blockedRight = true;
                else {
                    right++;
                    total += g.end - g.start;
                }
            }
        }
        const base = groups[left].start;
        return { refs: refs.slice(base, groups[right].end), base, activeIndex: active - base };
    }
    XMN.planMediaWindow = planMediaWindow;
})(XMN || (XMN = {}));
var XMN;
(function (XMN) {
    class SessionStore {
        async call(op, profile, session) {
            try {
                if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage)
                    return null;
                const data = await chrome.runtime.sendMessage({
                    kind: 'xmn-store-v1', op, profile, session
                });
                if (!data || typeof data !== 'object')
                    return null;
                return data;
            }
            catch {
                return null;
            }
        }
        async hasConsent(profile) {
            const r = await this.call('consent.get', profile);
            return r?.ok === true && r.granted === true;
        }
        async grantConsent(profile) {
            return (await this.call('consent.set', profile))?.ok === true;
        }
        async load(profile) {
            const r = await this.call('session.get', profile);
            return r?.ok === true && r.session ? r.session : null;
        }
        async save(data) {
            return (await this.call('session.set', data.profile, data))?.ok === true;
        }
        async clear(profile) {
            await this.call('session.clear', profile);
        }
    }
    XMN.SessionStore = SessionStore;
    /** Purge only our obsolete host-page keys; never read or migrate untrusted values. */
    function clearLegacyPageSession() {
        try {
            window.sessionStorage.removeItem('xmn-public-media-v1');
            const match = /^\/([a-zA-Z0-9_]{1,15})\/(?:status\/|media(?:\/|$))/.exec(window.location.pathname);
            if (match)
                window.sessionStorage.removeItem('xmn-fxembed-consent-' + match[1].toLowerCase());
        }
        catch { /* Third-party storage can be disabled; secure worker does not depend on it. */ }
    }
    XMN.clearLegacyPageSession = clearLegacyPageSession;
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
    // Bounded, progressive future-post prefetch. Never saturate the network.
    const PREFETCH_MAX_IMAGES = 5;
    const PREFETCH_MAX_CONCURRENT = 2;
    const PREFETCH_MAX_RECORDS = 6;
    const PREFETCH_MAX_DECODED_BYTES = 80 * 1024 * 1024;
    const DIAGNOSTIC_VERSION = '2.4.21-dev';
    // Only numeric counts, booleans, and fixed operation labels are reported.
    // Never record X URLs, handles, post IDs, cookies, tokens or API cursors.
    function diagnostic(event, details = {}) {
        try {
            console.info(`[XMN ${DIAGNOSTIC_VERSION}] ${event}`, details);
        }
        catch { /* Diagnostics must never interrupt the viewer. */ }
    }
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
    function pause(ms) {
        return new Promise((resolve) => window.setTimeout(resolve, ms));
    }
    function mediaColumn() {
        return document.querySelector('main [data-testid="primaryColumn"]') ?? document.querySelector('main');
    }
    function isEditingTarget(target) {
        if (!(target instanceof Element))
            return false;
        return !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="slider"], [role="spinbutton"], video');
    }
    /** Hidden X carousel controls cannot prove a live gallery boundary. */
    function isHiddenNativeControl(control) {
        return control.getAttribute('aria-hidden') === 'true' ||
            control.getAttribute('hidden') !== null ||
            control.getAttribute('inert') !== null ||
            !!control.closest?.('[aria-hidden="true"], [hidden], [inert]');
    }
    function usableTileLink(tile, profile) {
        const links = Array.from(tile.querySelectorAll('a[href]'));
        const possibilities = links
            // A quoted post can contain its own media links. They are not the
            // originating profile's media tile, even if the handle matches.
            .filter((link) => !link.closest('[data-testid="quoteTweet"]'))
            .map((link) => ({ link, ref: XMN.mediaRefFromHref(link.getAttribute('href') ?? '', profile) }))
            .filter((candidate) => candidate.ref !== null);
        const hasThumbnail = !!tile.querySelector('img, video');
        // Prefer the link actually wrapping the thumbnail, not an unrelated
        // reply/permalink. Ambiguous owners are safer to leave unnumbered.
        const owned = possibilities.filter(({ link }) => !!link.querySelector('img, video'));
        if (owned.length === 1)
            return owned[0];
        if (owned.length > 1)
            return null;
        if (new Set(possibilities.map(({ ref }) => ref.statusId)).size > 1)
            return null;
        const explicit = possibilities.find(({ ref }) => ref.kind !== null);
        // X can leave a not-yet-loaded image placeholder in the grid. Preserve
        // one explicit /photo/N or /video/N link even before the img appears.
        if (!hasThumbnail)
            return possibilities.length === 1 ? explicit ?? null : null;
        // In older grids, the image sits outside its link. A single owner is still safe.
        return explicit ?? possibilities[0] ?? null;
    }
    /** Maintain a stable ordered list of media refs, never cached DOM nodes. */
    class Controller {
        constructor() {
            this.sessionStore = new XMN.SessionStore();
            this.originProfile = null;
            this.originTimeline = null;
            this.pendingGrid = null;
            this.refs = [];
            this.indexes = new Map();
            // Bounded, validated live DOM handles; never stored across a session reset.
            this.liveLinks = new Map();
            // Append-only media ordering lets route updates reuse first-seen post
            // ordinals instead of rebuilding a Set/array for every arrow press.
            this.statusOrdinalCache = null;
            this.imageSources = new Map();
            this.imageSourcesRevision = 0;
            this.knownPhotoTotals = new Map();
            this.prefetched = new Map();
            this.prefetchQueue = [];
            this.prefetchWanted = new Set();
            this.prefetchInFlight = 0;
            this.prefetchFailed = new Set();
            this.prefetchTooLarge = new Set();
            this.prefetchFailurePath = '';
            this.preopenExpireTimer = null;
            this.handoff = null;
            this.preloadTimer = null;
            this.preloadForPath = '';
            this.nativeAdvancedPost = null;
            this.rightProbeTimer = null;
            // Read-only, no-cookie public-media continuation for the private beta.
            // Never fetch until reaching the end of the already observed X media grid.
            this.publicApiKeys = new Set();
            this.publicApiCursor = null;
            this.publicApiAnchorFound = false;
            this.publicApiExhausted = false;
            this.publicApiLoading = false;
            this.publicApiAbort = null;
            this.publicApiCancelReason = null;
            this.publicApiRetryAt = 0;
            this.publicApiFailures = 0;
            // Only the most recent eligible end-of-list key may resume after warmup.
            this.pendingBoundary = null;
            this.pendingDocumentHandoff = null;
            // Warm only after the user has explicitly allowed this external provider.
            this.publicApiWarmCursor = null;
            this.publicApiWarmTimer = null;
            // Persisted X-observed native refs stay navigable after a public API handoff.
            this.publicSessionRestored = false;
            this.viewer = null;
            // Portaled controls live outside X's React-owned photo carousel. X may
            // unmount or hide a slide's children on photo 2 without closing the modal.
            this.controlsHost = null;
            this.controlsViewer = null;
            this.controlsDialog = null;
            // Lock arrows to the PHOTO PANE in viewport coordinates. X can animate,
            // translate or recycle its inner swipe viewer on every post transition;
            // reusing that moving bounding box causes accumulating apparent drift.
            this.controlsPaneAnchor = null;
            this.controlsGeometryKey = '';
            this.controlsLayoutPath = '';
            this.activeViewerPath = '';
            // Ignore unchanged 450ms polling cycles instead of walking the full
            // media timeline to rebuild identical button state and position labels.
            this.viewerStateSnapshot = null;
            this.viewObserver = null;
            this.modalObserver = null;
            this.listObserver = null;
            this.observedColumn = null;
            this.lastPath = '';
            this.scanTimer = null;
            this.routeTickTimer = null;
            this.observedRouteKey = '';
            this.pendingFullScan = false;
            this.pendingSourceTiles = new Set();
            this.navigationBusy = false;
            this.navGeneration = 0;
            XMN.clearLegacyPageSession();
            void this.restorePublicMediaSession().catch(() => { }).finally(() => {
                diagnostic('startup', { restored: this.publicSessionRestored, indexed: this.refs.length });
                this.tick();
            });
            // Observe actual user keyboard input only when the viewer belongs to a media-tab session.
            document.addEventListener('keydown', (event) => this.onKeyDown(event), true);
            // Preheat adjacent images when a user opens media from the grid, before
            // X has constructed its React modal. This never consumes the click.
            document.addEventListener('click', (event) => this.onMediaTileClick(event), true);
            document.addEventListener('visibilitychange', () => this.onVisibilityChange(), { passive: true });
            window.addEventListener('resize', () => {
                this.controlsPaneAnchor = null;
                this.controlsLayoutPath = '';
                if (this.viewer?.isConnected)
                    this.positionControls(this.viewer);
            }, { passive: true });
            document.addEventListener('fullscreenchange', () => {
                this.controlsPaneAnchor = null;
                this.controlsLayoutPath = '';
                if (this.viewer?.isConnected)
                    this.controlContainer(this.viewer);
            });
            this.observedRouteKey = `${window.location.pathname}${window.location.search}`;
            this.installRouteObserver();
            // Safety fallback: browsers may omit Navigation API events for X routes
            // and media content may mount after its URL has already committed.
            this.refreshId = window.setInterval(() => this.tick(), 450);
        }
        /**
         * Transient public Post URL index only. Never store X credentials, cookies,
         * signed-in page data, or private profile content. A full X document
         * navigation may be required when no X-owned React media link exists.
         */
        /** Never publish a page-owned session or trust it on reload. */
        async persistPublicMediaSession() {
            try {
                if (!this.originProfile || this.refs.length < 1 || this.refs.length > 450)
                    return false;
                const refs = this.refs.map(ref => ref.href);
                const photos = [...this.imageSources].filter(([key]) => this.publicApiKeys.has(key)).slice(0, 450);
                const statuses = new Set(this.refs.filter(ref => this.publicApiKeys.has(ref.key)).map(ref => ref.statusId));
                const photoTotals = [...this.knownPhotoTotals].filter(([id]) => statuses.has(id)).slice(-128);
                const payload = {
                    schema: 1,
                    profile: this.originProfile,
                    timeline: this.originTimeline,
                    expires: Date.now() + 30 * 60 * 1000,
                    refs, apiKeys: [...this.publicApiKeys],
                    photos, photoTotals, cursor: this.publicApiCursor,
                    anchorFound: this.publicApiAnchorFound,
                    exhausted: this.publicApiExhausted,
                };
                this.sessionStore ?? (this.sessionStore = new XMN.SessionStore());
                return await this.sessionStore.save(payload);
            }
            catch {
                return false;
            }
        }
        async restorePublicMediaSession() {
            const path = window.location.pathname;
            const match = /^\/([a-zA-Z0-9_]{1,15})\/status\/\d+/.exec(path);
            if (!match)
                return;
            const profile = match[1].toLowerCase();
            const generation = this.navGeneration;
            this.sessionStore ?? (this.sessionStore = new XMN.SessionStore());
            const data = await this.sessionStore.load(profile);
            if (!data || window.location.pathname !== path ||
                generation !== this.navGeneration || this.originProfile !== null)
                return;
            const route = XMN.mediaRefFromHref(path, profile);
            if (!route || !Array.isArray(data.refs) || !Array.isArray(data.apiKeys))
                return;
            const refs = data.refs.map(href => XMN.mediaRefFromHref(href, profile));
            if (refs.some(ref => !ref) || !refs.some(ref => ref?.key === route.key))
                return;
            const keys = new Set(data.apiKeys.filter(key => typeof key === 'string' &&
                refs.some(ref => ref?.key === key)));
            if (keys.size === 0)
                return;
            this.publicSessionRestored = true;
            this.originProfile = profile;
            this.originTimeline = data.timeline;
            this.refs = refs;
            this.indexes = new Map(this.refs.map((ref, i) => [ref.key, i]));
            this.publicApiKeys = keys;
            this.publicApiAnchorFound = data.anchorFound === true;
            this.publicApiExhausted = data.exhausted === true;
            this.publicApiCursor = data.cursor;
            this.knownPhotoTotals ?? (this.knownPhotoTotals = new Map());
            for (const item of data.photoTotals ?? []) {
                if (!Array.isArray(item) || item.length !== 2 ||
                    typeof item[0] !== 'string' || !Number.isInteger(item[1]) ||
                    item[1] < 1 || item[1] > 4)
                    continue;
                const complete = Array.from({ length: item[1] }, (_, i) => keys.has(item[0] + ':photo:' + (i + 1))).every(Boolean);
                if (complete)
                    this.rememberPhotoTotal(item[0], item[1]);
            }
            this.imageSources ?? (this.imageSources = new Map());
            for (const entry of data.photos ?? []) {
                if (!Array.isArray(entry) || entry.length !== 2 ||
                    !keys.has(entry[0]) || typeof entry[1] !== 'string')
                    continue;
                this.rememberImageSource(entry[0], entry[1]);
            }
        }
        /**
         * A public, third-party API, explicitly requested by the user for this
         * private development beta. Send ONLY the public handle; no X cookies,
         * OAuth, referrer, bearer tokens or browsing logs.
         */
        /** Bound the wire bytes even when Content-Length is missing or incorrect. */
        async readBoundedPublicBody(response) {
            const maxBytes = 4000000;
            if (!response.body) {
                // Test fixtures and old browsers have no stream. The bound is applied
                // immediately after text() in this compatibility fallback.
                const text = await response.text();
                return text.length <= maxBytes ? text : null;
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            const chunks = [];
            let bytes = 0;
            try {
                for (;;) {
                    const part = await reader.read();
                    if (part.done)
                        break;
                    bytes += part.value.byteLength;
                    if (bytes > maxBytes) {
                        try {
                            await reader.cancel();
                        }
                        catch { }
                        return null;
                    }
                    chunks.push(decoder.decode(part.value, { stream: true }));
                }
                chunks.push(decoder.decode());
                return chunks.join('');
            }
            finally {
                reader.releaseLock();
            }
        }
        /** Throttle malformed public payloads as well as HTTP rate limits. */
        imposePublicApiCooldown(reason, providerRetryMs = 0) {
            this.publicApiFailures = Math.min(6, (this.publicApiFailures ?? 0) + 1);
            const fallback = Math.min(60000, 1000 * (2 ** this.publicApiFailures));
            const advised = Number.isFinite(providerRetryMs) && providerRetryMs > 0 ? providerRetryMs : 0;
            this.publicApiRetryAt = Date.now() + Math.min(120000, Math.max(fallback, advised));
            diagnostic('fxembed.cooldown', { reason, retryMs: this.publicApiRetryAt - Date.now() });
        }
        async fetchPublicMediaPage(cursor) {
            if (!this.originProfile)
                return null;
            const url = new URL('https://api.fxtwitter.com/2/profile/' +
                this.originProfile + '/media');
            url.searchParams.set('count', '100');
            if (cursor)
                url.searchParams.set('cursor', cursor);
            const abort = new AbortController();
            this.publicApiAbort = abort;
            this.publicApiCancelReason = null;
            const started = Date.now();
            diagnostic('fxembed.request', { continuation: !!cursor });
            const watchdog = window.setTimeout(() => {
                if (this.publicApiAbort === abort)
                    this.publicApiCancelReason = 'timeout';
                abort.abort();
            }, 9500);
            try {
                const response = await fetch(url.toString(), {
                    method: 'GET', mode: 'cors', credentials: 'omit',
                    referrerPolicy: 'no-referrer', cache: 'no-store',
                    signal: abort.signal, headers: { Accept: 'application/json' },
                });
                if (!response.ok) {
                    diagnostic('fxembed.http_failure', { httpStatus: response.status });
                    if (response.status === 429 || response.status >= 500) {
                        let retryMs = 0;
                        const header = response.headers.get('retry-after');
                        if (header) {
                            const seconds = Number(header);
                            const asDate = Date.parse(header);
                            retryMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 :
                                Number.isFinite(asDate) ? Math.max(0, asDate - Date.now()) : 0;
                        }
                        this.imposePublicApiCooldown('http_' + response.status, retryMs);
                    }
                    return null;
                }
                const size = Number(response.headers.get('content-length'));
                if (Number.isFinite(size) && size > 4000000) {
                    diagnostic('fxembed.rejected', { reason: 'content_length' });
                    this.imposePublicApiCooldown('content_length');
                    return null;
                }
                const body = await this.readBoundedPublicBody(response);
                if (body === null) {
                    diagnostic('fxembed.rejected', { reason: 'body_length' });
                    this.imposePublicApiCooldown('body_length');
                    return null;
                }
                const page = XMN.parsePublicMediaPage(JSON.parse(body), this.originProfile);
                if (!page) {
                    diagnostic('fxembed.rejected', { reason: 'invalid_payload' });
                    this.imposePublicApiCooldown('invalid_payload');
                    return null;
                }
                this.publicApiFailures = 0;
                this.publicApiRetryAt = 0;
                diagnostic('fxembed.page', {
                    entries: page.refs.length, photos: page.photos.length,
                    hasNext: !!page.cursor, elapsedMs: Date.now() - started,
                });
                return page;
            }
            catch (error) {
                const wasAbort = error instanceof Error && error.name === 'AbortError';
                if (!wasAbort || this.publicApiCancelReason === 'timeout')
                    this.imposePublicApiCooldown(wasAbort ? 'timeout' : 'network_or_json');
                diagnostic('fxembed.failed', {
                    reason: wasAbort ? (this.publicApiCancelReason ?? 'timeout') : 'network_or_json',
                });
                return null;
            }
            finally {
                window.clearTimeout(watchdog);
                if (this.publicApiAbort === abort) {
                    this.publicApiAbort = null;
                    this.publicApiCancelReason = null;
                }
            }
        }
        /**
         * After explicit FxEmbed consent, warm the next cursor shortly BEFORE
         * reaching the last indexed post. No new provider calls before consent.
         * A cancelled timer may be retried; failed requests obey cooldown limits.
         */
        async schedulePublicMediaWarmup(currentIndex) {
            if (currentIndex === null || !this.publicApiAnchorFound ||
                !this.publicApiCursor || this.publicApiExhausted || this.publicApiLoading ||
                this.navigationBusy || !this.viewer?.isConnected || document.hidden ||
                this.publicApiWarmTimer !== null ||
                this.publicApiWarmCursor === this.publicApiCursor || !this.originProfile ||
                this.publicApiRetryAt > Date.now())
                return;
            const profile = this.originProfile;
            this.sessionStore ?? (this.sessionStore = new XMN.SessionStore());
            if (!await this.sessionStore.hasConsent(profile))
                return;
            if (this.originProfile !== profile || !this.viewer?.isConnected ||
                this.publicApiLoading || this.navigationBusy || document.hidden ||
                !this.publicApiCursor || this.publicApiExhausted ||
                this.publicApiWarmTimer !== null ||
                this.publicApiWarmCursor === this.publicApiCursor ||
                this.publicApiRetryAt > Date.now())
                return;
            let position = currentIndex;
            let remaining = 0;
            for (let n = 0; n < 4; n++) {
                const next = XMN.adjacentPostIndex(this.refs, this.refs[position].statusId, 1, position);
                if (next === null)
                    break;
                position = next;
                remaining++;
            }
            if (remaining > 3)
                return;
            const requestedCursor = this.publicApiCursor;
            this.publicApiWarmTimer = window.setTimeout(() => {
                this.publicApiWarmTimer = null;
                if (this.publicApiCursor !== requestedCursor || this.publicApiLoading ||
                    this.navigationBusy || !this.viewer?.isConnected || document.hidden)
                    return;
                // Mark only an actually started call; a cancelled timer may be retried.
                this.publicApiWarmCursor = requestedCursor;
                diagnostic('fxembed.warmup', { remainingPosts: remaining });
                void this.loadPublicMediaContinuation(true).then(ok => {
                    if (!ok && this.publicApiWarmCursor === requestedCursor)
                        this.publicApiWarmCursor = null;
                }).catch(() => {
                    if (this.publicApiWarmCursor === requestedCursor)
                        this.publicApiWarmCursor = null;
                });
            }, 400);
        }
        /** Append only validated, chronologically older media records. */
        async loadPublicMediaContinuation(background = false) {
            if (!this.originProfile || this.publicApiLoading || document.hidden ||
                (typeof navigator !== 'undefined' && navigator.onLine === false) ||
                this.publicApiExhausted)
                return false;
            if (this.publicApiRetryAt > Date.now()) {
                diagnostic('fxembed.cooldown_active', { retryMs: this.publicApiRetryAt - Date.now() });
                return false;
            }
            const nativeLast = this.refs[this.refs.length - 1]?.statusId;
            if (!nativeLast)
                return false;
            const generation = this.navGeneration;
            const profile = this.originProfile;
            const timeline = this.originTimeline;
            // Keep the native X Photos / Videos filter when appending public media.
            if (timeline && timeline !== `${profile}|default` &&
                timeline !== `${profile}|photo` && timeline !== `${profile}|video`)
                return false;
            const mediaKind = timeline === `${profile}|photo` ? 'photo' :
                timeline === `${profile}|video` ? 'video' : null;
            const initialPath = window.location.pathname;
            const stillSameSession = () => generation === this.navGeneration && this.originProfile === profile &&
                this.originTimeline === timeline &&
                window.location.pathname === initialPath && !document.hidden;
            this.publicApiLoading = true;
            if (!background) {
                this.navigationBusy = true;
                this.updateViewerState();
            }
            diagnostic('fxembed.continuation_start', { background, indexed: this.refs.length });
            let cursor = this.publicApiCursor;
            const pages = [];
            let newCursor = cursor;
            let committed = false;
            try {
                for (let attempt = 0; attempt < 4; attempt++) {
                    const page = await this.fetchPublicMediaPage(cursor);
                    if (!stillSameSession() || !page) {
                        diagnostic('fxembed.continuation_abort', {
                            reason: !stillSameSession() ? 'route_changed' : 'request_failed',
                        });
                        return false;
                    }
                    // Cursor progress is mandatory even if the page already has enough posts.
                    if (cursor && page.cursor === cursor) {
                        diagnostic('fxembed.continuation_abort', { reason: 'cursor_not_advanced' });
                        this.imposePublicApiCooldown('cursor_not_advanced');
                        return false;
                    }
                    pages.push({
                        refs: mediaKind ? page.refs.filter((ref) => ref.kind === mediaKind) : page.refs,
                        photos: mediaKind === 'video' ? [] : page.photos,
                    });
                    newCursor = page.cursor;
                    const all = pages.flatMap((item) => item.refs);
                    const groups = [...new Set(all.map((ref) => ref.statusId))];
                    const last = groups.indexOf(nativeLast);
                    const candidates = this.publicApiAnchorFound ? groups.length :
                        last >= 0 ? groups.length - last - 1 : 0;
                    // Require 8 future posts after the native end when possible.
                    if (candidates >= 8 || !page.cursor)
                        break;
                    if (page.cursor === cursor)
                        return false;
                    cursor = page.cursor;
                    await pause(300); // Avoid hammering the volunteer API.
                    if (!stillSameSession())
                        return false;
                }
                if (!stillSameSession())
                    return false;
                const combined = pages.flatMap((item) => item.refs);
                if (!combined.length)
                    return false;
                // Validate RAW contiguous post groups before Set() can mask a
                // repeated post separated by another post across page boundaries.
                const seenGroups = new Set();
                let previousGroup = null;
                for (const ref of combined) {
                    if (ref.statusId === previousGroup)
                        continue;
                    if (seenGroups.has(ref.statusId) || (previousGroup &&
                        ref.statusId.padStart(19, '0') >= previousGroup.padStart(19, '0'))) {
                        diagnostic('fxembed.continuation_abort', { reason: 'noncontiguous_post_group' });
                        this.imposePublicApiCooldown('noncontiguous_post_group');
                        return false;
                    }
                    seenGroups.add(ref.statusId);
                    previousGroup = ref.statusId;
                }
                const statusIds = [...seenGroups];
                // Snowflake status IDs must decrease in chronological order. Refuse
                // reordered external results rather than crossing posts out-of-order.
                if (statusIds.some((id, i) => i > 0 &&
                    id.padStart(19, '0') >= statusIds[i - 1].padStart(19, '0')))
                    return false;
                // A stale cursor may replay an earlier page. Allow the indexed tail
                // itself as a legitimate overlap, but never append a newer post.
                if (this.publicApiAnchorFound &&
                    statusIds[0].padStart(19, '0') > nativeLast.padStart(19, '0')) {
                    diagnostic('fxembed.continuation_abort', { reason: 'cursor_newer_than_tail' });
                    return false;
                }
                let start = 0;
                const anchorExtra = [];
                if (!this.publicApiAnchorFound) {
                    const last = statusIds.indexOf(nativeLast);
                    if (last < 0) {
                        diagnostic('fxembed.continuation_abort', { reason: 'anchor_missing' });
                        this.imposePublicApiCooldown('anchor_missing');
                        return false;
                    }
                    const earlier = [...new Set(this.refs.map((ref) => ref.statusId))].slice(-2, -1);
                    if (earlier.length && !earlier.every((id) => statusIds.slice(0, last).includes(id))) {
                        diagnostic('fxembed.continuation_abort', { reason: 'timeline_mismatch' });
                        this.imposePublicApiCooldown('timeline_mismatch');
                        return false; // Provider does not match X native media list.
                    }
                    start = combined.findIndex((ref) => ref.statusId === nativeLast);
                    const anchorStart = start;
                    while (start < combined.length && combined[start].statusId === nativeLast)
                        start++;
                    // X can expose only photo/1 in its native timeline. Preserve any
                    // newly verified photos of the anchor post before appending older posts.
                    const nativeGroup = this.refs.filter(ref => ref.statusId === nativeLast);
                    const maxNativePhoto = Math.max(0, ...nativeGroup.map(ref => ref.kind === 'photo' ? ref.mediaIndex ?? 0 : 0));
                    for (const ref of combined.slice(anchorStart, start)) {
                        if (this.indexes.has(ref.key))
                            continue;
                        if (ref.kind !== 'photo' || maxNativePhoto === 0 ||
                            (ref.mediaIndex ?? 0) <= maxNativePhoto) {
                            diagnostic('fxembed.continuation_abort', { reason: 'anchor_album_ambiguous' });
                            return false;
                        }
                        anchorExtra.push(ref);
                    }
                }
                const newlyVerified = [...anchorExtra, ...combined.slice(start)];
                const sourceMap = new Map(pages.flatMap((item) => item.photos));
                const oldLength = this.refs.length;
                const oldCursor = this.publicApiCursor;
                const oldAnchorFound = this.publicApiAnchorFound;
                const oldExhausted = this.publicApiExhausted;
                const oldPhotoTotals = new Map(this.knownPhotoTotals ?? []);
                const oldImageSources = new Map(this.imageSources ?? []);
                const oldImageRevision = this.imageSourcesRevision;
                const plannedKeys = new Set();
                for (const ref of newlyVerified) {
                    if (!this.indexes.has(ref.key))
                        plannedKeys.add(ref.key);
                }
                // Never silently drop part of an album/page and then advance the
                // cursor beyond those missing posts. Fail without changing the index.
                if (this.refs.length + plannedKeys.size > 450) {
                    diagnostic('fxembed.continuation_abort', { reason: 'index_limit' });
                    return false;
                }
                let appended = 0;
                for (const ref of newlyVerified) {
                    if (this.indexes.has(ref.key))
                        continue;
                    this.indexes.set(ref.key, this.refs.length);
                    this.refs.push(ref);
                    this.publicApiKeys.add(ref.key);
                    const source = sourceMap.get(ref.key);
                    if (source)
                        this.rememberImageSource(ref.key, source);
                    appended++;
                }
                // FxEmbed includes the full photo array per Post. Only use a
                // confirmed 1–4 photo count when EVERY photo of that group was
                // indexed (the 450-ref cap must never truncate the album counter).
                const groupedPhotos = new Map();
                for (const ref of newlyVerified) {
                    if (ref.kind !== 'photo' || ref.mediaIndex === null)
                        continue;
                    const indexes = groupedPhotos.get(ref.statusId) ?? new Set();
                    indexes.add(ref.mediaIndex);
                    groupedPhotos.set(ref.statusId, indexes);
                }
                for (const [id, positions] of groupedPhotos) {
                    if (positions.size >= 1 && positions.size <= 4 &&
                        Array.from({ length: positions.size }, (_, i) => i + 1).every((i) => positions.has(i) &&
                            this.publicApiKeys.has(`${id}:photo:${i}`))) {
                        this.rememberPhotoTotal(id, positions.size);
                    }
                }
                this.publicApiAnchorFound = true;
                this.publicApiCursor = newCursor;
                this.publicApiExhausted = !newCursor;
                this.statusOrdinalCache = null;
                this.viewerStateSnapshot = null;
                // Zero new posts with an explicit terminal cursor is a legitimate end,
                // not a retryable error. Preserve the already-verified public window.
                if (appended === 0 && newCursor === null && stillSameSession()) {
                    this.publicApiExhausted = true;
                    const saved = !this.publicApiKeys.size ||
                        await this.persistPublicMediaSession();
                    // A route change during storage belongs to the NEW session.
                    if (!stillSameSession())
                        return false;
                    if (!saved) {
                        this.publicApiCursor = oldCursor;
                        this.publicApiAnchorFound = oldAnchorFound;
                        this.publicApiExhausted = oldExhausted;
                        return false;
                    }
                    diagnostic('fxembed.exhausted', { indexed: this.refs.length });
                    return false;
                }
                const saved = appended > 0 && stillSameSession()
                    ? await this.persistPublicMediaSession() : false;
                if (!stillSameSession())
                    return false;
                if (saved) {
                    diagnostic('fxembed.continuation_ready', {
                        added: appended, indexed: this.refs.length, hasMore: !!newCursor, background,
                    });
                    committed = true;
                    return true;
                }
                diagnostic('fxembed.continuation_abort', {
                    reason: appended === 0 ? 'no_new_entries' : 'storage_or_route',
                });
                // Do not leave a half-appended public page if storage is blocked or
                // X changed profile/tab while the asynchronous API was responding.
                for (const ref of this.refs.splice(oldLength)) {
                    this.indexes.delete(ref.key);
                    this.publicApiKeys.delete(ref.key);
                    this.imageSources.delete(ref.key);
                }
                this.publicApiCursor = oldCursor;
                this.publicApiAnchorFound = oldAnchorFound;
                this.publicApiExhausted = oldExhausted;
                this.knownPhotoTotals = oldPhotoTotals;
                this.imageSources = oldImageSources;
                this.imageSourcesRevision = oldImageRevision;
                if (appended === 0)
                    this.imposePublicApiCooldown('no_new_entries');
                return false;
            }
            finally {
                if (generation === this.navGeneration && this.originProfile === profile) {
                    this.publicApiLoading = false;
                    if (!background)
                        this.navigationBusy = false;
                    this.updateViewerState();
                    const intent = this.pendingBoundary;
                    this.pendingBoundary = null; // Single-use regardless of result.
                    if (committed && intent && intent.generation === this.navGeneration &&
                        intent.path === window.location.pathname &&
                        this.viewer?.isConnected && !document.hidden &&
                        this.originProfile === profile &&
                        (!intent.photoIdentity || this.currentPhotoIdentity() === intent.photoIdentity) &&
                        this.refs.some(ref => ref.statusId === intent.statusId)) {
                        const index = this.activeIndex();
                        if (index !== null && this.refs[index].statusId === intent.statusId &&
                            XMN.adjacentPostIndex(this.refs, intent.statusId, 1, index) !== null) {
                            diagnostic('fxembed.boundary_resumed');
                            void this.navigate(1);
                        }
                    }
                }
            }
        }
        /**
         * Subscribe only to a standard browser event (no React/History hooks).
         * Navigation API detects committed same-document pushState/replaceState
         * changes; popstate is the lightweight legacy fallback.
         */
        installRouteObserver() {
            const nav = window.navigation;
            if (nav && typeof nav.addEventListener === 'function') {
                try {
                    nav.addEventListener('currententrychange', () => this.scheduleRouteTick());
                    return true;
                }
                catch { /* Unsupported/limited isolated-world API: poll remains. */ }
            }
            window.addEventListener('popstate', () => this.scheduleRouteTick());
            return false;
        }
        /** Collapse consecutive same-route updates into one next-task DOM check. */
        scheduleRouteTick() {
            const key = `${window.location.pathname}${window.location.search}`;
            if (this.observedRouteKey === key)
                return;
            this.observedRouteKey = key;
            if (this.routeTickTimer != null)
                return;
            this.routeTickTimer = window.setTimeout(() => {
                this.routeTickTimer = null;
                // X's click handler may commit a new URL before its modal finishes
                // replacing the prior photo. The modal observer covers that mount;
                // never forcibly tear down controls during an in-flight navigation.
                if (this.navigationBusy)
                    return;
                if (this.originProfile &&
                    XMN.profileStatusFromPath(window.location.pathname, this.originProfile) &&
                    !document.querySelector(VIEWER_SELECTOR))
                    return;
                this.tick();
            }, 0);
        }
        resetSession() {
            this.navGeneration++;
            if (this.publicApiAbort) {
                this.publicApiCancelReason = 'route_changed';
                this.publicApiAbort.abort();
            }
            this.publicApiAbort = null;
            this.publicApiRetryAt = 0;
            this.publicApiFailures = 0;
            this.controlsPaneAnchor = null;
            this.navigationBusy = false;
            this.pendingGrid = null;
            this.refs = [];
            this.indexes.clear();
            this.liveLinks?.clear();
            this.statusOrdinalCache = null;
            this.publicApiKeys?.clear();
            this.publicApiCursor = null;
            this.publicApiAnchorFound = false;
            this.publicApiExhausted = false;
            this.publicSessionRestored = false;
            this.publicApiLoading = false;
            this.pendingBoundary = null;
            this.pendingDocumentHandoff = null;
            this.publicApiWarmCursor = null;
            if (this.publicApiWarmTimer !== null)
                window.clearTimeout(this.publicApiWarmTimer);
            this.publicApiWarmTimer = null;
            this.imageSources.clear();
            this.imageSourcesRevision++;
            this.knownPhotoTotals.clear();
            this.clearVisualHandoff();
            // A removed media session must not leave background CDN transfers alive.
            this.prefetchQueue = [];
            this.prefetchWanted.clear();
            for (const entry of this.prefetched.values())
                entry.cancel?.();
            this.prefetched.clear();
            this.prefetchFailed.clear();
            this.prefetchTooLarge.clear();
            this.prefetchFailurePath = '';
            this.prefetchInFlight = 0;
            if (this.preopenExpireTimer !== null)
                window.clearTimeout(this.preopenExpireTimer);
            this.preopenExpireTimer = null;
            this.preloadForPath = '';
            this.nativeAdvancedPost = null;
            if (this.rightProbeTimer !== null)
                window.clearTimeout(this.rightProbeTimer);
            this.rightProbeTimer = null;
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
            this.pendingFullScan = false;
            this.pendingSourceTiles.clear();
        }
        /** The first swipe-to-dismiss node can be an offscreen carousel slide. */
        findActiveViewer() {
            if (typeof document.querySelectorAll !== 'function')
                return document.querySelector(VIEWER_SELECTOR);
            const candidates = document.querySelectorAll(VIEWER_SELECTOR);
            let best = null;
            let bestArea = -1;
            for (const viewer of candidates) {
                if (!viewer.isConnected || viewer.getAttribute('aria-hidden') === 'true' ||
                    viewer.getAttribute('hidden') !== null || viewer.getAttribute('inert') !== null ||
                    viewer.closest('[aria-hidden="true"], [hidden], [inert]'))
                    continue;
                // X can fade the previous slide to opacity:0 while keeping it
                // connected and geometrically overlapping the new photo.
                const style = typeof window.getComputedStyle === 'function'
                    ? window.getComputedStyle(viewer) : null;
                if (style && (style.display === 'none' || style.visibility === 'hidden' ||
                    style.opacity === '0'))
                    continue;
                let area = 1;
                if (typeof viewer.getBoundingClientRect === 'function') {
                    const rect = viewer.getBoundingClientRect();
                    const vw = typeof window.innerWidth === 'number' ? window.innerWidth : Infinity;
                    const vh = typeof window.innerHeight === 'number' ? window.innerHeight : Infinity;
                    area = Math.max(0, Math.min(vw, rect.right) - Math.max(0, rect.left)) *
                        Math.max(0, Math.min(vh, rect.bottom) - Math.max(0, rect.top));
                }
                if (area > bestArea && area > 0) {
                    best = viewer;
                    bestArea = area;
                }
            }
            return best;
        }
        /** Keep the chosen X slide across idle polls, without querying layouts. */
        activeViewerForRoute() {
            const route = window.location.pathname;
            const current = this.viewer;
            if (current?.isConnected && this.activeViewerPath === route &&
                current.getAttribute?.('aria-hidden') !== 'true' &&
                current.getAttribute?.('hidden') === null &&
                current.getAttribute?.('inert') === null &&
                !current.closest?.('[aria-hidden="true"], [hidden], [inert]'))
                return current;
            this.activeViewerPath = route;
            return this.findActiveViewer();
        }
        /**
         * React's history.pushState does not fire popstate. Detect X's modal
         * insertion/removal through DOM changes instead of waiting up to 450ms.
         * Only inspect nodes added or removed, never rescan the entire page on
         * unrelated feed mutations. The interval remains a route-change fallback.
         */
        syncModalObserver() {
            if (!this.originProfile || !document.body) {
                this.modalObserver?.disconnect();
                this.modalObserver = null;
                return;
            }
            if (this.modalObserver || typeof MutationObserver === 'undefined')
                return;
            this.modalObserver = new MutationObserver((records) => {
                if (!this.originProfile)
                    return;
                for (const record of records) {
                    for (const node of [...record.addedNodes, ...record.removedNodes]) {
                        if (!(node instanceof Element))
                            continue;
                        if (node.matches(VIEWER_SELECTOR) || node.querySelector(VIEWER_SELECTOR)) {
                            this.activeViewerPath = '';
                            this.tick();
                            return;
                        }
                    }
                }
            });
            this.modalObserver.observe(document.body, { childList: true, subtree: true });
        }
        tick() {
            // Chromium may still dispatch throttled interval callbacks for a hidden
            // tab. Do not traverse X's media DOM while backgrounded; we reconcile
            // once on visibilitychange before resuming bounded photo prefetch.
            if (document.hidden)
                return;
            const path = window.location.pathname;
            const atMedia = XMN.mediaProfileFromPath(path);
            const timeline = XMN.mediaTimelineKey(path, window.location.search);
            if (atMedia && timeline) {
                let scanRequired = false;
                if (this.publicSessionRestored || this.originProfile !== atMedia) {
                    // Returning from an API-only full-page route restores a fresh X grid.
                    // Old saved refs are not the live grid's ordering or filter authority.
                    this.resetSession();
                    this.originProfile = atMedia;
                    this.originTimeline = timeline;
                    scanRequired = true;
                }
                else if (this.originTimeline !== timeline) {
                    // A modal close initiated by this extension can temporarily drop
                    // ?filter=photo. Keep the original session until navigate() checks
                    // the actual target. Do not clear refs midway through the operation.
                    if (this.navigationBusy)
                        return;
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
                if (!this.pendingGrid && (scanRequired || observerAdded))
                    this.scanTiles();
            }
            else if (!this.originProfile || !XMN.profileStatusFromPath(path, this.originProfile)) {
                if (this.originProfile !== null) {
                    this.resetSession();
                    this.originProfile = null;
                    this.originTimeline = null;
                }
            }
            else {
                // The timeline is a retained DOM tree beneath the modal. Do NOT index the
                // status-page recommendations as though they were the originating media tab.
                this.stopListObserver();
            }
            this.syncModalObserver();
            if (path !== this.lastPath) {
                this.pendingDocumentHandoff = null;
                if (this.publicApiAbort && this.publicApiLoading) {
                    this.publicApiCancelReason = 'route_changed';
                    this.publicApiAbort.abort();
                }
                if (this.pendingBoundary && this.pendingBoundary.path !== path)
                    this.pendingBoundary = null;
                // Track proven native photo changes even if the next key is pressed
                // before the delayed fallback probe completes.
                if (this.originProfile) {
                    const previous = XMN.mediaRefFromHref(this.lastPath, this.originProfile);
                    const displayed = XMN.mediaRefFromHref(path, this.originProfile);
                    if (previous?.kind === 'photo' && displayed?.kind === 'photo' &&
                        previous.statusId === displayed.statusId &&
                        previous.mediaIndex !== displayed.mediaIndex) {
                        this.nativeAdvancedPost = displayed.statusId;
                    }
                }
                this.lastPath = path;
            }
            const viewer = this.originProfile && XMN.profileStatusFromPath(path, this.originProfile)
                ? this.activeViewerForRoute() : null;
            if (viewer && this.originProfile) {
                this.syncViewer(viewer);
            }
            else {
                this.removeViewerUI();
            }
        }
        /** First few anchors and DOM nodes distinguish X's data swap from our badge cleanup. */
        captureGrid() {
            const column = mediaColumn();
            const tiles = column ? Array.from(column.querySelectorAll(TILE_SELECTOR)) : [];
            const firstTiles = tiles.slice(0, 8);
            const lastTiles = tiles.slice(-8);
            const firstKeys = firstTiles.map((tile) => {
                const link = this.originProfile ? usableTileLink(tile, this.originProfile) : null;
                return link?.ref.key ?? '';
            });
            const lastKeys = lastTiles.map(tile => {
                const link = this.originProfile ? usableTileLink(tile, this.originProfile) : null;
                return link?.ref.key ?? '';
            });
            return { column, firstTiles, firstKeys, lastTiles, lastKeys, tileCount: tiles.length };
        }
        hasGridTurnedOver(previous) {
            const current = this.captureGrid();
            if (current.firstTiles.length === 0)
                return false;
            // Waiting for X's actual list replacement is safer than a fixed delay.
            if (current.column !== previous.column)
                return true;
            const replaced = current.firstTiles.some((tile, index) => tile !== previous.firstTiles[index]);
            const keysChanged = current.firstKeys.some((key, index) => key !== previous.firstKeys[index]);
            const tailChanged = (previous.lastTiles ?? []).some((tile, i) => current.lastTiles?.[i] !== tile);
            const tailKeysChanged = (previous.lastKeys ?? []).some((key, i) => current.lastKeys?.[i] !== key);
            const countChanged = previous.tileCount !== undefined &&
                current.tileCount !== previous.tileCount;
            return replaced || keysChanged || tailChanged || tailKeysChanged || countChanged;
        }
        ensureListObserver() {
            const column = mediaColumn();
            if (!column || column === this.observedColumn)
                return false;
            this.stopListObserver();
            this.observedColumn = column;
            this.pendingSourceTiles ?? (this.pendingSourceTiles = new Set());
            this.listObserver = new MutationObserver((records) => {
                let relevant = false;
                for (const record of records) {
                    if (record.type === 'attributes') {
                        // A late-loading thumbnail only requires updating its own URL.
                        const tile = record.target instanceof Element
                            ? record.target.closest(TILE_SELECTOR) : null;
                        if (tile) {
                            this.pendingSourceTiles.add(tile);
                            relevant = true;
                        }
                    }
                    else if (record.type === 'childList') {
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
                if (!relevant || this.scanTimer !== null)
                    return;
                this.scanTimer = window.setTimeout(() => {
                    this.scanTimer = null;
                    const full = this.pendingFullScan;
                    const changed = [...this.pendingSourceTiles];
                    this.pendingFullScan = false;
                    this.pendingSourceTiles.clear();
                    if (XMN.mediaProfileFromPath(window.location.pathname) !== this.originProfile)
                        return;
                    if (this.pendingGrid && this.hasGridTurnedOver(this.pendingGrid))
                        this.pendingGrid = null;
                    if (this.pendingGrid)
                        return;
                    if (full)
                        this.scanTiles();
                    else
                        for (const tile of changed)
                            this.refreshKnownTileSource(tile);
                }, 100);
            });
            this.listObserver.observe(column, {
                childList: true, subtree: true,
                attributes: true, attributeFilter: ['src', 'srcset'],
            });
            return true;
        }
        /** Shared bounded URL cache for X tiles, FxEmbed and restored sessions. */
        rememberImageSource(key, url) {
            if (!this.imageSources || XMN.preloadImageUrl(url) !== url)
                return;
            if (this.imageSources.get(key) === url)
                return;
            this.imageSources.delete(key);
            this.imageSources.set(key, url);
            this.imageSourcesRevision = (this.imageSourcesRevision ?? 0) + 1;
            while (this.imageSources.size > 128) {
                const oldest = this.imageSources.keys().next().value;
                if (oldest === undefined)
                    break;
                this.imageSources.delete(oldest);
            }
        }
        /** Update only the changed thumbnail without rescanning the whole media grid. */
        recordTileImageSource(tile, found) {
            const ownedImage = found.link.querySelector('img[src]');
            // Only search the entire tile when X renders the image outside its
            // anchor. On long grids a second subtree query for every tile adds up.
            const otherImages = ownedImage ? null : tile.querySelectorAll('img[src]');
            const thumbnail = ownedImage ?? (otherImages?.length === 1 ? otherImages[0] : null);
            // A recycled X thumbnail may already be assigned a NEW photo in src
            // while currentSrc still points to the old, rendered photo. For a
            // pending load follow the newly assigned resource. Once the image is
            // completely loaded, currentSrc is authoritative for srcset/picture
            // candidates and may differ from a valid fallback src.
            const displayed = thumbnail ? XMN.preloadImageUrl(thumbnail.currentSrc || '') : null;
            const assigned = thumbnail ? XMN.preloadImageUrl(thumbnail.src || '') : null;
            const different = assigned && displayed &&
                XMN.photoCdnIdentity(assigned) !== XMN.photoCdnIdentity(displayed);
            const loaded = thumbnail?.complete === true && thumbnail.naturalWidth > 0;
            const url = different && !loaded ? assigned : displayed ?? assigned;
            if (url)
                this.rememberImageSource(found.ref.key, url);
        }
        refreshKnownTileSource(tile) {
            if (!tile.isConnected || !this.originProfile || this.pendingGrid ||
                XMN.mediaProfileFromPath(window.location.pathname) !== this.originProfile)
                return;
            const found = usableTileLink(tile, this.originProfile);
            if (found && this.indexes?.has(found.ref.key))
                this.recordTileImageSource(tile, found);
        }
        scanTiles() {
            if (!this.originProfile || this.pendingGrid ||
                XMN.mediaProfileFromPath(window.location.pathname) !== this.originProfile)
                return;
            const root = mediaColumn();
            if (!root)
                return;
            const tiles = Array.from(root.querySelectorAll(TILE_SELECTOR));
            // When X prepends a newer post, its DOM order (not discovery time)
            // determines the verified head. Never reorder previously observed posts
            // when the first surviving anchor is not the original head.
            if (this.refs.length > 0) {
                const head = [];
                for (const tile of tiles) {
                    const observed = usableTileLink(tile, this.originProfile);
                    if (!observed)
                        continue;
                    const known = this.indexes.get(observed.ref.key);
                    if (known !== undefined) {
                        if (known === 0 && head.length &&
                            head.every(ref => ref.statusId.padStart(19, '0') >
                                this.refs[0].statusId.padStart(19, '0'))) {
                            const unique = [...new Map(head.map(ref => [ref.key, ref])).values()];
                            this.refs.unshift(...unique);
                            this.indexes = new Map(this.refs.map((ref, i) => [ref.key, i]));
                            this.statusOrdinalCache = null;
                            this.viewerStateSnapshot = null;
                        }
                        break;
                    }
                    head.push(observed.ref);
                }
            }
            for (const tile of tiles) {
                const found = usableTileLink(tile, this.originProfile);
                if (!found)
                    continue;
                const { ref } = found;
                this.recordTileImageSource(tile, found);
                this.rememberLiveLink(ref, found.link);
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
        /** Pin post controls to a stable media-pane rectangle, not moving slides. */
        positionControls(viewer) {
            const host = this.controlsHost;
            if (!host || typeof viewer.getBoundingClientRect !== 'function')
                return;
            const viewportWidth = typeof window.innerWidth === 'number' ? window.innerWidth : 0;
            const viewportHeight = typeof window.innerHeight === 'number' ? window.innerHeight : 0;
            const fullscreenRoot = document.fullscreenElement ?? null;
            let anchor = this.controlsPaneAnchor;
            if (!anchor || anchor.viewportWidth !== viewportWidth ||
                anchor.viewportHeight !== viewportHeight ||
                anchor.fullscreenRoot !== fullscreenRoot) {
                // X's swipe element may be temporarily translated while advancing
                // between POSTS. Capture once per stable viewport and reuse; repeated
                // getBoundingClientRect() caused the arrows to walk across the screen.
                const rect = viewer.getBoundingClientRect();
                const vw = viewportWidth || rect.right;
                const vh = viewportHeight || rect.bottom;
                const maxRight = vw >= 900 ? vw - Math.min(250, vw * 0.2) : vw;
                const left = Math.max(0, rect.left);
                const top = Math.max(0, rect.top);
                const right = Math.min(rect.right, maxRight);
                const bottom = Math.min(rect.bottom, vh);
                const width = right - left, height = bottom - top;
                if (width < 150 || height < 120 || !Number.isFinite(width) ||
                    !Number.isFinite(height)) {
                    host.style.display = 'none';
                    this.controlsLayoutPath = '';
                    return; // Never cache a transiently invalid slide rectangle.
                }
                anchor = { left, top, width, height, viewportWidth, viewportHeight, fullscreenRoot };
                this.controlsPaneAnchor = anchor;
            }
            const { left, top, width, height } = anchor;
            const geometry = [left, top, width, height].map(Math.round).join(',');
            if (geometry !== this.controlsGeometryKey) {
                host.style.left = left + 'px';
                host.style.top = top + 'px';
                host.style.width = width + 'px';
                host.style.height = height + 'px';
                this.controlsGeometryKey = geometry;
            }
            host.style.display = '';
            this.controlsLayoutPath = window.location.pathname;
        }
        /** Place post arrows outside X's React-owned carousel descendants. */
        controlContainer(viewer) {
            if (typeof viewer.getBoundingClientRect !== 'function' || !document.body)
                return viewer; // Older DOM / lightweight test harness fallback.
            const parent = (document.fullscreenElement || document.body);
            let host = this.controlsHost;
            if (!host || !host.isConnected) {
                host = document.createElement('div');
                host.className = 'xmn-controls-layer';
                host.setAttribute('role', 'group');
                host.setAttribute('aria-label', '投稿間ナビゲーション');
                parent.appendChild(host);
                this.controlsHost = host;
                this.controlsDialog = viewer.closest('[role="dialog"]');
                this.controlsGeometryKey = '';
                this.controlsLayoutPath = '';
                this.viewerStateSnapshot = null;
                // Remove controls left by an earlier/legacy content-script version.
                viewer.querySelectorAll('.xmn-nav-button, .xmn-status').forEach(el => el.remove());
            }
            else if (host.parentElement !== parent) {
                parent.appendChild(host);
                this.controlsGeometryKey = '';
                this.controlsLayoutPath = '';
            }
            if (this.controlsViewer !== viewer ||
                this.controlsLayoutPath !== window.location.pathname) {
                this.controlsViewer = viewer;
                this.positionControls(viewer);
            }
            return host;
        }
        removeViewerUI(preserveControls = false) {
            this.viewerStateSnapshot = null;
            this.activeViewerPath = '';
            if (!preserveControls) {
                // X may remove a photo viewer before adding the next one and before
                // the route poll observes it. Keep the screen-space anchor while on a
                // status route, even when the previous node is already detached.
                // Only an explicit return to the media grid invalidates the anchor.
                if (!this.navigationBusy && this.originProfile &&
                    XMN.mediaProfileFromPath(window.location.pathname) === this.originProfile)
                    this.controlsPaneAnchor = null;
                this.controlsHost?.remove();
                this.controlsHost = null;
                this.controlsDialog = null;
            }
            this.controlsViewer = null;
            this.controlsGeometryKey = '';
            this.controlsLayoutPath = '';
            this.viewObserver?.disconnect();
            this.viewObserver = null;
            if (this.rightProbeTimer !== null)
                window.clearTimeout(this.rightProbeTimer);
            this.rightProbeTimer = null;
            if (this.viewer) {
                this.viewer.querySelectorAll('.xmn-nav-button, .xmn-status').forEach((element) => element.remove());
                this.viewer = null;
            }
        }
        syncViewer(viewer) {
            if (viewer !== this.viewer) {
                // On photo 2/3 X may replace just the active slide inside the same
                // dialog. Preserve the outside-React control layer without flicker.
                const oldDialog = this.viewer?.closest('[role="dialog"]');
                const newDialog = viewer.closest('[role="dialog"]');
                const preserve = !!this.controlsHost?.isConnected &&
                    !!newDialog && (oldDialog === newDialog ||
                    this.controlsDialog === newDialog);
                this.removeViewerUI(preserve);
                this.viewer = viewer;
                this.viewObserver = new MutationObserver((changes) => {
                    if (!this.viewer?.isConnected)
                        return;
                    // React may reuse an existing <img> and swap only its src/srcset.
                    // React render/remount uses childList. Ignore our own button/status
                    // decoration whenever possible to avoid repeated full UI updates.
                    const photoAttributeChange = changes.some((change) => change.type === 'attributes' &&
                        change.target instanceof HTMLImageElement &&
                        (change.attributeName === 'src' || change.attributeName === 'srcset'));
                    const structuralChange = changes.some((change) => change.type === 'childList' &&
                        [...change.addedNodes, ...change.removedNodes].some((node) => node instanceof Element &&
                            (node.matches('img, picture, video') ||
                                !!node.querySelector('img, picture, video'))));
                    if (structuralChange) {
                        this.controlsLayoutPath = '';
                        this.ensureViewerButtons();
                    }
                    if (structuralChange || photoAttributeChange)
                        this.finishVisualHandoff(this.viewer);
                });
                this.viewObserver.observe(viewer, {
                    childList: true, subtree: true,
                    attributes: true, attributeFilter: ['src', 'srcset'],
                });
            }
            this.ensureViewerButtons();
            this.finishVisualHandoff(viewer);
        }
        ensureViewerButtons() {
            const viewer = this.viewer;
            if (!viewer || !viewer.isConnected)
                return;
            const container = this.controlContainer(viewer);
            for (const [direction, className, text, label] of [
                [-1, 'xmn-prev', '◀', '前の投稿へ（最初の画像では←でも移動）'],
                [1, 'xmn-next', '▶', '次の投稿へ（最後の画像では→でも移動）'],
            ]) {
                let button = container.querySelector(`.${className}`);
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
                    container.appendChild(button);
                    // X may recreate DOM controls while leaving the route unchanged.
                    this.viewerStateSnapshot = null;
                }
            }
            let status = container.querySelector('.xmn-status');
            if (!status) {
                status = document.createElement('div');
                status.className = 'xmn-status';
                status.setAttribute('aria-live', 'polite');
                container.appendChild(status);
                this.viewerStateSnapshot = null;
            }
            this.updateViewerState();
            this.schedulePreload();
        }
        activeIndex() {
            if (!this.originProfile)
                return null;
            const route = XMN.mediaRefFromHref(window.location.pathname, this.originProfile);
            if (!route)
                return null;
            const indexed = this.indexes?.get(route.key);
            // Never trust an index unless its stored media key still matches X's
            // current route; virtualized grids can replace and reorder DOM tiles.
            if (indexed !== undefined && this.refs[indexed]?.key === route.key)
                return indexed;
            const exact = XMN.findCurrentIndex(this.refs, window.location.pathname, this.originProfile);
            if (exact !== null)
                return exact;
            // A media tab may offer only one link for a post with several photos.
            const current = XMN.mediaRefFromHref(window.location.pathname, this.originProfile);
            // The status-only fallback is rare: avoid allocating O(N) per-tile
            // temporary objects when a long X gallery only indexed photo/1.
            const index = current ? this.refs.findIndex((ref) => ref.statusId === current.statusId) : -1;
            return index >= 0 ? index : null;
        }
        updateViewerState() {
            const viewer = this.viewer;
            if (!viewer)
                return;
            // Media refs are append-only within a session; only their count,
            // current route, or navigation busy state changes the post controls.
            const key = `${window.location.pathname}|${this.originProfile ?? ''}|${this.refs.length}|${this.navigationBusy ? 1 : 0}`;
            if (this.viewerStateSnapshot?.viewer === viewer && this.viewerStateSnapshot.key === key)
                return;
            const current = this.activeIndex();
            const controls = this.controlsHost?.isConnected ? this.controlsHost : viewer;
            const prev = controls.querySelector('.xmn-prev');
            const next = controls.querySelector('.xmn-next');
            const currentRef = current !== null ? this.refs[current] : null;
            if (prev)
                prev.disabled = this.navigationBusy || !currentRef || XMN.adjacentPostIndex(this.refs, currentRef.statusId, -1, current ?? undefined) === null;
            // At the last known post clicking the next button may load more media.
            if (next)
                next.disabled = this.navigationBusy || !currentRef;
            const indicator = controls.querySelector('.xmn-status');
            if (indicator) {
                let ordinal = this.statusOrdinalCache;
                // Every new ref appends to the timeline. Rebuild only when the array
                // identity or number of indexed items changes, not on each route.
                if (!ordinal || ordinal.refs !== this.refs || ordinal.length !== this.refs.length) {
                    const byStatus = new Map();
                    for (const ref of this.refs) {
                        if (!byStatus.has(ref.statusId))
                            byStatus.set(ref.statusId, byStatus.size);
                    }
                    ordinal = { refs: this.refs, length: this.refs.length, byStatus };
                    this.statusOrdinalCache = ordinal;
                }
                const index = currentRef ? ordinal.byStatus.get(currentRef.statusId) ?? -1 : -1;
                const label = index < 0 ? '投稿の位置を確認中' :
                    `投稿 ${index + 1} / ${ordinal.byStatus.size}`;
                if (indicator.textContent !== label)
                    indicator.textContent = label;
            }
            this.viewerStateSnapshot = { viewer, key };
            this.schedulePublicMediaWarmup?.(current);
        }
        /**
         * Prove the actual media count from accessibility metadata or the official
         * four-attachment limit. A carousel may mount only its visible photos;
         * one to three tweetPhoto nodes never prove that there are no more photos.
         */
        photoCount(viewer, statusId) {
            const profile = this.originProfile;
            if (!profile)
                return null;
            const displayed = XMN.mediaRefFromHref(window.location.pathname, profile);
            const known = this.knownPhotoTotals?.get(statusId);
            if (known && displayed?.kind === 'photo' && displayed.mediaIndex !== null &&
                displayed.statusId === statusId && displayed.mediaIndex <= known)
                return known;
            const root = viewer.closest('[role="dialog"]') ?? viewer.parentElement;
            if (!root)
                return null;
            // X can render a gallery counter. Confirm it belongs to the displayed photo,
            // rather than matching a number in an unrelated reply or recommended post.
            if (displayed?.kind === 'photo' && displayed.statusId === statusId) {
                for (const node of viewer.querySelectorAll('[aria-label], [title], [aria-setsize][aria-posinset]')) {
                    if (node.closest('.xmn-nav-button, .xmn-status'))
                        continue;
                    for (const label of [node.getAttribute('aria-label'), node.getAttribute('title')]) {
                        const count = label && XMN.parseGalleryCounter(label);
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
            const indexes = new Set();
            for (const article of root.querySelectorAll('article[data-testid="tweet"]')) {
                for (const link of article.querySelectorAll('a[href*="/photo/"]')) {
                    const ref = XMN.mediaRefFromHref(link.getAttribute('href') ?? '', profile);
                    if (ref?.statusId === statusId && ref.kind === 'photo' && ref.mediaIndex !== null)
                        indexes.add(ref.mediaIndex);
                }
            }
            if (XMN.completeFourPhotoSet(indexes)) {
                this.rememberPhotoTotal(statusId, 4);
                return 4;
            }
            return null;
        }
        /** Cache only counts supported by explicit X evidence or a confirmed edge. */
        rememberPhotoTotal(statusId, total) {
            if (!total || !Number.isInteger(total) || total < 1 || total > 4)
                return;
            if (!this.knownPhotoTotals)
                this.knownPhotoTotals = new Map();
            this.knownPhotoTotals.delete(statusId);
            this.knownPhotoTotals.set(statusId, total);
            while (this.knownPhotoTotals.size > 128) {
                const first = this.knownPhotoTotals.keys().next().value;
                if (!first)
                    break;
                this.knownPhotoTotals.delete(first);
            }
        }
        nativeGalleryArrowAvailable(viewer, direction) {
            const root = viewer.closest('[role="dialog"]') ?? viewer;
            const pattern = direction === 1 ? NATIVE_NEXT : NATIVE_PREVIOUS;
            for (const button of root.querySelectorAll('[aria-label], [title]')) {
                if (button.closest('.xmn-nav-button') || isHiddenNativeControl(button))
                    continue;
                const label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').trim();
                if (pattern.test(label) && button.getAttribute('aria-disabled') !== 'true' &&
                    !(button instanceof HTMLButtonElement && button.disabled))
                    return true;
            }
            return false;
        }
        /** An explicitly disabled PHOTO-next button is positive end-of-gallery evidence. */
        nativeGalleryArrowDisabled(viewer) {
            if (typeof viewer.closest !== 'function' || typeof viewer.querySelectorAll !== 'function')
                return false;
            const root = viewer.closest('[role="dialog"]') ?? viewer;
            let disabledPhotoNextSeen = false;
            for (const button of root.querySelectorAll('[aria-label], [title]')) {
                if (button.closest('.xmn-nav-button') || isHiddenNativeControl(button))
                    continue;
                const label = (button.getAttribute('aria-label') || button.getAttribute('title') || '').trim();
                // A generic disabled "Next" could belong to the sidebar, not photos.
                if (!/next\s*(?:photo|image)|次の(?:画像|写真)/i.test(label))
                    continue;
                const disabled = button.getAttribute('aria-disabled') === 'true' ||
                    (button instanceof HTMLButtonElement && button.disabled);
                // Mixed native controls are ambiguous, never proof of gallery end.
                if (!disabled)
                    return false;
                disabledPhotoNextSeen = true;
            }
            return disabledPhotoNextSeen;
        }
        onKeyDown(event) {
            if (event.key === 'ArrowLeft' || event.key === 'Escape')
                this.pendingBoundary = null;
            if (!this.viewer?.isConnected || !this.originProfile ||
                isEditingTarget(event.target) || this.navigationBusy)
                return;
            const currentIndex = this.activeIndex();
            if (currentIndex === null)
                return;
            const current = XMN.mediaRefFromHref(window.location.pathname, this.originProfile);
            const count = current ? this.photoCount(this.viewer, current.statusId) : null;
            const photoCount = count ?? (current?.kind === 'photo' &&
                this.nativeGalleryArrowDisabled?.(this.viewer) ? current.mediaIndex : null);
            const nativeNext = this.nativeGalleryArrowAvailable(this.viewer, 1);
            const direction = XMN.galleryBoundaryDirection(event, current, photoCount, nativeNext, this.nativeGalleryArrowAvailable(this.viewer, -1));
            if (direction === null) {
                // X may not expose a gallery counter. Give its own ArrowRight handler
                // first chance to change photos, then offer a non-skipping fallback.
                if (current && current.kind === 'photo' && event.key === 'ArrowRight' &&
                    XMN.postShortcutDirection(event) === 1 && !nativeNext) {
                    this.handleUnknownRightBoundary(event, current);
                }
                return;
            }
            if (direction === -1 && current && XMN.adjacentPostIndex(this.refs, current.statusId, -1, currentIndex) === null)
                return;
            if (direction === 1 && current?.kind === 'photo' && current.mediaIndex !== null &&
                (photoCount === current.mediaIndex))
                this.rememberPhotoTotal?.(current.statusId, photoCount);
            event.preventDefault();
            event.stopImmediatePropagation();
            void this.navigate(direction);
        }
        /**
         * Find the primary displayed photo, not every thumbnail/quoted photo in
         * the X viewer. Prefer the single large on-screen candidate. If the layout
         * is ambiguous, abstain rather than skipping an unseen gallery photo.
         */
        displayedPhoto() {
            const viewer = this.viewer;
            if (!viewer || typeof viewer.querySelectorAll !== 'function')
                return null;
            const photos = [...viewer.querySelectorAll('img[src], img[srcset]')]
                .filter((img) => XMN.photoCdnIdentity(img.currentSrc || '') ||
                XMN.photoCdnIdentity(img.src || ''))
                .filter((img) => {
                // X may keep decoded carousel siblings outside the viewport. A
                // hidden/offscreen preload is NOT the image the user can see.
                if (typeof img.closest === 'function' &&
                    img.closest('[aria-hidden="true"], [hidden], [inert]'))
                    return false;
                if (typeof img.getBoundingClientRect !== 'function')
                    return true;
                const r = img.getBoundingClientRect();
                return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 &&
                    (typeof window.innerWidth !== 'number' || r.left < window.innerWidth) &&
                    (typeof window.innerHeight !== 'number' || r.top < window.innerHeight);
            });
            if (photos.length === 1)
                return photos[0];
            // X may keep an adjacent carousel image (or quoted photo) at the same
            // layout size. Resolve the *active route's* X CDN media identity first
            // instead of treating equal-size unrelated photos as ambiguous.
            const current = this.originProfile
                ? XMN.mediaRefFromHref(window.location.pathname, this.originProfile) : null;
            const ownedUrl = current ? this.imageSources?.get(current.key) : null;
            const ownedId = ownedUrl ? XMN.photoCdnIdentity(ownedUrl) : null;
            if (ownedId) {
                const matching = photos.filter((img) => XMN.photoCdnIdentity(img.currentSrc || '') === ownedId ||
                    XMN.photoCdnIdentity(img.src || '') === ownedId);
                if (matching.length === 1)
                    return matching[0];
                const loaded = matching.filter((img) => {
                    const selected = XMN.photoCdnIdentity(img.currentSrc || img.src || '');
                    const assigned = XMN.photoCdnIdentity(img.src || '');
                    return img.complete && img.naturalWidth > 0 &&
                        selected === ownedId && (!assigned || assigned === ownedId);
                });
                if (loaded.length === 1)
                    return loaded[0];
            }
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
                ranked[1].area >= ranked[0].area * 0.65))
                return null;
            return ranked[0].img;
        }
        /** Observe only the active X photo, not unrelated images in the dialog. */
        currentPhotoSignature() {
            const image = this.displayedPhoto();
            return image
                ? `${image.currentSrc || ''}|${image.src || ''}|${image.complete ? 1 : 0}|${image.naturalWidth || 0}`
                : null;
        }
        /** Track X's assigned photo, not old pixels awaiting the new resource. */
        currentPhotoIdentity() {
            const image = this.displayedPhoto();
            return image
                ? XMN.photoCdnIdentity(image.src || '') ?? XMN.photoCdnIdentity(image.currentSrc || '')
                : null;
        }
        /** A pending native photo download must never be mistaken for gallery end. */
        currentPhotoReady() {
            if (!this.viewer || typeof this.viewer.querySelector !== 'function')
                return false;
            // Do not mistake an X-internal loading state for the end of its gallery.
            if (this.viewer.querySelector('[aria-busy="true"], [role="progressbar"]'))
                return false;
            const image = this.displayedPhoto();
            if (!image || !image.complete || image.naturalWidth < 1)
                return false;
            const selectedId = XMN.photoCdnIdentity(image.currentSrc || '') ||
                XMN.photoCdnIdentity(image.src || '');
            const assignedId = XMN.photoCdnIdentity(image.src || '');
            const routeRef = this.originProfile
                ? XMN.mediaRefFromHref(window.location.pathname, this.originProfile) : null;
            const ownedUrl = routeRef ? this.imageSources?.get(routeRef.key) : null;
            const ownedId = ownedUrl ? XMN.photoCdnIdentity(ownedUrl) : null;
            // If X still paints the previous photo while an indexed current photo
            // loads, the old visible pixels cannot prove the new gallery edge.
            return selectedId !== null && (!assignedId || selectedId === assignedId) &&
                (!ownedId || selectedId === ownedId);
        }
        /**
         * Let X handle the FIRST right-arrow. An unknown album boundary is never
         * established from a timer alone: a stable, loaded X photo and no observed
         * next-photo control are also required. If that photo is still loading,
         * keep the first key's probe alive rather than demanding a second press.
         */
        handleUnknownRightBoundary(_event, current) {
            if (!this.viewer || this.navigationBusy || current.mediaIndex === null)
                return;
            if (this.refs?.some((ref) => ref.statusId === current.statusId &&
                ref.kind === 'photo' && ref.mediaIndex !== null &&
                ref.mediaIndex > current.mediaIndex))
                return;
            // Another key must not restart the active native-gallery observation.
            // X still receives the original keydown to operate its own carousel.
            if (this.rightProbeTimer != null)
                return;
            const path = window.location.pathname;
            const signature = this.currentPhotoSignature();
            const photoId = this.currentPhotoIdentity();
            const generation = this.navGeneration;
            const viewer = this.viewer;
            let loadingWaitMs = 0;
            const check = () => {
                this.rightProbeTimer = null;
                if (generation !== this.navGeneration || viewer !== this.viewer ||
                    !viewer.isConnected || this.navigationBusy)
                    return;
                const after = this.originProfile
                    ? XMN.mediaRefFromHref(window.location.pathname, this.originProfile) : null;
                if (!after || after.statusId !== current.statusId)
                    return;
                if (window.location.pathname !== path || after.mediaIndex !== current.mediaIndex) {
                    if (after.mediaIndex !== null && after.mediaIndex !== current.mediaIndex)
                        this.nativeAdvancedPost = current.statusId;
                    return; // X has changed photos; never jump over a native slide.
                }
                const nowId = this.currentPhotoIdentity();
                if ((photoId && nowId !== photoId) ||
                    (!photoId && signature !== this.currentPhotoSignature()))
                    return;
                if (this.nativeGalleryArrowAvailable(viewer, 1))
                    return;
                if (this.refs?.some((ref) => ref.statusId === current.statusId &&
                    ref.kind === 'photo' && ref.mediaIndex !== null &&
                    ref.mediaIndex > current.mediaIndex))
                    return;
                const nativeReachedHere = current.mediaIndex !== null &&
                    current.mediaIndex > 1 && this.nativeAdvancedPost === current.statusId;
                if ((photoId !== null && this.currentPhotoReady()) || nativeReachedHere) {
                    // A loaded, unchanged photo after X's chance to handle the native key.
                    // This remains a conservative no-op heuristic, not an album count.
                    void this.navigate(1);
                    return;
                }
                if (photoId !== null && loadingWaitMs < 2400) {
                    loadingWaitMs += 150;
                    this.rightProbeTimer = window.setTimeout(check, 150);
                    return;
                }
                // Never suggest "press again" when another key cannot prove an edge.
                // Leave unknown or permanently unready galleries under X's control.
                if (photoId === null)
                    this.toast('表示中の写真を特定できないため、Xの操作を優先しました');
            };
            this.rightProbeTimer = window.setTimeout(check, 1050);
        }
        schedulePreload() {
            if (!this.originProfile || !this.viewer || document.hidden)
                return;
            const key = `${this.originTimeline ?? ''}|${window.location.pathname}|${this.refs.length}|${this.imageSources.size}|${this.imageSourcesRevision ?? 0}`;
            if (key === this.preloadForPath)
                return;
            this.preloadForPath = key;
            if (this.preloadTimer !== null)
                window.clearTimeout(this.preloadTimer);
            // Start immediately after X mounts the viewer; a 350ms debounce used
            // to miss the entire next-post transition on fast arrow navigation.
            // The timeline/path key above already deduplicates repeated DOM updates.
            this.preloadTimer = window.setTimeout(() => {
                this.preloadTimer = null;
                this.preloadAdjacentImages();
            }, 0);
        }
        /** Stop obsolete background transfers; reuse decoded photos on return. */
        onVisibilityChange() {
            if (document.hidden) {
                this.pendingBoundary = null;
                if (this.publicApiAbort) {
                    this.publicApiCancelReason = 'hidden';
                    this.publicApiAbort.abort();
                }
                if (this.preloadTimer !== null)
                    window.clearTimeout(this.preloadTimer);
                this.preloadTimer = null;
                this.prefetchQueue = [];
                this.prefetchWanted.clear();
                // An image currently used as the visual handoff must remain alive.
                // All other in-flight downloads are optional once X is backgrounded.
                for (const entry of [...this.prefetched.values()]) {
                    if (entry.loading && !this.handoff?.host.contains(entry.image))
                        entry.cancel?.();
                }
                return;
            }
            // The previous route/source fingerprint may be unchanged after returning
            // from the background. Force only the existing bounded prefetch policy
            // to reconsider nearby photos, not a new polling service.
            this.preloadForPath = '';
            this.tick();
            if (this.viewer?.isConnected && this.originProfile)
                this.schedulePreload();
        }
        /** Prefetch before X opens the modal, but only after a real media-tile click. */
        onMediaTileClick(event) {
            if (!this.originProfile || this.pendingGrid || this.navigationBusy ||
                event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey ||
                XMN.mediaProfileFromPath(window.location.pathname) !== this.originProfile ||
                !(event.target instanceof Element))
                return;
            // On slower connections let X load the *current* photo first. Early
            // background transfers must not compete with its initial modal render.
            const connection = navigator.connection;
            const memory = navigator.deviceMemory;
            if (connection?.saveData || /^(slow-2g|2g|3g)$/.test(connection?.effectiveType ?? '') ||
                (memory !== undefined && memory <= 4))
                return;
            const tile = event.target.closest(TILE_SELECTOR);
            const clickedLink = event.target.closest('a[href]');
            if (!tile || !clickedLink)
                return;
            const found = usableTileLink(tile, this.originProfile);
            if (!found || found.link !== clickedLink || !found.link.isConnected)
                return;
            const index = this.indexes.get(found.ref.key);
            if (index === undefined || this.refs[index]?.key !== found.ref.key)
                return;
            this.preloadAdjacentImages({ index, current: found.ref });
            if (this.preopenExpireTimer !== null)
                window.clearTimeout(this.preopenExpireTimer);
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
        preloadAdjacentImages(preopen) {
            if ((!this.viewer?.isConnected && !preopen) || !this.originProfile || document.hidden ||
                (typeof navigator !== 'undefined' && navigator.onLine === false))
                return;
            const connection = navigator.connection;
            if (connection?.saveData || /^(slow-2g|2g)$/.test(connection?.effectiveType ?? ''))
                return;
            const index = preopen?.index ?? this.activeIndex();
            const current = preopen?.current ?? XMN.mediaRefFromHref(window.location.pathname, this.originProfile);
            if (index === null || !current || this.refs[index]?.statusId !== current.statusId)
                return;
            this.prefetchTooLarge ?? (this.prefetchTooLarge = new Set()); // Supports lightweight test controllers.
            const failureScope = preopen?.current.href ?? window.location.pathname;
            if (this.prefetchFailurePath !== failureScope) {
                // Retry transient CDN errors once the user actually navigates away.
                // Never spin on the same missing image while a modal stays open.
                this.prefetchFailed.clear();
                this.prefetchFailurePath = failureScope;
            }
            const targets = [];
            // 1. All already indexed later photos of this very post.
            for (let i = index + 1; i < this.refs.length && this.refs[i].statusId === current.statusId; i++) {
                if (this.refs[i].kind === 'photo')
                    targets.push(this.refs[i]);
            }
            // 2. Collect future POSTS in their observed order without losing the
            // nearest previous photo to a long forward-only prefetch window.
            const future = [];
            let cursor = index;
            for (let hops = 0; hops < 8 && targets.length + future.length < PREFETCH_MAX_IMAGES + 3; hops++) {
                const next = XMN.adjacentPostIndex(this.refs, this.refs[cursor].statusId, 1, cursor);
                if (next === null)
                    break;
                cursor = next;
                if (this.refs[cursor].kind === 'photo')
                    future.push(this.refs[cursor]);
                if (hops === 0) {
                    // X's native carousel may advance to photo/2 immediately after
                    // opening the next post. Warm one extra photo from that nearest
                    // album instead of only the first image of distant posts.
                    const sibling = this.refs[cursor + 1];
                    if (sibling?.kind === 'photo' && sibling.statusId === this.refs[cursor].statusId &&
                        targets.length + future.length < PREFETCH_MAX_IMAGES + 3)
                        future.push(sibling);
                }
            }
            // 3. Preserve fast forward movement (first two POSTS if there is room),
            // then reserve one of the five slots for going backwards. This improves
            // left-arrow continuity without increasing transfers or memory limits.
            const back = this.refs[index - 1];
            const prior = back?.kind === 'photo' && back.statusId === current.statusId ? back
                : (() => {
                    const previous = XMN.adjacentPostIndex(this.refs, current.statusId, -1, index);
                    return previous !== null && this.refs[previous].kind === 'photo'
                        ? this.refs[previous] : null;
                })();
            const forwardFirst = Math.min(2, Math.max(1, PREFETCH_MAX_IMAGES - targets.length - (prior ? 1 : 0)));
            targets.push(...future.slice(0, forwardFirst));
            if (prior)
                targets.push(prior);
            targets.push(...future.slice(forwardFirst));
            const memory = navigator.deviceMemory;
            const max = connection?.effectiveType === '3g' || (memory !== undefined && memory <= 4)
                ? 2 : PREFETCH_MAX_IMAGES;
            const urls = targets.map((ref) => this.imageSources.get(ref.key)).filter((url) => !!url);
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
                    !this.handoff?.host.contains(entry.image))
                    entry.cancel?.();
            }
            this.drainPrefetchQueue(!!preopen);
        }
        trimPrefetched() {
            let bytes = [...this.prefetched.values()].reduce((sum, value) => sum + value.bytes, 0);
            // prefetchWanted is ordered by usefulness (nearest next photo first).
            // The old LRU fallback evicted that MOST useful photo whenever all
            // decoded images were still wanted and their sum exceeded 80MiB.
            const priorities = new Map();
            let order = 0;
            for (const url of this.prefetchWanted)
                priorities.set(url, order++);
            while (this.prefetched.size > PREFETCH_MAX_RECORDS || bytes > PREFETCH_MAX_DECODED_BYTES) {
                let victim = null;
                let worst = -1;
                for (const [url, item] of this.prefetched) {
                    if (item.loading || this.handoff?.host.contains(item.image))
                        continue;
                    // Obsolete photos are evicted before any requested photo; among
                    // requested ones the farthest future photo is evicted first.
                    // Equal-priority obsolete entries retain the oldest-first LRU rule.
                    const rank = priorities.get(url) ?? Infinity;
                    if (rank > worst) {
                        worst = rank;
                        victim = [url, item];
                    }
                }
                if (!victim)
                    break; // Only in-flight or currently displayed images remain.
                this.prefetched.delete(victim[0]);
                bytes -= victim[1].bytes;
            }
        }
        drainPrefetchQueue(allowMediaGrid = false) {
            const activeModal = !!this.viewer?.isConnected;
            const openedFromGrid = allowMediaGrid &&
                XMN.mediaProfileFromPath(window.location.pathname) === this.originProfile;
            if (document.hidden || (!activeModal && !openedFromGrid) || this.navigationBusy)
                return;
            while (this.prefetchInFlight < PREFETCH_MAX_CONCURRENT && this.prefetchQueue.length) {
                const url = this.prefetchQueue.shift();
                if (!this.prefetchWanted.has(url) || this.prefetched.has(url) ||
                    this.prefetchFailed.has(url) || this.prefetchTooLarge.has(url))
                    continue;
                const image = new Image();
                const record = { image, ready: false, loading: true, bytes: 0 };
                const generation = this.navGeneration;
                let settled = false;
                let cancelled = false;
                let watchdog = null;
                const finish = (success) => {
                    if (watchdog !== null && typeof window.clearTimeout === 'function') {
                        window.clearTimeout(watchdog);
                        watchdog = null;
                    }
                    if (settled)
                        return;
                    settled = true;
                    if (generation !== this.navGeneration)
                        return;
                    this.prefetchInFlight = Math.max(0, this.prefetchInFlight - 1);
                    if (this.prefetched.get(url) === record) {
                        record.loading = false;
                        record.ready = success && image.naturalWidth > 0;
                        if (!record.ready) {
                            this.prefetched.delete(url);
                            if (!cancelled)
                                this.prefetchFailed.add(url);
                            if (this.prefetchFailed.size > 64)
                                this.prefetchFailed.delete(this.prefetchFailed.values().next().value);
                        }
                        else {
                            const estimate = (image.naturalWidth || 0) * (image.naturalHeight || 0) * 4;
                            record.bytes = Number.isFinite(estimate) ? estimate : 0;
                            if (record.bytes > PREFETCH_MAX_DECODED_BYTES) {
                                // A single giant decoded photo cannot fit in the memory budget.
                                // Do not evict it and then download it again on every scan.
                                this.prefetched.delete(url);
                                this.prefetchTooLarge.add(url);
                                if (this.prefetchTooLarge.size > 64) {
                                    this.prefetchTooLarge.delete(this.prefetchTooLarge.values().next().value);
                                }
                            }
                        }
                    }
                    if (record.ready && this.handoff?.targetPrefetchUrl === url) {
                        // A low-quality preview may already be visible while the decoded
                        // prefetch completes. Upgrade in-place; never issue a second fetch.
                        this.promoteVisualHandoff();
                    }
                    this.trimPrefetched();
                    diagnostic('prefetch.finished', {
                        decoded: record.ready, cached: this.prefetched.has(url), cancelled,
                        inFlight: this.prefetchInFlight,
                    });
                    // A pre-open click may launch the first two requests. Do not drain
                    // the remaining queue until the actual gallery is visible.
                    this.drainPrefetchQueue();
                };
                record.cancel = () => {
                    if (settled)
                        return;
                    cancelled = true;
                    image.onload = null;
                    image.onerror = null;
                    try {
                        // Never reset to an empty URL, which could request the page itself.
                        if (typeof image.removeAttribute === 'function')
                            image.removeAttribute('src');
                        else
                            image.src = 'data:,';
                    }
                    catch { /* The record and slot must still be released. */ }
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
                    if (typeof image.decode !== 'function')
                        finish(true);
                };
                this.prefetched.set(url, record);
                this.prefetchInFlight++;
                diagnostic('prefetch.started', { inFlight: this.prefetchInFlight });
                image.src = url;
                if (typeof image.decode === 'function') {
                    void image.decode().then(() => finish(true)).catch(() => finish(false));
                }
                this.trimPrefetched();
            }
        }
        /**
         * Capture an ALREADY decoded native thumbnail, never download another
         * small image. Drawing a third-party image taints this temporary canvas;
         * we only display the canvas and NEVER export/read pixel data.
         */
        captureLowQualityThumbnail(target, link) {
            const expected = this.imageSources?.get(target.key);
            const expectedId = expected ? XMN.photoCdnIdentity(expected) : null;
            if (!expectedId || target.kind !== 'photo' || !this.originProfile ||
                !link?.isConnected ||
                XMN.mediaRefFromHref(link.getAttribute('href') ?? '', this.originProfile)?.key !== target.key)
                return null;
            let image = link.querySelector('img[src], img[srcset]');
            if (!image) {
                // Some older X tiles place one thumbnail outside their native anchor.
                // Never guess among several candidate media images.
                const images = link.closest(TILE_SELECTOR)?.querySelectorAll('img[src], img[srcset]');
                if (images?.length === 1)
                    image = images[0];
            }
            if (!image || !image.complete || image.naturalWidth < 1 || image.naturalHeight < 1 ||
                XMN.photoCdnIdentity(image.currentSrc || image.src || '') !== expectedId)
                return null;
            try {
                const canvas = document.createElement('canvas');
                const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight));
                canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
                canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
                const ctx = canvas.getContext('2d', { alpha: false });
                if (!ctx)
                    return null;
                ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                canvas.classList.add('xmn-handoff-preview');
                diagnostic('preview.low_thumbnail_decoded', {
                    width: canvas.width, height: canvas.height, extraRequests: 0,
                });
                return canvas;
            }
            catch {
                // Failed/cross-origin-restricted or unsupported draw is optional.
                // Native X image loading must always remain functional.
                return null;
            }
        }
        /** Promote a low-res canvas to the existing decoded prefetch if ready. */
        promoteVisualHandoff() {
            const handoff = this.handoff;
            if (!handoff || handoff.quality !== 'low' ||
                handoff.generation !== this.navGeneration)
                return false;
            const record = this.prefetched?.get(handoff.targetPrefetchUrl);
            if (!record?.ready || record.image.naturalWidth < 1 ||
                XMN.photoCdnIdentity(handoff.targetPrefetchUrl) !== handoff.targetPhotoIdentity)
                return false;
            try {
                record.image.classList.add('xmn-handoff-image');
                handoff.host.replaceChildren(record.image);
                handoff.quality = 'high';
                diagnostic('preview.promoted_to_high', { visible: handoff.shown });
                return true;
            }
            catch {
                return false;
            }
        }
        /**
         * Visual-only handoff while X swaps its SPA photo viewer.
         * High quality decoded prefetch wins; otherwise display ONLY an existing
         * thumbnail's small canvas snapshot, without any extra image request.
         */
        beginVisualHandoff(target, link = null) {
            if (target.kind !== 'photo' || this.handoff || !this.originProfile || document.hidden)
                return false;
            if (typeof window.matchMedia === 'function' &&
                window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                diagnostic('preview.skipped', { reason: 'reduced_motion' });
                return false;
            }
            const url = this.imageSources?.get(target.key);
            const record = url ? this.prefetched?.get(url) : undefined;
            const targetPhotoIdentity = url ? XMN.photoCdnIdentity(url) : null;
            if (!url || !targetPhotoIdentity || XMN.preloadImageUrl(url) !== url) {
                diagnostic('preview.skipped', { reason: 'verified_photo_url_unavailable' });
                return false;
            }
            const highReady = !!record?.ready && record.image.naturalWidth > 0;
            if (!highReady && !link) {
                diagnostic('preview.skipped', { reason: 'native_thumbnail_unavailable' });
                return false;
            }
            let host = null;
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
                    this.viewer?.querySelector('img[src]')?.getBoundingClientRect?.(),
                ];
                const bounds = candidates.find((b) => b &&
                    b.width > 100 && b.height > 100 &&
                    Number.isFinite(b.left) && Number.isFinite(b.top) &&
                    (typeof maxRight !== 'number' || b.right <= maxRight + 5));
                if (!bounds) {
                    diagnostic('preview.skipped', { reason: 'unsafe_photo_geometry' });
                    return false;
                }
                host.style.setProperty('inset', 'auto');
                host.style.setProperty('left', `${bounds.left}px`);
                host.style.setProperty('top', `${bounds.top}px`);
                host.style.setProperty('width', `${bounds.width}px`);
                host.style.setProperty('height', `${bounds.height}px`);
                const visual = highReady ? record.image
                    : this.captureLowQualityThumbnail(target, link);
                if (!visual) {
                    diagnostic('preview.skipped', { reason: 'thumbnail_not_decoded' });
                    return false;
                }
                if (highReady)
                    visual.classList.add('xmn-handoff-image');
                host.appendChild(visual);
                document.body.appendChild(host);
                const timeout = window.setTimeout(() => this.clearVisualHandoff('timeout'), 1800);
                const handoff = {
                    host,
                    targetStatus: target.statusId,
                    targetMediaIndex: target.mediaIndex,
                    targetPhotoIdentity,
                    targetPrefetchUrl: url,
                    quality: highReady ? 'high' : 'low',
                    timeout,
                    generation: this.navGeneration,
                    shown: false,
                    shownAt: null,
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
                diagnostic('preview.prepared', { quality: handoff.quality, visible: false });
                // Only for the short handoff window: detect the new SPA modal as
                // soon as it mounts rather than waiting for the 450ms route poll.
                if (typeof MutationObserver !== 'undefined') {
                    const observer = new MutationObserver(() => {
                        if (this.handoff !== handoff)
                            return;
                        const opened = this.findActiveViewer();
                        if (opened && opened !== handoff.sourceViewer && this.originProfile &&
                            XMN.profileStatusFromPath(window.location.pathname, this.originProfile)) {
                            this.syncViewer(opened);
                        }
                    });
                    observer.observe(document.body, { childList: true, subtree: true });
                    handoff.observer = observer;
                }
                return true;
            }
            catch {
                diagnostic('preview.skipped', { reason: 'overlay_setup_failed' });
                // A failed MutationObserver setup can happen AFTER the overlay was
                // attached and this.handoff assigned. Dispose both together.
                if (host && this.handoff?.host === host)
                    this.clearVisualHandoff();
                else
                    host?.remove();
                return false; // Handoff is optional; never interrupt native SPA navigation.
            }
        }
        /** Attach at most one load listener, and detach it if the SPA swaps images. */
        watchHandoffImageLoad(handoff, image, viewer) {
            if (handoff.waitingImage === image && handoff.waitingLoadHandler)
                return;
            if (handoff.waitingImage && handoff.waitingLoadHandler) {
                handoff.waitingImage.removeEventListener('load', handoff.waitingLoadHandler);
            }
            const handler = () => {
                if (handoff.waitingImage === image && handoff.waitingLoadHandler === handler) {
                    handoff.waitingImage = null;
                    handoff.waitingLoadHandler = null;
                }
                if (this.handoff === handoff)
                    this.finishVisualHandoff(viewer);
            };
            handoff.waitingImage = image;
            handoff.waitingLoadHandler = handler;
            image.addEventListener('load', handler, { once: true });
        }
        /** Reveal the decoded image only once the old native modal has closed. */
        showVisualHandoff() {
            const handoff = this.handoff;
            if (handoff && handoff.generation === this.navGeneration && !handoff.shown) {
                // If the decoded full-size photo became ready during the SPA route
                // change, skip showing the blurry intermediary altogether.
                this.promoteVisualHandoff();
                // The event means the DOM reveal instruction succeeded, not that the
                // browser has already painted a visible frame.
                try {
                    handoff.host.classList.add('xmn-handoff-visible');
                }
                catch {
                    diagnostic('preview.skipped', { reason: 'reveal_failed' });
                    this.clearVisualHandoff();
                    return;
                }
                handoff.shown = true;
                handoff.shownAt = Date.now();
                diagnostic('preview.visible', { quality: handoff.quality });
                // The old modal can take most of the original 1.8s to close.
                // Start the visible handoff window only after that close finishes.
                window.clearTimeout(handoff.timeout);
                handoff.timeout = window.setTimeout(() => this.clearVisualHandoff('timeout'), 1800);
            }
        }
        finishVisualHandoff(viewer) {
            const handoff = this.handoff;
            if (!handoff || handoff.revealTimer !== null || !viewer.isConnected ||
                handoff.generation !== this.navGeneration || !this.originProfile)
                return;
            const shown = XMN.mediaRefFromHref(window.location.pathname, this.originProfile);
            if (!shown || shown.statusId !== handoff.targetStatus ||
                (handoff.targetMediaIndex !== null && shown.mediaIndex !== null &&
                    handoff.targetMediaIndex !== shown.mediaIndex))
                return;
            // A mounted X viewer can first show avatars or another photo. Match
            // the actual CDN *media identity* before removing the decoded handoff.
            // The display may use name=orig while prefetch used name=large.
            const candidates = [...viewer.querySelectorAll('img[src], img[srcset]')];
            const actualImage = candidates.find((img) => {
                // A new src may be assigned while currentSrc still displays the OLD
                // image. Never accept that loading target as rendered and decoded.
                const displayed = img.currentSrc || '';
                return displayed
                    ? XMN.photoCdnIdentity(displayed) === handoff.targetPhotoIdentity
                    : XMN.photoCdnIdentity(img.src || '') === handoff.targetPhotoIdentity;
            });
            if (!actualImage) {
                // The target may already be assigned to the same <img> whose currentSrc
                // still points to the previous photo. Subscribe to its next load event.
                const pendingTarget = candidates.find((img) => XMN.photoCdnIdentity(img.src || '') === handoff.targetPhotoIdentity);
                if (pendingTarget)
                    this.watchHandoffImageLoad(handoff, pendingTarget, viewer);
                return;
            }
            if (!actualImage.complete || actualImage.naturalWidth < 1) {
                if (actualImage)
                    this.watchHandoffImageLoad(handoff, actualImage, viewer);
                return;
            }
            // X can report a loaded image before its pixels are decoded. Wait
            // for the matching full-size image's decode(), never an avatar/old photo.
            // The 1.8s failsafe still removes the overlay on stalled decoding.
            const displayedSrc = actualImage.currentSrc || actualImage.src || '';
            if (typeof actualImage.decode === 'function' &&
                (handoff.decodedImage !== actualImage || handoff.decodedSrc !== displayedSrc)) {
                if (handoff.decodingImage === actualImage && handoff.decodingSrc === displayedSrc)
                    return;
                handoff.decodingImage = actualImage;
                handoff.decodingSrc = displayedSrc;
                void actualImage.decode().catch(() => {
                    // If decode() rejects for an already loaded image, avoid a permanent
                    // visual stall; X will render it itself.
                }).then(() => {
                    if (this.handoff !== handoff || handoff.decodingImage !== actualImage ||
                        handoff.decodingSrc !== displayedSrc)
                        return;
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
                if (this.handoff !== handoff)
                    return;
                const stillVisible = handoff.decodedImage &&
                    handoff.decodedImage.isConnected !== false &&
                    viewer.isConnected && handoff.decodedImage.complete &&
                    handoff.decodedImage.naturalWidth > 0 &&
                    (handoff.decodedImage.currentSrc || handoff.decodedImage.src || '') === handoff.decodedSrc &&
                    XMN.photoCdnIdentity(handoff.decodedSrc || '') === handoff.targetPhotoIdentity;
                if (stillVisible) {
                    this.clearVisualHandoff('native_photo_ready');
                }
                else {
                    // React can recycle the image again during this 90ms paint window.
                    // Avoid exposing an unrelated image; the 1.8s failsafe still expires.
                    handoff.revealTimer = null;
                    handoff.decodedImage = null;
                    handoff.decodedSrc = null;
                    this.finishVisualHandoff(viewer);
                }
            }, 90);
        }
        clearVisualHandoff(reason = 'cleanup') {
            const handoff = this.handoff;
            if (!handoff)
                return;
            diagnostic('preview.finished', {
                quality: handoff.quality, reason, visible: handoff.shown,
                visibleMs: handoff.shownAt == null ? 0 : Date.now() - handoff.shownAt,
            });
            this.handoff = null;
            window.clearTimeout(handoff.timeout);
            if (handoff.revealTimer !== null)
                window.clearTimeout(handoff.revealTimer);
            handoff.observer?.disconnect();
            if (handoff.waitingImage && handoff.waitingLoadHandler) {
                handoff.waitingImage.removeEventListener('load', handoff.waitingLoadHandler);
            }
            handoff.waitingImage = null;
            handoff.waitingLoadHandler = null;
            handoff.host.remove();
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
        /** Keep the already observed X link, but never trust it after React recycles it. */
        rememberLiveLink(ref, link, priority = false) {
            this.liveLinks ?? (this.liveLinks = new Map());
            const existing = this.liveLinks.has(ref.key);
            if (!existing && this.liveLinks.size >= 1024 && !priority)
                return;
            this.liveLinks.delete(ref.key);
            this.liveLinks.set(ref.key, link);
            while (this.liveLinks.size > 1024) {
                const oldest = this.liveLinks.keys().next().value;
                if (oldest === undefined)
                    break;
                this.liveLinks.delete(oldest);
            }
        }
        findLiveLink(ref) {
            if (!this.originProfile)
                return null;
            const column = mediaColumn();
            if (!column)
                return null;
            const cached = this.liveLinks?.get(ref.key);
            if (cached?.isConnected) {
                const tile = typeof cached.closest === 'function'
                    ? cached.closest(TILE_SELECTOR) : null;
                if (tile && (typeof column.contains !== 'function' || column.contains(tile))) {
                    const owner = usableTileLink(tile, this.originProfile);
                    if (owner?.link === cached && owner.ref.key === ref.key) {
                        // Refresh recent-use position without inspecting the whole media grid.
                        this.rememberLiveLink?.(ref, cached, true);
                        return cached;
                    }
                }
            }
            this.liveLinks?.delete(ref.key);
            for (const tile of column.querySelectorAll(TILE_SELECTOR)) {
                const found = usableTileLink(tile, this.originProfile);
                if (found?.ref.key === ref.key && found.link.isConnected) {
                    this.rememberLiveLink?.(ref, found.link, true);
                    return found.link;
                }
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
            // Keep the same 1.5s timeout but avoid a 125ms blank gap between
            // X closing its modal and the prefetched-photo handoff appearing.
            for (let i = 0; i < 30; i++) {
                if (!viewer.isConnected || !document.querySelector(VIEWER_SELECTOR))
                    return true;
                await pause(50);
            }
            return !viewer.isConnected;
        }
        /**
         * Try X's own media-tile SPA link before dismissing its dialog.
         * No URL/history writes, React hooks, GraphQL calls or new permissions.
         * A changed route is X-owned; never close/reopen it a second time.
         */
        async tryNativeInModalNavigation(target, link, viewer, generation) {
            const profile = this.originProfile;
            const sourcePath = window.location.pathname;
            const oldDialog = viewer.closest?.('[role="dialog"]');
            const href = link.getAttribute?.('href') ?? '';
            const linkRef = profile ? XMN.mediaRefFromHref(href, profile) : null;
            if (!profile || !link.isConnected || !viewer.isConnected || linkRef?.key !== target.key ||
                (link.target && link.target !== '_self') || link.hasAttribute?.('download'))
                return 'fallback';
            // Let X's delegated SPA listener handle the link, but cancel a browser
            // document navigation if it does not. Check whether X already claimed
            // the click BEFORE our safety guard calls preventDefault().
            let observedNativeClick = false;
            let claimedByX = false;
            const guard = (event) => {
                const node = event.target;
                if (node instanceof Node && (node === link || link.contains(node))) {
                    observedNativeClick = true;
                    claimedByX = event.defaultPrevented;
                    event.preventDefault();
                }
            };
            window.addEventListener('click', guard);
            try {
                link.click();
            }
            finally {
                window.removeEventListener('click', guard);
            }
            // If X did not claim a normally bubbling click, a native document
            // navigation would have happened without our guard. Allow 100ms for a
            // very short deferred route, not the full 300ms used for X-owned SPA.
            const probeCount = observedNativeClick && !claimedByX ? 3 : 7;
            for (let i = 0; i < probeCount; i++) {
                if (generation !== this.navGeneration || this.originProfile !== profile)
                    return 'abort';
                const route = XMN.mediaRefFromHref(window.location.pathname, profile);
                if (route?.key === target.key) {
                    const activeViewer = typeof this.findActiveViewer === 'function'
                        ? this.findActiveViewer() : document.querySelector(VIEWER_SELECTOR);
                    const dialogRetained = oldDialog && oldDialog.isConnected &&
                        activeViewer?.closest?.('[role="dialog"]') === oldDialog;
                    return (activeViewer === viewer && viewer.isConnected) || dialogRetained
                        ? 'retained' : 'navigated';
                }
                if (window.location.pathname !== sourcePath || !viewer.isConnected || !link.isConnected) {
                    // X already changed the route or dialog unexpectedly: no second click.
                    return 'abort';
                }
                if (i < probeCount - 1)
                    await pause(50);
            }
            return 'fallback';
        }
        /**
         * Avoid painting a second photo over X if its target is already loaded.
         * A stale currentSrc plus a different assigned src is NOT ready.
         */
        nativeSpaTargetRendered() {
            const handoff = this.handoff;
            if (!handoff || !this.viewer?.isConnected)
                return false;
            const image = this.displayedPhoto();
            if (!image || !image.complete || image.naturalWidth < 1)
                return false;
            const displayed = XMN.photoCdnIdentity(image.currentSrc || image.src || '');
            const assigned = XMN.photoCdnIdentity(image.src || '');
            return displayed === handoff.targetPhotoIdentity &&
                (!assigned || assigned === handoff.targetPhotoIdentity);
        }
        async navigate(direction) {
            const currentIndex = this.activeIndex();
            const oldViewer = this.viewer;
            if (this.navigationBusy || currentIndex === null || !oldViewer || !this.originProfile)
                return;
            const currentRef = this.refs[currentIndex];
            const nextIndex = XMN.adjacentPostIndex(this.refs, currentRef.statusId, direction, currentIndex);
            // Never change X's scroll position simply to discover an unseen post.
            // A new post URL cannot be inferred from its predecessor's ID. Keep
            // the exact current modal/replies panel until X itself loads more cards
            // from a user-initiated media-timeline scroll.
            if (nextIndex === null) {
                if (direction !== 1)
                    return;
                if (this.publicApiLoading) {
                    // One pending intent only; its path and generation are checked again
                    // after the public index is committed. Never queue multiple arrows.
                    this.pendingBoundary = { path: window.location.pathname,
                        statusId: currentRef.statusId, generation: this.navGeneration,
                        photoIdentity: this.currentPhotoIdentity() };
                    diagnostic('fxembed.boundary_waiting', { background: true });
                    this.toast('次の投稿を公開APIから取得中です');
                    return;
                }
                // This uses a separate public third-party API, not X's official API.
                // Ask only once per tab/profile before disclosing the public handle.
                const consentProfile = this.originProfile;
                const consentPath = window.location.pathname;
                const consentGeneration = this.navGeneration;
                this.sessionStore ?? (this.sessionStore = new XMN.SessionStore());
                const approved = await this.sessionStore.hasConsent(consentProfile);
                if (this.originProfile !== consentProfile ||
                    this.navGeneration !== consentGeneration ||
                    window.location.pathname !== consentPath || !oldViewer.isConnected)
                    return;
                if (!approved) {
                    const message = '続きの投稿を外部サービス FxEmbed の公開APIで取得しますか？' +
                        '公開プロフィール名と接続元IP等の通信情報がFxEmbedに伝わります。' +
                        'XのCookie・ログイン情報・閲覧履歴は送りません。';
                    if (typeof window.confirm !== 'function' || !window.confirm(message)) {
                        diagnostic('fxembed.consent_declined');
                        this.toast('ここまでが読み込み済みです。続きはXのメディア一覧で読み込んでください');
                        return;
                    }
                    if (!await this.sessionStore.grantConsent(consentProfile)) {
                        this.toast('拡張専用の一時保存を利用できないため、公開APIには接続しません');
                        return;
                    }
                    if (this.originProfile !== consentProfile ||
                        this.navGeneration !== consentGeneration ||
                        window.location.pathname !== consentPath || !oldViewer.isConnected)
                        return;
                    diagnostic('fxembed.consent_granted');
                }
                const appended = await this.loadPublicMediaContinuation();
                if (!appended) {
                    this.toast('公開APIで次の投稿を確認できませんでした。Xのメディア一覧で読み込んでください');
                    return;
                }
                // Newly verified public URL can now be navigated as a native X page,
                // without moving the underlying media grid.
                void this.navigate(direction);
                return;
            }
            const generation = this.navGeneration;
            const profile = this.originProfile;
            const initialDestination = this.findLiveLink(this.refs[nextIndex]);
            // An old media-timeline entry may have been evicted from X's virtualized DOM.
            // Do not close the active viewer when the known destination is no longer clickable.
            if (!initialDestination) {
                if (this.publicApiKeys?.has(this.refs[nextIndex].key) ||
                    (this.publicSessionRestored && this.indexes.has(this.refs[nextIndex].key))) {
                    // X's link may be absent after an API-driven document navigation.
                    // Only previously verified native or public refs may navigate here.
                    // Never fake a React SPA route with
                    // history.pushState: that can desync the image and reply panel.
                    // Use an ordinary X document navigation, preserving only verified
                    // A full-document transition is asynchronous. Keep one in-flight
                    // navigation request instead of issuing duplicate location.assign calls.
                    const destination = this.refs[nextIndex].href;
                    const prior = this.pendingDocumentHandoff;
                    if (prior && prior.generation === this.navGeneration &&
                        Date.now() - prior.started < 10000)
                        return;
                    const originPath = window.location.pathname;
                    const generation = this.navGeneration;
                    this.pendingDocumentHandoff = { target: destination,
                        started: Date.now(), generation };
                    // The extension worker keeps validated refs in tab-scoped memory.
                    if (!await this.persistPublicMediaSession() ||
                        originPath !== window.location.pathname ||
                        generation !== this.navGeneration || !oldViewer.isConnected) {
                        this.pendingDocumentHandoff = null;
                        this.toast('一時保存または画面状態の確認ができないため移動を中止しました');
                        return;
                    }
                    diagnostic('navigation.document_handoff', { kind: this.refs[nextIndex].kind ?? 'post' });
                    try {
                        window.location.assign(destination);
                    }
                    catch {
                        this.pendingDocumentHandoff = null;
                        this.toast('ページ移動に失敗しました');
                    }
                    return;
                }
                this.toast('移動先が一覧から消えています。ビューアは閉じません');
                return;
            }
            // A native in-modal SPA link does not need a close button. Only the
            // legacy close-and-reopen fallback depends on this control.
            const closeButton = this.findCloseButton(oldViewer);
            this.navigationBusy = true;
            this.updateViewerState();
            // Rapid arrow presses may overlap the 1.8s decoded-image handoff. A
            // preview for the prior destination must never paint over a new post.
            const nextRef = nextIndex === null ? null : this.refs[nextIndex];
            if (this.handoff && (!nextRef || this.handoff.targetStatus !== nextRef.statusId ||
                this.handoff.targetMediaIndex !== nextRef.mediaIndex)) {
                this.clearVisualHandoff();
            }
            let destinationOpened = false;
            try {
                // First let X navigate directly between observed photo links. If its
                // modal survives, the right tweet/replies panel is never dismissed.
                if (nextIndex !== null && initialDestination &&
                    currentRef.kind === 'photo' && this.refs[nextIndex].kind === 'photo' &&
                    typeof this.tryNativeInModalNavigation === 'function') {
                    // Prepare an already decoded photo invisibly. Only paint it when X
                    // accepted the new route but has not yet rendered its target image.
                    this.beginVisualHandoff(this.refs[nextIndex], initialDestination);
                    const result = await this.tryNativeInModalNavigation(this.refs[nextIndex], initialDestination, oldViewer, generation);
                    if (result === 'retained' || result === 'navigated') {
                        diagnostic('navigation.native_spa', { retained: result === 'retained' });
                        destinationOpened = true;
                        if (this.handoff && !this.nativeSpaTargetRendered()) {
                            this.showVisualHandoff();
                            const activeViewer = this.findActiveViewer();
                            if (activeViewer?.isConnected)
                                this.finishVisualHandoff(activeViewer);
                        }
                        else {
                            this.clearVisualHandoff();
                        }
                        return;
                    }
                    if (result === 'abort')
                        return;
                }
                if (generation !== this.navGeneration || !oldViewer.isConnected ||
                    !XMN.profileStatusFromPath(window.location.pathname, profile))
                    return;
                // The direct route was ignored by X. Only now use the proven
                // close-and-reopen fallback and its decoded photo bridge.
                if (!closeButton) {
                    this.toast('Xの閉じるボタンが見つからず、移動を中止しました');
                    return;
                }
                if (nextIndex !== null && !this.handoff)
                    this.beginVisualHandoff(this.refs[nextIndex], initialDestination);
                closeButton.click();
                if (!await this.waitForViewerToClose(oldViewer)) {
                    this.toast('ビューアを閉じられませんでした');
                    return;
                }
                if (generation !== this.navGeneration || XMN.mediaProfileFromPath(window.location.pathname) !== profile)
                    return;
                // SPA navigation may return to a different Photos/Videos filter than the
                // timeline that supplied these refs. Never open a ref from the wrong grid.
                const returnedTimeline = XMN.mediaTimelineKey(window.location.pathname, window.location.search);
                if (this.originTimeline && returnedTimeline !== this.originTimeline) {
                    // Some X routes drop ?filter=photo on modal close. Accept that
                    // normalization only when the EXACT same observed destination link
                    // remains connected; an explicit switch to video is never accepted.
                    const droppedFilter = returnedTimeline === `${profile}|default` &&
                        this.originTimeline !== `${profile}|default`;
                    const unchangedTarget = this.findLiveLink(this.refs[nextIndex]) === initialDestination &&
                        initialDestination.isConnected;
                    // No unknown destination is ever loaded behind the modal anymore.
                    // Do not trust an unrelated retained grid for filter normalization.
                    if (!droppedFilter || !unchangedTarget) {
                        this.toast('一覧の種類が切り替わったため、移動を中止しました');
                        return;
                    }
                }
                const destination = this.refs[nextIndex];
                if (generation !== this.navGeneration)
                    return;
                const link = destination.statusId !== currentRef.statusId ? this.findLiveLink(destination) : null;
                if (link) {
                    // The old X viewer is now closed. Keep its own photo visible
                    // until this point; showing the next image early caused a flash.
                    this.showVisualHandoff?.();
                    link.click();
                    destinationOpened = true;
                }
                else {
                    // Don't navigate to a guessed URL or re-open an unrelated status.
                    this.toast('次の項目を見つけられませんでした。一覧で続きを読み込んでください');
                    // Restore current viewer when its source is still present.
                    this.findLiveLink(currentRef)?.click();
                }
            }
            catch (error) {
                diagnostic('navigation.failed', {
                    reason: error instanceof Error ? error.name : 'unknown_exception',
                });
                this.toast('メディアの切り替えに失敗しました');
            }
            finally {
                if (!destinationOpened)
                    this.clearVisualHandoff?.();
                this.navigationBusy = false;
                this.updateViewerState();
                // The direct SPA route can change before the regular 450ms poll.
                // Start the next bounded lookahead immediately, if X kept the viewer.
                if (destinationOpened && this.viewer?.isConnected && this.imageSources)
                    this.schedulePreload?.();
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
