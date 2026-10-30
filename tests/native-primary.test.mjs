import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const bundle = readFileSync(new URL('../extension/content_script.js', import.meta.url),'utf8');
const location={pathname:'/alice/status/400/photo/1',search:''};
const context=vm.createContext({
  URL,URLSearchParams,Map,Set,Date,console,
  document:{readyState:'loading',hidden:false,addEventListener(){}},
  navigator:{onLine:true},
  window:{location,addEventListener(){},setInterval(){return 1;},
    setTimeout,clearTimeout,sessionStorage:{removeItem(){}}},
  Element:class {},
});
vm.runInContext(bundle,context);
const proto=context.XMN.Controller.prototype;
const ref=(id)=>context.XMN.mediaRefFromHref('/alice/status/'+id+'/photo/1','alice');

test('new controller starts in native-only mode without restoring third-party pages',async()=>{
  const original=proto.restorePublicMediaSession;
  const originalTick=proto.tick;
  const originalRoute=proto.installRouteObserver;
  let restoreCalls=0,ticks=0;
  proto.restorePublicMediaSession=async()=>{restoreCalls++;};
  proto.tick=function(){ticks++;};
  proto.installRouteObserver=()=>false;
  try{
    const controller=new context.XMN.Controller();
    assert.equal(controller.experimentalThirdPartyApiEnabled,false);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(restoreCalls,0,'do not rehydrate old external API session');
    assert.ok(ticks>0,'native startup still executes');
  }finally{
    proto.restorePublicMediaSession=original;
    proto.tick=originalTick;
    proto.installRouteObserver=originalRoute;
  }
});

test('last native post preserves viewer, replies and location without any API or consent',async()=>{
  const current=ref(400),saved=ref(300),toasts=[];
  const viewer={isConnected:true};
  const ctl=Object.assign(Object.create(proto),{
    experimentalThirdPartyApiEnabled:false,
    originProfile:'alice',originTimeline:'alice|photo',viewer,
    navGeneration:1,navigationBusy:false,
    refs:[current],publicApiLoading:true,publicApiCursor:'cursor',
    publicSessionRestored:true,restoredCheckpointPage:1,
    activeIndex(){return 0;},
    tryCommittedPageBoundary(){throw Error('external checkpoint must not be opened');},
    loadPublicMediaContinuation(){throw Error('third-party API must not be fetched');},
    sessionStore:{hasConsent(){throw Error('consent must not be requested');}},
    toast(s){toasts.push(s);},updateViewerState(){throw Error('do not mutate existing modal');},
    findCloseButton(){throw Error('do not close X viewer');},
  });
  const original=location.pathname;
  await proto.navigate.call(ctl,1);
  assert.deepEqual(toasts,['ここまでが読み込み済みです。続きはXのメディア一覧で読み込んでください']);
  assert.equal(ctl.navigationBusy,false);
  assert.equal(ctl.pendingBoundary,undefined);
  assert.equal(location.pathname,original);
  assert.equal(viewer.isConnected,true);
  assert.equal(saved.kind,'photo');
  toasts.length=0;
  await proto.navigate.call(ctl,-1);
  assert.deepEqual(toasts,[],'left boundary stays quiet');
});

test('cached public cursor cannot advertise automatic fetching in native-only UI',()=>{
  const current=ref(400),previous=ref(500);
  const status={textContent:'',title:''},previousButton={disabled:false},nextButton={disabled:false};
  const viewer={isConnected:true,querySelector(selector){
    return selector==='.xmn-status'?status:selector==='.xmn-prev'?previousButton:
      selector==='.xmn-next'?nextButton:null;
  }};
  const ctl=Object.assign(Object.create(proto),{
    viewer,originProfile:'alice',refs:[previous,current],
    navigationBusy:false,experimentalThirdPartyApiEnabled:false,
    publicApiCursor:'old-cursor',publicApiExhausted:false,
    activeIndex(){return 1;},
    schedulePublicMediaWarmup(){throw Error('no background third-party warmup');},
  });
  proto.updateViewerState.call(ctl);
  assert.equal(status.textContent,'投稿 2 / 2');
  assert.match(status.title,/読み込み済み/);
  assert.equal(nextButton.disabled,false,'right click can show a clear boundary message');
});

test('legacy provider can only start with an explicit isolated extension-side option',async()=>{
  const oldRestore=proto.restorePublicMediaSession;
  const oldTick=proto.tick;
  const oldRoute=proto.installRouteObserver;
  let calls=0;
  proto.restorePublicMediaSession=async()=>{calls++;};
  proto.tick=()=>{};
  proto.installRouteObserver=()=>false;
  try{
    const isolated=new context.XMN.Controller({enableLegacyProviderForIsolatedQa:true});
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(isolated.experimentalThirdPartyApiEnabled,true);
    assert.equal(calls,1,'explicit QA opt-in may test historical Worker sessions');
    const native=new context.XMN.Controller();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(native.experimentalThirdPartyApiEnabled,false);
    assert.equal(calls,1,'normal construction must not restore external data');
  }finally{
    proto.restorePublicMediaSession=oldRestore;
    proto.tick=oldTick;
    proto.installRouteObserver=oldRoute;
  }
});