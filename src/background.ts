/// <reference path="./core.ts" />
/** MV3 trusted worker: tab-scoped, memory-only consent and validated media session. */
type Sender = { tab?: { id?: number }, frameId?: number, url?: string };
type Message = { kind?: string, op?: string, profile?: string, session?: unknown };
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
 const HANDLE=/^[a-zA-Z0-9_]{1,15}$/;
 const SESSION_PREFIX='xmn:session:';
 const CONSENT_PREFIX='xmn:consent:';
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
     await chrome.storage.session.set({[consentKey(id,profile)]:true});
     return {ok:true};
   }
   if(msg.op==='session.get'){
     const key=sessionKey(id);
     const data=await chrome.storage.session.get(key);
     const saved=data[key];
     if(!validateSession(saved,profile)){
       if(saved!==undefined)await chrome.storage.session.remove(key);
       return {ok:true,session:null};
     }
     return {ok:true,session:saved};
   }
   if(msg.op==='session.set'){
     if(!validateSession(msg.session,profile))return {ok:false};
     await chrome.storage.session.set({[sessionKey(id)]:msg.session});
     return {ok:true};
   }
   if(msg.op==='session.clear'){
     await chrome.storage.session.remove(sessionKey(id));
     return {ok:true};
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
     const all=await chrome.storage.session.get(null);
     const keys=Object.keys(all).filter(k=>
       k===sessionKey(tabId)||k.startsWith(CONSENT_PREFIX+tabId+':'));
     if(keys.length)await chrome.storage.session.remove(keys);
   })().catch(()=>{/* Nothing to report after the tab closed. */});
 });
}
