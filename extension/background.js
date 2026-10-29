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
var XMN;
(function (XMN) {
    const MAX_SESSION_CHARACTERS = 120000;
    const HANDLE = /^[a-zA-Z0-9_]{1,15}$/;
    const SESSION_PREFIX = 'xmn:session:';
    const CONSENT_PREFIX = 'xmn:consent:';
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
        if (msg.op === 'session.clear') {
            await chrome.storage.session.remove(sessionKey(id));
            return { ok: true };
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
            const all = await chrome.storage.session.get(null);
            const keys = Object.keys(all).filter(k => k === sessionKey(tabId) || k.startsWith(CONSENT_PREFIX + tabId + ':'));
            if (keys.length)
                await chrome.storage.session.remove(keys);
        })().catch(() => { });
    });
})(XMN || (XMN = {}));
