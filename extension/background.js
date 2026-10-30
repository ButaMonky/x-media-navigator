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
/// <reference path="./core.ts" />
/** B2: a manifest commits immutable page boundaries without evicting the X viewer.
 * This module defines data invariants only; it never fetches, navigates or
 * interprets a volunteer API cursor as proof of missing/complete X posts.
 */
var XMN;
(function (XMN) {
    const MANIFEST_FIELDS = [
        'schema', 'profile', 'timeline', 'expires', 'activePage', 'pages'
    ];
    const PAGE_FIELDS = [
        'page', 'firstRef', 'lastRef', 'mediaCount', 'incomingCursor', 'outgoingCursor'
    ];
    const exactFields = (v, fields) => {
        const own = Object.keys(v);
        return own.length === fields.length && own.every(key => fields.includes(key));
    };
    const cursorValid = (v) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 1024);
    const older = (a, b) => a.padStart(19, '0') < b.padStart(19, '0');
    function parsePublicPageManifest(input, profile) {
        if (!input || typeof input !== 'object' || Array.isArray(input))
            return null;
        const m = input;
        if (!exactFields(m, MANIFEST_FIELDS) || m.schema !== 1 ||
            typeof m.profile !== 'string' || m.profile !== profile.toLowerCase() ||
            typeof m.timeline !== 'string' ||
            !['default', 'photo', 'video'].some(k => m.timeline === m.profile + '|' + k) ||
            typeof m.expires !== 'number' || !Number.isFinite(m.expires) ||
            m.expires <= Date.now() || m.expires > Date.now() + 31 * 60000 ||
            !Array.isArray(m.pages) || m.pages.length < 1 || m.pages.length > 64 ||
            !Number.isSafeInteger(m.activePage) ||
            m.activePage < 0 || m.activePage >= m.pages.length)
            return null;
        const rows = [];
        let priorLast = null;
        let priorCursor = null;
        for (let i = 0; i < m.pages.length; i++) {
            const row = m.pages[i];
            if (!row || typeof row !== 'object' || Array.isArray(row) ||
                !exactFields(row, PAGE_FIELDS))
                return null;
            const p = row;
            if (p.page !== i || !Number.isSafeInteger(p.mediaCount) ||
                p.mediaCount < 1 || p.mediaCount > 450 ||
                typeof p.firstRef !== 'string' || typeof p.lastRef !== 'string' ||
                !cursorValid(p.incomingCursor) || !cursorValid(p.outgoingCursor))
                return null;
            const first = XMN.mediaRefFromHref(p.firstRef, profile);
            const last = XMN.mediaRefFromHref(p.lastRef, profile);
            if (!first || !last || first.href !== p.firstRef || last.href !== p.lastRef ||
                older(first.statusId, last.statusId))
                return null;
            if (i === 0 && p.incomingCursor !== null)
                return null;
            if (i > 0 && (p.incomingCursor !== priorCursor ||
                priorCursor === null || priorLast === null ||
                !older(first.statusId, priorLast)))
                return null;
            priorLast = last.statusId;
            priorCursor = p.outgoingCursor;
            rows.push(p);
        }
        return m;
    }
    XMN.parsePublicPageManifest = parsePublicPageManifest;
    function samePublicPageDescriptor(a, b) {
        return a.page === b.page && a.firstRef === b.firstRef &&
            a.lastRef === b.lastRef && a.mediaCount === b.mediaCount &&
            a.incomingCursor === b.incomingCursor && a.outgoingCursor === b.outgoingCursor;
    }
    XMN.samePublicPageDescriptor = samePublicPageDescriptor;
    function publicPageMatchesDescriptor(input, desc, profile, timeline, manifestExpires) {
        const refs = input.refs;
        if (input.profile !== profile || input.timeline !== timeline ||
            typeof input.expires !== 'number' || manifestExpires > input.expires ||
            !Array.isArray(refs) || refs.length !== desc.mediaCount ||
            refs[0] !== desc.firstRef || refs[refs.length - 1] !== desc.lastRef ||
            input.cursor !== desc.outgoingCursor ||
            input.anchorFound !== true)
            return false;
        // No split post may cross a committed page boundary.
        return true;
    }
    XMN.publicPageMatchesDescriptor = publicPageMatchesDescriptor;
    function planPublicBoundaryTransition(input, profile, sourceRef, direction, verifiedTargetRoute) {
        const m = parsePublicPageManifest(input, profile);
        if (!m || (direction !== 1 && direction !== -1))
            return null;
        const expectedActivePage = m.activePage;
        const targetPage = expectedActivePage + direction;
        if (targetPage < 0 || targetPage >= m.pages.length)
            return null;
        const source = m.pages[expectedActivePage];
        const target = m.pages[targetPage];
        if (sourceRef !== (direction === 1 ? source.lastRef : source.firstRef))
            return null;
        // On a reverse hop the last post may contain multiple photos: Worker
        // must prove that the destination is the first media of that post.
        const targetRef = direction === 1 ? target.firstRef :
            (verifiedTargetRoute ?? target.lastRef);
        const parsed = XMN.mediaRefFromHref(targetRef, profile);
        const tail = XMN.mediaRefFromHref(target.lastRef, profile);
        if (!parsed || parsed.href !== targetRef || !tail ||
            (direction === -1 && parsed.statusId !== tail.statusId) ||
            (direction === 1 && targetRef !== target.firstRef))
            return null;
        return { expectedActivePage, targetPage, direction, sourceRef, targetRef };
    }
    XMN.planPublicBoundaryTransition = planPublicBoundaryTransition;
})(XMN || (XMN = {}));
/// <reference path="./core.ts" />
var XMN;
(function (XMN) {
    const MAX_SESSION_CHARACTERS = 120000;
    const SESSION_FIELDS = [
        'schema', 'profile', 'timeline', 'expires', 'refs', 'apiKeys',
        'photos', 'photoTotals', 'cursor', 'anchorFound', 'exhausted'
    ];
    const canonicalSession = (value) => JSON.stringify(SESSION_FIELDS.map(key => [key, value[key]]));
    const HANDLE = /^[a-zA-Z0-9_]{1,15}$/;
    const SESSION_PREFIX = 'xmn:session:';
    const CONSENT_PREFIX = 'xmn:consent:';
    const CHECKPOINT_PREFIX = 'xmn:checkpoint:';
    const MANIFEST_PREFIX = 'xmn:manifest:';
    const MAX_CHECKPOINT_PAGES = 64; // Up to ~28,800 media references in memory.
    const validTab = (sender, profile) => {
        const tab = sender.tab?.id;
        if (typeof tab !== 'number' || !Number.isSafeInteger(tab) || tab < 0 || sender.frameId !== 0 ||
            typeof profile !== 'string' || !HANDLE.test(profile))
            return null;
        try {
            const url = new URL(sender.url || '');
            if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com',
                'www.twitter.com'].includes(url.hostname))
                return null;
            const owner = profile.toLowerCase();
            if (XMN.mediaProfileFromPath(url.pathname) !== owner &&
                !XMN.profileStatusFromPath(url.pathname, profile))
                return null;
            return tab;
        }
        catch {
            return null;
        }
    };
    function validateSession(data, profile) {
        if (!data || typeof data !== 'object' || Array.isArray(data))
            return false;
        const x = data;
        // Never persist unsolicited fields such as page data, access tokens or
        // arbitrary nested objects as part of the short-lived public index.
        if (Object.keys(x).length !== SESSION_FIELDS.length ||
            Object.keys(x).some(key => !SESSION_FIELDS.includes(key)))
            return false;
        const p = profile.toLowerCase();
        if (x.schema !== 1 || x.profile !== p || typeof x.expires !== 'number' ||
            !Number.isFinite(x.expires) || x.expires <= Date.now() ||
            x.expires > Date.now() + 31 * 60 * 1000 ||
            !['default', 'photo', 'video'].some(t => x.timeline === p + '|' + t) ||
            !Array.isArray(x.refs) || x.refs.length < 1 || x.refs.length > 450 ||
            !Array.isArray(x.apiKeys) || x.apiKeys.length < 1 || x.apiKeys.length > 450 ||
            (x.cursor !== null && (typeof x.cursor !== 'string' ||
                x.cursor.length < 1 || x.cursor.length > 1024)) ||
            typeof x.anchorFound !== 'boolean' || typeof x.exhausted !== 'boolean')
            return false;
        let last = '';
        const keys = new Set(), groups = new Set();
        for (const raw of x.refs) {
            if (typeof raw !== 'string' || raw.length > 128)
                return false;
            const ref = XMN.mediaRefFromHref(raw, p);
            if (!ref || ref.href !== raw || keys.has(ref.key))
                return false;
            keys.add(ref.key);
            if (ref.statusId !== last) {
                if (groups.has(ref.statusId) || (last &&
                    ref.statusId.padStart(19, '0') >= last.padStart(19, '0')))
                    return false;
                groups.add(ref.statusId);
                last = ref.statusId;
            }
        }
        for (const key of x.apiKeys) {
            if (typeof key !== 'string' || !keys.has(key))
                return false;
        }
        if (!Array.isArray(x.photos) || x.photos.length > 450 ||
            !Array.isArray(x.photoTotals) || x.photoTotals.length > 128)
            return false;
        for (const item of x.photos) {
            if (!Array.isArray(item) || item.length !== 2 || !keys.has(item[0]) ||
                typeof item[1] !== 'string' || XMN.preloadImageUrl(item[1]) !== item[1])
                return false;
        }
        for (const item of x.photoTotals) {
            if (!Array.isArray(item) || item.length !== 2 ||
                typeof item[0] !== 'string' || !/^\d{1,19}$/.test(item[0]) ||
                !Number.isInteger(item[1]) || item[1] < 1 || item[1] > 4 ||
                !groups.has(item[0]))
                return false;
        }
        try {
            return JSON.stringify(x).length <= MAX_SESSION_CHARACTERS;
        }
        catch {
            return false;
        }
    }
    const sessionKey = (id) => SESSION_PREFIX + id;
    const consentKey = (id, profile) => CONSENT_PREFIX + id + ':' + profile.toLowerCase();
    const checkpointPrefix = (id, profile) => CHECKPOINT_PREFIX + id + ':' + profile.toLowerCase() + ':';
    const checkpointKey = (id, profile, page) => checkpointPrefix(id, profile) + page;
    const checkpointPage = (page) => typeof page === 'number' && Number.isSafeInteger(page) &&
        page >= 0 && page < MAX_CHECKPOINT_PAGES;
    const manifestKey = (tab, profile) => MANIFEST_PREFIX + tab + ':' + profile.toLowerCase();
    const manifestJobs = new Map();
    async function withManifestLock(key, operation) {
        const previous = manifestJobs.get(key) ?? Promise.resolve();
        const current = previous.catch(() => undefined).then(operation);
        manifestJobs.set(key, current);
        try {
            return await current;
        }
        finally {
            if (manifestJobs.get(key) === current)
                manifestJobs.delete(key);
        }
    }
    async function verifyManifestPages(manifest, tab, profile) {
        const keys = manifest.pages.map(meta => checkpointKey(tab, profile, meta.page));
        const stored = await chrome.storage.session.get(keys);
        for (let i = 0; i < manifest.pages.length; i++) {
            const value = stored[keys[i]];
            if (!validateSession(value, profile))
                return false;
            if (!XMN.publicPageMatchesDescriptor(value, manifest.pages[i], profile, manifest.timeline, manifest.expires))
                return false;
        }
        return true;
    }
    // A page slot is immutable. Concurrent writes to the same slot serialize;
    // a replay is idempotent and a different payload is rejected.
    const checkpointWrites = new Map();
    async function storeCheckpointOnce(key, payload) {
        const prior = checkpointWrites.get(key) ?? Promise.resolve(true);
        const write = prior.catch(() => false).then(async () => {
            const existing = (await chrome.storage.session.get(key))[key];
            if (existing !== undefined) {
                try {
                    // Chrome may reorder object fields during storage serialization.
                    // Equal snapshots are still idempotent; different cursor/ref data
                    // must never replace an immutable historical page.
                    return canonicalSession(existing) ===
                        canonicalSession(payload);
                }
                catch {
                    return false;
                }
            }
            await chrome.storage.session.set({ [key]: payload });
            return true;
        });
        checkpointWrites.set(key, write);
        try {
            return await write;
        }
        finally {
            if (checkpointWrites.get(key) === write)
                checkpointWrites.delete(key);
        }
    }
    async function deleteCheckpointPages(tabId, profile, page) {
        const prefix = checkpointPrefix(tabId, profile);
        // A pending immutable write must finish before all pages are enumerated.
        const pending = [...checkpointWrites.entries()]
            .filter(([key]) => page === undefined
            ? key.startsWith(prefix)
            : key === checkpointKey(tabId, profile, page))
            .map(([, write]) => write.catch(() => false));
        if (pending.length)
            await Promise.all(pending);
        const keys = page === undefined
            ? Object.keys(await chrome.storage.session.get(null))
                .filter(key => key.startsWith(prefix))
            : [checkpointKey(tabId, profile, page)];
        if (keys.length)
            await chrome.storage.session.remove(keys);
    }
    async function handle(msg, sender) {
        if (msg.kind !== 'xmn-store-v1')
            return { ok: false };
        const id = validTab(sender, msg.profile);
        if (id === null || typeof msg.profile !== 'string')
            return { ok: false };
        const profile = msg.profile.toLowerCase();
        if (msg.op === 'consent.get') {
            const data = await chrome.storage.session.get(consentKey(id, profile));
            return { ok: true, granted: data[consentKey(id, profile)] === true };
        }
        if (msg.op === 'consent.set') {
            await chrome.storage.session.set({ [consentKey(id, profile)]: true });
            return { ok: true };
        }
        if (msg.op === 'session.get') {
            const key = sessionKey(id);
            const data = await chrome.storage.session.get(key);
            const saved = data[key];
            if (!validateSession(saved, profile)) {
                if (saved !== undefined)
                    await chrome.storage.session.remove(key);
                return { ok: true, session: null };
            }
            return { ok: true, session: saved };
        }
        if (msg.op === 'session.set') {
            if (!validateSession(msg.session, profile))
                return { ok: false };
            await chrome.storage.session.set({ [sessionKey(id)]: msg.session });
            return { ok: true };
        }
        if (msg.op === 'session.clear' || msg.op === 'checkpoint.clear' ||
            msg.op === 'manifest.clear') {
            if (msg.op === 'checkpoint.clear' && msg.page !== undefined &&
                !checkpointPage(msg.page))
                return { ok: false };
            return withManifestLock(manifestKey(id, profile), async () => {
                await deleteCheckpointPages(id, profile, msg.op === 'checkpoint.clear' ? msg.page : undefined);
                const remove = [manifestKey(id, profile)];
                if (msg.op === 'session.clear')
                    remove.push(sessionKey(id));
                await chrome.storage.session.remove(remove);
                return { ok: true };
            });
        }
        if (msg.op === 'checkpoint.find' || msg.op === 'checkpoint.adjacent') {
            if (msg.op === 'checkpoint.adjacent' && msg.direction !== -1 &&
                msg.direction !== 1)
                return { ok: false };
            // A historical page may be selected only by the exact public media URL
            // already displayed in this TOP-FRAME X tab. No cross-post lookup.
            if (typeof msg.href !== 'string' || msg.href.length > 128)
                return { ok: false };
            const ref = XMN.mediaRefFromHref(msg.href, profile);
            if (!ref || ref.kind === null || ref.href !== msg.href)
                return { ok: false };
            const targetHref = msg.href;
            try {
                if (new URL(sender.url || '').pathname !== msg.href)
                    return { ok: false };
            }
            catch {
                return { ok: false };
            }
            const consent = (await chrome.storage.session.get(consentKey(id, profile)))[consentKey(id, profile)];
            if (consent !== true)
                return { ok: false };
            const key = manifestKey(id, profile);
            return withManifestLock(key, async () => {
                const saved = (await chrome.storage.session.get(key))[key];
                if (saved === undefined)
                    return { ok: true, session: null, page: null };
                const manifest = XMN.parsePublicPageManifest(saved, profile);
                if (!manifest) {
                    await chrome.storage.session.remove(key);
                    return { ok: true, session: null, page: null };
                }
                const keys = manifest.pages.map(meta => checkpointKey(id, profile, meta.page));
                const storage = await chrome.storage.session.get(keys);
                let chosen = null;
                let selected = null;
                for (let i = 0; i < keys.length; i++) {
                    const data = storage[keys[i]];
                    if (!validateSession(data, profile) ||
                        !XMN.publicPageMatchesDescriptor(data, manifest.pages[i], profile, manifest.timeline, manifest.expires)) {
                        await chrome.storage.session.remove(key);
                        return { ok: true, session: null, page: null };
                    }
                    if (data.refs.includes(targetHref)) {
                        if (chosen !== null) {
                            // One X media URL may not belong to two committed page windows.
                            await chrome.storage.session.remove(key);
                            return { ok: true, session: null, page: null };
                        }
                        chosen = data;
                        selected = manifest.pages[i].page;
                    }
                }
                if (msg.op === 'checkpoint.adjacent') {
                    if (chosen === null || selected === null ||
                        selected !== manifest.activePage)
                        return { ok: true, href: null, page: null };
                    const ownRefs = chosen.refs;
                    const firstStatus = XMN.mediaRefFromHref(ownRefs[0], profile)?.statusId;
                    const lastStatus = XMN.mediaRefFromHref(ownRefs[ownRefs.length - 1], profile)?.statusId;
                    if (msg.direction === 1 && ref.statusId === lastStatus &&
                        selected < keys.length - 1) {
                        const next = storage[keys[selected + 1]];
                        const urls = next.refs;
                        return { ok: true, href: urls[0], page: selected + 1 };
                    }
                    if (msg.direction === -1 && ref.statusId === firstStatus &&
                        selected > 0) {
                        const previous = storage[keys[selected - 1]];
                        const urls = previous.refs;
                        const tail = XMN.mediaRefFromHref(urls[urls.length - 1], profile)?.statusId;
                        // Navigate to the FIRST image of the adjoining (newer) post.
                        const destination = urls.find(url => XMN.mediaRefFromHref(url, profile)?.statusId === tail);
                        return { ok: true, href: destination ?? null,
                            page: destination ? selected - 1 : null };
                    }
                    return { ok: true, href: null, page: null };
                }
                return { ok: true, session: chosen, page: selected };
            });
        }
        if (msg.op === 'manifest.get' || msg.op === 'manifest.put' ||
            msg.op === 'manifest.activate') {
            const consent = (await chrome.storage.session.get(consentKey(id, profile)))[consentKey(id, profile)];
            if (consent !== true)
                return { ok: false };
            const key = manifestKey(id, profile);
            return withManifestLock(key, async () => {
                const saved = (await chrome.storage.session.get(key))[key];
                if (msg.op === 'manifest.get') {
                    if (saved === undefined)
                        return { ok: true, manifest: null };
                    const current = XMN.parsePublicPageManifest(saved, profile);
                    if (!current || !await verifyManifestPages(current, id, profile)) {
                        await chrome.storage.session.remove(key);
                        return { ok: true, manifest: null };
                    }
                    return { ok: true, manifest: current };
                }
                if (msg.op === 'manifest.activate') {
                    const current = XMN.parsePublicPageManifest(saved, profile);
                    if (!current || !await verifyManifestPages(current, id, profile))
                        return { ok: false };
                    const raw = msg.transition;
                    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
                        return { ok: false };
                    const t = raw;
                    const fields = ['expectedActivePage', 'targetPage', 'direction',
                        'sourceRef', 'targetRef'];
                    if (Object.keys(t).length !== fields.length ||
                        Object.keys(t).some(field => !fields.includes(field)) ||
                        typeof t.sourceRef !== 'string' || typeof t.targetRef !== 'string' ||
                        (t.direction !== 1 && t.direction !== -1) ||
                        !Number.isSafeInteger(t.expectedActivePage) ||
                        !Number.isSafeInteger(t.targetPage))
                        return { ok: false };
                    const expected = XMN.planPublicBoundaryTransition(current, profile, t.sourceRef, t.direction, t.targetRef);
                    if (!expected || fields.some(field => t[field] !== expected[field]))
                        return { ok: false };
                    try {
                        if (new URL(sender.url || '').pathname !== expected.targetRef)
                            return { ok: false };
                    }
                    catch {
                        return { ok: false };
                    }
                    const desc = current.pages[expected.targetPage];
                    const target = (await chrome.storage.session.get(checkpointKey(id, profile, expected.targetPage)))[checkpointKey(id, profile, expected.targetPage)];
                    if (!validateSession(target, profile) || !XMN.publicPageMatchesDescriptor(target, desc, profile, current.timeline, current.expires))
                        return { ok: false };
                    const refs = target.refs;
                    const lastStatus = XMN.mediaRefFromHref(refs[refs.length - 1], profile)?.statusId;
                    const backFirst = refs.find(url => XMN.mediaRefFromHref(url, profile)?.statusId === lastStatus);
                    // Rewinding to the last post must open its FIRST media, not the
                    // last image of a multiple-photo album.
                    if (expected.direction === -1 && expected.targetRef !== backFirst)
                        return { ok: false };
                    if (expected.direction === 1 && expected.targetRef !== refs[0])
                        return { ok: false };
                    const updated = {
                        ...current, activePage: expected.targetPage
                    };
                    await chrome.storage.session.set({
                        [key]: updated, [sessionKey(id)]: target
                    });
                    return { ok: true, session: target, manifest: updated };
                }
                const next = XMN.parsePublicPageManifest(msg.manifest, profile);
                if (!next || (saved === undefined && next.activePage !== 0))
                    return { ok: false };
                if (saved !== undefined) {
                    const previous = XMN.parsePublicPageManifest(saved, profile);
                    if (!previous || previous.timeline !== next.timeline ||
                        next.activePage !== previous.activePage ||
                        next.expires > previous.expires ||
                        next.pages.length < previous.pages.length ||
                        previous.pages.some((desc, i) => !XMN.samePublicPageDescriptor(desc, next.pages[i])))
                        return { ok: false };
                }
                if (!await verifyManifestPages(next, id, profile))
                    return { ok: false };
                await chrome.storage.session.set({ [key]: next });
                return { ok: true };
            });
        }
        if (msg.op === 'checkpoint.put' || msg.op === 'checkpoint.get' ||
            msg.op === 'checkpoint.list') {
            const consent = (await chrome.storage.session.get(consentKey(id, profile)))[consentKey(id, profile)];
            if (consent !== true)
                return { ok: false };
            if (msg.op === 'checkpoint.put' || msg.op === 'checkpoint.get') {
                if (!checkpointPage(msg.page))
                    return { ok: false };
                const key = checkpointKey(id, profile, msg.page);
                if (msg.op === 'checkpoint.put') {
                    if (!validateSession(msg.session, profile) ||
                        msg.session.anchorFound !== true)
                        return { ok: false };
                    return { ok: await storeCheckpointOnce(key, msg.session) };
                }
                const saved = (await chrome.storage.session.get(key))[key];
                if (saved === undefined)
                    return { ok: true, session: null };
                if (!validateSession(saved, profile)) {
                    await chrome.storage.session.remove(key);
                    return { ok: true, session: null };
                }
                return { ok: true, session: saved };
            }
            const prefix = checkpointPrefix(id, profile);
            const stored = await chrome.storage.session.get(null);
            const pages = [];
            const corrupt = [];
            for (const [key, value] of Object.entries(stored)) {
                if (!key.startsWith(prefix))
                    continue;
                const raw = key.slice(prefix.length);
                const page = Number(raw);
                if (!/^\d+$/.test(raw) || !checkpointPage(page) ||
                    String(page) !== raw || !validateSession(value, profile))
                    corrupt.push(key);
                else
                    pages.push(page);
            }
            if (corrupt.length)
                await chrome.storage.session.remove(corrupt);
            return { ok: true, pages: pages.sort((a, b) => a - b) };
        }
        return { ok: false };
    }
    chrome.runtime.onMessage.addListener((raw, sender, reply) => {
        if (!raw || typeof raw !== 'object' || raw.kind !== 'xmn-store-v1')
            return false;
        void handle(raw, sender)
            .then(reply).catch(() => reply({ ok: false }));
        return true; // Keep response port alive on every supported Chrome version.
    });
    chrome.tabs.onRemoved.addListener(tabId => {
        // Tab IDs may be reused. Never let another tab inherit prior consent.
        void (async () => {
            const prefix = CHECKPOINT_PREFIX + tabId + ':';
            const manifestPrefix = MANIFEST_PREFIX + tabId + ':';
            // A tab ID may be recycled. Clear already-started transactions first.
            await Promise.all([...manifestJobs.entries()]
                .filter(([key]) => key.startsWith(manifestPrefix))
                .map(([, job]) => job.catch(() => undefined)));
            await Promise.all([...checkpointWrites.entries()]
                .filter(([key]) => key.startsWith(prefix))
                .map(([, write]) => write.catch(() => false)));
            const all = await chrome.storage.session.get(null);
            const keys = Object.keys(all).filter(k => k === sessionKey(tabId) || k.startsWith(CONSENT_PREFIX + tabId + ':') ||
                k.startsWith(prefix) || k.startsWith(manifestPrefix));
            if (keys.length)
                await chrome.storage.session.remove(keys);
        })().catch(() => { });
    });
})(XMN || (XMN = {}));
