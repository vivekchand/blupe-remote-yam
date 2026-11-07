const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict'), test = require('node:test');
const {webcrypto,createHash} = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname, '../static/hosted.js'), 'utf8');

function fixture(reply, extras = {}) {
  const calls = [], key = {value:'retained-key'};
  const events=[];
  const c = vm.createContext({robotGeneration:1, csrf:'token', selectedRobot:'robo-house', liveViewers:null,
    crypto:webcrypto,TextEncoder,CustomEvent:class {constructor(type,options){this.type=type;this.detail=options.detail;}},
    window:{dispatchEvent:event=>events.push(event)},
    ended:false, buttons(){}, $:()=>key,
    fetch:async (...args)=>{calls.push(args); return typeof reply === 'function' ? reply() : reply;},...extras});
  let start = source.indexOf('function createRunLaunchGuard(');
  vm.runInContext(source.slice(start, source.indexOf("(() => {\n  'use strict';", start)) +
    '\nvar runLaunchGuard = createRunLaunchGuard();', c);
  start = source.indexOf('  async function api(');
  vm.runInContext(source.slice(start, source.indexOf('  const runVideoEmail', start)), c);
  return {c, calls, key, events};
}

function admission(task='Pick up the red block'){
  return {schema:'clawmetry.intent_guard.v1',version:1,decision:'reject',mode:'block',outcome:'intent_violation',
    reason_code:'forbidden_color_requested',scope:'explicit_color_intent',physical_permission_granted:false,
    summary:'This request conflicts with the saved red rule.',task_hash:createHash('sha256').update(task).digest('hex'),
    config_hash:'a'.repeat(64),forbidden_colors:['red'],requested_colors:['red'],blocked_colors:['red']};
}

test('verified admission stays a blocked local request with the actual submitted runner, not old public identity',async()=>{
  const task='Pick up the red block',raw={...admission(task),secret:'PRIVATE_EXTRA'};
  const f=fixture(Response.json({error:'Blocked before model or queue',guard_admission:raw},{status:409}));
  const guard=f.c.runLaunchGuard,version=guard.start({task,runner_name:'Andrew',robot_id:'robo-house'});
  let caught;try{await f.c.api('/api/run',{prompt:task,runner_name:'Vivek'});}catch(error){caught=error;}
  assert(caught.guardAdmission);assert.equal(caught.guardAdmission.secret,undefined);
  assert.equal(guard.reject(version,caught.message,caught.guardAdmission),true);
  const shown=guard.conversation({task:'Previous task',runner_name:'Andrew',attempt_id:'old'});
  assert.equal(shown.status,'blocked');assert.equal(shown.guard_admission_verified,true);
  assert.equal(shown.runner_name,'Vivek');assert.equal(shown.task,task);assert.equal(shown.attempt_id,undefined);
  assert.equal(f.events.at(-1).type,'yam:run-rejected');assert.equal(f.events.at(-1).detail.version,version);
  assert.equal(f.events.at(-1).detail.robot_id,'robo-house');assert.equal(f.calls.length,1);
  const start=source.indexOf('function currentTaskRun('),end=source.indexOf('// End of shared task helpers.');
  vm.runInContext(source.slice(start,end),f.c);f.c.sharedTaskRun=run=>run;
  const state={status:'running',provider:{task_progress:{task:'Old Andrew task'}}};
  assert.equal(f.c.currentTaskRun(shown,state).task,task);
  assert.equal(f.c.taskRunFailure(shown).label,'Blocked before model');
  assert.equal(f.c.taskRunFailure(shown).tone,'warning');
  guard.reset();assert.equal(f.events.at(-1).type,'yam:run-cleared');
});

test('forged, mismatched or non-admission errors retain legacy failed status',async()=>{
  const task='Pick up the red block';
  for(const change of [value=>{value.task_hash='b'.repeat(64);},value=>{value.mode='monitor';},
    value=>{value.physical_permission_granted=true;},value=>{value.forbidden_colors=['yellow'];},
    value=>{value.requested_colors=['red','red'];},value=>{value.summary=[];},value=>{value.reason_code='untrusted';}]){
    const raw=admission(task);change(raw);
    const f=fixture(Response.json({error:'Rejected',guard_admission:raw},{status:409}));
    const guard=f.c.runLaunchGuard,version=guard.start({task,robot_id:'robo-house'});
    let caught;try{await f.c.api('/api/run',{prompt:task});}catch(error){caught=error;}
    assert.equal(caught.guardAdmission,null);guard.reject(version,caught.message,caught.guardAdmission);
    assert.equal(guard.conversation(null).status,'failed');
    assert.equal(f.events.some(event=>event.type==='yam:run-rejected'),false);
  }
  const f=fixture(Response.json({error:'Unavailable',guard_admission:admission(task)},{status:503}));
  const version=f.c.runLaunchGuard.start({task});let caught;try{await f.c.api('/api/run',{prompt:task});}catch(error){caught=error;}
  assert.equal(caught.guardAdmission,undefined);
  f.c.runLaunchGuard.reject(version,caught.message,admission(task));
  assert.equal(f.c.runLaunchGuard.conversation(null).status,'failed','plain unverified metadata cannot classify a block');
});

