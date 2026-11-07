'use strict';
// Isolated source/formatter contracts; never a live robot or model claim.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=path.join(__dirname,'../static/clawmetry-activity.js'),source=fs.readFileSync(file,'utf8'),activity=require(file);
const row=(id,kind,rest={})=>({id,t:100+id,kind,...rest});
const modelEvent=(id,kind,rest={})=>({id:String(id),timestamp_s:100+id,kind,note:'Approved shared note',...rest});
const view=events=>({schema:'yam.telemetry.v1',scope:'shared_public_run',run:{present:true,model:'Dream'},events});

test('native journal IDs order late timing receipts without pretending their worker clock is chronological',()=>{
  const rows=[row(9,'policy_timing',{stage:'sdk_get_action',state:'completed',started_at:1,duration_s:.2}),
    row(4,'packet_submit',{waypoint_count:3}),row(7,'packet_completed',{waypoint_count:3}),
    row(2,'policy_timing',{stage:'worker_predict',state:'started',started_at:99999})];
  const copy=structuredClone(rows),entries=activity.motionEntries(rows,'Dream');
  assert.deepEqual(entries.map(value=>value.id),[2,4,7,9]);assert.deepEqual(rows,copy);
  assert.equal(entries[0].title,'Policy prediction started');assert.equal(entries[3].title,'Model action generation finished');
  assert.match(entries[3].detail,/Source stage duration: 0.20 s/);
  assert(!JSON.stringify(entries).includes('99999'));assert(!JSON.stringify(entries).includes('started_at'));
  assert.deepEqual(Object.keys(entries[0]).sort(),['category','detail','id','key','kind','t','title']);
});

test('model timing in a failed request never becomes a successful model response or a made-up call number',()=>{
  const entries=activity.motionEntries([row(1,'model_timing',{elapsed_s:1.25,state:'error',request:'PRIVATE_REQUEST',response:'PRIVATE_RESPONSE'}),
    row(2,'model_timing',{waypoint_count:8,timing:{secret:'PRIVATE_TIMING'}})],'Dream');
  assert.equal(entries[0].title,'Dream timing reported');assert.equal(entries[0].detail,'Reported request duration: 1.25 s.');
  assert.match(entries[1].detail,/8 planned waypoints/);assert.doesNotMatch(JSON.stringify(entries),/PRIVATE|successfully|Call [0-9]|response received/);
  assert.equal(activity.motionEntries([row(3,'model_timing',{duration_s:NaN})])[0].title,'Model timing reported');
});

