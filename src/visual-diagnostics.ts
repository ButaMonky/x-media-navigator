/** Privacy-safe, temporary verbose visual telemetry for private XMN QA.
 * Deliberately NEVER collect URLs, handles, status IDs, labels, text content,
 * alt text, image src, cookies, storage values, or request headers. */
namespace XMN {
  export interface VisualDebugContext {
    viewer: HTMLElement | null;
    host: HTMLElement | null;
    indexedRefs: number;
    indexedPosts: number;
    activeIndex: number | null;
    profileReady: boolean;
    gridPending: boolean;
    navigationBusy: boolean;
    prefetchInFlight: number;
    cacheEntries: number;
    photoTotals: number;
    listObserverActive: boolean;
    modalObserverActive: boolean;
    healthCode: string;
  }

  const VDBG_TESTIDS = new Set([
    'swipe-to-dismiss', 'mediaViewer', 'tweetPhoto', 'cellInnerDiv',
    'primaryColumn', 'tweet', 'app-bar-close', 'videoPlayer',
    'tweetText', 'quotedTweet', 'quoteTweet', 'gallery', 'modal',
  ]);
  const VDBG_ROLES = new Set([
    'dialog','group','button','list','listitem','main','img',
    'presentation','status','generic','region','article','navigation',
  ]);

  function vdbgCount(root: ParentNode | null, selector: string): number {
    try { return root?.querySelectorAll(selector)?.length ?? 0; }
    catch { return -1; }
  }

  function vdbgRect(node: Element | null): Record<string, number> | null {
    if (!node || typeof node.getBoundingClientRect !== 'function') return null;
    try {
      const b = node.getBoundingClientRect();
      const round = (n:number):number => Number.isFinite(n) ? Math.round(n * 10) / 10 : -1;
      return { x:round(b.x), y:round(b.y), width:round(b.width), height:round(b.height),
        right:round(b.right), bottom:round(b.bottom) };
    } catch { return null; }
  }

  function vdbgStyle(node: Element | null): Record<string, string> | null {
    if (!node || typeof window.getComputedStyle !== 'function') return null;
    try {
      const s=window.getComputedStyle(node);
      return {
        display:s.display, visibility:s.visibility, opacity:s.opacity,
        position:s.position, zIndex:s.zIndex, pointerEvents:s.pointerEvents,
        width:s.width, height:s.height, left:s.left, right:s.right,
        top:s.top, bottom:s.bottom, transform:s.transform,
        overflowX:s.overflowX, overflowY:s.overflowY, clipPath:s.clipPath?.includes("url(") ? "url_redacted" : s.clipPath,
        contain:s.contain, contentVisibility:s.contentVisibility,
        isolation:s.isolation, filter:s.filter?.includes("url(") ? "url_redacted" : s.filter,
        backgroundColor:s.backgroundColor, color:s.color,
        borderColor:s.borderColor, borderWidth:s.borderWidth,
        fontSize:s.fontSize,
      };
    } catch { return null; }
  }

  function vdbgNode(node: Element | null): Record<string, unknown> | null {
    if (!node) return null;
    const rawTestid=node.getAttribute?.('data-testid');
    const rawRole=node.getAttribute?.('role');
    const cls=node.classList;
    return {
      tag:node.tagName?.toLowerCase() ?? 'unknown',
      testid:rawTestid ? (VDBG_TESTIDS.has(rawTestid) ? rawTestid : 'other') : null,
      role:rawRole ? (VDBG_ROLES.has(rawRole) ? rawRole : 'other') : null,
      xmn:!!cls && ['xmn-controls-layer','xmn-nav-button','xmn-status',
        'xmn-tile-badge','xmn-visual-handoff'].some(k=>cls.contains(k)),
      hiddenAttribute:node.hasAttribute?.('hidden') ?? false,
      inertAttribute:node.hasAttribute?.('inert') ?? false,
      ariaHidden:node.getAttribute?.('aria-hidden') === 'true',
    };
  }

