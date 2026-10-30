/// <reference path="./core.ts" />
/** B2: a manifest commits immutable page boundaries without evicting the X viewer.
 * This module defines data invariants only; it never fetches, navigates or
 * interprets a volunteer API cursor as proof of missing/complete X posts.
 */
namespace XMN {
  export interface PublicPageDescriptor {
    page: number;
    firstRef: string;
    lastRef: string;
    mediaCount: number;
    incomingCursor: string|null;
    outgoingCursor: string|null;
  }

  export interface PublicPageManifest {
    schema: 1;
    profile: string;
    timeline: string;
    expires: number;
    activePage: number;
    pages: PublicPageDescriptor[];
  }

  const MANIFEST_FIELDS = [
    'schema','profile','timeline','expires','activePage','pages'
  ];
  const PAGE_FIELDS = [
    'page','firstRef','lastRef','mediaCount','incomingCursor','outgoingCursor'
  ];
  const exactFields = (v: Record<string,unknown>, fields: string[]) => {
    const own = Object.keys(v);
    return own.length===fields.length && own.every(key=>fields.includes(key));
  };
  const cursorValid = (v: unknown) =>
    v===null || (typeof v==='string' && v.length>0 && v.length<=1024);
  const older = (a: string,b:string) =>
    a.padStart(19,'0')<b.padStart(19,'0');

  export function parsePublicPageManifest(
    input: unknown, profile: string
  ): PublicPageManifest|null {
    if(!input || typeof input!=='object' || Array.isArray(input))
      return null;
    const m=input as Record<string,unknown>;
    if(!exactFields(m,MANIFEST_FIELDS) || m.schema!==1 ||
       typeof m.profile!=='string'||m.profile!==profile.toLowerCase()||
       typeof m.timeline!=='string' ||
       !['default','photo','video'].some(k=>m.timeline===m.profile+'|'+k)||
       typeof m.expires!=='number'||!Number.isFinite(m.expires)||
       m.expires<=Date.now() || m.expires>Date.now()+31*60_000 ||
       !Array.isArray(m.pages)||m.pages.length<1||m.pages.length>64 ||
       !Number.isSafeInteger(m.activePage) ||
       (m.activePage as number)<0||(m.activePage as number)>=m.pages.length)
      return null;
    const rows: PublicPageDescriptor[]=[];
    let priorLast:string|null=null;
    let priorCursor:string|null=null;
    for(let i=0;i<m.pages.length;i++){
      const row=m.pages[i];
      if(!row||typeof row!=='object'||Array.isArray(row)||
         !exactFields(row as Record<string,unknown>,PAGE_FIELDS))return null;
      const p=row as Record<string,unknown>;
      if(p.page!==i||!Number.isSafeInteger(p.mediaCount)||
         (p.mediaCount as number)<1||(p.mediaCount as number)>450||
         typeof p.firstRef!=='string'||typeof p.lastRef!=='string'||
         !cursorValid(p.incomingCursor)||!cursorValid(p.outgoingCursor))
        return null;
      const first=mediaRefFromHref(p.firstRef,profile);
      const last=mediaRefFromHref(p.lastRef,profile);
      if(!first||!last||first.href!==p.firstRef||last.href!==p.lastRef||
         older(first.statusId,last.statusId))return null;
      if(i===0 && p.incomingCursor!==null)return null;
      if(i>0 && (p.incomingCursor!==priorCursor||
         priorCursor===null||priorLast===null||
         !older(first.statusId,priorLast)))return null;
      priorLast=last.statusId;
      priorCursor=p.outgoingCursor as string|null;
      rows.push(p as unknown as PublicPageDescriptor);
    }
    return m as unknown as PublicPageManifest;
  }

  export function samePublicPageDescriptor(
    a:PublicPageDescriptor,b:PublicPageDescriptor
  ):boolean{
    return a.page===b.page&&a.firstRef===b.firstRef&&
      a.lastRef===b.lastRef&&a.mediaCount===b.mediaCount&&
      a.incomingCursor===b.incomingCursor&&a.outgoingCursor===b.outgoingCursor;
  }

  export function publicPageMatchesDescriptor(
    input: Record<string,unknown>,desc:PublicPageDescriptor,profile:string,
    timeline:string,manifestExpires:number
  ):boolean{
    const refs=input.refs;
    if(input.profile!==profile||input.timeline!==timeline||
      typeof input.expires!=='number'||manifestExpires>input.expires||
      !Array.isArray(refs)||refs.length!==desc.mediaCount||
      refs[0]!==desc.firstRef||refs[refs.length-1]!==desc.lastRef||
      input.cursor!==desc.outgoingCursor||
      input.anchorFound!==true)return false;
    // No split post may cross a committed page boundary.
    return true;
  }
  /** A read-only step from one proven page boundary to its neighbor. */
  export interface PublicBoundaryTransition {
    expectedActivePage: number;
    targetPage: number;
    direction: -1|1;
    sourceRef: string;
    targetRef: string;
  }
  export function planPublicBoundaryTransition(
    input:unknown,profile:string,sourceRef:string,direction:-1|1
  ):PublicBoundaryTransition|null{
    const manifest=parsePublicPageManifest(input,profile);
    if(!manifest||![-1,1].includes(direction))return null;
    const expectedActivePage=manifest.activePage;
    const targetPage=expectedActivePage+direction;
    if(targetPage<0||targetPage>=manifest.pages.length)return null;
    const source=manifest.pages[expectedActivePage];
    const target=manifest.pages[targetPage];
    const expectedSource=direction===1 ? source.lastRef : source.firstRef;
    const targetRef=direction===1 ? target.firstRef : target.lastRef;
    if(sourceRef!==expectedSource)return null;
    const parsed=mediaRefFromHref(targetRef,profile);
    if(!parsed||parsed.href!==targetRef)return null;
    return {expectedActivePage,targetPage,direction,sourceRef,targetRef};
  }
}
