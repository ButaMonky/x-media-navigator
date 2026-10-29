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
 type StoreReply={ok?:boolean,granted?:boolean,session?:PublicSession|null};
 export class SessionStore {
  private async call(op:string,profile:string,session?:PublicSession)
   :Promise<StoreReply|null>{
   try {
    if(typeof chrome==='undefined'||!chrome.runtime?.sendMessage)return null;
    const data=await chrome.runtime.sendMessage({
     kind:'xmn-store-v1',op,profile,session});
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
