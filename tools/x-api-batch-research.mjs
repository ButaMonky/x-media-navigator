/**
 * OFFLINE study only: documented X API v2 user-Posts pagination/media expansions.
 *
 * No network request, credential loading, browser cookie use, extension changes,
 * auth shortcut, account automation, or X media-tab ordering assumptions.
 * API results are NOT equivalent to X's interactive profile Media tab, and
 * the generated photo links are theoretical until verified by X-native DOM.
 *
 * Docs:
 * https://docs.x.com/x-api/users/get-posts
 * https://docs.x.com/x-api/getting-started/pricing
 */
const idPattern = /^[0-9]{1,19}$/;
const handlePattern = /^[A-Za-z0-9_]{1,15}$/;

export function buildUserPostsApiUrl(userId, paginationToken) {
  if (typeof userId !== 'string' || !idPattern.test(userId))
    throw new TypeError('An explicitly supplied numeric X user ID is required');
  const url = new URL(`https://api.x.com/2/users/${userId}/tweets`);
  url.searchParams.set('max_results', '100');
  url.searchParams.set('post.fields', 'attachments');
  url.searchParams.set('expansions', 'attachments.media_keys');
  url.searchParams.set('media.fields', 'media_key,type,url,width,height');
  if (paginationToken != null) {
    if (typeof paginationToken !== 'string' ||
        !/^[A-Za-z0-9_-]{1,512}$/.test(paginationToken))
      throw new TypeError('Expected a validated X pagination token');
    url.searchParams.set('pagination_token', paginationToken);
  }
  return url.toString();
}

function knownImageUrl(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'pbs.twimg.com' ||
        url.port || url.username || url.password) return null;
    if (!/^\/media\/[A-Za-z0-9_-]+(?:\.(?:jpg|jpeg|png|webp))?$/i.test(url.pathname))
      return null;
    return url.toString();
  } catch { return null; }
}

export function studyUserPostsPage(data, profile) {
  if (typeof profile !== 'string' || !handlePattern.test(profile))
    throw new TypeError('The public profile handle must be supplied explicitly');
  const media = new Map();
  for (const item of Array.isArray(data?.includes?.media) ? data.includes.media : []) {
    if (!item || typeof item.media_key !== 'string') continue;
    if (!media.has(item.media_key)) media.set(item.media_key, item);
  }
  const posts = [];
  let skipped = 0;
  const seen = new Set();
  for (const post of Array.isArray(data?.data) ? data.data : []) {
    if (!post || typeof post.id !== 'string' || !idPattern.test(post.id) ||
        seen.has(post.id)) { skipped++; continue; }
    seen.add(post.id);
    const keys = post.attachments?.media_keys;
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 4 ||
        new Set(keys).size !== keys.length) { skipped++; continue; }
    const attachments = keys.map(key => media.get(key));
    // Mixed photo/video/GIF, missing expansion, and unknown CDNs are NOT safe
    // to convert to X's numbered photo links without actual X gallery DOM.
    if (attachments.some(item => !item || item.type !== 'photo')) {
      skipped++; continue;
    }
    const urls = attachments.map(item => knownImageUrl(item.url));
    if (urls.some(url => !url)) { skipped++; continue; }
    posts.push({
      statusId: post.id,
      // Research hypotheses, not authenticated/observed native X links.
      photoHrefs: urls.map((_, i) =>
        `/${profile.toLowerCase()}/status/${post.id}/photo/${i + 1}`),
      mediaUrls: urls,
    });
  }
  return {
    candidatePosts: posts,
    skippedOrUnsupportedPosts: skipped,
    pageHasContinuation: typeof data?.meta?.next_token === 'string' &&
      data.meta.next_token.length > 0,
    // Never assume the returned API ordering/filter matches X's Media tab.
    exactXMediaTabOrderProven: false,
  };
}
