/** Read-only public FxEmbed contract probe. No X sign-in, tokens, cookies or writes. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const endpoint = 'https://api.fxtwitter.com/2/profile/pignic_cafe/media';
const src = readFileSync(new URL('../extension/content_script.js', import.meta.url),'utf8');
const context = vm.createContext({ URL, URLSearchParams, console,
  window:{location:{pathname:'/pignic_cafe/media',search:''},addEventListener(){}},
  document:{readyState:'loading',addEventListener(){}},Element:class{} });
vm.runInContext(src,context);
const parser = context.XMN.parsePublicMediaPage;
const results = [];
let cursor = null, previousOldest = null;
const seen = new Set();
for (let page=0;page<3;page++){
  const url = new URL(endpoint);url.searchParams.set('count','100');
  if(cursor)url.searchParams.set('cursor',cursor);
  const response=execFileSync('curl.exe',['--fail','--silent','--show-error',
    '--max-time','17',url.toString()],{maxBuffer:8_000_000,timeout:20000});
  const body=JSON.parse(response.toString('utf8'));
  const parsed=parser(body,'pignic_cafe');
  if(!parsed)throw Error('Published FxEmbed contract is incompatible with parser');
  const rows=Array.isArray(body.results)?body.results:[];
  const valid=rows.filter(p=>p.type==='status' && p.author?.screen_name?.toLowerCase()==='pignic_cafe');
  const ids=valid.map(p=>p.id).filter(id=>typeof id==='string'&&/^\d{1,19}$/.test(id));
  const ordered=ids.every((id,i)=>i===0||BigInt(id)<BigInt(ids[i-1]));
  const crossPageOrdered=previousOldest==null||ids.length===0||
    BigInt(ids[0])<BigInt(previousOldest);
  const overlapping=ids.filter(id=>seen.has(id)).length;
  ids.forEach(id=>seen.add(id));
  const mixed=valid.filter(p=>new Set((p.media?.all||[]).map(x=>x.type)).size>1).length;
  const video=valid.filter(p=>(p.media?.all||[]).some(x=>x.type==='video'||x.type==='gif')).length;
  const accepted=new Set(parsed.refs.map(x=>x.statusId));
  const rejectedReasons={mixed:0,multiVideo:0,missingMedia:0,invalidPhoto:0,other:0};
  for(const post of valid){
    if(accepted.has(post.id))continue;
    const media=post.media?.all;
    const types=Array.isArray(media)?new Set(media.map(x=>x?.type)):new Set();
    const reason=!Array.isArray(media)||media.length===0||media.length>4
      ? 'missingMedia' : types.size>1 ? 'mixed' :
      media.length>1 && [...types].every(t=>t==='video'||t==='gif') ? 'multiVideo' :
      types.has('photo') ? 'invalidPhoto' : 'other';
    rejectedReasons[reason]++;
  }
  const photoURLsValid=parsed.photos.every(x=>typeof x[1]==='string'&&
    x[1].startsWith('https://pbs.twimg.com/media/')&&x[1].includes('name=large'));
  results.push({page:page+1,httpCode:body.code,rows:rows.length,
    originalPosts:valid.length,acceptedPosts:accepted.size,
    photoMediaRefs:parsed.photos.length,mixed,rejectedReasons,
    withVideo:video,inPageDescending:ordered,
    crossPageDescending:crossPageOrdered,
    duplicateIDsAcrossPages:overlapping,
    photoURLsValid,hasNext:!!parsed.cursor,
    cursorLength:parsed.cursor?.length??0});
  previousOldest=ids.at(-1)??previousOldest;
  if(!parsed.cursor||parsed.cursor===cursor)break;
  cursor=parsed.cursor;
}
console.log(JSON.stringify({source:'public FxEmbed; no credentials',results},null,2));
if(results.some(r=>!r.inPageDescending||!r.crossPageDescending||
    !r.photoURLsValid))process.exitCode=2;