test('fixed stage aliases never render unknown tokens, free prose, or prototype properties',()=>{
  for(const stage of ['PRIVATE_STAGE','__proto__','constructor',['worker_predict'],{}])for(const state of ['PRIVATE_STATE','completed','__proto__']){
    const entry=activity.motionEntries([row(1,'policy_timing',{stage,state,message:'PRIVATE_MESSAGE',note:'PRIVATE_NOTE',code:'PRIVATE_CODE'})])[0];
    assert.equal(entry.title,'Policy timing reported');assert.doesNotMatch(JSON.stringify(entry),/PRIVATE|__proto__|constructor|undefined|\[object/);
  }
  assert.equal(activity.motionEntries([row(1,'policy_timing',{stage:'worker_predict',state:'error'})])[0].category,'issue');
});

test('planned targets, gateway receipts, completion reports and measured feedback remain separate facts',()=>{
  const entries=activity.motionEntries([row(1,'packet_ready',{waypoint_count:4}),row(2,'packet_submit',{waypoint_count:4}),
    row(3,'packet_accepted'),row(4,'packet_completed',{waypoint_count:4}),row(5,'observation',{left_joints_deg:[1,2,3,4,5,6]})]);
  assert.deepEqual(entries.map(value=>value.title),['Targets prepared','Targets sent','Gateway accepted the packet','Packet completion reported','Robot feedback received']);
  assert.equal(entries[0].detail,'Prepared 4 waypoints.');assert.equal(entries[1].detail,'Sent 4 waypoints to the gateway.');
  assert.equal(entries[3].detail,'The source reported 4 waypoints complete.');assert.match(entries[4].detail,/Encoder readings.*targets.*separately/);
  assert(entries.every(value=>value.detail.length<=90));
  assert.doesNotMatch(JSON.stringify(entries),/arms settled|object lifted|task succeeded|safe to move/);
});

test('progress folds by actual trajectory and observation folds by journal ID, then order is restored',()=>{
  const entries=activity.motionEntries([row(3,'observation'),row(4,'packet_progress',{trajectory_id:'first',progress_count:1,waypoint_count:5}),
    row(9,'packet_progress',{trajectory_id:'first',progress_count:4,waypoint_count:5}),row(5,'packet_submit'),
    row(8,'observation',{t:1}),row(6,'packet_progress',{trajectory_id:'second',progress_count:1,waypoint_count:2}),
    row(10,'packet_progress'),row(11,'packet_progress')]);
  assert.deepEqual(entries.map(value=>value.id),[5,6,8,9,10,11]);
  assert.match(entries.find(value=>value.id===9).detail,/4 of 5/);
});

test('bounds, malformed source values and ambiguous duplicate IDs cannot fabricate an entry',()=>{
  assert.deepEqual(activity.motionEntries(null),[]);
  const invalid=[row(-1,'packet_submit'),row(1,'unknown'),row(2,'observation',{t:NaN}),null,{},row(4,'packet_submit',{id:true})];
  assert.deepEqual(activity.motionEntries(invalid),[]);
  assert.deepEqual(activity.motionEntries([row(1,'packet_submit'),row(1,'observation')]),[]);
  assert.deepEqual(activity.motionEntries([row(1,'packet_progress',{trajectory_id:'a'}),row(1,'packet_progress',{trajectory_id:'b'})]),[]);
  const many=activity.motionEntries(Array.from({length:2000},(_,id)=>row(id,'packet_submit')));
  assert.equal(many.length,12);assert.deepEqual(many.map(value=>value.id),Array.from({length:12},(_,i)=>1988+i));
  const entry=activity.motionEntries([row(1,'packet_submit',{message:'PRIVATE',first:['PRIVATE'],response:{secret:'PRIVATE'},waypoint_count:Infinity})])[0];
  assert.doesNotMatch(JSON.stringify(entry),/PRIVATE|Infinity|10 Hz/);
});

test('Stop, errors and policy Done never establish physical stop or verified task success',()=>{
  const entries=activity.motionEntries([row(1,'stop_requested'),row(2,'stopped'),row(3,'policy_complete'),row(4,'tool_error'),row(5,'tool_result',{steps:3})]);
  assert.deepEqual(entries.map(value=>value.title),['Stop requested','Session reported stopped','Policy reported completion','Controller tool error reported','Controller result reported']);
  assert(entries.every(value=>value.detail.length<=90));
  assert.doesNotMatch(JSON.stringify(entries),/physical stop confirmed|task succeeded|movement completed|success verified/i);
});

test('primary activity details remain compact even at the admitted numeric limits',()=>{
  const kinds=['packet_ready','packet_submit','packet_dispatched','packet_accepted','packet_progress','packet_completed','packet_error',
    'observation','tool_result','tool_error','model_timing','policy_timing','execution_timing','step_timing','ik_replay',
    'observation_refreshed','observation_retry','observation_failure','observation_recovered','worker_recovery',
    'stop_requested','stopped','policy_complete','home_scene','feedback_check','feedback_timeout','reconnecting'];
  for(const kind of kinds){
    const entry=activity.motionEntries([row(1,kind,{waypoint_count:1e9,progress_count:1e9,steps:1e9,
      elapsed_s:86400,duration_s:86400,total_s:86400,stage:'sdk_get_action',state:'completed'})])[0];
    assert.ok(entry,kind);assert(entry.detail.length<=90,kind+': '+entry.detail);
  }
});

test('replanning no-dispatch wording requires the complete positive zero-dispatch attestation',()=>{
  const proof={state:'replanning',reason_code:'pre_dispatch_pose_changed',retry_limit:2,retry_count:1,dispatched:false,executed_waypoints:0};
  const entry=activity.motionEntries([row(1,'plan_recovery',proof)])[0];assert.match(entry.detail,/reports 0 waypoints dispatched/);
  for(const change of [{dispatched:true},{executed_waypoints:1},{retry_count:3},{reason_code:'PRIVATE'}])assert.deepEqual(activity.motionEntries([row(1,'plan_recovery',{...proof,...change})]),[]);
});

test('model summaries require explicit projected sharing and never use raw model messages or wire fields',()=>{
  const event=modelEvent(1,'model_request',{message:'PRIVATE_MESSAGE',request:{input:'PRIVATE_PROMPT'},note:'PRIVATE_REQUEST_NOTE'});
  const shared=view([event]),copy=structuredClone(shared);
  const summary=activity.modelUpdate(shared);assert.equal(summary.title,'Dream request sent');assert.equal(summary.model,'Dream');
  assert.equal(summary.detail,'Input and response details are in the recorded trace.');
  assert.doesNotMatch(JSON.stringify(summary),/PRIVATE/);assert.deepEqual(shared,copy);
  for(const bad of [null,{}, {...shared,scope:'not_shared'},{...shared,scope:true},{...shared,schema:'unknown'},
    {...shared,run:{...shared.run,present:false}},{...shared,events:[]}])assert.equal(activity.modelUpdate(bad),null);
});

test('latest approved model update keeps its source order and model identity separate from native timing',()=>{
  const shared=view([modelEvent(8,'model_response',{timestamp_s:200}),modelEvent(9,'model_progress',{timestamp_s:100,progress_type:'summary',note:'Rechecking the scene'})]);
  let summary=activity.modelUpdate(shared);assert.equal(summary.id,'9');assert.equal(summary.t,100);assert.match(summary.detail,/Rechecking the scene/);
  assert.equal(summary.detail,'Rechecking the scene');assert.equal(summary.category,'model');
  shared.events.push(modelEvent(10,'model_progress',{progress_type:'private_reasoning',note:'PRIVATE_REASONING'}));
  assert.equal(activity.modelUpdate(shared).id,'9');
  shared.run.model=null;summary=activity.modelUpdate(shared);assert.equal(summary.model,null);assert.equal(summary.title,'Model update published');
  shared.selected_model='Dream';assert.equal(activity.modelUpdate(shared).model,null,'current selector cannot attribute a past model update');
  shared.events.push(modelEvent(11,'model_error',{note:'The published request failed'}));assert.equal(activity.modelUpdate(shared).title,'Model reported an error');
});

test('only bounded approved text survives a shared model response, without untyped tools or payloads',()=>{
  const shared=view([modelEvent(1,'model_response',{note:'A'.repeat(1000),message:'PRIVATE_MESSAGE',response:'PRIVATE_RESPONSE',tools:[{note:'PRIVATE_TOOL',arguments:{secret:'PRIVATE'}}]})]);
  let summary=activity.modelUpdate(shared);assert.equal(summary.detail.length,200);assert.equal(summary.detail,'A'.repeat(200));assert.doesNotMatch(JSON.stringify(summary),/PRIVATE/);
  shared.events[0].note='api_key=secretvalue Bearer privateauthorization sk-abcdefghi';shared.run.model='Dream\nA';
  summary=activity.modelUpdate(shared);assert.doesNotMatch(summary.detail,/secretvalue|privateauthorization|sk-abcdefghi/);assert.equal(summary.model,'Dream A');
  shared.events[0].id='cap_sensitive';assert.equal(activity.modelUpdate(shared),null);
});

test('CommonJS and browser exports are pure and contain no DOM, network, timer or runtime dependency',()=>{
  assert.deepEqual(Object.keys(activity).sort(),['modelUpdate','motionEntries']);
  const context={window:{}};vm.runInNewContext(source,context);
  assert.equal(typeof context.window.ClawmetryActivity.motionEntries,'function');assert.equal(typeof context.window.ClawmetryActivity.modelUpdate,'function');
  assert.doesNotMatch(source,/\b(?:fetch|setTimeout|setInterval|require|import)\s*\(|\bdocument\./);
});
