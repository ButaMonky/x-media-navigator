import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const compiled=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const location={pathname:'/alice/status/100',search:''};
const context=vm.createContext({URL,URLSearchParams,Map,Set,Date,console,
  window:{location,addEventListener(){}},
  document:{readyState:'loading',addEventListener(){}},
  Element:class {}
});
vm.runInContext(compiled,context);
const X=context.XMN;
const proto=X.Controller.prototype;
const ref=path=>X.mediaRefFromHref(path,'alice');
const refs=[
  ref('/alice/status/100/photo/1'),
  ref('/alice/status/100/photo/2'),
  ref('/alice/status/90/photo/1')
];
function owner(){
 return Object.assign(Object.create(proto),{
  originProfile:'alice',refs,indexes:new Map(refs.map((x,i)=>[x.key,i]))
 });
}
test('R-030: ambiguous bare status URL never guesses the first indexed photo',()=>{
 const c=owner(),before=location.pathname;
 try{
  location.pathname='/alice/status/100';
  assert.equal(c.activeIndex(),null,'two photos cannot establish bare-status media ownership');
  location.pathname='/alice/status/100/photo/1';
  assert.equal(c.activeIndex(),0,'explicit first photo remains navigable');
  location.pathname='/alice/status/100/photo/2';
  assert.equal(c.activeIndex(),1,'explicit second photo remains navigable');
  location.pathname='/alice/status/90';
  assert.equal(c.activeIndex(),2,'a uniquely indexed status remains safe');
 }finally{location.pathname=before;}
});

test('R-030: ambiguous bare route does not intercept native X keyboard input',()=>{
 const c=owner(),old=location.pathname,handled=[];
 c.viewer={isConnected:true};
 c.navigationBusy=false;
 c.navigate=direction=>handled.push(direction);
 const key={key:'ArrowRight',target:null,prevented:false,
  shiftKey:false,altKey:false,ctrlKey:false,metaKey:false,
  preventDefault(){this.prevented=true},
  stopImmediatePropagation(){this.stopped=true}
 };
 try{
  location.pathname='/alice/status/100';
  proto.onKeyDown.call(c,key);
  assert.equal(key.prevented,false);
  assert.deepEqual(handled,[]);
  location.pathname='/bob/status/100/photo/1';
  assert.equal(c.activeIndex(),null,'another profile cannot adopt the cached media index');
 }finally{location.pathname=old;}
});
