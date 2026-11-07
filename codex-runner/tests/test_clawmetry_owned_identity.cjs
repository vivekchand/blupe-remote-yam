'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict');
const projection=require('../static/telemetry-status.js');
const source=fs.readFileSync(path.join(__dirname,'../static/hosted.js'),'utf8');
function guard(){
  const context=vm.createContext({});const start=source.indexOf('function createRunLaunchGuard(');
  vm.runInContext(source.slice(start,source.indexOf("(() => {\n  'use strict';",start))+'\nvar guard=createRunLaunchGuard();',context);
  const version=context.guard.start({task:'PRIVATE_TASK',model_name:'PRIVATE_MODEL'});
  context.guard.accept(version,'owned-attempt');return context.guard;
}
function status(){
  return {attempt_id:'owned-attempt',episode_id:'owned-episode',status:'running',
    interactions:{events:[{message:'PRIVATE_NOTES'}]},
    public_run:{attempt_id:'foreign-attempt',episode_id:'foreign-episode',task:'PRIVATE_FOREIGN',status:'running'},
    telemetry:{public_run_shared:true,owned_run:{schema:'clawmetry.owned_run.v1',robot_id:'yam-1',attempt_id:'owned-attempt',episode_id:'owned-episode',status:'running'},
      detail:{path:'/clawmetry/trace/'+'a'.repeat(32),attempt_id:'owned-attempt',episode_id:'owned-episode'}}};
}
const project=(state,displayed)=>projection.project(state,{robot_id:'yam-1',displayed_identity:displayed});
test('native owned synthesis supplies exact episode for private current Guard source binding',()=>{
  const launch=guard(),state=status(),live=launch.conversation(state.public_run,state);
  assert.equal(live.attempt_id,'owned-attempt');assert.equal(live.episode_id,'owned-episode');
  const view=project(state,live);assert.equal(view.run.status,'running');
  assert.equal(view.detail_path,state.telemetry.detail.path);
  assert.equal(view.run.task,null);assert.equal(view.run.model,null);assert.deepEqual(view.events,[]);
  assert.equal(JSON.stringify(view).includes('PRIVATE_'),false);
});
test('same attempt with stale public episode cannot override native current episode',()=>{
  const launch=guard(),state=status();state.public_run.attempt_id='owned-attempt';state.public_run.episode_id='previous-episode';
  const live=launch.conversation(state.public_run,state);assert.equal(live.episode_id,'owned-episode');
  assert.equal(live.task,'PRIVATE_TASK');
});
test('owned phase attestation never lends evidence to foreign or stale displayed run',()=>{
  const state=status();
  for(const displayed of [state.public_run,{attempt_id:'owned-attempt',episode_id:'previous-episode'},null]){
    const view=project(state,displayed);assert.equal(view.detail_path,null);
    if(displayed!==state.public_run)assert.equal(view.run.status,null);
  }
  for(const change of ['episode','attempt','robot','phase','schema','detail']){
    const raw=status(),displayed={attempt_id:raw.attempt_id,episode_id:raw.episode_id};
    if(change==='episode')raw.episode_id='changed';
    if(change==='attempt')raw.attempt_id='changed';
    if(change==='robot')raw.telemetry.owned_run.robot_id='other';
    if(change==='phase')raw.telemetry.owned_run.status='PRIVATE_PHASE';
    if(change==='schema')raw.telemetry.owned_run.schema='untrusted';
    if(change==='detail')delete raw.telemetry.detail;
    assert.equal(project(raw,displayed).run.status,null,change);
  }
});
test('terminal owned phase is fixed and resets to unknown when attestation is absent',()=>{
  const state=status(),displayed=guard().conversation(state.public_run,state);
  state.status=state.telemetry.owned_run.status='stopped';assert.equal(project(state,displayed).run.status,'stopped');
  delete state.telemetry.owned_run;assert.equal(project(state,displayed).run.status,null);
});
