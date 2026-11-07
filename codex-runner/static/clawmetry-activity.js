/* Pure summaries of projected evidence. No transport or control authority. */
(() => {
  'use strict';
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  const number=value=>typeof value==='number'&&Number.isFinite(value);
  const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=1e9;
  const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value)&&!/^(?:sk-|cap_|lease_)/i.test(value);
  function text(value,maximum=600) {
    if(typeof value!=='string')return null;
    const result=value.slice(0,maximum).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'')
      .replace(/\b(?:sk-|rk-|cap_|lease_)[A-Za-z0-9_-]{6,}/g,'[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,'Bearer [redacted]')
      .replace(/\b(?:api[_ -]?key|session[_ -]?capability|csrf|authorization)\s*[:=]\s*["']?[^\s,"'}]+/gi,'[redacted]').trim();
    return result||null;
  }
  const modelLabel=value=>text(value,120)?.replace(/\s+/g,' ')||null;
  const duration=value=>number(value)&&value>=0&&value<=86400?value.toFixed(2)+' s':null;
  const STAGES=Object.freeze({
    worker_acquisition:['model','Model worker preparation'],worker_start:['model','Model worker startup'],
    worker_configure:['model','Model worker configuration'],adapter_wait_ready:['model','Model readiness check'],
    worker_predict:['model','Policy prediction'],sdk_get_action:['model','Model action generation'],
    sdk_import:['model','Model SDK loading'],sdk_client_init:['model','Model client initialization'],
    sdk_configure:['model','Model SDK configuration'],sdk_kinematics_install:['model','Reference kinematics loading'],
    sdk_reset:['model','Model state reset'],sdk_observation_update:['input','Model observation update'],
    observation_read:['input','Robot feedback read'],camera_acquisition:['input','Camera input capture'],
    observation_refresh:['input','Observation refresh'],observation_wait:['input','Camera input wait'],
    selected_observation_capture:['input','Camera input selection'],controller_wait_ready:['feedback','Robot readiness check'],
    lease_feedback_refresh:['feedback','Session feedback refresh'],feedback_reconciliation:['feedback','Robot feedback reconciliation'],
    calibration_check:['input','Published calibration check'],home_observation_received:['feedback','Home feedback receipt'],
    home_feedback_confirmed:['feedback','Home feedback confirmation'],
  });
  function describe(row,modelName) {
    const waypoints=count(row.waypoint_count)?row.waypoint_count+' waypoints':'a packet';
    switch(row.kind) {
      case 'packet_ready':return ['command','Targets prepared','Prepared '+waypoints+'.'];
      case 'packet_submit':return ['command','Targets sent','Sent '+waypoints+' to the gateway.'];
      case 'packet_dispatched':return ['execution','Gateway reported dispatch','Dispatch receipt received from the gateway.'];
      case 'packet_accepted':return ['execution','Gateway accepted the packet','Gateway acceptance receipt received.'];
      case 'packet_progress':return ['execution','Execution progress reported',count(row.progress_count)&&count(row.waypoint_count)
        ?row.progress_count+' of '+row.waypoint_count+' waypoints reported.':'The gateway reported trajectory progress.'];
      case 'packet_completed':return ['execution','Packet completion reported','The source reported '+waypoints+' complete.'];
      case 'packet_error':return ['issue','Packet error reported','Review execution receipts and measured feedback for the physical result.'];
      case 'observation':return ['feedback','Robot feedback received','Encoder readings received; requested targets are shown separately.'];
      case 'tool_result':return ['status','Controller result reported',count(row.steps)?'Reported result for '+row.steps+' waypoints.':'A controller result was received.'];
      case 'tool_error':return ['issue','Controller tool error reported','Review this error in the recorded trace.'];
      case 'model_timing': {
        const elapsed=duration(row.elapsed_s)||duration(row.duration_s);
        return ['model',(modelLabel(modelName)||'Model')+' timing reported',elapsed?'Reported request duration: '+elapsed+'.'
          :count(row.waypoint_count)?'Reported '+row.waypoint_count+' planned waypoints.':'Timing receipt received.'];
      }
      case 'policy_timing': {
        const stage=typeof row.stage==='string'&&Object.prototype.hasOwnProperty.call(STAGES,row.stage)?STAGES[row.stage]:null;
        const state=['started','completed','error'].includes(row.state)?{started:'started',completed:'finished',error:'reported an error'}[row.state]:null;
        if(!stage||!state)return ['status','Policy timing reported','Additional stage timing is in the recorded trace.'];
        const elapsed=duration(row.duration_s),title=stage[1]+' '+state;
        return [row.state==='error'?'issue':stage[0],title,elapsed?'Source stage duration: '+elapsed+'.':'Source stage receipt received.'];
      }
      case 'execution_timing':return ['execution','Execution timing reported',duration(row.elapsed_s)?'Reported execution interval: '+duration(row.elapsed_s)+'.':'Execution timing receipt received.'];
      case 'step_timing':return ['status','Controller step timing reported',duration(row.total_s)?'Controller step interval: '+duration(row.total_s)+'.':'Controller step timing receipt received.'];
      case 'ik_replay':return ['command','Joint targets calculated','Inverse kinematics calculation reported.'];
      case 'observation_refreshed':return ['input','Observation refresh reported','Observation delivery refresh reported.'];
      case 'observation_retry':return ['issue','Observation read retry reported','Input read retry reported; no movement retry is inferred.'];
      case 'observation_failure':return ['issue','Observation feed unavailable','A usable robot observation was not supplied.'];
      case 'observation_recovered':return ['input','Observation feed recovered','Observation delivery resumed, according to the source.'];
      case 'worker_recovery':return ['issue','Model worker recovery reported','Worker recovery receipt received.'];
      case 'stop_requested':return ['status','Stop requested','The controller requested a stop.'];
      case 'stopped':return ['status','Session reported stopped','Source reported the session stopped.'];
      case 'policy_complete':return ['status','Policy reported completion','Policy completion report received.'];
      case 'home_scene':return ['status','Home scene update reported','Home setup receipt received.'];
      case 'feedback_check':return ['feedback','Robot feedback check reported','Robot readiness feedback was received.'];
      case 'feedback_timeout':return ['issue','Robot feedback read timed out','The station feedback read exceeded its deadline.'];
      case 'reconnecting':return ['issue','Robot connection recovery reported','Connection recovery receipt received.'];
      case 'plan_recovery':
        if(!['replanning','exhausted'].includes(row.state)||row.reason_code!=='pre_dispatch_pose_changed'||row.retry_limit!==2
          ||!count(row.retry_count)||row.retry_count>2||row.dispatched!==false||row.executed_waypoints!==0)return null;
        return ['issue',row.state==='exhausted'?'Replanning limit reached':'Plan discarded; checking a fresh view',
          'Retry '+row.retry_count+' of 2; recovery reports 0 waypoints dispatched.'];
      default:return null;
    }
  }
  function motionEntries(rows,modelName=null) {
    if(!Array.isArray(rows))return [];
    const byId=new Map(),conflicts=new Set();
    for(const raw of rows.slice(-500)) {
      const row=object(raw);
      if(!Number.isSafeInteger(row.id)||row.id<0||!number(row.t)||row.t<=0)continue;
      const description=describe(row,modelName);if(!description)continue;
      const entry={id:row.id,key:row.kind+':'+row.id,t:row.t,kind:row.kind,category:description[0],title:description[1],detail:description[2]};
      const previous=byId.get(row.id),trajectory=identifier(row.trajectory_id)?row.trajectory_id:null;
      if(previous&&(previous.trajectory!==trajectory||JSON.stringify(previous.entry)!==JSON.stringify(entry))){conflicts.add(row.id);continue;}
      byId.set(row.id,{entry,trajectory});
    }
    const ordered=[...byId.values()].filter(row=>!conflicts.has(row.entry.id)).sort((a,b)=>a.entry.id-b.entry.id),folded=new Map();
    for(const row of ordered) {
      const group=row.entry.kind==='observation'?'observation':row.entry.kind==='packet_progress'&&row.trajectory?'progress:'+row.trajectory:row.entry.key;
      folded.set(group,row.entry);
    }
    return [...folded.values()].sort((a,b)=>a.id-b.id).slice(-12);
  }
  function modelUpdate(view) {
    if(view?.schema!=='yam.telemetry.v1'||view.scope!=='shared_public_run'||view.run?.present!==true||!Array.isArray(view.events))return null;
    let latest=null;
    for(const raw of view.events.slice(-96)) {
      const event=object(raw);
      if(!identifier(event.id)||!number(event.timestamp_s)||event.timestamp_s<=0
        ||!['model_request','model_response','model_progress','model_error'].includes(event.kind)
        ||event.kind==='model_progress'&&!['summary','status'].includes(event.progress_type))continue;
      const model=modelLabel(view.run.model),label=model||'Model',note=text(event.note,200);
      const title=event.kind==='model_request'?label+' request sent':event.kind==='model_response'?label+' response published'
        :event.kind==='model_error'?label+' reported an error':label+' update published';
      const detail=event.kind==='model_request'?'Input and response details are in the recorded trace.'
        :note||(event.kind==='model_response'?'Model response details are in the recorded trace.'
          :event.kind==='model_error'?'Model error details are in the recorded trace.':'Model update details are in the recorded trace.');
      latest={id:event.id,key:event.kind+':'+event.id,t:event.timestamp_s,kind:event.kind,category:'model',model,title,detail};
    }
    return latest;
  }
  const api=Object.freeze({motionEntries,modelUpdate});
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(typeof window!=='undefined')window.ClawmetryActivity=api;
})();
