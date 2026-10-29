/// <reference path="./core.ts" />
/**
 * Experimental post-level index for very long X Media timelines.
 * This module is kept separate from the released Content Script until
 * the production media-index integration can be tested in real X.
 */
namespace XMN {
 export type MediaProvenance='x-dom'|'fxembed'|'restored'|'combined';
 export type MediaCompleteness='complete'|'partial'|'unknown';
 export interface MediaPostGroup {
  statusId:string;
  refs:MediaRef[];
  provenance:MediaProvenance;
  completeness:MediaCompleteness;
 }
 export interface MediaWindowView {
  startPost:number;
  endPost:number;
  activePost:number;
  mediaRefs:number;
  posts:MediaPostGroup[];
 }
 const numericStatus=(id:string)=>/^\d{1,19}$/.test(id);
 const olderThan=(a:string,b:string):boolean=>
  a.padStart(19,'0')<b.padStart(19,'0');
 const photoPositions=(group:MediaPostGroup):number[]|null=>{
  const indexes=group.refs.map(r=>r.kind==='photo'?r.mediaIndex:null);
  if(indexes.some(v=>v===null))return null;
  return indexes as number[];
 };

 export function validateMediaPostGroup(group:MediaPostGroup,profile?:string):boolean{
  if(!numericStatus(group.statusId)||!Array.isArray(group.refs)||
     group.refs.length<1||group.refs.length>4 ||
     !['x-dom','fxembed','restored','combined'].includes(group.provenance) ||
     !['complete','partial','unknown'].includes(group.completeness))return false;
  const seen=new Set<string>();
  for(const r of group.refs){
   if(r.statusId!==group.statusId|| (profile&&r.profile!==profile.toLowerCase()) ||
      seen.has(r.key))return false;
   const canonical=mediaRefFromHref(r.href,r.profile);
   if(!canonical||canonical.key!==r.key||
      canonical.statusId!==r.statusId||canonical.href!==r.href||
      r.kind!==canonical.kind||r.mediaIndex!==canonical.mediaIndex)return false;
   if(r.kind==='photo' && (!r.mediaIndex||r.mediaIndex>4))return false;
   if(r.kind==='video' && r.mediaIndex!==1)return false;
   seen.add(r.key);
  }
  if(group.completeness==='complete'){
   if(group.refs.some(r=>r.kind===null))return false;
   const photos=photoPositions(group);
   if(photos&&photos.some((n,i)=>n!==i+1))return false;
  }
  return true;
 }
 /** Preserve source order; non-adjacent repeated statuses are invalid. */
 export function groupMediaRefs(
  refs:readonly MediaRef[],provenance:MediaProvenance,
  completeness:MediaCompleteness='unknown'
 ):MediaPostGroup[]|null{
  const result:MediaPostGroup[]=[];
  const seen=new Set<string>();
  for(const ref of refs){
   const last=result[result.length-1];
   if(!last||last.statusId!==ref.statusId){
    if(seen.has(ref.statusId))return null;
    seen.add(ref.statusId);
    result.push({statusId:ref.statusId,refs:[ref],provenance,completeness});
   }else{last.refs.push(ref);}
  }
  return result.every(g=>validateMediaPostGroup(g))?result:null;
 }

 const groupProfile=(group:MediaPostGroup):string=>group.refs[0].profile;
 function validateSequence(
  groups:readonly MediaPostGroup[],strictDescending:boolean
 ):boolean{
  if(!Array.isArray(groups)||groups.length<1)return false;
  const profile=groupProfile(groups[0]),seen=new Set<string>();
  for(let i=0;i<groups.length;i++){
   const g=groups[i];
   if(!validateMediaPostGroup(g,profile)||seen.has(g.statusId))return false;
   seen.add(g.statusId);
   if(strictDescending&&i>0&&!olderThan(g.statusId,groups[i-1].statusId))
    return false;
  }
  return true;
 }
 /** A new X DOM head must not silently overwrite an older indexed post. */
 export function prependNativeGroups(
  base:readonly MediaPostGroup[],incoming:readonly MediaPostGroup[]
 ):MediaPostGroup[]|null{
  if(!validateSequence(base,false)||!validateSequence(incoming,false)||
     groupProfile(base[0])!==groupProfile(incoming[0]))return null;
  const existing=new Set(base.map(g=>g.statusId));
  const firstOverlap=incoming.findIndex(g=>existing.has(g.statusId));
  if(firstOverlap>=0 && incoming[firstOverlap].statusId!==base[0].statusId)
   return null;
  const front=firstOverlap<0?incoming:incoming.slice(0,firstOverlap);
  if(!front.every(g=>!existing.has(g.statusId)&&
     olderThan(base[0].statusId,g.statusId)))return null;
  if(front.some((g,i)=>i>0&&!olderThan(g.statusId,front[i-1].statusId)))
   return null;
  return [...front,...base];
 }

