/// <reference path="./core.ts" />
/// <reference path="./session.ts" />
/** A bounded, immutable checkpoint is published ONLY after its full page is
 * validated. X still owns the real gallery and its navigation.
 */
namespace XMN {
 const pageOlder=(a:string,b:string)=>
   a.padStart(19,'0')<b.padStart(19,'0');
 /** Build from complete provider POST groups, never from guessed photo URLs. */
 export function preparePublicContinuationPage(
   profile:string,timeline:string,refs:readonly MediaRef[],
   suppliedPhotos:ReadonlyMap<string,string>,
   outgoingCursor:string|null,expires:number
 ):PublicSession|null {
   const p=profile.toLowerCase();
   if(!/^[a-z0-9_]{1,15}$/.test(p)||
      !['default','photo','video'].some(t=>timeline===p+'|'+t)||
      refs.length<1||refs.length>450||
      !Number.isFinite(expires)||expires<=Date.now()||
      expires>Date.now()+31*60_000||
      (outgoingCursor!==null && (outgoingCursor.length<1||
        outgoingCursor.length>1024)))return null;
   const groups=groupMediaRefs(refs,'fxembed','complete');
   if(!groups||groups.length<1)return null;
   const photos:[string,string][]=[];
   const photoTotals:[string,number][]=[];
   const seen=new Set<string>();
   for(let i=0;i<groups.length;i++){
     const g=groups[i];
     if(i>0&&!pageOlder(g.statusId,groups[i-1].statusId))return null;
     if(g.refs.some(r=>r.profile!==p||r.kind===null||seen.has(r.key)))
       return null;
     for(const r of g.refs)seen.add(r.key);
     // The provider parser excludes mixed media. Do not silently interpret
     // /photo/N and /video/N as one canonical album.
     const kind=g.refs[0].kind;
     if(g.refs.some(r=>r.kind!==kind))return null;
     if(kind==='video'&& (g.refs.length!==1||
       g.refs[0].mediaIndex!==1))return null;
     if(kind==='photo'){
       if(g.refs.length>MAX_MEDIA_PER_POST||g.refs.some((r,j)=>r.mediaIndex!==j+1))
         return null;
       photoTotals.push([g.statusId,g.refs.length]);
       for(const r of g.refs){
         const url=suppliedPhotos.get(r.key);
         if(!url||preloadImageUrl(url)!==url)return null;
         photos.push([r.key,url]);
       }
     }
   }
   if(photoTotals.length>128)photoTotals.splice(0,photoTotals.length-128);
   return {schema:1,profile:p,timeline,expires,
     refs:refs.map(r=>r.href),apiKeys:refs.map(r=>r.key),
     photos,photoTotals,cursor:outgoingCursor,
     anchorFound:true,exhausted:outgoingCursor===null};
 }
 /** A descriptor never points into the middle of a post group. */
 export function createPublicContinuationManifest(
   active:PublicSession,next:PublicSession,
   previous:PublicPageManifest|null
 ):PublicPageManifest|null {
   if(active.schema!==1||next.schema!==1||
      active.profile!==next.profile||active.timeline!==next.timeline||
      !active.anchorFound||active.exhausted||!active.cursor||
      !next.anchorFound||active.expires!==next.expires||
      active.refs.length<1||active.refs.length>450||
      next.refs.length<1||next.refs.length>450)return null;
   const profile=active.profile;
   const currentFirst=mediaRefFromHref(active.refs[0],profile);
   const currentLast=mediaRefFromHref(active.refs[active.refs.length-1],profile);
   const nextFirst=mediaRefFromHref(next.refs[0],profile);
   const nextLast=mediaRefFromHref(next.refs[next.refs.length-1],profile);
   if(!currentFirst||!currentLast||!nextFirst||!nextLast||
      !pageOlder(nextFirst.statusId,currentLast.statusId))
     return null;
   const basePages=previous?.pages??[];
   if(basePages.length>=64)return null;
   if(previous){
     const last=basePages[basePages.length-1];
     if(previous.activePage!==basePages.length-1||
        previous.profile!==profile||previous.timeline!==active.timeline||
        previous.expires>active.expires||
        last.firstRef!==active.refs[0]||
        last.lastRef!==active.refs[active.refs.length-1]||
        last.mediaCount!==active.refs.length||
        last.outgoingCursor!==active.cursor)return null;
   }
   const currentIndex=previous ? basePages.length-1 : 0;
   const pages:PublicPageDescriptor[]=previous ? basePages.slice() : [{
     page:0,firstRef:active.refs[0],lastRef:active.refs[active.refs.length-1],
     mediaCount:active.refs.length,incomingCursor:null,
     outgoingCursor:active.cursor
   }];
   pages.push({page:currentIndex+1,firstRef:next.refs[0],
     lastRef:next.refs[next.refs.length-1],mediaCount:next.refs.length,
     incomingCursor:active.cursor!,outgoingCursor:next.cursor});
   const manifest:PublicPageManifest={
     schema:1,profile,timeline:active.timeline!,
     expires:previous?.expires??active.expires,
     activePage:currentIndex,pages
   };
   return parsePublicPageManifest(manifest,profile);
 }
}