  function vdbgParents(node:Element|null, limit=9):Record<string,unknown>[] {
    const parents:Record<string,unknown>[]=[];
    let current:Element|null=node;
    for(let i=0;current && i<limit;i++,current=current.parentElement) {
      parents.push({ level:i, element:vdbgNode(current), rect:vdbgRect(current),
        style:vdbgStyle(current) });
    }
    return parents;
  }

  function vdbgHit(node:Element):Record<string,unknown> {
    const r=node.getBoundingClientRect?.();
    if(!r||!Number.isFinite(r.width)||!Number.isFinite(r.height)||
       r.width<=0||r.height<=0)return {status:'zero_size'};
    const x=r.left+r.width/2, y=r.top+r.height/2;
    if(x<0||y<0||x>=window.innerWidth||y>=window.innerHeight)
      return { status:'outside_viewport', point:[Math.round(x),Math.round(y)] };
    try {
      const top=document.elementFromPoint(x,y);
      const stack=typeof document.elementsFromPoint==='function'
        ? document.elementsFromPoint(x,y).slice(0,7).map(vdbgNode)
        : [vdbgNode(top)];
      return { status:top && (top===node||node.contains(top))?'hit':'occluded',
        point:[Math.round(x),Math.round(y)], top:vdbgNode(top), stack };
    } catch { return {status:'hit_test_unavailable'}; }
  }

  function vdbgElement(node:Element|null):Record<string,unknown>|null {
    if(!node)return null;
    return { element:vdbgNode(node), rect:vdbgRect(node), style:vdbgStyle(node),
      parentChain:vdbgParents(node,7) };
  }

  function vdbgMode():{route:string;mediaKind:string;position:number|null;filter:string} {
    const pathname=window.location.pathname;
    const match=/(?:^|\/)(photo|video)\/(\d+)\/?$/.exec(pathname);
    const route=/\/media\/?$/.test(pathname) ? 'profile_media'
      : /\/status\/\d+/.test(pathname) ? 'post' : 'other';
    const mode=new URLSearchParams(window.location.search).get('filter');
    return {
      route,
      mediaKind:match?.[1] ?? 'unknown',
      position:match ? Number(match[2]) : null,
      filter:mode==='photo'||mode==='video'?mode:mode?'other':'default',
    };
  }

