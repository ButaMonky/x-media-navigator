/// <reference path="./core.ts" />
/** MV3 trusted worker: tab-scoped, memory-only consent and validated media session. */
type Sender = { tab?: { id?: number }, frameId?: number, url?: string };
type Message = {
  kind?: string; op?: string; profile?: string; session?: unknown;
  page?: unknown; manifest?: unknown; href?: unknown; direction?: unknown;
  transition?: unknown;
};
declare const chrome: {
 runtime: { onMessage: { addListener(cb: (
   message: unknown, sender: Sender, sendResponse: (result: unknown)=>void
 )=>boolean|void): void } },
 storage: { session: {
   get(keys: string|string[]|null): Promise<Record<string, unknown>>,
   set(values: Record<string, unknown>): Promise<void>,
   remove(keys: string|string[]): Promise<void>
 } },
 tabs: { onRemoved: { addListener(cb: (tabId: number)=>void): void } }
};
namespace XMN {
 const MAX_SESSION_CHARACTERS=120000;
 const SESSION_FIELDS=[
   'schema','profile','timeline','expires','refs','apiKeys',
   'photos','photoTotals','cursor','anchorFound','exhausted'
 ] as const;
 const canonicalSession=(value:Record<string,unknown>):string=>
   JSON.stringify(SESSION_FIELDS.map(key=>[key,value[key]]));
 /** Immutable media identity, excluding volatile TTL and derived image caches. */
 const canonicalSessionMediaIdentity=(value:Record<string,unknown>):string=>
   JSON.stringify(SESSION_FIELDS.filter(key=>
     key!=='expires'&&key!=='photos'&&key!=='photoTotals')
     .map(key=>[key,value[key]]));
 const HANDLE=/^[a-zA-Z0-9_]{1,15}$/;
 const SESSION_PREFIX='xmn:session:';
 const CONSENT_PREFIX='xmn:consent:';
 const CHECKPOINT_PREFIX='xmn:checkpoint:';
 const MANIFEST_PREFIX='xmn:manifest:';
 const MAX_CHECKPOINT_PAGES=64; // Up to ~28,800 media references in memory.
 const validTab=(sender:Sender,profile:unknown):number|null=>{
   const tab=sender.tab?.id;
   if(typeof tab!=='number'||!Number.isSafeInteger(tab)||tab<0||sender.frameId!==0 ||
      typeof profile!=='string'||!HANDLE.test(profile))return null;
   try{
     const url=new URL(sender.url||'');
     if(url.protocol!=='https:'||!['x.com','www.x.com','twitter.com',
       'www.twitter.com'].includes(url.hostname))return null;
     const owner=profile.toLowerCase();
     if(mediaProfileFromPath(url.pathname)!==owner &&
        !profileStatusFromPath(url.pathname,profile))return null;
     return tab as number;
   }catch{return null;}
 };
 function validateSession(data:unknown, profile:string):data is Record<string,unknown>{
   if(!data||typeof data!=='object'||Array.isArray(data))return false;
   const x=data as Record<string,unknown>;
   // Never persist unsolicited fields such as page data, access tokens or
   // arbitrary nested objects as part of the short-lived public index.
   if(Object.keys(x).length!==SESSION_FIELDS.length||
      Object.keys(x).some(key=>!(SESSION_FIELDS as readonly string[]).includes(key)))
     return false;
   const p=profile.toLowerCase();
   if(x.schema!==1 || x.profile!==p || typeof x.expires!=='number' ||
      !Number.isFinite(x.expires) || x.expires<=Date.now() ||
      x.expires>Date.now()+31*60*1000 ||
      !['default','photo','video'].some(t=>x.timeline===p+'|'+t) ||
      !Array.isArray(x.refs)||x.refs.length<1||x.refs.length>450 ||
      !Array.isArray(x.apiKeys)||x.apiKeys.length<1||x.apiKeys.length>450 ||
      (x.cursor!==null && (typeof x.cursor!=='string' ||
       x.cursor.length<1||x.cursor.length>1024)) ||
      typeof x.anchorFound!=='boolean'||typeof x.exhausted!=='boolean')return false;
   let last='';const keys=new Set<string>(),groups=new Set<string>();
   for(const raw of x.refs){
     if(typeof raw!=='string'||raw.length>128)return false;
     const ref=mediaRefFromHref(raw,p);
     if(!ref||ref.href!==raw||keys.has(ref.key))return false;
     keys.add(ref.key);
     if(ref.statusId!==last){
       if(groups.has(ref.statusId)|| (last&&
          ref.statusId.padStart(19,'0')>=last.padStart(19,'0')))return false;
       groups.add(ref.statusId);last=ref.statusId;
     }
   }
   for(const key of x.apiKeys){
     if(typeof key!=='string'||!keys.has(key))return false;
   }
   if(!Array.isArray(x.photos)||x.photos.length>450||
      !Array.isArray(x.photoTotals)||x.photoTotals.length>128)return false;
   for(const item of x.photos){
     if(!Array.isArray(item)||item.length!==2||!keys.has(item[0])||
        typeof item[1]!=='string'||preloadImageUrl(item[1])!==item[1])
       return false;
   }
   for(const item of x.photoTotals){
     if(!Array.isArray(item)||item.length!==2||
        typeof item[0]!=='string'||!/^\d{1,19}$/.test(item[0])||
        !Number.isInteger(item[1])||item[1]<1||item[1]>4 ||
        !groups.has(item[0]))return false;
   }
   try{return JSON.stringify(x).length<=MAX_SESSION_CHARACTERS}
   catch{return false}
 }
 const sessionKey=(id:number)=>SESSION_PREFIX+id;
 const consentKey=(id:number,profile:string)=>
   CONSENT_PREFIX+id+':'+profile.toLowerCase();
 const checkpointPrefix=(id:number,profile:string)=>
   CHECKPOINT_PREFIX+id+':'+profile.toLowerCase()+':';
 const checkpointKey=(id:number,profile:string,page:number)=>
   checkpointPrefix(id,profile)+page;
 const checkpointPage=(page:unknown):page is number=>
   typeof page==='number'&&Number.isSafeInteger(page)&&
   page>=0&&page<MAX_CHECKPOINT_PAGES;
 const manifestKey=(tab:number,profile:string)=>
   MANIFEST_PREFIX+tab+':'+profile.toLowerCase();
 // A session is keyed by TAB, not profile. All operations that can read,
 // replace, clear or activate that session share the same tab-level lock.
 const tabLockKey=(tab:number)=>MANIFEST_PREFIX+tab+':_tab';
 const manifestJobs=new Map<string,Promise<unknown>>();
 async function withManifestLock<T>(key:string,operation:()=>Promise<T>):Promise<T>{
   const previous=manifestJobs.get(key)??Promise.resolve();
   const current=previous.catch(()=>undefined).then(operation);
   manifestJobs.set(key,current);
   try{return await current}
   finally{if(manifestJobs.get(key)===current)manifestJobs.delete(key)}
 }
 async function verifyManifestPages(
   manifest:PublicPageManifest,tab:number,profile:string
 ):Promise<boolean>{
   const keys=manifest.pages.map(meta=>checkpointKey(tab,profile,meta.page));
   const stored=await chrome.storage.session.get(keys);
   for(let i=0;i<manifest.pages.length;i++){
     const value=stored[keys[i]];
     if(!validateSession(value,profile))return false;
     if(!publicPageMatchesDescriptor(value,manifest.pages[i],
          profile,manifest.timeline,manifest.expires))return false;
   }
   return true;
 }
 // A page slot is immutable. Concurrent writes to the same slot serialize;
 // a replay is idempotent and a different payload is rejected.
 const checkpointWrites=new Map<string,Promise<boolean>>();
 async function storeCheckpointOnce(key:string,payload:unknown):Promise<boolean>{
   const prior=checkpointWrites.get(key)??Promise.resolve(true);
   const write=prior.catch(()=>false).then(async()=>{
     const existing=(await chrome.storage.session.get(key))[key];
     if(existing!==undefined){
       try{
         // Chrome may reorder object fields during storage serialization.
         // Equal snapshots are still idempotent; different cursor/ref data
         // must never replace an immutable historical page.
         return canonicalSession(existing as Record<string,unknown>)===
           canonicalSession(payload as Record<string,unknown>);
       }catch{return false}
     }
     await chrome.storage.session.set({[key]:payload});
     return true;
   });
   checkpointWrites.set(key,write);
   try{return await write}
   finally{
     if(checkpointWrites.get(key)===write)checkpointWrites.delete(key);
   }
 }
 async function deleteCheckpointPages(
   tabId:number,profile:string,page?:number
 ):Promise<void>{
   const prefix=checkpointPrefix(tabId,profile);
   // A pending immutable write must finish before all pages are enumerated.
   const pending=[...checkpointWrites.entries()]
     .filter(([key])=>page===undefined
       ? key.startsWith(prefix)
       : key===checkpointKey(tabId,profile,page))
     .map(([,write])=>write.catch(()=>false));
   if(pending.length)await Promise.all(pending);
   const keys=page===undefined
     ? Object.keys(await chrome.storage.session.get(null))
       .filter(key=>key.startsWith(prefix))
     : [checkpointKey(tabId,profile,page)];
   if(keys.length)await chrome.storage.session.remove(keys);
 }
 async function handle(msg:Message,sender:Sender):Promise<unknown>{
   if(msg.kind!=='xmn-store-v1')return {ok:false};
   const id=validTab(sender,msg.profile);
   if(id===null||typeof msg.profile!=='string')return {ok:false};
   const profile=msg.profile.toLowerCase();
   if(msg.op==='consent.get'){
     const data=await chrome.storage.session.get(consentKey(id,profile));
     return {ok:true,granted:data[consentKey(id,profile)]===true};
   }
   if(msg.op==='consent.set'){
     // A closing tab must wait for a pending consent write. Otherwise the
     // same tab ID can be reused after cleanup but retain stale consent.
     return withManifestLock(tabLockKey(id),async()=>{
       await chrome.storage.session.set({[consentKey(id,profile)]:true});
       return {ok:true};
     });
   }
   if(msg.op==='session.get'){
     // Expiry cleanup must not race with manifest.activate's atomic
     // session update: an old read could otherwise delete the new page.
     return withManifestLock(tabLockKey(id),async()=>{
       const key=sessionKey(id);
       const data=await chrome.storage.session.get(key);
       const saved=data[key];
       if(!validateSession(saved,profile)){
         // One tab has one active session slot. A late read from its former
         // profile must not erase a valid session owned by the new profile.
         const other=(saved&&typeof saved==='object'&&!Array.isArray(saved))
           ? (saved as Record<string,unknown>).profile : null;
         if(typeof other==='string'&&other!==profile&&HANDLE.test(other)&&
            validateSession(saved,other))
           return {ok:true,session:null};
         if(saved!==undefined)await chrome.storage.session.remove(key);
         return {ok:true,session:null};
       }
       return {ok:true,session:saved};
     });
   }
   if(msg.op==='session.set'){
     if(!validateSession(msg.session,profile))return {ok:false};
     const key=manifestKey(id,profile);
     return withManifestLock(tabLockKey(id),async()=>{
       const value=(await chrome.storage.session.get(key))[key];
       if(value!==undefined){
         const m=parsePublicPageManifest(value,profile);
         if(!m||!await verifyManifestPages(m,id,profile))
           return {ok:false};
         const active=m.pages[m.activePage];
         const pageKey=checkpointKey(id,profile,m.activePage);
         const stored=(await chrome.storage.session.get(pageKey))[pageKey];
         if(!validateSession(stored,profile)||
            !publicPageMatchesDescriptor(stored,active,profile,
              m.timeline,m.expires)||
            canonicalSessionMediaIdentity(stored)!==
              canonicalSessionMediaIdentity(
                msg.session as Record<string,unknown>))
           return {ok:false};
         // A verified page may refresh its TTL or decoded-image cache after
         // checkpoint commit. Acknowledge the same media identity, but
         // never extend or overwrite the immutable active page expiration.
         if(canonicalSession(stored)!==
            canonicalSession(msg.session as Record<string,unknown>))
           return {ok:true};
       }
       await chrome.storage.session.set({[sessionKey(id)]:msg.session});
       return {ok:true};
     });
   }
   if(msg.op==='session.clear'||msg.op==='checkpoint.clear'||
      msg.op==='manifest.clear'){
     if(msg.op==='checkpoint.clear' && msg.page!==undefined &&
        !checkpointPage(msg.page))return {ok:false};
     return withManifestLock(tabLockKey(id),async()=>{
       await deleteCheckpointPages(id,profile,
         msg.op==='checkpoint.clear' ? msg.page as number|undefined : undefined);
       const remove=[manifestKey(id,profile)];
       if(msg.op==='session.clear'){
         const key=sessionKey(id);
         const saved=(await chrome.storage.session.get(key))[key];
         // One tab can switch profiles while an older document is closing.
         // Only clear a session actually owned by the requested profile.
         if(saved&&typeof saved==='object'&&!Array.isArray(saved) &&
            (saved as Record<string,unknown>).profile===profile)
           remove.push(key);
       }
       await chrome.storage.session.remove(remove);
       return {ok:true};
     });
   }
   if(msg.op==='checkpoint.find'||msg.op==='checkpoint.adjacent'||
      msg.op==='checkpoint.restore'){
     if(msg.op==='checkpoint.adjacent' && msg.direction!==-1 &&
        msg.direction!==1)return {ok:false};
     // A historical page may be selected only by the exact public media URL
     // already displayed in this TOP-FRAME X tab. No cross-post lookup.
     if(typeof msg.href!=='string'||msg.href.length>128)return {ok:false};
     const ref=mediaRefFromHref(msg.href,profile);
     if(!ref||ref.kind===null||ref.href!==msg.href)return {ok:false};
     const targetHref=msg.href;
     try{
       if(new URL(sender.url||'').pathname!==msg.href)return {ok:false};
     }catch{return {ok:false}}
     const consent=(await chrome.storage.session.get(consentKey(id,profile)))[consentKey(id,profile)];
     if(consent!==true)return {ok:false};
     const key=manifestKey(id,profile);
     return withManifestLock(tabLockKey(id),async()=>{
       const saved=(await chrome.storage.session.get(key))[key];
       if(saved===undefined)return {ok:true,session:null,page:null};
       const manifest=parsePublicPageManifest(saved,profile);
       if(!manifest){
         await chrome.storage.session.remove(key);
         return {ok:true,session:null,page:null};
       }
       const keys=manifest.pages.map(meta=>checkpointKey(id,profile,meta.page));
       const storage=await chrome.storage.session.get(keys);
       let chosen:Record<string,unknown>|null=null;
       let selected:number|null=null;
       for(let i=0;i<keys.length;i++){
         const data=storage[keys[i]];
         if(!validateSession(data,profile)||
            !publicPageMatchesDescriptor(
              data,manifest.pages[i],profile,manifest.timeline,manifest.expires)){
           await chrome.storage.session.remove(key);
           return {ok:true,session:null,page:null};
         }
         if((data.refs as string[]).includes(targetHref)){
           if(chosen!==null){
             // One X media URL may not belong to two committed page windows.
             await chrome.storage.session.remove(key);
             return {ok:true,session:null,page:null};
           }
           chosen=data;
           selected=manifest.pages[i].page;
         }
       }
       if(msg.op==='checkpoint.adjacent'){
         if(chosen===null||selected===null ||
            selected!==manifest.activePage)
           return {ok:true,href:null,page:null};
         const ownRefs=chosen.refs as string[];
         const firstStatus=mediaRefFromHref(ownRefs[0],profile)?.statusId;
         const lastStatus=mediaRefFromHref(ownRefs[ownRefs.length-1],profile)?.statusId;
         if(msg.direction===1 && ref.statusId===lastStatus &&
            selected<keys.length-1){
           const next=storage[keys[selected+1]] as Record<string,unknown>;
           const urls=next.refs as string[];
           return {ok:true,href:urls[0],page:selected+1};
         }
         if(msg.direction===-1 && ref.statusId===firstStatus &&
            selected>0){
           const previous=storage[keys[selected-1]] as Record<string,unknown>;
           const urls=previous.refs as string[];
           const tail=mediaRefFromHref(urls[urls.length-1],profile)?.statusId;
           // Navigate to the FIRST image of the adjoining (newer) post.
           const destination=urls.find(url=>
             mediaRefFromHref(url,profile)?.statusId===tail);
           return {ok:true,href:destination??null,
             page:destination?selected-1:null};
         }
         return {ok:true,href:null,page:null};
       }
       if(msg.op==='checkpoint.restore'&&chosen!==null&&selected!==null){
         // An ordinary browser History jump can skip multiple immutable
         // checkpoint pages. Reading the snapshot alone leaves the Worker
         // stuck on a different active page and breaks later arrow navigation.
         // The user has ALREADY arrived at this exact verified X media route;
         // atomically publish the historical page and its active session.
         const updated:PublicPageManifest={...manifest,activePage:selected};
         await chrome.storage.session.set({
           [key]:updated,[sessionKey(id)]:chosen
         });
         return {ok:true,session:chosen,page:selected,manifest:updated};
       }
       return {ok:true,session:chosen,page:selected};
     });
   }
   if(msg.op==='manifest.get'||msg.op==='manifest.put'||
      msg.op==='manifest.activate'){
     const consent=(await chrome.storage.session.get(consentKey(id,profile)))[consentKey(id,profile)];
     if(consent!==true)return {ok:false};
     const key=manifestKey(id,profile);
     return withManifestLock(tabLockKey(id),async()=>{
       const saved=(await chrome.storage.session.get(key))[key];
       if(msg.op==='manifest.get'){
         if(saved===undefined)return {ok:true,manifest:null};
         const current=parsePublicPageManifest(saved,profile);
         if(!current || !await verifyManifestPages(current,id,profile)){
           await chrome.storage.session.remove(key);
           return {ok:true,manifest:null};
         }
         return {ok:true,manifest:current};
       }
       if(msg.op==='manifest.activate'){
         const current=parsePublicPageManifest(saved,profile);
         if(!current||!await verifyManifestPages(current,id,profile))
           return {ok:false};
         const raw=msg.transition;
         if(!raw||typeof raw!=='object'||Array.isArray(raw))return {ok:false};
         const t=raw as Record<string,unknown>;
         const fields=['expectedActivePage','targetPage','direction',
           'sourceRef','targetRef'];
         if(Object.keys(t).length!==fields.length||
           Object.keys(t).some(field=>!fields.includes(field))||
           typeof t.sourceRef!=='string'||typeof t.targetRef!=='string'||
           (t.direction!==1&&t.direction!==-1)||
           !Number.isSafeInteger(t.expectedActivePage)||
           !Number.isSafeInteger(t.targetPage))return {ok:false};
         const expected=planPublicBoundaryTransition(
           current,profile,t.sourceRef,t.direction as -1|1,t.targetRef);
         if(!expected||fields.some(field=>
           t[field]!==expected[field as keyof PublicBoundaryTransition]))
           return {ok:false};
         try{
           if(new URL(sender.url||'').pathname!==expected.targetRef)
             return {ok:false};
         }catch{return {ok:false}}
         const desc=current.pages[expected.targetPage];
         const target=(await chrome.storage.session.get(
           checkpointKey(id,profile,expected.targetPage)))[
             checkpointKey(id,profile,expected.targetPage)];
         if(!validateSession(target,profile)||!publicPageMatchesDescriptor(
           target,desc,profile,current.timeline,current.expires))
           return {ok:false};
         const refs=target.refs as string[];
         const lastStatus=mediaRefFromHref(refs[refs.length-1],profile)?.statusId;
         const backFirst=refs.find(url=>
           mediaRefFromHref(url,profile)?.statusId===lastStatus);
         // Rewinding to the last post must open its FIRST media, not the
         // last image of a multiple-photo album.
         if(expected.direction===-1 && expected.targetRef!==backFirst)
           return {ok:false};
         if(expected.direction===1 && expected.targetRef!==refs[0])
           return {ok:false};
         const updated:PublicPageManifest={
           ...current,activePage:expected.targetPage
         };
         await chrome.storage.session.set({
           [key]:updated,[sessionKey(id)]:target
         });
         return {ok:true,session:target,manifest:updated};
       }
       const next=parsePublicPageManifest(msg.manifest,profile);
       if(!next||(saved===undefined && next.activePage!==0))return {ok:false};
       if(saved!==undefined){
         const previous=parsePublicPageManifest(saved,profile);
         if(!previous || previous.timeline!==next.timeline ||
            next.activePage!==previous.activePage ||
            next.expires>previous.expires ||
            next.pages.length<previous.pages.length ||
            previous.pages.some((desc,i)=>
              !samePublicPageDescriptor(desc,next.pages[i])))return {ok:false};
       }
       if(!await verifyManifestPages(next,id,profile))return {ok:false};
       await chrome.storage.session.set({[key]:next});
       return {ok:true};
     });
   }
   if(msg.op==='checkpoint.put'||msg.op==='checkpoint.get'||
      msg.op==='checkpoint.list'){
     const consent=(await chrome.storage.session.get(consentKey(id,profile)))[consentKey(id,profile)];
     if(consent!==true)return {ok:false};
     if(msg.op==='checkpoint.put'||msg.op==='checkpoint.get'){
       if(!checkpointPage(msg.page))return {ok:false};
       const key=checkpointKey(id,profile,msg.page);
       if(msg.op==='checkpoint.put'){
         if(!validateSession(msg.session,profile)||
            (msg.session as Record<string,unknown>).anchorFound!==true)return {ok:false};
         return {ok:await storeCheckpointOnce(key,msg.session)};
       }
       const saved=(await chrome.storage.session.get(key))[key];
       if(saved===undefined)return {ok:true,session:null};
       if(!validateSession(saved,profile)){
         await chrome.storage.session.remove(key);
         return {ok:true,session:null};
       }
       return {ok:true,session:saved};
     }
     const prefix=checkpointPrefix(id,profile);
     const stored=await chrome.storage.session.get(null);
     const pages:number[]=[];
     const corrupt:string[]=[];
     for(const [key,value] of Object.entries(stored)){
       if(!key.startsWith(prefix))continue;
       const raw=key.slice(prefix.length);
       const page=Number(raw);
       if(!/^\d+$/.test(raw)||!checkpointPage(page)||
          String(page)!==raw||!validateSession(value,profile))corrupt.push(key);
       else pages.push(page);
     }
     if(corrupt.length)await chrome.storage.session.remove(corrupt);
     return {ok:true,pages:pages.sort((a,b)=>a-b)};
   }
   return {ok:false};
 }
 chrome.runtime.onMessage.addListener((raw,sender,reply)=>{
   if(!raw||typeof raw!=='object'||(raw as Message).kind!=='xmn-store-v1')
     return false;
   void handle(raw as Message,sender)
     .then(reply).catch(()=>reply({ok:false}));
   return true; // Keep response port alive on every supported Chrome version.
 });
 chrome.tabs.onRemoved.addListener(tabId=>{
   // Tab IDs may be reused. Never let another tab inherit prior consent.
   void (async()=>{
     const prefix=CHECKPOINT_PREFIX+tabId+':';
     const manifestPrefix=MANIFEST_PREFIX+tabId+':';
     // A tab ID may be recycled. Clear already-started transactions first.
     await Promise.all([...manifestJobs.entries()]
       .filter(([key])=>key.startsWith(manifestPrefix))
       .map(([,job])=>job.catch(()=>undefined)));
     await Promise.all([...checkpointWrites.entries()]
       .filter(([key])=>key.startsWith(prefix))
       .map(([,write])=>write.catch(()=>false)));
     const all=await chrome.storage.session.get(null);
     const keys=Object.keys(all).filter(k=>
       k===sessionKey(tabId)||k.startsWith(CONSENT_PREFIX+tabId+':')||
       k.startsWith(prefix)||k.startsWith(manifestPrefix));
     if(keys.length)await chrome.storage.session.remove(keys);
   })().catch(()=>{/* Nothing to report after the tab closed. */});
 });
}
