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
  const DIAGNOSTIC_VERSION = '2.4.25-dev';
  // Only numeric counts, booleans, and fixed operation labels are reported.
  // Never record X URLs, handles, post IDs, cookies, tokens or API cursors.
  function diagnostic(event: string, details: Record<string, string | number | boolean> = {}): void {
    try { console.info(`[XMN ${DIAGNOSTIC_VERSION}] ${event}`, details); }
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

  /** CSS-hidden React slides are not active even while attached. */
  function viewerStyleVisible(viewer: HTMLElement): boolean {
    if (typeof window.getComputedStyle !== 'function') return true;
    try {
      const style=window.getComputedStyle(viewer);
      const opacity=Number.parseFloat(style.opacity || '1');
      return style.display !== 'none' && style.visibility !== 'hidden' &&
        style.visibility !== 'collapse' &&
        Number.isFinite(opacity) && opacity>0.01;
    } catch { return false; }
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
    targetPrefetchUrl: string;
    quality: 'low' | 'high';
    timeout: number;
    generation: number;
    shown: boolean;
    shownAt: number | null;
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

  /** Store canonical media refs; ephemeral DOM handles are bounded and revalidated. */
  export class Controller {
    private sessionStore: SessionStore = new SessionStore();
    private originProfile: string | null = null;
    private originTimeline: string | null = null;
    private pendingGrid: { column: Element | null; firstTiles: Element[]; firstKeys: string[]; lastTiles?: Element[]; lastKeys?: string[]; tileCount?: number } | null = null;
    private refs: MediaRef[] = [];
    private indexes = new Map<string, number>();
    // Validated post groups are rebuilt only when the underlying media index
    // changes, not on each arrow or five-image prefetch.
    private postWindowCache: {
      refs: MediaRef[]; length: number; first: string; last: string;
      profile: string | null; model: ValidatedMediaWindowIndex | null;
    } | null = null;
    // Bounded, validated live DOM handles; never stored across a session reset.
    private liveLinks = new Map<string, HTMLAnchorElement>();
    // Append-only media ordering lets route updates reuse first-seen post
    // ordinals instead of rebuilding a Set/array for every arrow press.
    private statusOrdinalCache: {
      refs: MediaRef[]; length: number; byStatus: Map<string,number>;
    } | null = null;
    private imageSources = new Map<string, string>();
    private imageSourcesRevision = 0;
    private knownPhotoTotals = new Map<string, number>();
    private prefetched = new Map<string, PrefetchedPhoto>();
    private prefetchQueue: string[] = [];
    private prefetchWanted = new Set<string>();
    private prefetchInFlight = 0;
    private prefetchPolicyStopping = false;
    private prefetchFailed = new Set<string>();
    private prefetchTooLarge = new Set<string>();
    private prefetchFailurePath = '';
    private preopenExpireTimer: number | null = null;
    private handoff: VisualHandoff | null = null;
    private preloadTimer: number | null = null;
    private preloadForPath = '';
    private nativeAdvancedPost: string | null = null;
    private rightProbeTimer: number | null = null;
    // Read-only, no-cookie public-media continuation for the private beta.
    // Never fetch until reaching the end of the already observed X media grid.
    private publicApiKeys = new Set<string>();
    private publicApiCursor: string | null = null;
    private publicApiAnchorFound = false;
    private publicApiExhausted = false;
    private publicApiLoading = false;
    private publicApiAbort: AbortController|null=null;
    private publicApiCancelReason: 'hidden'|'route_changed'|'timeout'|null=null;
    private publicApiRetryAt=0;
    private publicApiFailures=0;
    // Only the most recent eligible end-of-list key may resume after warmup.
    private pendingBoundary: {path:string;statusId:string;generation:number;photoIdentity:string|null}|null=null;
    private pendingDocumentHandoff: {target:string;started:number;generation:number}|null=null;
    private checkpointBoundaryPending=false;
    private restoredCheckpointPage:number|null=null;
    // Own an asynchronous manifest preflight until it completes. Two keys
    // in the same route must not query the Worker or API concurrently.
    private publicApiPreflightGeneration:number|null=null;
    // Consent prompts are user-visible. Two rapid arrows may not open two
    // third-party permission dialogs before either MV3 read finishes.
    private publicConsentPendingGeneration:number|null=null;
    // A checkpoint with a committed next page or full 64-page quota must not
    // repeatedly contact the volunteer provider for unusable pagination.
    private checkpointContinuationBlocked=false;
    private checkpointCapacityReached=false;
    // Warm only after the user has explicitly allowed this external provider.
    private publicApiWarmCursor: string | null = null;
    private publicApiWarmTimer: number | null = null;
    // Persisted X-observed native refs stay navigable after a public API handoff.
    private publicSessionRestored = false;

    private viewer: HTMLElement | null = null;
    // Portaled controls live outside X's React-owned photo carousel. X may
    // unmount or hide a slide's children on photo 2 without closing the modal.
    private controlsHost: HTMLDivElement | null = null;
    private controlsViewer: HTMLElement | null = null;
    private controlsDialog: Element | null = null;
    // Lock arrows to the PHOTO PANE in viewport coordinates. X can animate,
    // translate or recycle its inner swipe viewer on every post transition;
    // reusing that moving bounding box causes accumulating apparent drift.
    private controlsPaneAnchor: {
      left: number; top: number; width: number; height: number;
      viewportWidth: number; viewportHeight: number;
      fullscreenRoot: Element | null;
    } | null = null;
    private controlsGeometryKey = '';
    private controlsLayoutPath = '';
    private activeViewerPath = '';
    // Ignore unchanged 450ms polling cycles instead of walking the full
    // media timeline to rebuild identical button state and position labels.
    private viewerStateSnapshot: { viewer: HTMLElement; key: string } | null = null;
    private viewObserver: MutationObserver | null = null;
    private modalObserver: MutationObserver | null = null;
    private listObserver: MutationObserver | null = null;
    private observedColumn: Element | null = null;
    private lastPath = '';
    private scanTimer: number | null = null;
    private routeTickTimer: number | null = null;
    private observedRouteKey = '';
    private pendingFullScan = false;
    private pendingSourceTiles = new Set<HTMLElement>();
    private navigationBusy = false;
    private navGeneration = 0;
    private refreshId: number;

    constructor() {
      clearLegacyPageSession();
      void this.restorePublicMediaSession().catch(() => {}).finally(() => {
        diagnostic('startup', { restored: this.publicSessionRestored, indexed: this.refs.length });
        this.tick();
      });
      // Observe actual user keyboard input only when the viewer belongs to a media-tab session.
      document.addEventListener('keydown', (event) => this.onKeyDown(event), true);
      // Preheat adjacent images when a user opens media from the grid, before
      // X has constructed its React modal. This never consumes the click.
      document.addEventListener('click', (event) => this.onMediaTileClick(event), true);
      document.addEventListener('visibilitychange', () => this.onVisibilityChange(), { passive: true });
      // BFCache does not rerun the original Content Script constructor.
      window.addEventListener('pageshow', (event: PageTransitionEvent) => {
        if(event.persisted)
          void this.reconcileBfcacheHistoryPage().catch(() => {});
      });
      // Chrome may change Save-Data, network quality or offline status
      // WHILE two low-priority images are already downloading. Stop them
      // immediately instead of waiting for the next navigation/idle poll.
      window.addEventListener('offline', () => this.onNetworkPolicyChange(), { passive: true });
      window.addEventListener('online', () => this.onNetworkPolicyChange(), { passive: true });
      const connection = typeof navigator === 'undefined' ? null :
        (navigator as Navigator & { connection?: {
          addEventListener?: (type:string,listener:()=>void)=>void
        } }).connection;
      connection?.addEventListener?.('change', () => this.onNetworkPolicyChange());
      window.addEventListener('resize', () => {
        this.controlsPaneAnchor = null;
        this.controlsLayoutPath = '';
        if (this.viewer?.isConnected) this.positionControls(this.viewer);
      }, { passive: true });
      document.addEventListener('fullscreenchange', () => {
        this.controlsPaneAnchor = null;
        this.controlsLayoutPath = '';
        if (this.viewer?.isConnected) this.controlContainer(this.viewer);
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
    private async persistPublicMediaSession(): Promise<boolean> {
      try {
        if (!this.originProfile || this.refs.length < 1 || this.refs.length > 450)
          return false;
        const refs = this.refs.map(ref => ref.href);
        const photos = [...this.imageSources].filter(([key]) =>
          this.publicApiKeys.has(key)).slice(0, 450);
        const statuses = new Set(this.refs.filter(ref =>
          this.publicApiKeys.has(ref.key)).map(ref => ref.statusId));
        const photoTotals = [...this.knownPhotoTotals].filter(([id]) =>
          statuses.has(id)).slice(-128);
        const payload: PublicSession = {
          schema: 1,
          profile: this.originProfile,
          timeline: this.originTimeline,
          expires: Date.now() + 30 * 60 * 1000,
          refs, apiKeys: [...this.publicApiKeys],
          photos, photoTotals, cursor: this.publicApiCursor,
          anchorFound: this.publicApiAnchorFound,
          exhausted: this.publicApiExhausted,
        };
        this.sessionStore ??= new SessionStore();
        return await this.sessionStore.save(payload);
      } catch { return false; }
    }

    /**
     * Reconcile a genuine BFCache pageshow, NOT every ordinary X route tick.
     * The user has returned to a preserved document that may be several
     * checkpoint pages away from the last active Worker session.
     */
    private async reconcileBfcacheHistoryPage(): Promise<void> {
      const path=window.location.pathname;
      const match=/^\/([a-zA-Z0-9_]{1,15})\/status\/\d+/.exec(path);
      if(!match)return;
      const profile=match[1].toLowerCase();
      const route=mediaRefFromHref(path,profile);
      if(!route||route.kind===null)return;
      const generation=this.navGeneration;
      this.sessionStore ??= new SessionStore();
      const manifest=await this.sessionStore.loadPageManifest(profile);
      if(!manifest||window.location.pathname!==path||
         generation!==this.navGeneration)return;
      const found=await this.sessionStore.restoreCheckpointForRoute(profile,route.href);
      if(!found||window.location.pathname!==path||
         generation!==this.navGeneration)return;
      // If the cached controller already owns this exact immutable page,
      // keep its X viewer, images and reply pane in place.
      if(this.publicSessionRestored && this.originProfile===profile &&
         this.refs.length===found.session.refs.length &&
         this.refs.every((ref,i)=>ref.href===found.session.refs[i])){
        this.restoredCheckpointPage=found.page;
        this.viewerStateSnapshot=null;
        this.updateViewerState();
        return;
      }
      // The original page may have been opened before the checkpoints were
      // first created. Do not trust that stale native X index on History Back.
      // Repopulate only after the Worker committed an exact-URL checkout.
      this.resetSession();
      this.originProfile=null;
      this.originTimeline=null;
      await this.restorePublicMediaSession();
      if(window.location.pathname===path)this.tick();
    }

    private async restorePublicMediaSession(): Promise<void> {
      const path = window.location.pathname;
      const match = /^\/([a-zA-Z0-9_]{1,15})\/status\/\d+/.exec(path);
      if (!match) return;
      const profile=match[1].toLowerCase();
      const generation=this.navGeneration;
      this.sessionStore ??= new SessionStore();
      const route=mediaRefFromHref(path,profile);
      if(!route)return;
      let data=await this.sessionStore.load(profile);
      let restoredPage:number|null=null;
      const sameRoute=()=>window.location.pathname===path &&
        generation===this.navGeneration && this.originProfile===null;
      if(!sameRoute())return;
      // A URL change alone never authorizes page activation. The trusted
      // Worker checks the exact TOP-FRAME route and immutable page snapshots.
      if((!data || !data.refs.includes(route.href)) && route.kind!==null){
        const manifest=await this.sessionStore.loadPageManifest?.(profile);
        if(!sameRoute())return;
        if(manifest){
          for(const direction of [1,-1] as const){
            const active=manifest.pages[manifest.activePage];
            const sourceRef=direction===1?active.lastRef:active.firstRef;
            const plan=planPublicBoundaryTransition(
              manifest,profile,sourceRef,direction,route.href);
            if(!plan||plan.targetRef!==route.href)continue;
            const activated=await this.sessionStore.activatePage?.(profile,plan);
            if(!sameRoute())return;
            if(activated?.manifest?.activePage===plan.targetPage){
              data=activated.session;
              restoredPage=plan.targetPage;
            }
            break;
          }
        }
        if(!data || !data.refs.includes(route.href)){
          // Browser History may jump over multiple checkpoints. Only a
          // Worker checkout of the exact TOP-FRAME URL makes arrows safe.
          const found=this.sessionStore.restoreCheckpointForRoute
            ? await this.sessionStore.restoreCheckpointForRoute(profile,route.href)
            : await this.sessionStore.findCheckpointForRoute?.(profile,route.href);
          if(!sameRoute())return;
          if(found){data=found.session;restoredPage=found.page;}
        }
      }
      // session.get may already point to the active checkpoint after
      // navigation; recover its index to enable the historical back button.
      if(data && restoredPage===null && route.kind!==null &&
         data.refs.includes(route.href)){
        const manifest=await this.sessionStore.loadPageManifest?.(profile);
        if(!sameRoute())return;
        const desc=manifest?.pages[manifest.activePage];
        if(desc && desc.firstRef===data.refs[0] &&
           desc.lastRef===data.refs[data.refs.length-1] &&
           desc.mediaCount===data.refs.length && desc.outgoingCursor===data.cursor)
          restoredPage=manifest!.activePage;
      }
      if(!data || window.location.pathname!==path ||
         generation!==this.navGeneration || this.originProfile!==null) return;
      if(!Array.isArray(data.refs) || !Array.isArray(data.apiKeys))return;
      const refs=data.refs.map(href=>mediaRefFromHref(href,profile));
      if(refs.some(ref=>!ref) || !refs.some(ref=>ref?.key===route.key))return;
      const keys=new Set(data.apiKeys.filter(key=>typeof key==='string' &&
        refs.some(ref=>ref?.key===key)));
      if(keys.size===0) return;
      this.publicSessionRestored=true;
      this.restoredCheckpointPage=restoredPage;
      this.originProfile=profile;
      this.originTimeline=data.timeline;
      this.refs=refs as MediaRef[];
      this.indexes=new Map(this.refs.map((ref,i)=>[ref.key,i]));
      this.publicApiKeys=keys;
      this.publicApiAnchorFound=data.anchorFound===true;
      this.publicApiExhausted=data.exhausted===true;
      this.publicApiCursor=data.cursor;
      this.knownPhotoTotals ??= new Map();
      for(const item of data.photoTotals??[]){
        if(!Array.isArray(item)||item.length!==2 ||
           typeof item[0]!=='string'||!Number.isInteger(item[1]) ||
           item[1]<1||item[1]>4) continue;
        const complete=Array.from({length:item[1]},(_,i)=>
          keys.has(item[0]+':photo:'+(i+1))).every(Boolean);
        if(complete)this.rememberPhotoTotal(item[0],item[1]);
      }
      this.imageSources ??= new Map();
      for(const entry of data.photos??[]){
        if(!Array.isArray(entry)||entry.length!==2 ||
           !keys.has(entry[0])||typeof entry[1]!=='string')continue;
        this.rememberImageSource(entry[0], entry[1]);
      }
      if(restoredPage!==null)
        diagnostic('checkpoint.restored',{page:restoredPage,media:this.refs.length});
    }

    /**
     * A public, third-party API, explicitly requested by the user for this
     * private development beta. Send ONLY the public handle; no X cookies,
     * OAuth, referrer, bearer tokens or browsing logs.
     */
    /** Bound the wire bytes even when Content-Length is missing or incorrect. */
    private async readBoundedPublicBody(response: Response): Promise<string|null> {
      const maxBytes=4_000_000;
      if(!response.body){
        // Test fixtures and old browsers have no stream. The bound is applied
        // immediately after text() in this compatibility fallback.
        const text=await response.text();
        // UTF-16 string.length undercounts multi-byte JSON: '€' occupies
        // one JS code unit but three UTF-8 wire bytes. Byte-cap this
        // compatibility path exactly like the streaming reader.
        if(text.length>maxBytes)return null;
        return new TextEncoder().encode(text).byteLength<=maxBytes
          ? text : null;
      }
      const reader=response.body.getReader();
      const decoder=new TextDecoder();
      const chunks:string[]=[];
      let bytes=0;
      try {
        for(;;){
          const part=await reader.read();
          if(part.done)break;
          bytes+=part.value.byteLength;
          if(bytes>maxBytes){
            try{await reader.cancel()}catch{}
            return null;
          }
          chunks.push(decoder.decode(part.value,{stream:true}));
        }
        chunks.push(decoder.decode());
        return chunks.join('');
      }finally{
        reader.releaseLock();
      }
    }

    /** Throttle malformed public payloads as well as HTTP rate limits. */
    private imposePublicApiCooldown(reason: string, providerRetryMs=0): void {
      this.publicApiFailures=Math.min(6,(this.publicApiFailures??0)+1);
      const fallback=Math.min(60000,1000*(2**this.publicApiFailures));
      const advised=Number.isFinite(providerRetryMs)&&providerRetryMs>0?providerRetryMs:0;
      this.publicApiRetryAt=Date.now()+Math.min(120000,Math.max(fallback,advised));
      diagnostic('fxembed.cooldown',{reason,retryMs:this.publicApiRetryAt-Date.now()});
    }

    private async fetchPublicMediaPage(cursor: string | null): Promise<{
      refs: MediaRef[]; photos: [string, string][]; cursor: string | null;
    } | null> {
      if (!this.originProfile) return null;
      const url = new URL('https://api.fxtwitter.com/2/profile/' +
        this.originProfile + '/media');
      url.searchParams.set('count', '100');
      if (cursor) url.searchParams.set('cursor', cursor);
      const abort = new AbortController();
      this.publicApiAbort=abort;
      this.publicApiCancelReason=null;
      const started = Date.now();
      diagnostic('fxembed.request', { continuation: !!cursor });
      const watchdog = window.setTimeout(() => {
        if(this.publicApiAbort===abort)this.publicApiCancelReason='timeout';
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
          if (response.status===429 || response.status>=500){
            let retryMs=0;
            const header=response.headers.get('retry-after');
            if(header){
              const seconds=Number(header);
              const asDate=Date.parse(header);
              retryMs=Number.isFinite(seconds)&&seconds>=0 ? seconds*1000 :
                Number.isFinite(asDate) ? Math.max(0,asDate-Date.now()) : 0;
            }
            this.imposePublicApiCooldown('http_'+response.status,retryMs);
          }
          return null;
        }
        const size = Number(response.headers.get('content-length'));
        if (Number.isFinite(size) && size > 4_000_000) {
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
        const page = parsePublicMediaPage(JSON.parse(body), this.originProfile);
        if (!page) {
          diagnostic('fxembed.rejected', { reason: 'invalid_payload' });
          this.imposePublicApiCooldown('invalid_payload');
          return null;
        }
        this.publicApiFailures=0;
        this.publicApiRetryAt=0;
        diagnostic('fxembed.page', {
          entries: page.refs.length, photos: page.photos.length,
          hasNext: !!page.cursor, elapsedMs: Date.now() - started,
        });
        return page;
      } catch (error) {
        const wasAbort=error instanceof Error && error.name==='AbortError';
        if(!wasAbort || this.publicApiCancelReason==='timeout')
          this.imposePublicApiCooldown(wasAbort?'timeout':'network_or_json');
        diagnostic('fxembed.failed', {
          reason: wasAbort ? (this.publicApiCancelReason??'timeout') : 'network_or_json',
        });
        return null;
      } finally {
        window.clearTimeout(watchdog);
        if(this.publicApiAbort===abort){
          this.publicApiAbort=null;
          this.publicApiCancelReason=null;
        }
      }
    }

    /**
     * After explicit FxEmbed consent, warm the next cursor shortly BEFORE
     * reaching the last indexed post. No new provider calls before consent.
     * A cancelled timer may be retried; failed requests obey cooldown limits.
     */
    private async schedulePublicMediaWarmup(currentIndex: number | null): Promise<void> {
      if (currentIndex === null || !this.publicApiAnchorFound ||
          !this.publicApiCursor || this.publicApiExhausted ||
          this.checkpointCapacityReached || this.checkpointContinuationBlocked || this.publicApiLoading ||
          (this.publicApiPreflightGeneration != null &&
           this.publicApiPreflightGeneration===this.navGeneration) ||
          this.navigationBusy || !this.viewer?.isConnected || document.hidden ||
          this.publicApiWarmTimer !== null ||
          this.publicApiWarmCursor === this.publicApiCursor || !this.originProfile ||
          this.publicApiRetryAt>Date.now()) return;
      const profile = this.originProfile;
      this.sessionStore ??= new SessionStore();
      if (!await this.sessionStore.hasConsent(profile)) return;
      if (this.originProfile !== profile || !this.viewer?.isConnected ||
          this.publicApiLoading ||
          (this.publicApiPreflightGeneration != null &&
           this.publicApiPreflightGeneration===this.navGeneration) ||
          this.navigationBusy || document.hidden ||
          !this.publicApiCursor || this.publicApiExhausted ||
          this.checkpointCapacityReached || this.checkpointContinuationBlocked ||
          this.publicApiWarmTimer !== null ||
          this.publicApiWarmCursor === this.publicApiCursor ||
          this.publicApiRetryAt>Date.now()) return;
      let position = currentIndex;
      let remaining = 0;
      for (let n = 0; n < 4; n++) {
        const next = adjacentPostIndex(
          this.refs, this.refs[position].statusId, 1, position);
        if (next === null) break;
        position = next;
        remaining++;
      }
      if (remaining > 3) return;
      const requestedCursor = this.publicApiCursor;
      this.publicApiWarmTimer = window.setTimeout(() => {
        this.publicApiWarmTimer = null;
        if (this.publicApiCursor !== requestedCursor || this.publicApiLoading ||
            (this.publicApiPreflightGeneration != null &&
           this.publicApiPreflightGeneration===this.navGeneration) ||
            this.checkpointCapacityReached || this.checkpointContinuationBlocked ||
            this.navigationBusy || !this.viewer?.isConnected || document.hidden) return;
        // Mark only an actually started call; a cancelled timer may be retried.
        this.publicApiWarmCursor = requestedCursor;
        diagnostic('fxembed.warmup', { remainingPosts: remaining });
        void this.loadPublicMediaContinuation(true).then(ok=>{
          if(!ok && !this.checkpointContinuationBlocked &&
             this.publicApiWarmCursor===requestedCursor)
            this.publicApiWarmCursor=null;
        }).catch(()=>{
          if(this.publicApiWarmCursor===requestedCursor)
            this.publicApiWarmCursor=null;
        });
      }, 400);
    }

    /** Roll a complete provider page into an immutable MV3 checkpoint.
     * Never evict the current viewer/index before the manifest is committed.
     * The following document validates the exact page boundary before use.
     */
    private async archivePublicContinuation(
      incoming:MediaRef[],photos:Map<string,string>,
      outgoing:string|null,previous:PublicPageManifest|null,
      stillSameSession:()=>boolean
    ):Promise<boolean>{
      const profile=this.originProfile;
      const timeline=this.originTimeline;
      if(!profile||!timeline||!this.publicApiCursor||
         !this.publicApiAnchorFound||!incoming.length ||
         !stillSameSession())return false;
      this.sessionStore ??= new SessionStore();
      const source=await this.sessionStore.load(profile);
      if(!source||!stillSameSession())return false;
      if(source.timeline!==timeline||source.cursor!==this.publicApiCursor||
         !source.anchorFound||source.exhausted||
         source.refs.length!==this.refs.length||
         source.refs.some((url,i)=>url!==this.refs[i].href)||
         source.apiKeys.length!==this.publicApiKeys.size||
         source.apiKeys.some(key=>!this.publicApiKeys.has(key)))
        return false;
      // A cursor can skip additional photos if an X-native partial album is
      // mistaken for a complete post. Archive only a proven final POST.
      const last=this.refs[this.refs.length-1];
      const samePost=this.refs.filter(r=>r.statusId===last.statusId);
      if(!samePost.every(r=>source.apiKeys.includes(r.key)))return false;
      if(last.kind==='photo'){
        const total=source.photoTotals.find(([id])=>id===last.statusId)?.[1];
        if(!total||samePost.length!==total||
           samePost.some((ref,i)=>ref.kind!=='photo'||
             ref.mediaIndex!==i+1))return false;
      }else if(last.kind!=='video'||samePost.length!==1||
               samePost[0].mediaIndex!==1)return false;
      const next=preparePublicContinuationPage(
        profile,timeline,incoming,photos,outgoing,source.expires);
      if(!next)return false;
      const manifest=createPublicContinuationManifest(source,next,previous);
      if(!manifest || !stillSameSession())return false;
      if(!previous){
        if(!await this.sessionStore.saveCheckpoint(0,source))return false;
        if(!stillSameSession())return false;
      }
      const newPage=manifest.pages.length-1;
      if(!await this.sessionStore.saveCheckpoint(newPage,next))return false;
      if(!stillSameSession())return false;
      if(!await this.sessionStore.savePageManifest(manifest))return false;
      if(!stillSameSession())return false;
      // The current session remains the previous page. No speculative
      // media URL is added to refs: Worker handles only committed boundaries.
      this.publicSessionRestored=true;
      this.restoredCheckpointPage=manifest.activePage;
      this.viewerStateSnapshot=null;
      diagnostic('checkpoint.page_ready',{
        page:newPage,media:incoming.length,hasMore:!!outgoing
      });
      return true;
    }

    /** Append only validated, chronologically older media records. */
    private async loadPublicMediaContinuation(background = false): Promise<boolean> {
      if (!this.originProfile || this.publicApiLoading ||
          (this.publicApiPreflightGeneration != null &&
           this.publicApiPreflightGeneration===this.navGeneration) || document.hidden ||
          (typeof navigator !== 'undefined' && navigator.onLine === false) ||
          this.publicApiExhausted) return false;
      if(this.publicApiRetryAt>Date.now()){
        diagnostic('fxembed.cooldown_active',{retryMs:this.publicApiRetryAt-Date.now()});
        return false;
      }
      const nativeLast = this.refs[this.refs.length - 1]?.statusId;
      if (!nativeLast) return false;
      const generation = this.navGeneration;
      const profile = this.originProfile;
      const timeline = this.originTimeline;
      // Keep the native X Photos / Videos filter when appending public media.
      if (timeline && timeline !== `${profile}|default` &&
          timeline !== `${profile}|photo` && timeline !== `${profile}|video`) return false;
      const mediaKind = timeline === `${profile}|photo` ? 'photo' :
        timeline === `${profile}|video` ? 'video' : null;
      const initialPath = window.location.pathname;
      const stillSameSession = (): boolean =>
        generation === this.navGeneration && this.originProfile === profile &&
        this.originTimeline === timeline &&
        window.location.pathname === initialPath && !document.hidden;
      if(this.restoredCheckpointPage!=null){
        this.sessionStore ??= new SessionStore();
        // Capture before yielding to MV3. Clear only OUR generation claim; an
        // older page cannot release the next route's in-flight manifest check.
        this.publicApiPreflightGeneration=generation;
        let manifest:PublicPageManifest|null=null;
        try { manifest=await this.sessionStore.loadPageManifest(profile); }
        catch { return false; }
        finally {
          if(this.publicApiPreflightGeneration===generation)
            this.publicApiPreflightGeneration=null;
        }
        if(!stillSameSession() || !manifest ||
           manifest.activePage!==this.restoredCheckpointPage)
          return false;
        const capacity=manifest.pages.length>=64;
        const savedNeighbor=manifest.activePage<manifest.pages.length-1;
        if(capacity||savedNeighbor){
          this.checkpointContinuationBlocked=true;
          const changed=this.checkpointCapacityReached!==capacity;
          this.checkpointCapacityReached=capacity;
          if(changed){
            this.viewerStateSnapshot=null;
            this.updateViewerState();
          }
          diagnostic('checkpoint.continuation_blocked',{
            reason:capacity?'page_capacity':'already_committed'
          });
          return false; // Never fetch data that cannot be committed.
        }
      }
      this.checkpointContinuationBlocked=false;
      this.checkpointCapacityReached=false;
      this.publicApiLoading = true;
      if (!background) {
        this.navigationBusy = true;
        this.updateViewerState();
      }
      diagnostic('fxembed.continuation_start', { background, indexed: this.refs.length });
      let cursor = this.publicApiCursor;
      const pages: { refs: MediaRef[]; photos: [string, string][] }[] = [];
      let newCursor: string | null = cursor;
      let committed=false;
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
            diagnostic('fxembed.continuation_abort',{reason:'cursor_not_advanced'});
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
          if (candidates >= 8 || !page.cursor) break;
          if (page.cursor === cursor) return false;
          cursor = page.cursor;
          await pause(300); // Avoid hammering the volunteer API.
          if (!stillSameSession()) return false;
        }
        if (!stillSameSession()) return false;
        const combined = pages.flatMap((item) => item.refs);
        if (!combined.length) return false;
        // Validate RAW contiguous post groups before Set() can mask a
        // repeated post separated by another post across page boundaries.
        const seenGroups=new Set<string>();
        let previousGroup:string|null=null;
        for(const ref of combined) {
          if(ref.statusId===previousGroup)continue;
          if(seenGroups.has(ref.statusId) || (previousGroup &&
             ref.statusId.padStart(19,'0')>=previousGroup.padStart(19,'0'))){
            diagnostic('fxembed.continuation_abort',{reason:'noncontiguous_post_group'});
            this.imposePublicApiCooldown('noncontiguous_post_group');
            return false;
          }
          seenGroups.add(ref.statusId);
          previousGroup=ref.statusId;
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
        const anchorExtra: MediaRef[] = [];
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
          const anchorStart=start;
          while (start < combined.length && combined[start].statusId === nativeLast) start++;
          // X can expose only photo/1 in its native timeline. Preserve any
          // newly verified photos of the anchor post before appending older posts.
          const nativeGroup = this.refs.filter(ref=>ref.statusId===nativeLast);
          const maxNativePhoto = Math.max(0,...nativeGroup.map(ref=>
            ref.kind==='photo' ? ref.mediaIndex??0 : 0));
          for(const ref of combined.slice(anchorStart,start)){
            if(this.indexes.has(ref.key))continue;
            if(ref.kind!=='photo'||maxNativePhoto===0 ||
               (ref.mediaIndex??0)<=maxNativePhoto){
              diagnostic('fxembed.continuation_abort',{reason:'anchor_album_ambiguous'});
              return false;
            }
            anchorExtra.push(ref);
          }
        }
        const newlyVerified=[...anchorExtra,...combined.slice(start)];
        const sourceMap = new Map(pages.flatMap((item) => item.photos));
        const oldLength = this.refs.length;
        const oldCursor = this.publicApiCursor;
        const oldAnchorFound = this.publicApiAnchorFound;
        const oldExhausted = this.publicApiExhausted;
        const oldPhotoTotals = new Map(this.knownPhotoTotals ?? []);
        const oldImageSources = new Map(this.imageSources ?? []);
        const oldImageRevision = this.imageSourcesRevision;
        // API data is initially speculative; a tab hide or route transition
        // while MV3 storage is pending must not leave a half-applied index.
        const sourceRefs=this.refs;
        const sourceIndexes=this.indexes;
        const sourceApiKeys=this.publicApiKeys;
        let appended=0;
        const rollbackLocalDraft=():void=>{
          // A newly created session (or a fresh native scan) owns its own data.
          // Do not tear it down merely because the old async save completed.
          if(generation!==this.navGeneration||
             this.originProfile!==profile||this.originTimeline!==timeline||
             this.refs!==sourceRefs||this.indexes!==sourceIndexes||
             this.publicApiKeys!==sourceApiKeys||
             this.refs.length!==oldLength+appended)return;
          for(const ref of this.refs.splice(oldLength)){
            this.indexes.delete(ref.key);
            this.publicApiKeys.delete(ref.key);
            this.imageSources.delete(ref.key);
          }
          this.publicApiCursor=oldCursor;
          this.publicApiAnchorFound=oldAnchorFound;
          this.publicApiExhausted=oldExhausted;
          this.knownPhotoTotals=oldPhotoTotals;
          this.imageSources=oldImageSources;
          this.imageSourcesRevision=oldImageRevision;
          this.statusOrdinalCache=null;
          this.viewerStateSnapshot=null;
          this.postWindowCache=null;
        };
        const plannedKeys = new Set<string>();
        for (const ref of newlyVerified) {
          if (!this.indexes.has(ref.key)) plannedKeys.add(ref.key);
        }
        // A committed page is immutable. Instead of appending to it or
        // dropping a provider page at the 450-reference bound, preserve the
        // previous whole-post page and commit a new bounded checkpoint.
        this.sessionStore ??= new SessionStore();
        const storedManifest=await this.sessionStore.loadPageManifest?.(profile)??null;
        if(!stillSameSession())return false;
        if(this.restoredCheckpointPage!=null && !storedManifest){
          diagnostic('checkpoint.page_abort',{reason:'manifest_missing'});
          return false;
        }
        if(storedManifest && plannedKeys.size===0){
          // A previously committed older page is not a fresh end-of-feed.
          // Only the final active checkpoint can mark a local terminal retry.
          if(newCursor===null &&
             storedManifest.activePage===storedManifest.pages.length-1)
            this.publicApiExhausted=true;
          diagnostic('checkpoint.no_new_entries');
          return false;
        }
        if(plannedKeys.size>0 &&
           (storedManifest || this.refs.length + plannedKeys.size > 450)){
          const additions=newlyVerified.filter(ref=>!this.indexes.has(ref.key));
          if(additions.length!==plannedKeys.size ||
             additions.some(ref=>ref.statusId===nativeLast)){
            diagnostic('checkpoint.page_abort',{reason:'split_or_duplicate'});
            return false;
          }
          const archived=await this.archivePublicContinuation(
            additions,sourceMap,newCursor,storedManifest,stillSameSession);
          if(archived){committed=true;return true;}
          diagnostic('checkpoint.page_abort',{reason:'unverified_or_storage'});
          return false;
        }
        if (this.refs.length + plannedKeys.size > 450) {
          diagnostic('fxembed.continuation_abort', { reason: 'index_limit' });
          return false;
        }
        for (const ref of newlyVerified) {
          if (this.indexes.has(ref.key)) continue;
          this.indexes.set(ref.key, this.refs.length);
          this.refs.push(ref);
          this.publicApiKeys.add(ref.key);
          const source = sourceMap.get(ref.key);
          if (source) this.rememberImageSource(ref.key, source);
          appended++;
        }
        // FxEmbed includes the full photo array per Post. Only use a
        // confirmed 1–4 photo count when EVERY photo of that group was
        // indexed (the 450-ref cap must never truncate the album counter).
        const groupedPhotos = new Map<string, Set<number>>();
        for (const ref of newlyVerified) {
          if (ref.kind !== 'photo' || ref.mediaIndex === null) continue;
          const indexes = groupedPhotos.get(ref.statusId) ?? new Set<number>();
          indexes.add(ref.mediaIndex);
          groupedPhotos.set(ref.statusId, indexes);
        }
        for (const [id, positions] of groupedPhotos) {
          if (positions.size >= 1 && positions.size <= 4 &&
              Array.from({ length: positions.size }, (_, i) => i + 1).every(
                (i) => positions.has(i) &&
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
          if (!stillSameSession() || !saved) {
            rollbackLocalDraft();
            return false;
          }
          diagnostic('fxembed.exhausted',{indexed:this.refs.length});
          return false;
        }
        const saved = appended > 0 && stillSameSession()
          ? await this.persistPublicMediaSession() : false;
        if (!stillSameSession()) {
          rollbackLocalDraft();
          return false;
        }
        if (saved) {
          diagnostic('fxembed.continuation_ready', {
            added: appended, indexed: this.refs.length, hasMore: !!newCursor, background,
          });
          committed=true;
          return true;
        }
        diagnostic('fxembed.continuation_abort', {
          reason: appended === 0 ? 'no_new_entries' : 'storage_or_route',
        });
        // Do not leave a half-appended public page if storage is blocked or
        // X changed profile/tab while the asynchronous API was responding.
        rollbackLocalDraft();
        if (appended === 0) this.imposePublicApiCooldown('no_new_entries');
        return false;
      } finally {
        if (generation === this.navGeneration && this.originProfile === profile) {
          this.publicApiLoading = false;
          if (!background) this.navigationBusy = false;
          this.updateViewerState();
          const intent=this.pendingBoundary;
          this.pendingBoundary=null; // Single-use regardless of result.
          if(committed && intent && intent.generation===this.navGeneration &&
             intent.path===window.location.pathname &&
             this.viewer?.isConnected && !document.hidden &&
             this.originProfile===profile &&
             (!intent.photoIdentity||this.currentPhotoIdentity()===intent.photoIdentity) &&
             this.refs.some(ref=>ref.statusId===intent.statusId)) {
            const index=this.activeIndex();
            if(index!==null && this.refs[index].statusId===intent.statusId &&
               (adjacentPostIndex(this.refs,intent.statusId,1,index)!==null ||
                (this.publicSessionRestored&&
                 this.restoredCheckpointPage!==null))) {
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
    private installRouteObserver(): boolean {
      const nav = (window as Window & { navigation?: EventTarget }).navigation;
      if (nav && typeof nav.addEventListener === 'function') {
        try {
          nav.addEventListener('currententrychange', () => this.scheduleRouteTick());
          return true;
        } catch { /* Unsupported/limited isolated-world API: poll remains. */ }
      }
      window.addEventListener('popstate', () => this.scheduleRouteTick());
      return false;
    }

    /** Collapse consecutive same-route updates into one next-task DOM check. */
    private scheduleRouteTick(): void {
      const key = `${window.location.pathname}${window.location.search}`;
      if (this.observedRouteKey === key) return;
      this.observedRouteKey = key;
      if (this.routeTickTimer != null) return;
      this.routeTickTimer = window.setTimeout(() => {
        this.routeTickTimer = null;
        // X's click handler may commit a new URL before its modal finishes
        // replacing the prior photo. The modal observer covers that mount;
        // never forcibly tear down controls during an in-flight navigation.
        if (this.navigationBusy) return;
        if (this.originProfile &&
            profileStatusFromPath(window.location.pathname, this.originProfile) &&
            !document.querySelector(VIEWER_SELECTOR)) return;
        this.tick();
      }, 0);
    }

    private resetSession(): void {
      this.navGeneration++;
      if(this.publicApiAbort){
        this.publicApiCancelReason='route_changed';
        this.publicApiAbort.abort();
      }
      this.publicApiAbort=null;
      this.publicApiRetryAt=0;
      this.publicApiFailures=0;
      this.controlsPaneAnchor = null;
      this.navigationBusy = false;
      this.pendingGrid = null;
      this.refs = [];
      this.indexes.clear();
      this.postWindowCache = null;
      this.liveLinks?.clear();
      this.statusOrdinalCache = null;
      this.publicApiKeys?.clear();
      this.publicApiCursor = null;
      this.publicApiAnchorFound = false;
      this.publicApiExhausted = false;
      this.publicSessionRestored = false;
      this.publicApiLoading = false;
      this.publicApiPreflightGeneration = null;
      this.publicConsentPendingGeneration = null;
      this.pendingBoundary = null;
      this.pendingDocumentHandoff = null;
      this.checkpointBoundaryPending = false;
      this.restoredCheckpointPage = null;
      this.checkpointContinuationBlocked = false;
      this.checkpointCapacityReached = false;
      this.publicApiWarmCursor = null;
      if (this.publicApiWarmTimer !== null) window.clearTimeout(this.publicApiWarmTimer);
      this.publicApiWarmTimer = null;
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

    /** The first swipe-to-dismiss node can be an offscreen carousel slide. */
    private findActiveViewer(): HTMLElement | null {
      if (typeof document.querySelectorAll !== 'function')
        return document.querySelector<HTMLElement>(VIEWER_SELECTOR);
      const candidates = document.querySelectorAll<HTMLElement>(VIEWER_SELECTOR);
      let best: HTMLElement | null = null;
      let bestArea = -1;
      for (const viewer of candidates) {
        if (!viewer.isConnected || viewer.getAttribute('aria-hidden') === 'true' ||
            viewer.getAttribute('hidden') !== null || viewer.getAttribute('inert') !== null ||
            viewer.closest('[aria-hidden="true"], [hidden], [inert]')) continue;
        // X can fade the previous slide to opacity:0 while keeping it
        // connected and geometrically overlapping the new photo.
        if (!viewerStyleVisible(viewer)) continue;
        let area = 1;
        if (typeof viewer.getBoundingClientRect === 'function') {
          const rect = viewer.getBoundingClientRect();
          const vw = typeof window.innerWidth === 'number' ? window.innerWidth : Infinity;
          const vh = typeof window.innerHeight === 'number' ? window.innerHeight : Infinity;
          area = Math.max(0, Math.min(vw, rect.right) - Math.max(0, rect.left)) *
            Math.max(0, Math.min(vh, rect.bottom) - Math.max(0, rect.top));
        }
        if (area > bestArea && area > 0) { best = viewer; bestArea = area; }
      }
      return best;
    }

    /** Keep the chosen X slide across idle polls, without querying layouts. */
    private activeViewerForRoute(): HTMLElement | null {
      const route = window.location.pathname;
      const current = this.viewer;
      if (current?.isConnected && this.activeViewerPath === route &&
          current.getAttribute?.('aria-hidden') !== 'true' &&
          current.getAttribute?.('hidden') === null &&
          current.getAttribute?.('inert') === null &&
          !current.closest?.('[aria-hidden="true"], [hidden], [inert]') &&
          viewerStyleVisible(current)) return current;
      this.activeViewerPath = route;
      return this.findActiveViewer();
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
              this.activeViewerPath = '';
              this.tick();
              return;
            }
          }
        }
      });
      this.modalObserver.observe(document.body, { childList: true, subtree: true });
    }

    private tick(): void {
      // Chromium may still dispatch throttled interval callbacks for a hidden
      // tab. Do not traverse X's media DOM while backgrounded; we reconcile
      // once on visibilitychange before resuming bounded photo prefetch.
      if (document.hidden) return;
      const path = window.location.pathname;
      const atMedia = mediaProfileFromPath(path);
      const timeline = mediaTimelineKey(path, window.location.search);
      if (atMedia && timeline) {
        let scanRequired = false;
        if (this.publicSessionRestored || this.originProfile !== atMedia) {
          // Returning from an API-only full-page route restores a fresh X grid.
          // Old saved refs are not the live grid's ordering or filter authority.
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
        this.pendingDocumentHandoff=null;
        if(this.publicApiAbort && this.publicApiLoading){
          this.publicApiCancelReason='route_changed';
          this.publicApiAbort.abort();
        }
        if(this.pendingBoundary && this.pendingBoundary.path!==path)
          this.pendingBoundary=null;
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
        this.lastPath = path;
      }
      const viewer = this.originProfile && profileStatusFromPath(path, this.originProfile)
        ? this.activeViewerForRoute() : null;
      if (viewer && this.originProfile) {
        this.syncViewer(viewer);
      } else {
        this.removeViewerUI();
      }
    }

    /** First few anchors and DOM nodes distinguish X's data swap from our badge cleanup. */
    private captureGrid(): { column: Element | null; firstTiles: Element[]; firstKeys: string[]; lastTiles?: Element[]; lastKeys?: string[]; tileCount?: number; allTiles?: Element[]; allKeys?: string[] } {
      const column = mediaColumn();
      const tiles=column ? Array.from(column.querySelectorAll(TILE_SELECTOR)) : [];
      // A filtered X timeline may reuse the same first and last tiles, but
      // replace only the MIDDLE. During this temporary transition scan each
      // media key exactly once, then compare the complete ordered snapshot.
      // This fingerprint is not calculated by the ordinary 450ms idle tick.
      const allKeys=tiles.map(tile=>{
        const link=this.originProfile ? usableTileLink(tile,this.originProfile) : null;
        return link?.ref.key ?? '';
      });
      const firstTiles=tiles.slice(0,8);
      const lastTiles=tiles.slice(-8);
      return {column,firstTiles,firstKeys:allKeys.slice(0,8),
        lastTiles,lastKeys:allKeys.slice(-8),tileCount:tiles.length,
        allTiles:tiles,allKeys};
    }

    private hasGridTurnedOver(previous: { column: Element | null; firstTiles: Element[]; firstKeys: string[]; lastTiles?: Element[]; lastKeys?: string[]; tileCount?: number; allTiles?: Element[]; allKeys?: string[] }): boolean {
      const current = this.captureGrid();
      if (current.firstTiles.length === 0) return false;
      // Waiting for X's actual list replacement is safer than a fixed delay.
      if (current.column !== previous.column) return true;
      const replaced = current.firstTiles.some((tile, index) => tile !== previous.firstTiles[index]);
      const keysChanged = current.firstKeys.some((key, index) => key !== previous.firstKeys[index]);
      const tailChanged=(previous.lastTiles??[]).some((tile,i)=>
        current.lastTiles?.[i]!==tile);
      const tailKeysChanged=(previous.lastKeys??[]).some((key,i)=>
        current.lastKeys?.[i]!==key);
      const countChanged=previous.tileCount!==undefined&&
        current.tileCount!==previous.tileCount;
      // A wholesale filter change may keep the two visible ends untouched
      // while recycling or rebinding an interior tile. Never keep pendingGrid
      // permanently because the sampled head/tail happen to match.
      const middleChanged=!!previous.allTiles && !!previous.allKeys &&
        (current.allTiles?.length!==previous.allTiles.length ||
         current.allKeys?.length!==previous.allKeys.length ||
         previous.allTiles.some((tile,i)=>current.allTiles?.[i]!==tile ||
           current.allKeys?.[i]!==previous.allKeys?.[i]));
      return replaced || keysChanged || tailChanged || tailKeysChanged ||
        countChanged || middleChanged;
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

    /** Shared bounded URL cache for X tiles, FxEmbed and restored sessions. */
    private rememberImageSource(key: string, url: string): void {
      if (!this.imageSources || preloadImageUrl(url) !== url) return;
      if (this.imageSources.get(key) === url) return;
      this.imageSources.delete(key);
      this.imageSources.set(key, url);
      this.imageSourcesRevision = (this.imageSourcesRevision ?? 0) + 1;
      while (this.imageSources.size > 128) {
        const oldest = this.imageSources.keys().next().value;
        if (oldest === undefined) break;
        this.imageSources.delete(oldest);
      }
    }

    /** Update only the changed thumbnail without rescanning the whole media grid. */
    private recordTileImageSource(
      tile: HTMLElement, found: { link: HTMLAnchorElement; ref: MediaRef },
    ): void {
      const ownedImage = found.link.querySelector<HTMLImageElement>('img[src]');
      // Only search the entire tile when X renders the image outside its
      // anchor. On long grids a second subtree query for every tile adds up.
      const otherImages = ownedImage ? null : tile.querySelectorAll<HTMLImageElement>('img[src]');
      const thumbnail = ownedImage ?? (otherImages?.length === 1 ? otherImages[0] : null);
      // A recycled X thumbnail may already be assigned a NEW photo in src
      // while currentSrc still points to the old, rendered photo. For a
      // pending load follow the newly assigned resource. Once the image is
      // completely loaded, currentSrc is authoritative for srcset/picture
      // candidates and may differ from a valid fallback src.
      const displayed = thumbnail ? preloadImageUrl(thumbnail.currentSrc || '') : null;
      const assigned = thumbnail ? preloadImageUrl(thumbnail.src || '') : null;
      const different = assigned && displayed &&
        photoCdnIdentity(assigned) !== photoCdnIdentity(displayed);
      const loaded = thumbnail?.complete === true && thumbnail.naturalWidth > 0;
      const url = different && !loaded ? assigned : displayed ?? assigned;
      if (url) this.rememberImageSource(found.ref.key, url);
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
      const tiles = Array.from(root.querySelectorAll<HTMLElement>(TILE_SELECTOR));
      // A virtualized X grid can omit its original head (e.g. status 400)
      // while prepending status 500 above an older surviving tile (300).
      // The first known ref does NOT have to be index zero. Only a strictly
      // descending NEWER prefix may be placed ahead of the verified index.
      // All other unanchored leading refs stay unindexed (rather than being
      // appended after the oldest post and corrupting arrow navigation).
      const unverifiedLeading = new Set<string>();
      if (this.refs.length > 0) {
        const head: MediaRef[] = [];
        let foundAnchor=false;
        for (const tile of tiles) {
          const observed=usableTileLink(tile,this.originProfile);
          if(!observed)continue;
          const known=this.indexes.get(observed.ref.key);
          if(known!==undefined){
            foundAnchor=true;
            if(head.length){
              const groups=groupMediaRefs(head,'x-dom','unknown');
              const originalHead=this.refs[0].statusId.padStart(19,'0');
              const verified=!!groups && groups.every((group,i)=>
                group.statusId.padStart(19,'0') > originalHead &&
                (i===0||group.statusId.padStart(19,'0') <
                  groups[i-1].statusId.padStart(19,'0')));
              if(verified){
                // A unique contiguous prefix is observed ahead of a known
                // DOM anchor, even when React virtualized the original head.
                this.refs.unshift(...head);
                this.indexes=new Map(this.refs.map((ref,i)=>[ref.key,i]));
                this.statusOrdinalCache=null;
                this.viewerStateSnapshot=null;
              }else{
                for(const ref of head)unverifiedLeading.add(ref.key);
                diagnostic('grid.leading_unverified',{count:head.length});
              }
            }
            break;
          }
          head.push(observed.ref);
        }
        if(!foundAnchor)
          for(const ref of head)unverifiedLeading.add(ref.key);
      }
      for (const tile of tiles) {
        const found = usableTileLink(tile, this.originProfile);
        if (!found) continue;
        const { ref } = found;
        if(unverifiedLeading.has(ref.key))continue;
        this.recordTileImageSource(tile, found);
        this.rememberLiveLink(ref, found.link);
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

    /** Pin post controls to a stable media-pane rectangle, not moving slides. */
    private positionControls(viewer: HTMLElement): void {
      const host = this.controlsHost;
      if (!host || typeof viewer.getBoundingClientRect !== 'function') return;
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
    private controlContainer(viewer: HTMLElement): HTMLElement {
      if (typeof viewer.getBoundingClientRect !== 'function' || !document.body)
        return viewer; // Older DOM / lightweight test harness fallback.
      const parent = (document.fullscreenElement || document.body) as HTMLElement;
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
      } else if (host.parentElement !== parent) {
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

    private removeViewerUI(preserveControls = false): void {
      this.viewerStateSnapshot = null;
      this.activeViewerPath = '';
      if (!preserveControls) {
        // X may remove a photo viewer before adding the next one and before
        // the route poll observes it. Keep the screen-space anchor while on a
        // status route, even when the previous node is already detached.
        // Only an explicit return to the media grid invalidates the anchor.
        if (!this.navigationBusy && this.originProfile &&
            mediaProfileFromPath(window.location.pathname) === this.originProfile)
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
      if (this.rightProbeTimer !== null) window.clearTimeout(this.rightProbeTimer);
      this.rightProbeTimer = null;
      if (this.viewer) {
        this.viewer.querySelectorAll('.xmn-nav-button, .xmn-status').forEach((element) => element.remove());
        this.viewer = null;
      }
    }

    private syncViewer(viewer: HTMLElement): void {
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
          if (structuralChange) {
            this.controlsLayoutPath = '';
            this.ensureViewerButtons();
          }
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
      const container = this.controlContainer(viewer);
      for (const [direction, className, text, label] of [
        [-1, 'xmn-prev', '◀', '前の投稿へ（最初の画像では←でも移動）'],
        [1, 'xmn-next', '▶', '次の投稿へ（最後の画像では→でも移動）'],
      ] as const) {
        let button = container.querySelector<HTMLButtonElement>(`.${className}`);
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
      let status = container.querySelector<HTMLElement>('.xmn-status');
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

    private activeIndex(): number | null {
      if (!this.originProfile) return null;
      const route = mediaRefFromHref(window.location.pathname, this.originProfile);
      if (!route) return null;
      const indexed = this.indexes?.get(route.key);
      // Never trust an index unless its stored media key still matches X's
      // current route; virtualized grids can replace and reorder DOM tiles.
      if (indexed !== undefined && this.refs[indexed]?.key === route.key) return indexed;
      const exact = findCurrentIndex(this.refs, window.location.pathname, this.originProfile);
      if (exact !== null) return exact;
      // A bare /status/id route with several indexed photos is ambiguous.
      // A guessed first image would change POSTS even though the displayed
      // X media is unknown. The pure helper already accepts unique statuses.
      if (route.kind === null) return null;
      // Explicit media URLs may still have only photo/1 observed in the grid.
      // Retain the conservative post-group fallback for those media routes.
      const index = this.refs.findIndex((ref) => ref.statusId === route.statusId);
      return index >= 0 ? index : null;
    }

    private updateViewerState(): void {
      const viewer = this.viewer;
      if (!viewer) return;
      // Media refs are append-only within a session; only their count,
      // current route, or navigation busy state changes the post controls.
      const key = `${window.location.pathname}|${this.originProfile ?? ''}|${this.refs.length}|${this.navigationBusy ? 1 : 0}|${this.publicApiCursor ? 1 : 0}|${this.publicApiExhausted ? 1 : 0}|${this.restoredCheckpointPage ?? -1}|${this.checkpointCapacityReached ? 1 : 0}`;
      if (this.viewerStateSnapshot?.viewer === viewer && this.viewerStateSnapshot.key === key) return;
      const current = this.activeIndex();
      const controls = this.controlsHost?.isConnected ? this.controlsHost : viewer;
      const prev = controls.querySelector<HTMLButtonElement>('.xmn-prev');
      const next = controls.querySelector<HTMLButtonElement>('.xmn-next');
      const currentRef = current !== null ? this.refs[current] : null;
      const canReturnToCommittedPage =
        this.publicSessionRestored && (this.restoredCheckpointPage ?? 0) > 0;
      if (prev) prev.disabled = this.navigationBusy || !currentRef ||
        (adjacentPostIndex(this.refs, currentRef.statusId, -1,
          current ?? undefined) === null && !canReturnToCommittedPage);
      // At the last known post clicking the next button may load more media.
      if (next) next.disabled = this.navigationBusy || !currentRef;
      const indicator = controls.querySelector<HTMLElement>('.xmn-status');
      if (indicator) {
        let ordinal = this.statusOrdinalCache;
        // Every new ref appends to the timeline. Rebuild only when the array
        // identity or number of indexed items changes, not on each route.
        if (!ordinal || ordinal.refs !== this.refs || ordinal.length !== this.refs.length) {
          const byStatus = new Map<string,number>();
          for (const ref of this.refs) {
            if (!byStatus.has(ref.statusId)) byStatus.set(ref.statusId, byStatus.size);
          }
          ordinal = { refs: this.refs, length: this.refs.length, byStatus };
          this.statusOrdinalCache = ordinal;
        }
        const index = currentRef ? ordinal.byStatus.get(currentRef.statusId) ?? -1 : -1;
        // Known indexed posts are not X's complete historical total.
        // A continuation cursor means older posts may still be obtainable.
        const mayContinue = !!this.publicApiCursor && !this.publicApiExhausted &&
          !this.checkpointCapacityReached;
        const label = index < 0 ? '投稿の位置を確認中' :
          `投稿 ${index + 1} / ${ordinal.byStatus.size}${mayContinue ? '+' : ''}`;
        if (indicator.textContent !== label) indicator.textContent = label;
        indicator.title = this.checkpointCapacityReached
          ? '保存済みの上限64ページに達しました。さらに過去の投稿はXのメディア一覧で確認してください。'
          : mayContinue
          ? '現在読み込み済みの投稿数です。続きを取得できる可能性があります。'
          : '現在読み込み済みの投稿数です。';
      }
      this.viewerStateSnapshot = { viewer, key };
      this.schedulePublicMediaWarmup?.(current);
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
      if(event.key==='ArrowLeft'||event.key==='Escape')this.pendingBoundary=null;
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
        if (photoCount === null && current && current.kind === 'photo' &&
            event.key === 'ArrowRight' &&
            postShortcutDirection(event) === 1 && !nativeNext) {
          this.handleUnknownRightBoundary(event, current);
        }
        return;
      }
      if (direction === -1 && current && adjacentPostIndex(this.refs, current.statusId, -1, currentIndex) === null) return;
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
          photoCdnIdentity(img.src || ''))
        .filter((img) => {
          // X may keep decoded carousel siblings outside the viewport. A
          // hidden/offscreen preload is NOT the image the user can see.
          if (typeof img.closest === 'function' &&
              img.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
          if (typeof img.getBoundingClientRect !== 'function') return true;
          const r = img.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 &&
            (typeof window.innerWidth !== 'number' || r.left < window.innerWidth) &&
            (typeof window.innerHeight !== 'number' || r.top < window.innerHeight);
        });
      if (photos.length === 1) return photos[0];
      // X may keep an adjacent carousel image (or quoted photo) at the same
      // layout size. Resolve the *active route's* X CDN media identity first
      // instead of treating equal-size unrelated photos as ambiguous.
      const current = this.originProfile
        ? mediaRefFromHref(window.location.pathname, this.originProfile) : null;
      const ownedUrl = current ? this.imageSources?.get(current.key) : null;
      const ownedId = ownedUrl ? photoCdnIdentity(ownedUrl) : null;
      if (ownedId) {
        const matching = photos.filter((img) =>
          photoCdnIdentity(img.currentSrc || '') === ownedId ||
          photoCdnIdentity(img.src || '') === ownedId);
        if (matching.length === 1) return matching[0];
        const loaded = matching.filter((img) => {
          const selected = photoCdnIdentity(img.currentSrc || img.src || '');
          const assigned = photoCdnIdentity(img.src || '');
          return img.complete && img.naturalWidth > 0 &&
            selected === ownedId && (!assigned || assigned === ownedId);
        });
        if (loaded.length === 1) return loaded[0];
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

    /** Track X's assigned photo, not old pixels awaiting the new resource. */
    private currentPhotoIdentity(): string | null {
      const image = this.displayedPhoto();
      return image
        ? photoCdnIdentity(image.src || '') ?? photoCdnIdentity(image.currentSrc || '')
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
      const routeRef = this.originProfile
        ? mediaRefFromHref(window.location.pathname, this.originProfile) : null;
      const ownedUrl = routeRef ? this.imageSources?.get(routeRef.key) : null;
      const ownedId = ownedUrl ? photoCdnIdentity(ownedUrl) : null;
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
    private handleUnknownRightBoundary(_event: KeyboardEvent, current: MediaRef): void {
      if (!this.viewer || this.navigationBusy || current.mediaIndex === null) return;
      if (this.refs?.some((ref) => ref.statusId === current.statusId &&
          ref.kind === 'photo' && ref.mediaIndex !== null &&
          ref.mediaIndex > current.mediaIndex!)) return;
      // Another key must not restart the active native-gallery observation.
      // X still receives the original keydown to operate its own carousel.
      if (this.rightProbeTimer != null) return;
      const path = window.location.pathname;
      const signature = this.currentPhotoSignature();
      const photoId = this.currentPhotoIdentity();
      const generation = this.navGeneration;
      const viewer = this.viewer;
      let loadingWaitMs = 0;
      const check = (): void => {
        this.rightProbeTimer = null;
        if (generation !== this.navGeneration || viewer !== this.viewer ||
            !viewer.isConnected || this.navigationBusy) return;
        const after = this.originProfile
          ? mediaRefFromHref(window.location.pathname, this.originProfile) : null;
        if (!after || after.statusId !== current.statusId) return;
        if (window.location.pathname !== path || after.mediaIndex !== current.mediaIndex) {
          if (after.mediaIndex !== null && after.mediaIndex !== current.mediaIndex)
            this.nativeAdvancedPost = current.statusId;
          return; // X has changed photos; never jump over a native slide.
        }
        const nowId = this.currentPhotoIdentity();
        if ((photoId && nowId !== photoId) ||
            (!photoId && signature !== this.currentPhotoSignature())) return;
        if (this.nativeGalleryArrowAvailable(viewer, 1)) return;
        if (this.refs?.some((ref) => ref.statusId === current.statusId &&
            ref.kind === 'photo' && ref.mediaIndex !== null &&
            ref.mediaIndex > current.mediaIndex!)) return;
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
        if (photoId === null) this.toast('表示中の写真を特定できないため、Xの操作を優先しました');
      };
      this.rightProbeTimer = window.setTimeout(check, 1050);
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

    /** Stop obsolete background transfers; reuse decoded photos on return. */
    private onVisibilityChange(): void {
      if (document.hidden) {
        this.pendingBoundary=null;
        if(this.publicApiAbort){
          this.publicApiCancelReason='hidden';
          this.publicApiAbort.abort();
        }
        if (this.preloadTimer !== null) window.clearTimeout(this.preloadTimer);
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
      if (this.viewer?.isConnected && this.originProfile) this.schedulePreload();
    }

    /** Only speculative CDN images obey these network policy controls.
     * The native X photo itself is owned by the website and is never aborted.
     */
    private optionalPrefetchAllowed(): boolean {
      if (typeof navigator === 'undefined') return true;
      const connection = (navigator as Navigator & {
        connection?: {saveData?:boolean;effectiveType?:string}
      }).connection;
      return navigator.onLine !== false && !connection?.saveData &&
        !/^(slow-2g|2g)$/.test(connection?.effectiveType ?? '');
    }

    /** Cancel only outstanding optional transfers, not decoded cache or the
     * exact photo presently serving a visible transition. A cancel() can
     * synchronously call drainPrefetchQueue(), hence the re-entry guard.
     */
    private suspendOptionalPrefetch(): void {
      if (this.prefetchPolicyStopping) return;
      this.prefetchPolicyStopping = true;
      try {
        if (this.preloadTimer != null && typeof window.clearTimeout === 'function')
          window.clearTimeout(this.preloadTimer);
        this.preloadTimer = null;
        this.preloadForPath = '';
        this.prefetchQueue = [];
        this.prefetchWanted.clear();
        for (const entry of [...this.prefetched.values()]) {
          if (entry.loading && !this.handoff?.host.contains(entry.image))
            entry.cancel?.();
        }
      } finally { this.prefetchPolicyStopping = false; }
    }

    /** A slow/offline/Data-Saver transition must take effect during fetch,
     * not only on the next click. Online restoration reuses normal limits.
     */
    private onNetworkPolicyChange(): void {
      if (!this.optionalPrefetchAllowed()) {
        this.suspendOptionalPrefetch();
        return;
      }
      this.preloadForPath = '';
      if (!document.hidden && this.viewer?.isConnected && this.originProfile)
        this.schedulePreload();
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

    /** Read-only view for prefetch; keep the full index until safe paging lands. */
    private verifiedPostWindow(index: number): MediaWindowView | null {
      if (index < 0 || index >= this.refs.length) return null;
      const first = this.refs[0]?.key ?? '';
      const last = this.refs[this.refs.length - 1]?.key ?? '';
      const existing = this.postWindowCache;
      const validCache = existing && existing.refs === this.refs &&
        existing.length === this.refs.length && existing.first === first &&
        existing.last === last && existing.profile === this.originProfile;
      if (validCache) {
        if (!existing.model) return null;
        const selected=existing.model.select(this.refs[index].statusId,450);
        if (selected) return selected;
      }
      // The full timeline can be very large. First find a bounded, intact
      // neighbourhood in O(N); validate only that <=450-ref neighbourhood.
      // The compiled model then serves consecutive local arrows in O(window).
      const plan = planMediaWindow(this.refs,this.refs[index].key,450);
      const groups = plan ? groupMediaRefs(plan.refs,'combined','unknown') : null;
      let model: ValidatedMediaWindowIndex | null = null;
      if (groups) {
        try { model=new ValidatedMediaWindowIndex(groups); }
        catch { /* Invalid provenance or duplicate album: no speculative URL. */ }
      }
      this.postWindowCache = {
        refs:this.refs,length:this.refs.length,first,last,
        profile:this.originProfile,model
      };
      return model?.select(this.refs[index].statusId,450)??null;
    }

    private preloadAdjacentImages(preopen?: { index: number; current: MediaRef }): void {
      if ((!this.viewer?.isConnected && !preopen) || !this.originProfile ||
          document.hidden) return;
      if (!this.optionalPrefetchAllowed()) {
        this.suspendOptionalPrefetch();
        return;
      }
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
      const index = preopen?.index ?? this.activeIndex();
      const current = preopen?.current ?? mediaRefFromHref(window.location.pathname, this.originProfile);
      if (index === null || !current || this.refs[index]?.statusId !== current.statusId) return;
      // For very long timelines, prefetch only an intact group in the
      // validated local 450-media window, never an arbitrary remote post.
      const windowView = this.refs.length > 450 ? this.verifiedPostWindow(index) : null;
      if (this.refs.length > 450 && !windowView) {
        diagnostic('prefetch.skipped',{reason:'unvalidated_media_window'});
        return;
      }
      const allowedWindowKeys = windowView
        ? new Set(windowView.posts.flatMap(group=>group.refs.map(ref=>ref.key)))
        : null;
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
      // 2. Collect future POSTS in their observed order without losing the
      // nearest previous photo to a long forward-only prefetch window.
      const future: MediaRef[] = [];
      let cursor = index;
      for (let hops = 0; hops < 8 && targets.length + future.length < PREFETCH_MAX_IMAGES + 3; hops++) {
        const next = adjacentPostIndex(this.refs, this.refs[cursor].statusId, 1, cursor);
        if (next === null) break;
        cursor = next;
        if (this.refs[cursor].kind === 'photo') future.push(this.refs[cursor]);
        if (hops === 0) {
          // X's native carousel may advance to photo/2 immediately after
          // opening the next post. Warm one extra photo from that nearest
          // album instead of only the first image of distant posts.
          const sibling = this.refs[cursor + 1];
          if (sibling?.kind === 'photo' && sibling.statusId === this.refs[cursor].statusId &&
              targets.length + future.length < PREFETCH_MAX_IMAGES + 3) future.push(sibling);
        }
      }
      // 3. Preserve fast forward movement (first two POSTS if there is room),
      // then reserve one of the five slots for going backwards. This improves
      // left-arrow continuity without increasing transfers or memory limits.
      const back = this.refs[index - 1];
      const prior = back?.kind === 'photo' && back.statusId === current.statusId ? back
        : (() => {
          const previous = adjacentPostIndex(this.refs, current.statusId, -1, index);
          return previous !== null && this.refs[previous].kind === 'photo'
            ? this.refs[previous] : null;
        })();
      const forwardFirst = Math.min(2, Math.max(1, PREFETCH_MAX_IMAGES - targets.length - (prior ? 1 : 0)));
      targets.push(...future.slice(0, forwardFirst));
      if (prior) targets.push(prior);
      targets.push(...future.slice(forwardFirst));
      const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      const max = connection?.effectiveType === '3g' || (memory !== undefined && memory <= 4)
        ? 2 : PREFETCH_MAX_IMAGES;
      const urls = targets
        .filter(ref=>!allowedWindowKeys || allowedWindowKeys.has(ref.key))
        .map((ref) => this.imageSources.get(ref.key))
        .filter((url): url is string => !!url);
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
      // prefetchWanted is ordered by usefulness (nearest next photo first).
      // The old LRU fallback evicted that MOST useful photo whenever all
      // decoded images were still wanted and their sum exceeded 80MiB.
      const priorities = new Map<string, number>();
      let order = 0;
      for (const url of this.prefetchWanted) priorities.set(url, order++);
      while (this.prefetched.size > PREFETCH_MAX_RECORDS || bytes > PREFETCH_MAX_DECODED_BYTES) {
        let victim: [string, PrefetchedPhoto] | null = null;
        let worst = -1;
        for (const [url, item] of this.prefetched) {
          if (item.loading || this.handoff?.host.contains(item.image)) continue;
          // Obsolete photos are evicted before any requested photo; among
          // requested ones the farthest future photo is evicted first.
          // Equal-priority obsolete entries retain the oldest-first LRU rule.
          const rank = priorities.get(url) ?? Infinity;
          if (rank > worst) { worst = rank; victim = [url, item]; }
        }
        if (!victim) break; // Only in-flight or currently displayed images remain.
        this.prefetched.delete(victim[0]);
        bytes -= victim[1].bytes;
      }
    }

    private drainPrefetchQueue(allowMediaGrid = false): void {
      const activeModal = !!this.viewer?.isConnected;
      const openedFromGrid = allowMediaGrid &&
        mediaProfileFromPath(window.location.pathname) === this.originProfile;
      if (!this.optionalPrefetchAllowed()) {
        this.suspendOptionalPrefetch();
        return;
      }
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
                // A single giant photo cannot fit in the memory budget.
                // Do not treat the rejected photo as decoded or displayable.
                record.ready = false;
                this.prefetched.delete(url);
                this.prefetchTooLarge.add(url);
                if (this.prefetchTooLarge.size > 64) {
                  this.prefetchTooLarge.delete(this.prefetchTooLarge.values().next().value!);
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
        let decodeStarted = false;
        const startDecode = (): void => {
          if (settled || decodeStarted) return;
          const width = image.naturalWidth || 0;
          const height = image.naturalHeight || 0;
          // Image dimensions may be available from metadata before decode().
          // Do not explicitly decode an image larger than the entire budget.
          if (width > 0 && height > 0 &&
              width * height * 4 > PREFETCH_MAX_DECODED_BYTES) {
            finish(true); // finish marks this entry tooLarge, not ready.
            image.onload = null;
            image.onerror = null;
            try {
              // Release the oversized transfer without requesting a blank URL.
              image.removeAttribute?.('src');
            } catch { /* Rejection remains valid even if cleanup is unavailable. */ }
            return;
          }
          if (typeof image.decode === 'function') {
            decodeStarted = true;
            try {
              void image.decode().then(() => finish(true)).catch(() => finish(false));
            } catch { finish(false); }
          } else {
            finish(true);
          }
        };
        image.onerror = () => finish(false);
        image.onload = () => startDecode();
        this.prefetched.set(url, record);
        this.prefetchInFlight++;
        diagnostic('prefetch.started', { inFlight: this.prefetchInFlight });
        image.src = url;
        // Synthetic fixtures and memory cache hits can have dimensions now.
        // A new browser image normally waits for onload to reveal its size.
        if (image.naturalWidth > 0 && image.naturalHeight > 0) startDecode();
        this.trimPrefetched();
      }
    }

    /**
     * Capture an ALREADY decoded native thumbnail, never download another
     * small image. Drawing a third-party image taints this temporary canvas;
     * we only display the canvas and NEVER export/read pixel data.
     */
    private captureLowQualityThumbnail(
      target: MediaRef, link: HTMLAnchorElement | null,
    ): HTMLCanvasElement | null {
      const expected = this.imageSources?.get(target.key);
      const expectedId = expected ? photoCdnIdentity(expected) : null;
      if (!expectedId || target.kind !== 'photo' || !this.originProfile ||
          !link?.isConnected ||
          mediaRefFromHref(link.getAttribute('href') ?? '', this.originProfile)?.key !== target.key)
        return null;
      let image = link.querySelector<HTMLImageElement>('img[src], img[srcset]');
      if (!image) {
        // Some older X tiles place one thumbnail outside their native anchor.
        // Never guess among several candidate media images.
        const images = link.closest(TILE_SELECTOR)?.querySelectorAll<HTMLImageElement>(
          'img[src], img[srcset]');
        if (images?.length === 1) image = images[0];
      }
      if (!image || !image.complete || image.naturalWidth < 1 || image.naturalHeight < 1 ||
          photoCdnIdentity(image.currentSrc || image.src || '') !== expectedId) return null;
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) return null;
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.classList.add('xmn-handoff-preview');
        diagnostic('preview.low_thumbnail_decoded', {
          width: canvas.width, height: canvas.height, extraRequests: 0,
        });
        return canvas;
      } catch {
        // Failed/cross-origin-restricted or unsupported draw is optional.
        // Native X image loading must always remain functional.
        return null;
      }
    }

    /** Promote a low-res canvas to the existing decoded prefetch if ready. */
    private promoteVisualHandoff(): boolean {
      const handoff = this.handoff;
      if (!handoff || handoff.quality !== 'low' ||
          handoff.generation !== this.navGeneration) return false;
      const record = this.prefetched?.get(handoff.targetPrefetchUrl);
      if (!record?.ready || record.image.naturalWidth < 1 ||
          photoCdnIdentity(handoff.targetPrefetchUrl) !== handoff.targetPhotoIdentity)
        return false;
      try {
        record.image.classList.add('xmn-handoff-image');
        handoff.host.replaceChildren(record.image);
        handoff.quality = 'high';
        diagnostic('preview.promoted_to_high', { visible: handoff.shown });
        return true;
      } catch { return false; }
    }

    /**
     * Visual-only handoff while X swaps its SPA photo viewer.
     * High quality decoded prefetch wins; otherwise display ONLY an existing
     * thumbnail's small canvas snapshot, without any extra image request.
     */
    private beginVisualHandoff(
      target: MediaRef, link: HTMLAnchorElement | null = null,
    ): boolean {
      if (target.kind !== 'photo' || this.handoff || !this.originProfile || document.hidden) return false;
      if (typeof window.matchMedia === 'function' &&
          window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        diagnostic('preview.skipped', { reason: 'reduced_motion' });
        return false;
      }
      const url = this.imageSources?.get(target.key);
      const record = url ? this.prefetched?.get(url) : undefined;
      const targetPhotoIdentity = url ? photoCdnIdentity(url) : null;
      if (!url || !targetPhotoIdentity || preloadImageUrl(url) !== url) {
        diagnostic('preview.skipped', { reason: 'verified_photo_url_unavailable' });
        return false;
      }
      const highReady = !!record?.ready && record.image.naturalWidth > 0;
      if (!highReady && !link) {
        diagnostic('preview.skipped', { reason: 'native_thumbnail_unavailable' });
        return false;
      }
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
        if (!bounds) {
          diagnostic('preview.skipped', { reason: 'unsafe_photo_geometry' });
          return false;
        }
        host.style.setProperty('inset', 'auto');
        host.style.setProperty('left', `${bounds.left}px`);
        host.style.setProperty('top', `${bounds.top}px`);
        host.style.setProperty('width', `${bounds.width}px`);
        host.style.setProperty('height', `${bounds.height}px`);
        const visual = highReady ? record!.image
          : this.captureLowQualityThumbnail(target, link);
        if (!visual) {
          diagnostic('preview.skipped', { reason: 'thumbnail_not_decoded' });
          return false;
        }
        if (highReady) visual.classList.add('xmn-handoff-image');
        host.appendChild(visual);
        document.body.appendChild(host);
        const timeout = window.setTimeout(() => this.clearVisualHandoff('timeout'), 1800);
        const handoff: VisualHandoff = {
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
            if (this.handoff !== handoff) return;
            const opened = this.findActiveViewer();
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
        diagnostic('preview.skipped', { reason: 'overlay_setup_failed' });
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
        // If the decoded full-size photo became ready during the SPA route
        // change, skip showing the blurry intermediary altogether.
        this.promoteVisualHandoff();
        // The event means the DOM reveal instruction succeeded, not that the
        // browser has already painted a visible frame.
        try {
          handoff.host.classList.add('xmn-handoff-visible');
        } catch {
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
          this.clearVisualHandoff('native_photo_ready');
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

    private clearVisualHandoff(reason = 'cleanup'): void {
      const handoff = this.handoff;
      if (!handoff) return;
      diagnostic('preview.finished', {
        quality: handoff.quality, reason, visible: handoff.shown,
        visibleMs: handoff.shownAt == null ? 0 : Date.now() - handoff.shownAt,
      });
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

    /** Keep the already observed X link, but never trust it after React recycles it. */
    private rememberLiveLink(ref: MediaRef, link: HTMLAnchorElement, priority = false): void {
      this.liveLinks ??= new Map();
      const existing = this.liveLinks.has(ref.key);
      if (!existing && this.liveLinks.size >= 1024 && !priority) return;
      this.liveLinks.delete(ref.key);
      this.liveLinks.set(ref.key, link);
      while (this.liveLinks.size > 1024) {
        const oldest = this.liveLinks.keys().next().value;
        if (oldest === undefined) break;
        this.liveLinks.delete(oldest);
      }
    }

    private findLiveLink(ref: MediaRef): HTMLAnchorElement | null {
      if (!this.originProfile) return null;
      const column = mediaColumn();
      if (!column) return null;
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
      // document navigation if it does not. Check whether X already claimed
      // the click BEFORE our safety guard calls preventDefault().
      let observedNativeClick = false;
      let claimedByX = false;
      const guard = (event: MouseEvent): void => {
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
      } finally {
        window.removeEventListener('click', guard);
      }

      // If X did not claim a normally bubbling click, a native document
      // navigation would have happened without our guard. Allow 100ms for a
      // very short deferred route, not the full 300ms used for X-owned SPA.
      const probeCount = observedNativeClick && !claimedByX ? 3 : 7;
      for (let i = 0; i < probeCount; i++) {
        if (generation !== this.navGeneration || this.originProfile !== profile) return 'abort';
        const route = mediaRefFromHref(window.location.pathname, profile);
        if (route?.key === target.key) {
          const activeViewer = typeof this.findActiveViewer === 'function'
            ? this.findActiveViewer() : document.querySelector<HTMLElement>(VIEWER_SELECTOR);
          const dialogRetained = oldDialog && oldDialog.isConnected &&
            activeViewer?.closest?.('[role="dialog"]') === oldDialog;
          return (activeViewer === viewer && viewer.isConnected) || dialogRetained
            ? 'retained' : 'navigated';
        }
        if (window.location.pathname !== sourcePath || !viewer.isConnected || !link.isConnected) {
          // X already changed the route or dialog unexpectedly: no second click.
          return 'abort';
        }
        if (i < probeCount - 1) await pause(50);
      }
      return 'fallback';
    }

    /**
     * Avoid painting a second photo over X if its target is already loaded.
     * A stale currentSrc plus a different assigned src is NOT ready.
     */
    private nativeSpaTargetRendered(): boolean {
      const handoff = this.handoff;
      if (!handoff || !this.viewer?.isConnected) return false;
      const image = this.displayedPhoto();
      if (!image || !image.complete || image.naturalWidth < 1) return false;
      const displayed = photoCdnIdentity(image.currentSrc || image.src || '');
      const assigned = photoCdnIdentity(image.src || '');
      return displayed === handoff.targetPhotoIdentity &&
        (!assigned || assigned === handoff.targetPhotoIdentity);
    }

    /** Read-only page hop, using ONLY a pre-committed adjacent X media ref.
     * This is an ordinary full document navigation; never spoof X's SPA.
     */
    private async tryCommittedPageBoundary(
      direction: Direction, currentRef: MediaRef, oldViewer: HTMLElement
    ): Promise<boolean> {
      if (!this.publicSessionRestored || !this.originProfile ||
          typeof this.sessionStore?.findAdjacentCheckpoint !== 'function')
        return false;
      if (this.checkpointBoundaryPending) return true;
      const profile=this.originProfile;
      const path=window.location.pathname;
      const generation=this.navGeneration;
      this.checkpointBoundaryPending=true;
      try {
        const result=await this.sessionStore.findAdjacentCheckpoint(
          profile,path,direction);
        if (generation!==this.navGeneration || this.originProfile!==profile ||
            window.location.pathname!==path || !oldViewer.isConnected ||
            this.navigationBusy || document.hidden)return true;
        if(!result){
          // The manifest may have expired since the historical page loaded.
          if(direction===-1 && this.restoredCheckpointPage!==null){
            this.restoredCheckpointPage=null;
            this.viewerStateSnapshot=null;
            this.updateViewerState();
          }
          return false;
        }
        const target=mediaRefFromHref(result.href,profile);
        if(!target || target.kind===null || target.href!==result.href ||
           (direction===1 &&
             target.statusId.padStart(19,'0') >= currentRef.statusId.padStart(19,'0')) ||
           (direction===-1 &&
             target.statusId.padStart(19,'0') <= currentRef.statusId.padStart(19,'0'))){
          diagnostic('checkpoint.boundary_rejected',{reason:'invalid_target'});
          return true;
        }
        const pending=this.pendingDocumentHandoff;
        if(pending && pending.generation===generation &&
           Date.now()-pending.started<10000)return true;
        this.pendingDocumentHandoff={
          target:target.href,started:Date.now(),generation
        };
        diagnostic('checkpoint.boundary_navigation',{
          direction,page:result.page
        });
        try{
          window.location.assign(target.href);
        }catch{
          this.pendingDocumentHandoff=null;
          this.toast('保存済みページへの移動に失敗しました');
        }
        return true;
      }finally{
        if(generation===this.navGeneration)
          this.checkpointBoundaryPending=false;
      }
    }

    private async navigate(direction: Direction): Promise<void> {
      const currentIndex = this.activeIndex();
      const oldViewer = this.viewer;
      if (this.navigationBusy || this.checkpointBoundaryPending ||
          currentIndex === null || !oldViewer || !this.originProfile) return;
      const currentRef = this.refs[currentIndex];
      const nextIndex = adjacentPostIndex(this.refs, currentRef.statusId, direction, currentIndex);
      // Never change X's scroll position simply to discover an unseen post.
      // A new post URL cannot be inferred from its predecessor's ID. Keep
      // the exact current modal/replies panel until X itself loads more cards
      // from a user-initiated media-timeline scroll.
      if (nextIndex === null) {
        // A previously verified page is preferable to another third-party
        // request; only the worker can supply its exact adjoining URL.
        // Do not add an asynchronous hop to the ordinary X-native boundary.
        if (this.publicSessionRestored &&
            await this.tryCommittedPageBoundary(direction,currentRef,oldViewer))
          return;
        if (direction !== 1) return;
        if (this.publicApiLoading ||
            (this.publicApiPreflightGeneration != null &&
           this.publicApiPreflightGeneration===this.navGeneration)) {
          // One pending intent only; its path and generation are checked again
          // after the public index is committed. Never queue multiple arrows.
          this.pendingBoundary={path:window.location.pathname,
            statusId:currentRef.statusId,generation:this.navGeneration,
            photoIdentity:this.currentPhotoIdentity()};
          diagnostic('fxembed.boundary_waiting', { background: true });
          this.toast('次の投稿を公開APIから取得中です');
          return;
        }
        if(this.publicConsentPendingGeneration != null &&
           this.publicConsentPendingGeneration===this.navGeneration) return;
        // This uses a separate public third-party API, not X's official API.
        // Ask only once per tab/profile before disclosing the public handle.
        const consentProfile = this.originProfile;
        const consentPath = window.location.pathname;
        const consentGeneration = this.navGeneration;
        this.sessionStore ??= new SessionStore();
        this.publicConsentPendingGeneration=consentGeneration;
        try {
        const approved = await this.sessionStore.hasConsent(consentProfile);
        if (this.originProfile !== consentProfile ||
            this.navGeneration !== consentGeneration ||
            window.location.pathname !== consentPath || !oldViewer.isConnected) return;
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
              window.location.pathname !== consentPath || !oldViewer.isConnected) return;
          diagnostic('fxembed.consent_granted');
        }
        } finally {
          // An obsolete consent flow must not release the next route's lock.
          if(this.publicConsentPendingGeneration===consentGeneration)
            this.publicConsentPendingGeneration=null;
        }
        const appended = await this.loadPublicMediaContinuation();
        if (!appended) {
          this.toast(this.checkpointCapacityReached
            ? '保存済みの上限64ページに達しました。Xのメディア一覧で続きを確認してください'
            : this.checkpointContinuationBlocked
              ? '次の保存済みページは、投稿の境界から移動できます'
              : '公開APIで次の投稿を確認できませんでした。Xのメディア一覧で読み込んでください');
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
          const destination=this.refs[nextIndex].href;
          const prior=this.pendingDocumentHandoff;
          if(prior && prior.generation===this.navGeneration &&
             Date.now()-prior.started<10000)return;
          const originPath=window.location.pathname;
          const generation=this.navGeneration;
          this.pendingDocumentHandoff={target:destination,
            started:Date.now(),generation};
          // The extension worker keeps validated refs in tab-scoped memory.
          if (!await this.persistPublicMediaSession() ||
              originPath!==window.location.pathname ||
              generation!==this.navGeneration || !oldViewer.isConnected) {
            this.pendingDocumentHandoff=null;
            this.toast('一時保存または画面状態の確認ができないため移動を中止しました');
            return;
          }
          diagnostic('navigation.document_handoff', { kind: this.refs[nextIndex].kind ?? 'post' });
          try{
            window.location.assign(destination);
          }catch{
            this.pendingDocumentHandoff=null;
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
          const result = await this.tryNativeInModalNavigation(
            this.refs[nextIndex], initialDestination, oldViewer, generation);
          if (result === 'retained' || result === 'navigated') {
            diagnostic('navigation.native_spa', { retained: result === 'retained' });
            destinationOpened = true;
            if (this.handoff && !this.nativeSpaTargetRendered()) {
              this.showVisualHandoff();
              const activeViewer = this.findActiveViewer();
              if (activeViewer?.isConnected) this.finishVisualHandoff(activeViewer);
            } else {
              this.clearVisualHandoff();
            }
            return;
          }
          if (result === 'abort') return;
        }
        if (generation !== this.navGeneration || !oldViewer.isConnected ||
            !profileStatusFromPath(window.location.pathname, profile)) return;
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
        if (generation !== this.navGeneration) return;
        const link = destination.statusId !== currentRef.statusId ? this.findLiveLink(destination) : null;
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
        diagnostic('navigation.failed', {
          reason: error instanceof Error ? error.name : 'unknown_exception',
        });
        this.toast('メディアの切り替えに失敗しました');
      } finally {
        if (!destinationOpened) this.clearVisualHandoff?.();
        this.navigationBusy = false;
        this.updateViewerState();
        // The direct SPA route can change before the regular 450ms poll.
        // Start the next bounded lookahead immediately, if X kept the viewer.
        if (destinationOpened && this.viewer?.isConnected && this.imageSources)
          this.schedulePreload?.();
      }
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => new XMN.Controller(), { once: true });
} else {
  new XMN.Controller();
}