  export function collectVisualDebug(input:VisualDebugContext):Record<string,unknown> {
    const host=input.host, viewer=input.viewer;
    const buttons=Array.from(document.querySelectorAll<HTMLButtonElement>('.xmn-nav-button')).slice(0,8);
    const layers=Array.from(document.querySelectorAll<HTMLElement>('.xmn-controls-layer')).slice(0,5);
    const primary=document.querySelector('[data-testid="primaryColumn"]') ?? document.querySelector('main');
    const mediaRoot=viewer ?? document.querySelector<HTMLElement>('[role="dialog"]');
    const media=Array.from((mediaRoot ?? document).querySelectorAll<HTMLElement>('img,video')).slice(0,10);
    const dialogs=Array.from(document.querySelectorAll<HTMLElement>('dialog,[role="dialog"],[popover]')).slice(0,8);
    const viewport=window.visualViewport;
    return {
      collectedAt:new Date().toISOString(),
      route:vdbgMode(),
      browser:{
        innerWidth:window.innerWidth,innerHeight:window.innerHeight,
        devicePixelRatio:window.devicePixelRatio,
        scrollX:window.scrollX,scrollY:window.scrollY,
        visualViewport:viewport?{
          width:viewport.width,height:viewport.height,offsetLeft:viewport.offsetLeft,
          offsetTop:viewport.offsetTop,scale:viewport.scale
        }:null,
        documentReadyState:document.readyState,
        visibilityState:document.visibilityState,
        fullscreen:!!document.fullscreenElement,
      },
      session:{
        profileReady:input.profileReady,indexedRefs:input.indexedRefs,
        indexedPosts:input.indexedPosts,activeIndex:input.activeIndex,
        gridPending:input.gridPending,navigationBusy:input.navigationBusy,
        prefetchInFlight:input.prefetchInFlight,cacheEntries:input.cacheEntries,
        photoTotals:input.photoTotals,listObserverActive:input.listObserverActive,
        modalObserverActive:input.modalObserverActive,healthCode:input.healthCode,
      },
      domCounts:{
        main:vdbgCount(document,'main'),
        primaryColumn:vdbgCount(document,'[data-testid="primaryColumn"]'),
        listItems:vdbgCount(primary,'li[role="listitem"]'),
        cellInnerDiv:vdbgCount(primary,'[data-testid="cellInnerDiv"]'),
        mediaAnchors:vdbgCount(primary,'a[href*="/status/"]'),
        mediaTilesWithBadge:vdbgCount(primary,'.xmn-tile-badge'),
        swipeViewers:vdbgCount(document,'[data-testid="swipe-to-dismiss"]'),
        modernViewers:vdbgCount(document,'[data-testid="mediaViewer"]'),
        dialogs:vdbgCount(document,'[role="dialog"]'),
        htmlDialogs:vdbgCount(document,'dialog'),
        modalTopLayer:vdbgCount(document,'dialog:modal'),
        popoverTopLayer:vdbgCount(document,'[popover]:popover-open'),
        photoElements:vdbgCount(document,'[data-testid="tweetPhoto"]'),
        images:vdbgCount(document,'img'),videos:vdbgCount(document,'video'),
        xmnLayers:vdbgCount(document,'.xmn-controls-layer'),
        xmnArrows:vdbgCount(document,'.xmn-nav-button'),
        xmnStatus:vdbgCount(document,'.xmn-status'),
        xmnToasts:vdbgCount(document,'.xmn-toast'),
        handoffs:vdbgCount(document,'.xmn-visual-handoff'),
        stylesheets:document.styleSheets?.length ?? 0,
      },
      ownViewer:vdbgElement(viewer),
      ownHost:vdbgElement(host),
      allHostLayers:layers.map((layer,i)=>({
        index:i,attachedToBody:layer.parentElement===document.body,
        topLayerAncestor:!!layer.closest('dialog:modal,[popover]:popover-open'),
        rect:vdbgRect(layer),style:vdbgStyle(layer),
        childArrows:vdbgCount(layer,'.xmn-nav-button'),
      })),
      buttons:buttons.map((button,i)=>({
        index:i,side:button.classList.contains('xmn-prev')?'left':
          button.classList.contains('xmn-next')?'right':'other',
        disabled:button.disabled,rect:vdbgRect(button),style:vdbgStyle(button),
        inlineDisplay:button.style.display,inlineOpacity:button.style.opacity,
        hitTest:vdbgHit(button),parents:vdbgParents(button,7),
      })),
      dialogs:dialogs.map((dialog,i)=>({
        index:i,element:vdbgNode(dialog),rect:vdbgRect(dialog),
        style:vdbgStyle(dialog),
        containsViewer:!!viewer&&dialog.contains(viewer),
        containsControls:!!host&&dialog.contains(host),
      })),
      visibleMediaSamples:media.map((element,i)=>({
        index:i,tag:element.tagName.toLowerCase(),
        rect:vdbgRect(element),style:vdbgStyle(element),
        naturalWidth:element.tagName==='IMG'?(element as HTMLImageElement).naturalWidth:null,
        naturalHeight:element.tagName==='IMG'?(element as HTMLImageElement).naturalHeight:null,
        imageComplete:element.tagName==='IMG'?(element as HTMLImageElement).complete:null,
        videoReadyState:element.tagName==='VIDEO'?(element as HTMLVideoElement).readyState:null,
      })),
      notes:[
        'No URLs, post IDs, handles, text, image source or credentials collected.',
        'Display and hit testing alone cannot prove human-visible pixel rendering.',
      ],
    };
  }
}
