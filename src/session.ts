/** Untrusted X pages cannot read chrome.storage.session, only extension code can. */
declare const chrome: {
 runtime?: { sendMessage(request: unknown): Promise<unknown> }
};
namespace XMN {
 export interface PublicSession {
  schema: 1;
  profile: string;
  timeline: string | null;
  expires: number;
  refs: string[];
  apiKeys: string[];
  photos: [string,string][];
  photoTotals: [string,number][];
  cursor: string | null;
  anchorFound: boolean;
  exhausted: boolean;
 }
 type StoreReply={
  ok?:boolean; granted?:boolean; session?:PublicSession|null; pages?:number[];
  manifest?:PublicPageManifest|null;
 };
 export class SessionStore {
  private async call(
    op:string,profile:string,session?:PublicSession,page?:number,
    manifest?:PublicPageManifest
  ):Promise<StoreReply|null>{
   try {
    if(typeof chrome==='undefined'||!chrome.runtime?.sendMessage)return null;
    const data=await chrome.runtime.sendMessage({
     kind:'xmn-store-v1',op,profile,session,page,manifest});
    if(!data||typeof data!=='object')return null;
    return data as StoreReply;
   }catch{return null}
  }
  async hasConsent(profile:string):Promise<boolean>{
   const r=await this.call('consent.get',profile);
   return r?.ok===true && r.granted===true;
  }
  async grantConsent(profile:string):Promise<boolean>{
   return (await this.call('consent.set',profile))?.ok===true;
  }
  async load(profile:string):Promise<PublicSession|null>{
   const r=await this.call('session.get',profile);
   return r?.ok===true && r.session ? r.session : null;
  }
  async save(data:PublicSession):Promise<boolean>{
   return (await this.call('session.set',data.profile,data))?.ok===true;
  }
  async clear(profile:string):Promise<void>{
   await this.call('session.clear',profile);
  }
  /** Immutable, tab-scoped snapshots for a future verified page switcher. */
  async saveCheckpoint(page:number,data:PublicSession):Promise<boolean>{
   if(!Number.isSafeInteger(page)||page<0||page>=64)return false;
   return (await this.call('checkpoint.put',data.profile,data,page))?.ok===true;
  }
  async loadCheckpoint(profile:string,page:number):Promise<PublicSession|null>{
   if(!Number.isSafeInteger(page)||page<0||page>=64)return null;
   const r=await this.call('checkpoint.get',profile,undefined,page);
   return r?.ok===true&&r.session ? r.session : null;
  }
  async listCheckpoints(profile:string):Promise<number[]|null>{
   const r=await this.call('checkpoint.list',profile);
   return r?.ok===true&&Array.isArray(r.pages) ? r.pages : null;
  }
  async clearCheckpoints(profile:string,page?:number):Promise<boolean>{
   if(page!==undefined && (!Number.isSafeInteger(page)||page<0||page>=64))
     return false;
   return (await this.call('checkpoint.clear',profile,undefined,page))?.ok===true;
  }
  /** Commit only a manifest whose immutable page snapshots already exist. */
  async savePageManifest(data:PublicPageManifest):Promise<boolean>{
   return (await this.call('manifest.put',data.profile,undefined,undefined,data))
      ?.ok===true;
  }
  async loadPageManifest(profile:string):Promise<PublicPageManifest|null>{
   const r=await this.call('manifest.get',profile);
   return r?.ok===true&&r.manifest ? r.manifest : null;
  }
  async clearPageManifest(profile:string):Promise<boolean>{
   return (await this.call('manifest.clear',profile))?.ok===true;
  }
 }
/** Purge only our obsolete host-page keys; never read or migrate untrusted values. */
 export function clearLegacyPageSession():void{
  try{
   window.sessionStorage.removeItem('xmn-public-media-v1');
   const match=/^\/([a-zA-Z0-9_]{1,15})\/(?:status\/|media(?:\/|$))/.exec(
     window.location.pathname);
   if(match)window.sessionStorage.removeItem(
     'xmn-fxembed-consent-'+match[1].toLowerCase());
  }catch{ /* Third-party storage can be disabled; secure worker does not depend on it. */ }
 }
}
