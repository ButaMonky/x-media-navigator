import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const bundle=readFileSync(new URL('../extension/content_script.js',import.meta.url),'utf8');
const ctx=vm.createContext({
  URL,URLSearchParams,Date,Map,Set,console,
  document:{readyState:'loading',addEventListener(){}},
  window:{location:{pathname:'/example/media',search:''},addEventListener(){}},
  Element:class {},
});
vm.runInContext(bundle,ctx);
const proto=ctx.XMN.Controller.prototype;

function layer({display='',width=450,height=350,buttons=2,connected=true}={}){
  return {
    isConnected:connected,
    style:{display},
    querySelectorAll(){return Array.from({length:buttons},()=>({}));},
    getBoundingClientRect(){return {width,height};},
  };
}

test('health distinguishes missing, hidden and positioned controls',()=>{
 const controller=Object.create(proto);
 assert.equal(proto.controlsHealthCode.call(controller),'CONTROLS_NOT_MOUNTED');
 controller.controlsHost=layer({display:'none'});
 assert.equal(proto.controlsHealthCode.call(controller),'CONTROLS_HIDDEN_GEOMETRY');
 controller.controlsHost=layer({width:110});
 assert.equal(proto.controlsHealthCode.call(controller),'CONTROLS_HIDDEN_GEOMETRY');
 controller.controlsHost=layer({height:90});
 assert.equal(proto.controlsHealthCode.call(controller),'CONTROLS_HIDDEN_GEOMETRY');
 controller.controlsHost=layer({buttons:1});
 assert.equal(proto.controlsHealthCode.call(controller),'CONTROLS_NOT_MOUNTED');
 controller.controlsHost=layer();
 assert.equal(proto.controlsHealthCode.call(controller),'CONTROLS_LAYOUT_OK');
});
