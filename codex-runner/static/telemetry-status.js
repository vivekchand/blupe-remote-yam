/* Optional read-only status projection. No authority or transport is exposed. */
(() => {
  'use strict';
  const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e9 ? value : null;
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) && !/^(?:sk-|cap_|lease_)/i.test(value) ? value : null;
  function text(value, maximum = 1000) {
    if (typeof value !== 'string') return null;
    return value.slice(0, maximum).replace(/\b(?:sk-|rk-|cap_|lease_)[A-Za-z0-9_-]{6,}/g, '[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
      .replace(/\b(?:api[_ -]?key|session[_ -]?capability|csrf|authorization)\s*[:=]\s*["']?[^\s,"'}]+/gi, '[redacted]');
  }
  function freeze(value) {
    if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
    return value;
  }
  function toolCalls(message) {
    if (typeof message !== 'string') return [];
    const source = message.slice(0, 12000), calls = [];
    const pattern = /(?:^|\n)(move_to|done|give_up):\s*/g;
    for (const match of source.matchAll(pattern)) {
      const start = match.index + match[0].length;
      if (source[start] !== '{') continue;
      let depth = 0, quoted = false, escaped = false;
      for (let at = start; at < source.length; at++) {
        const char = source[at];
        if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
        else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) {
          try {
            const raw = object(JSON.parse(source.slice(start, at + 1))), tool = match[1];
            const row = {tool, note: text(raw.note || raw.summary || raw.reason), targets: {}, requested_arms: []};
            if (tool === 'move_to') {
              const targets = object(raw.targets);
              for (const arm of ['left', 'right']) for (const axis of ['x', 'y', 'z', 'yaw', 'pitch', 'roll', 'gripper']) {
                const key = arm + '_' + axis;
                if (finite(targets[key])) row.targets[key] = targets[key];
              }
              row.requested_arms = ['left', 'right'].filter(arm => Object.keys(row.targets).some(key => key.startsWith(arm + '_')));
            }
            calls.push(row);
          } catch (_) { /* An incomplete response may be supplied in a later status. */ }
          break;
        }
      }
      if (calls.length >= 8) break;
    }
    return calls;
  }
  function events(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const raw of rows.slice(-80)) {
      const row = object(raw), kind = row.kind;
      if (!['model_request', 'model_response', 'model_progress', 'model_error'].includes(kind)) continue;
      if (kind === 'model_progress' && !['summary', 'status'].includes(row.progress_type)) continue;
      const identity = id(typeof row.id === 'number' ? String(row.id) : row.id);
      if (!identity || !finite(row.timestamp) || row.timestamp <= 0) continue;
      const calls = kind === 'model_response' ? toolCalls(row.message) : [];
      out.push({id: identity, timestamp_s: row.timestamp, kind,
        note: kind === 'model_error' ? 'Model request failed.' : kind === 'model_request' ? 'Model request sent.' : calls.length ? calls.map(call => call.note).filter(Boolean).join('\n').slice(0, 2000) || null : text(row.message),
        progress_type: kind === 'model_progress' ? row.progress_type : null, tools: calls});
    }
    return out.slice(-32);
  }
  function measurement(raw, robot) {
    const source = object(raw);
    if (!robot) return null;
    if (source.jetson_id && source.jetson_id !== robot) return null;
    const arms = {};
    for (const arm of ['left', 'right']) {
      const joints = source[arm + '_joints_deg'];
      const gripper = source[arm + '_gripper'];
      arms[arm] = {joints_deg: Array.isArray(joints) ? joints.slice(0, 6).map(value => finite(value) ? value : null) : [],
        gripper_percent: finite(gripper) && gripper >= 0 && gripper <= 1 ? gripper * 100 : null};
    }
    if (!Object.values(arms).some(arm => arm.joints_deg.some(finite)) && !finite(source.observed_at)) return null;
    const mode = typeof source.mode === 'string' ? source.mode.toUpperCase() : '';
    const safety = object(source.safety);
    return {source_timestamp_s: finite(source.observed_at) && source.observed_at > 0 ? source.observed_at : null,
      source: ['hardware', 'simulation'].includes(source.source) ? source.source : 'unknown',
      observation_kind: source.type === 'station_status' || !Number.isInteger(source.step_id) ? 'station' : 'session',
      mode: ['DISABLED', 'IDLE', 'HOLD', 'RUNNING', 'ENABLED', 'ERROR', 'FAULT', 'MANUAL', 'READY', 'HOMING'].includes(mode) ? mode : null,
      ready: typeof safety.ok === 'boolean' ? safety.ok : null, settled: typeof source.settled === 'boolean' ? source.settled : null,
      step_id: count(source.step_id), arms};
  }
  // Motion rows are numbers, bounded tokens and timestamps. The server already
  // applies this allowlist; re-applying it here means a future server field
  // cannot reach the page without someone editing this line too.
  const MOTION_KINDS = ['packet_ready', 'packet_submit', 'packet_dispatched', 'packet_accepted',
    'packet_progress', 'packet_completed', 'packet_error', 'execution_timing', 'step_timing',
    'observation', 'tool_result', 'tool_error', 'policy_timing', 'model_timing', 'ik_replay',
    'observation_refreshed', 'observation_retry', 'observation_failure', 'observation_recovered',
    'worker_recovery', 'stop_requested', 'stopped', 'policy_complete', 'home_scene',
    'feedback_check', 'feedback_timeout', 'reconnecting', 'plan_recovery'];
  const MOTION_COUNTS = ['step_id', 'progress_count', 'waypoint_count', 'cadence_hz', 'steps', 'reported_progress', 'step'];
  const MOTION_DURATIONS = ['elapsed_s', 'duration_s', 'total_s', 'started_at'];
  const MOTION_TOKENS = ['stage', 'state', 'status', 'code', 'progress_type', 'reason_code'];
  const MOTION_SOURCES = ['station_journal', 'remote_host', 'unavailable'];

  function vector(value, maximum) {
    if (!Array.isArray(value)) return null;
    const numbers = value.slice(0, maximum).map(item => finite(item) ? item : null);
    return numbers.length ? numbers : null;
  }
  function armValues(source, row) {
    for (const arm of ['left', 'right']) {
      const joints = vector(source[arm + '_joints_deg'], 6);
      if (joints && joints.some(finite)) row[arm + '_joints_deg'] = joints;
      const gripper = source[arm + '_gripper'];
      if (finite(gripper)) row[arm + '_gripper'] = gripper;
    }
  }
  function motionRow(raw) {
    const source = object(raw);
    if (!MOTION_KINDS.includes(source.kind)) return null;
    if (!Number.isSafeInteger(source.id) || source.id < 0) return null;
    if (!finite(source.t) || source.t <= 0) return null;
    const row = {id: source.id, t: source.t, kind: source.kind};
    if(source.kind==='plan_recovery'){
      if(!['replanning','exhausted'].includes(source.state)||source.reason_code!=='pre_dispatch_pose_changed'||
        !Number.isSafeInteger(source.retry_count)||source.retry_count<0||source.retry_count>2||source.retry_limit!==2||
        count(source.step_id)===null||!id(source.trajectory_id)||source.dispatched!==false||source.executed_waypoints!==0)return null;
      return {...row,state:source.state,reason_code:'pre_dispatch_pose_changed',retry_count:source.retry_count,retry_limit:2,
        step_id:source.step_id,trajectory_id:source.trajectory_id,dispatched:false,executed_waypoints:0};
    }
    if (id(source.trajectory_id)) row.trajectory_id = source.trajectory_id;
    for (const name of MOTION_COUNTS) { const value = count(source[name]); if (value !== null) row[name] = value; }
    for (const name of MOTION_DURATIONS) if (finite(source[name])) row[name] = source[name];
    for (const name of MOTION_TOKENS) { const value = id(source[name]); if (value) row[name] = value; }
    for (const name of ['first', 'last']) {
      const points = vector(source[name], 16);
      if (points && points.every(finite)) row[name] = points;
    }
    armValues(source, row);
    const feedback = object(source.feedback), measured = {};
    armValues(feedback, measured);
    if (Object.keys(measured).length) row.feedback = measured;
    return row;
  }
  function motion(metadata) {
    const source = object(metadata.motion);
    if (!id(source.run_id) || !MOTION_SOURCES.includes(source.source)) return null;
    const rows = Array.isArray(source.rows) ? source.rows.slice(-200).map(motionRow).filter(Boolean) : [];
    return {run_id: source.run_id, source: source.source, rows};
  }

  function detailPath(metadata, displayed) {
    const detail = object(metadata.detail);
    if (typeof detail.path !== 'string' || !/^\/clawmetry\/trace\/[0-9a-f]{32}$/.test(detail.path)) return null;
    const sourceEpisode=id(detail.episode_id),displayedEpisode=id(displayed.episode_id);
    const hasEpisode=detail.episode_id!=null || displayed.episode_id!=null;
    if(hasEpisode && (!sourceEpisode || !displayedEpisode || sourceEpisode!==displayedEpisode))return null;
    const same = id(detail.attempt_id) && id(displayed.attempt_id) ? detail.attempt_id === displayed.attempt_id
      : id(detail.public_run_id) && id(displayed.run_id) ? detail.public_run_id === displayed.run_id
      : !!(id(detail.episode_id) && detail.episode_id === id(displayed.episode_id));
    return same ? detail.path : null;
  }
  // A finished run's trace stays served, but `detail_path` is tied to the run
  // the station is displaying now, so it goes blank the moment the station is
  // idle. The server offers the reader's own most recent run separately; it is
  // kept separate here too, because a past run must never read as the live one.
  function recentDetail(metadata) {
    const recent = object(metadata.detail_recent);
    if (typeof recent.path !== 'string' || !/^\/clawmetry\/trace\/[0-9a-f]{32}$/.test(recent.path)) return null;
    return {path: recent.path, task: text(recent.task), ended: recent.ended === true};
  }
  const hash = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
  const traceId = value => typeof value==='string' && /^[a-f0-9]{32}$/.test(value) ? value : null;
  const guardTokens = new Set(['target_encoding','valid_yam_targets','fresh_measured_feedback','fresh_policy_cameras',
    'object_color_guard','guard_configuration_changed','object_color_evidence_unavailable',
    ...['red','yellow','blue','green'].map(color=>'forbidden_'+color+'_grasp'),
    'color_guard_calibration_unvalidated','color_guard_identity_mismatch','color_guard_calibration_changed',
    'color_guard_incomplete_object_depth','color_guard_uncertain_forbidden_extent','color_guard_uncertain_red_extent',
    'color_guard_stale_capture_horizon','color_guard_stale_feedback_horizon','color_guard_stale_or_unknown_feedback',
    'color_guard_unsettled_baseline','color_guard_missing_gripper_feedback','color_guard_unknown_held_object',
    'color_guard_unknown_object','color_guard_ambiguous_object','color_guard_uncertain_object',
    'color_guard_incomplete_closing_sweep','color_guard_invalid_or_unavailable_perception',
    'color_guard_invalid_input','color_guard_invalid_packet','color_guard_invalid_rgbd',
    'color_guard_invalid_capture_time','color_guard_capture_precedes_settle','color_guard_missing_cadence',
    'color_guard_unsupported_joint_calibration','color_guard_invalid_kinematics','color_guard_sweep_budget_exceeded',
    'color_guard_distance_budget_exceeded','color_guard_association_budget_exceeded',
    'object_color_capture_unavailable','object_color_capture_stale','object_color_feedback_stale',
    'object_color_source_changed','object_color_source_identity','object_color_packet_changed',
    'object_color_runtime_configuration','object_color_evaluation_invalid','object_color_frame_identity',
    'object_color_calibration_changed','object_color_calibration_identity',
    'fresh_measured_hardware_baseline','settled_measured_hardware_baseline','measured_grippers','held_object_identity',
    'matching_station_calibration','paired_top_rgbd','fresh_capture','fresh_paired_capture','post_settle_paired_capture',
    'matching_depth_sensor','calibrated_image_dimensions','fresh_capture_through_closure','fresh_feedback_through_closure',
    'validated_extrinsics','published_native_kinematics','measured_depth_for_visible_color',
    'qualified_visible_forbidden_component','qualified_visible_red_component','unique_visible_grasp_object',
    'strong_nonred_rgbd_component','strong_permitted_rgbd_component','unique_object_through_closing_sweep',
    'bounded_closing_sweep','bounded_closing_associations','bounded_closing_association_work','valid_measured_rgbd_geometry',
    'cadence_hz','guard_evaluation_unavailable','feedback_age','camera_age','max_step_deg','max_rate_deg_s','gripper_bounds',
    ...['left','right'].flatMap(side=>['measured_baseline','gripper_target','joint_bounds','gripper_bounds','max_step_deg','max_rate_deg_s'].map(name=>side+'_'+name))]);
  const tokens = values => Array.isArray(values) ? [...new Set(values.slice(0,32).filter(value=>guardTokens.has(value)))] : [];
  function colorRule(value) {
    const source=object(value),colors=source.forbidden_colors;
    if(Object.keys(source).length!==2||!Array.isArray(colors)||!colors.length||colors.length>4
      ||colors.some((color,index)=>!['blue','green','red','yellow'].includes(color)||index>0&&colors[index-1]>=color)
      ||!finite(source.max_capture_age_s)||source.max_capture_age_s<=0||source.max_capture_age_s>2)return null;
    return {forbidden_colors:colors.slice(),max_capture_age_s:source.max_capture_age_s};
  }
  function guardConfig(value) {
    const source=object(value);
    if(source.schema!=='clawmetry.blupe.guard.v1' || !['monitor','block'].includes(source.mode)
      || !Number.isSafeInteger(source.version) || source.version<1 || source.version>=2**31)return null;
    const result={schema:source.schema,mode:source.mode,version:source.version};
    if('object_color_guard' in source){const rule=colorRule(source.object_color_guard);if(!rule)return null;result.object_color_guard=rule;}
    for(const field of ['max_step_deg','max_rate_deg_s','max_feedback_age_s','max_camera_age_s']) {
      if(!(field in source))continue;
      if(!finite(source[field]) || source[field]<=0 || source[field]>3600)return null;
      result[field]=source[field];
    }
    const pair=(value,minimum,maximum)=>Array.isArray(value)&&value.length===2
      &&value.every(item=>finite(item)&&item>=minimum&&item<=maximum)&&value[0]<=value[1];
    if('gripper_bounds' in source) {
      if(!pair(source.gripper_bounds,0,1))return null;
      result.gripper_bounds=source.gripper_bounds.slice();
    }
    if('joint_bounds' in source) {
      const bounds=object(source.joint_bounds),sides=Object.keys(bounds);
      if(!sides.length || sides.some(side=>!['left','right'].includes(side)))return null;
      result.joint_bounds={};
      for(const side of sides) {
        if(!Array.isArray(bounds[side])||bounds[side].length!==6||!bounds[side].every(value=>pair(value,-3600,3600)))return null;
        result.joint_bounds[side]=bounds[side].map(value=>value.slice());
      }
    }
    return result;
  }
  function pendingGuard(value) {
    const source=object(value),revision=count(source.revision),config=guardConfig(source.config),digest=hash(source.config_hash);
    if(source.state!=='saved_for_next_run'||revision===null||revision<1||!config||!digest)return null;
    const result={state:'saved_for_next_run',revision,config_hash:digest,config,coverage_scope:'local_joint_trajectory',policy:null};
    const policy=object(source.policy);
    if(policy.status==='saved_for_next_run'&&hash(policy.policy_hash)&&Array.isArray(policy.rules)&&policy.rules.length<=12) {
      const rules=[];
      for(const row of policy.rules) {
        const rule=object(row),field=rule.field;
        if(!['max_step_deg','max_rate_deg_s','max_feedback_age_s','gripper_bounds','object_color_guard'].includes(field)
          ||!(field in config))return result;
        const expected=config[field],semantic=field==='object_color_guard'?colorRule(rule.value):null;
        const same=field==='object_color_guard' ? !!semantic&&semantic.max_capture_age_s===expected.max_capture_age_s&&semantic.forbidden_colors.length===expected.forbidden_colors.length&&semantic.forbidden_colors.every((color,index)=>color===expected.forbidden_colors[index]) : Array.isArray(expected)
          ? Array.isArray(rule.value)&&rule.value.length===2&&rule.value.every((item,index)=>finite(item)&&item===expected[index])
          : finite(rule.value)&&rule.value===expected;
        if(!same)return result;
        const value=field==='object_color_guard'?colorRule(config[field]):Array.isArray(config[field])?config[field].slice():config[field];
        const description=field==='object_color_guard'?'Do not grasp recognized '+value.forbidden_colors.join(', ')+' regions; hold uncertain evidence'
          :field==='max_step_deg'?'Maximum joint step: '+value+' degrees'
          :field==='max_rate_deg_s'?'Maximum joint target rate: '+value+' degrees per second'
          :field==='max_feedback_age_s'?'Maximum feedback age: '+value+' seconds'
          :'Grippers between '+value[0]*100+' and '+value[1]*100+' percent open';
        rules.push({field,value,description});
      }
      result.policy={status:'saved_for_next_run',policy_hash:policy.policy_hash,rules};
    }
    return result;
  }
  function trust(metadata,displayed) {
    const source=object(metadata.trust);
    if(source.schema!=='clawmetry.trust.v1')return null;
    const trace=traceId(source.trace_id),path=detailPath(metadata,displayed);
    const matches=!!(trace && path==='/clawmetry/trace/'+trace);
    const result={schema:'clawmetry.trust.v1',trace_id:matches?trace:null,
      persistence:{state:'unavailable',through_sequence:null},
      guard:{state:'unavailable',mode:null,decision:null,coverage:[],reasons:[],missing:[],
        coverage_scope:'local_joint_trajectory',source:'duckdb_recorded_events',partial_window:true},
      next_run_guard:pendingGuard(source.next_run_guard),launch_hold:null};
    const hold=object(source.launch_hold);
    if(hold.state==='held'&&['unsupported_policy','unapplied_policy','owner_changed'].includes(hold.reason))result.launch_hold={state:'held',reason:hold.reason};
    if(!matches)return result;
    const persistence=object(source.persistence),guard=object(source.guard);
    const persisted=count(persistence.through_sequence);
    result.persistence={state:persistence.state==='confirmed'&&persisted!==null&&persisted>0?'confirmed':'unavailable',through_sequence:persisted};
    if(guard.source!=='duckdb_recorded_events'||guard.coverage_scope!=='local_joint_trajectory'
      ||!['unconfigured','configured','decision_recorded','unavailable'].includes(guard.state))return result;
    if(['configured','decision_recorded'].includes(guard.state)
      &&(!['monitor','block'].includes(guard.mode)||!hash(guard.config_hash)
        ||count(guard.config_version)===null||guard.config_version<1||count(guard.sequence)===null||guard.sequence<1))return result;
    if(guard.state==='decision_recorded'&&!['allow','reject'].includes(guard.decision))return result;
    result.guard={state:guard.state,mode:['monitor','block'].includes(guard.mode)?guard.mode:null,
      config_version:count(guard.config_version),config_hash:hash(guard.config_hash),
      decision:guard.state==='decision_recorded'?guard.decision:null,
      outcome:['within_configured_rules','violation','unknown'].includes(guard.outcome)?guard.outcome:null,
      sequence:count(guard.sequence),coverage:tokens(guard.coverage),reasons:tokens(guard.reasons),missing:tokens(guard.missing),
      coverage_scope:'local_joint_trajectory',source:'duckdb_recorded_events',partial_window:guard.partial_window!==false};
    const recordedConfig=guardConfig(guard.config);
    if(recordedConfig&&recordedConfig.version===result.guard.config_version&&recordedConfig.mode===result.guard.mode)
      result.guard.config=recordedConfig;
    return result;
  }
  function project(input, options = {}) {
    const state = object(input), metadata = object(state.telemetry), candidate = object(state.public_run);
    const displayed = object(options.displayed_identity);
    // A matching attempt must not override a conflicting or one-sided episode.
    // Only a fixed phase may cross the conversation-sharing boundary below.
    const sameEpisode = candidate.episode_id == null && displayed.episode_id == null
      || !!(id(candidate.episode_id) && id(candidate.episode_id) === id(displayed.episode_id));
    const sameAttempt = candidate.attempt_id == null && displayed.attempt_id == null
      || !!(id(candidate.attempt_id) && id(candidate.attempt_id) === id(displayed.attempt_id));
    const sameDisplayed = sameEpisode && sameAttempt && (id(displayed.attempt_id) && id(candidate.attempt_id) ? displayed.attempt_id === candidate.attempt_id
      : id(displayed.run_id) && id(candidate.run_id) ? displayed.run_id === candidate.run_id
      : !!(id(displayed.episode_id) && displayed.episode_id === id(candidate.episode_id)));
    const shared = metadata.public_run_shared === true && sameDisplayed;
    const run = shared ? candidate : {}, robot = id(options.robot_id);
    const attempt = id(run.attempt_id), episode = id(run.episode_id), publicRun = id(run.run_id);
    const ownAttempt = id(state.attempt_id), ownEpisode = id(state.episode_id);
    const matchesOwn = !!(shared && (attempt && ownAttempt ? attempt === ownAttempt
      : ownEpisode && (episode === ownEpisode || publicRun === ownEpisode)));
    const recording = matchesOwn ? object(metadata.recording) : {}, trajectory = matchesOwn ? object(state.trajectory) : {};
    const metrics = matchesOwn ? object(state.run_metrics) : {};
    const receiptStates = ['prepared', 'submitted', 'dispatched', 'accepted', 'running', 'executing', 'completed', 'failed', 'stopped', 'pending', 'recovering'];
    const phase = ['idle', 'queued', 'preparing', 'running', 'stopped', 'completed', 'complete', 'resetting', 'failed', 'disconnected', 'safety_aborted', 'timed_out'];
    const owned=object(metadata.owned_run);
    const ownedPhase=owned.schema==='clawmetry.owned_run.v1' && owned.robot_id===robot
      && id(owned.attempt_id) && owned.attempt_id===id(state.attempt_id) && owned.attempt_id===id(displayed.attempt_id)
      && id(owned.episode_id) && owned.episode_id===id(state.episode_id) && owned.episode_id===id(displayed.episode_id)
      && owned.status===state.status && phase.includes(owned.status) && owned.status!=='idle'
      && detailPath(metadata,displayed) ? owned.status : null;
    return freeze({schema: 'yam.telemetry.v1', robot_id: robot,
      received_at_s: finite(options.received_at_s) ? options.received_at_s : Date.now() / 1000,
      scope: shared ? 'shared_public_run' : 'not_shared',
      detail_path: detailPath(metadata, displayed),
      recent_detail: recentDetail(metadata),
      trust: trust(metadata,displayed),
      identity: {attempt_id: attempt, public_run_id: publicRun, episode_id: episode,
        recording_run_id: shared && matchesOwn ? id(object(state.interactions).run_id) : null,
        session_id: matchesOwn ? id(state.session_id) : null},
      run: {present: !!(id(displayed.attempt_id) || id(displayed.run_id) || id(displayed.episode_id)),
        task: text(run.task), model: text(run.model_name, 120), status: ownedPhase || (sameDisplayed && phase.includes(candidate.status) ? candidate.status : null)},
      events: shared ? events(run.events) : [],
      // Motion is published for every run on the station, so it is not behind
      // `shared`. It carries no task text, note, prompt or tool argument.
      motion: motion(metadata),
      receipt: matchesOwn ? {scope: 'matching_owned_run', trajectory_id: id(trajectory.trajectory_id),
        state: receiptStates.includes(trajectory.state) ? trajectory.state : null,
        waypoint_count: count(trajectory.waypoint_count), progress_count: count(trajectory.progress_count),
        final_observation_received: typeof trajectory.final_observation_received === 'boolean' ? trajectory.final_observation_received : null,
        packets_submitted: count(state.packets_submitted), accepted_packets: count(metrics.accepted_packets)} : null,
      measurement: measurement(state.last_observation, robot),
      recording: {state: ['waiting', 'recording', 'closed', 'incomplete', 'disabled', 'unavailable', 'not_configured'].includes(recording.state) ? recording.state : 'unconfirmed',
        trace_id: id(recording.trace_id), persistence: 'unconfirmed'},
      coverage: {private_reasoning: false, physical_motion_confirmed: false, physical_stop_confirmed: false,
        motion_scope: 'Every run on this station, independently of its conversation sharing choice.',
        capture: 'Published run output and received reports only. Independent camera and robot clocks.'}});
  }
  const api = {project, toolCalls, measurement, text, detailPath, motion, motionRow, trust, guardConfig, pendingGuard};
  if (typeof window !== 'undefined') window.YamTelemetryStatus = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