 /** Never commit API results unless the original cursor and boundary are proven. */
 export function appendVerifiedPublicGroups(
  base:readonly MediaPostGroup[],
  incoming:readonly MediaPostGroup[],
  checkpointVerified:boolean
 ):MediaPostGroup[]|null{
  if(!checkpointVerified||!validateSequence(base,false)||
     !validateSequence(incoming,true)||
     groupProfile(base[0])!==groupProfile(incoming[0]))return null;
  const existing=new Set(base.map(g=>g.statusId));
  const tail=base[base.length-1];
  let next:MediaPostGroup[]=base.slice();
  let start=0;
  if(incoming[0].statusId===tail.statusId){
   // Never let an untrusted provider expand an X-proven complete album.
   const additional=incoming[0].refs.some(r=>!tail.refs.some(x=>x.key===r.key));
   if(additional&&tail.completeness==='complete')return null;
   const joined=new Map(tail.refs.map(r=>[r.key,r]));
   for(const r of incoming[0].refs){
    const old=joined.get(r.key);
    if(old&&old.href!==r.href)return null;
    joined.set(r.key,r);
   }
   const refs=[...joined.values()];
   if(refs.every(r=>r.kind==='photo')){
    refs.sort((a,b)=>a.mediaIndex!-b.mediaIndex!);
   }else if(incoming[0].refs.some(r=>!tail.refs.some(x=>x.key===r.key))){
    // Mixed-media ordering cannot be reconstructed from partial evidence.
    return null;
   }
   const merged:MediaPostGroup={
    statusId:tail.statusId,refs,provenance:'combined',
    completeness:incoming[0].completeness==='complete'
      ?'complete':tail.completeness
   };
   if(!validateMediaPostGroup(merged,groupProfile(tail)))return null;
   next=[...base.slice(0,-1),merged];start=1;
  }

  for(let i=start;i<incoming.length;i++){
   const group=incoming[i];
   if(existing.has(group.statusId)||!olderThan(group.statusId,
       next[next.length-1].statusId))return null;
   next.push(group);
  }
  return validateSequence(next,false)?next:null;
 }
 /** Already validated groups can be selected in O(window size), not O(history). */
 function chooseVerifiedWindow(
  groups:readonly MediaPostGroup[],index:number,maxRefs:number
 ):MediaWindowView|null{
  if(!Number.isSafeInteger(maxRefs)||maxRefs<1||maxRefs>450||
     index<0||groups[index].refs.length>maxRefs)return null;
  let start=index,end=index,total=groups[index].refs.length;
  let canLeft=true,canRight=true;
  while(canLeft||canRight){
   const preferLeft=canLeft&&(!canRight||(index-start)<=(end-index));
   if(preferLeft){
    const next=start-1;
    if(next<0||total+groups[next].refs.length>maxRefs){
     canLeft=false;continue;
    }
    start=next;total+=groups[next].refs.length;
   }else{
    const next=end+1;
    if(next>=groups.length||total+groups[next].refs.length>maxRefs){
     canRight=false;continue;
    }
    end=next;total+=groups[next].refs.length;
   }
  }
  return {startPost:start,endPost:end,activePost:index-start,
   mediaRefs:total,posts:groups.slice(start,end+1).map(g=>({
    ...g,refs:g.refs.slice()
   }))};
 }
 /** Validates once, then reuses the status→position index on every arrow. */
 export class ValidatedMediaWindowIndex {
  private readonly groups:readonly MediaPostGroup[];
  private readonly byStatus:ReadonlyMap<string,number>;
  constructor(groups:readonly MediaPostGroup[]){
   if(!validateSequence(groups,false))throw new Error('invalid_media_timeline');
   this.groups=groups.map(g=>({...g,refs:g.refs.slice()}));
   this.byStatus=new Map(this.groups.map((g,i)=>[g.statusId,i]));
  }
  get postCount():number{return this.groups.length}
  select(activeStatusId:string,maxRefs=450):MediaWindowView|null{
   const index=this.byStatus.get(activeStatusId);
   return chooseVerifiedWindow(this.groups,index??-1,maxRefs);
  }
 }
 /** Safe one-shot alternative for callers not caching a validated index. */
 export function chooseMediaWindow(
  groups:readonly MediaPostGroup[],activeStatusId:string,maxRefs=450
 ):MediaWindowView|null{
  if(!validateSequence(groups,false))return null;
  return chooseVerifiedWindow(groups,
   groups.findIndex(g=>g.statusId===activeStatusId),maxRefs);
 }
}