test('admission verification binds the serialized task and rejects source changes during crypto work',async()=>{
  const task='Pick up the red block';let deliver;
  const f=fixture(()=>new Promise(resolve=>{deliver=resolve;}));
  const payload={prompt:task,runner_name:'Vivek'},guard=f.c.runLaunchGuard;
  guard.start({task,robot_id:'robo-house'});const pending=f.c.api('/api/run',payload);payload.prompt='Pick yellow';
  deliver(Response.json({error:'Blocked',guard_admission:admission(task)},{status:409}));
  await assert.rejects(pending,error=>!!error.guardAdmission);
  assert.equal(JSON.parse(f.calls[0][1].body).prompt,task);
  for(const change of ['attempt','robot','owner']){
    let finish,entered;const started=new Promise(resolve=>{entered=resolve;});
    const crypto={subtle:{digest:()=>{entered();return new Promise(resolve=>{finish=resolve;});}}};
    const race=fixture(Response.json({error:'Blocked',guard_admission:admission(task)},{status:409}),{crypto});
    race.c.runLaunchGuard.start({task,robot_id:'robo-house'});const response=race.c.api('/api/run',{prompt:task});await started;
    if(change==='attempt')race.c.runLaunchGuard.start({task:'New task'});
    if(change==='robot')race.c.robotGeneration++;
    if(change==='owner')race.c.csrf='different-owner';
    finish(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(task)));
    await assert.rejects(response,error=>error.stale===true);
    assert.equal(race.events.some(event=>event.type==='yam:run-rejected'),false);
  }
});

test('status heartbeats use the selected robot and the live camera visibility', async ()=>{
  for(const watching of [true,false]) {
    const f=fixture(Response.json({status:'idle'}));
    f.c.liveViewers={watching:()=>watching};
    await f.c.api('/api/status');
    assert.equal(f.calls[0][1].headers['X-YAM-Watching'],watching?'1':'0');
    assert.equal(f.calls[0][1].headers['X-Blupe-Robot'],'robo-house');
    assert.equal(f.calls[0][1].method,'GET');
  }
});

test('plain-text maintenance rejection has an actionable error and never replays the run', async ()=>{
  const f = fixture(new Response('Deployment in progress. Please retry shortly.', {status:503}));
  await assert.rejects(f.c.api('/api/run', {prompt:'place green block on plate'}), error=>{
    assert.match(error.message, /temporarily unavailable.*HTTP 503.*try again shortly/i);
    assert.doesNotMatch(error.message, /Unexpected token|valid JSON/);
    return true;
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][1].method, 'POST');
  assert.equal(f.c.ended, false);
});

test('proxy HTML and empty error bodies retain status without displaying raw content', async ()=>{
  for (const [status, body] of [[502,'<html>private proxy diagnostic</html>'], [504,''], [400,'private diagnostic']]) {
    const f = fixture(new Response(body, {status}));
    await assert.rejects(f.c.api('/api/run', {}), error=>{
      assert.match(error.message, new RegExp('HTTP '+status));
      assert.doesNotMatch(error.message, /private|html|Unexpected token|valid JSON/);
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test('valid JSON errors preserve the server message and subscription metadata', async ()=>{
  const setup = {state:'login_required'};
  const f = fixture(Response.json({error:'Sign in required', subscription_setup:setup, payment_confirmed:true}, {status:409}));
  await assert.rejects(f.c.api('/api/run', {}), error=>{
    assert.equal(error.message, 'Sign in required');
    assert.equal(error.subscriptionSetup.state, setup.state);
    assert.equal(error.paymentConfirmed, true);
    return true;
  });
});

test('a non-JSON unauthorized response still expires the session and clears its key', async ()=>{
  const f = fixture(new Response('Unauthorized', {status:401}));
  await assert.rejects(f.c.api('/api/status'), /HTTP 401/);
  assert.equal(f.c.ended, true);
  assert.equal(f.key.value, '');
});

test('malformed successful replies are rejected without resubmitting an uncertain run', async ()=>{
  for (const body of ['Brief maintenance', 'null', '[]', '"not an object"']) {
    const f = fixture(new Response(body, {status:200}));
    await assert.rejects(f.c.api('/api/run', {}), /invalid response.*Check the current run/i);
    assert.equal(f.calls.length, 1);
  }
});

test('invalid successful status replies are reported even after an accepted attempt', async ()=>{
  const f = fixture(new Response('<html>proxy</html>', {status:200}));
  const guard = f.c.runLaunchGuard, version = guard.start();
  guard.accept(version, 'accepted');
  await assert.rejects(f.c.api('/api/status'), error=>{
    assert.equal(error.stale, undefined);
    assert.match(error.message, /invalid response/i);
    return true;
  });
});

test('late non-JSON responses from a previous robot cannot revoke the new session', async ()=>{
  let deliver;
  const f = fixture(()=>new Promise(resolve=>{deliver=resolve;}));
  const pending = f.c.api('/api/status');
  f.c.robotGeneration = 2; f.c.csrf = 'new-token';
  deliver(new Response('Unauthorized', {status:401}));
  await assert.rejects(pending, error=>error.stale === true);
  assert.equal(f.c.ended, false);
  assert.equal(f.key.value, 'retained-key');
});

test('late maintenance rejection cannot replace a newer run attempt', async ()=>{
  let deliver;
  const f = fixture(()=>new Promise(resolve=>{deliver=resolve;}));
  const pending = f.c.api('/api/run', {});
  f.c.runLaunchGuard.start();
  deliver(new Response('Brief maintenance', {status:503}));
  await assert.rejects(pending, error=>error.stale === true);
  assert.equal(f.calls.length, 1);
});

test('valid successful responses still pass through the API unchanged', async ()=>{
  const f = fixture(Response.json({status:'preparing', attempt_id:'new'}));
  const result = await f.c.api('/api/run', {});
  assert.equal(result.status, 'preparing');
  assert.equal(result.attempt_id, 'new');
});
