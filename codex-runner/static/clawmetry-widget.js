/* Optional embedded evidence panel. The existing runner remains authoritative. */
(() => {
  'use strict';
  function identity(view) {
    const ids = view.identity || {};
    return JSON.stringify([view.robot_id, view.scope, ids.attempt_id, ids.public_run_id, ids.episode_id,
      view.trust?.trace_id || view.motion?.run_id || null]);
  }
  // One advancing row per trajectory; every other row is distinct by journal id.
  const ADVANCING = new Set(['packet_progress']);
  const motionKey = row => ADVANCING.has(row.kind) ? row.kind + ':' + (row.trajectory_id || '') : row.kind + ':' + row.id;

  function createStore() {
    let key = null, samples = [], events = new Map(), signature = null, latest = null;
    let motion = new Map(), motionRun = null, motionSource = null;
    return {
      // The server window slides; the browser keeps the whole run's timeline so
      // a long run's early moves stay readable after they leave that window.
      updateMotion(view) {
        const next = view && view.motion;
        if (!next) { const changed = motion.size > 0 || motionSource !== null; motion.clear(); motionRun = motionSource = null; return changed; }
        if (motionRun !== next.run_id) { motion.clear(); motionRun = next.run_id; }
        const before = motion.size, source = motionSource;
        motionSource = next.source;
        let changed = source !== motionSource;
        for (const row of next.rows) {
          const rowKey = motionKey(row), previous = motion.get(rowKey);
          if (previous && previous.id === row.id && previous.t === row.t) continue;
          motion.set(rowKey, row);
          changed = true;
        }
        while (motion.size > 500) motion.delete(motion.keys().next().value);
        return changed || motion.size !== before;
      },
      get motion() { return [...motion.values()]; },
      get motionSource() { return motionSource; },
      get motionRun() { return motionRun; },
      update(view) {
        if (!view || view.schema !== 'yam.telemetry.v1') return false;
        const next = identity(view);
        if (key !== next) { key = next; samples = []; events.clear(); signature = null; }
        for (const event of view.events) {
          const eventKey = [event.kind, event.id].join(':');
          events.set(eventKey, event);
        }
        while (events.size > 96) events.delete(events.keys().next().value);
        const known = [...events.values()], visible = known.slice(-8);
        const lastCall = [...known].reverse().find(event => event.tools.length);
        if (lastCall && !visible.includes(lastCall)) visible.unshift(lastCall);
        const clipped = {...view, events: visible};
        const {received_at_s, ...evidence} = clipped;
        const fingerprint = JSON.stringify(evidence);
        latest = clipped;
        if (fingerprint === signature) return false;
        signature = fingerprint; samples.push(clipped);
        if (samples.length > 80) samples.shift();
        return true;
      },
      clear() { key = signature = latest = null; samples = []; events.clear(); motion.clear(); motionRun = motionSource = null; },
      get samples() { return samples.slice(); },
      get latest() { return latest; },
      export() { return {schema: 'yam.telemetry.browser.v1', exported_at_s: Date.now() / 1000,
        coverage: 'This browser window only. A recording receipt does not confirm durable daemon ingestion.',
        events: [...events.values()], motion: [...motion.values()], motion_source: motionSource,
        samples: samples.slice()}; },
    };
  }
  function freshness(view, now = Date.now() / 1000) {
    const stamp = view?.measurement?.source_timestamp_s;
    if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0 || stamp > now + 2) return {state: 'unknown', age_s: null};
    return {state: now - stamp > 10 ? 'stale' : 'fresh', age_s: Math.max(0, Math.floor(now - stamp))};
  }
  function requestedAction(event) {
    const calls = event?.tools || [];
    if (!calls.length) return 'No typed action request was published.';
    return calls.map(call => call.tool === 'move_to'
      ? 'Requested ' + (call.requested_arms.length ? call.requested_arms.join(' and ') + ' arm targets' : 'unspecified arm targets')
      : call.tool === 'done' ? 'Model reported task complete.' : 'Model requested to give up.').join(' ');
  }
  function receiptText(receipt) {
    if (!receipt) return 'No execution receipt for this published run.';
    const stateNames = {prepared: 'Packet prepared', submitted: 'Packet submitted', dispatched: 'Packet dispatched', accepted: 'Packet accepted',
      running: 'Trajectory reported running', executing: 'Trajectory reported executing', completed: 'Trajectory reported complete',
      failed: 'Trajectory reported failed', stopped: 'Trajectory reported stopped', pending: 'Packet pending', recovering: 'Trajectory recovery reported'};
    const parts = [];
    if (receipt.state) parts.push(stateNames[receipt.state]);
    if (Number.isSafeInteger(receipt.packets_submitted)) parts.push(receipt.packets_submitted + ' packet(s) submitted');
    if (Number.isSafeInteger(receipt.accepted_packets)) parts.push(receipt.accepted_packets + ' packet(s) accepted');
    if (Number.isSafeInteger(receipt.progress_count) && Number.isSafeInteger(receipt.waypoint_count)) parts.push(receipt.progress_count + ' of ' + receipt.waypoint_count + ' waypoints reported');
    return parts.join('. ') || 'Execution receipt not supplied.';
  }
  // Rows carry no text from the run, so every sentence is written here from the
  // journal kind and its numbers. An unknown kind never reaches this map.
  const seconds = value => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) + 's' : null;
  const counted = (value, fallback) => Number.isSafeInteger(value) ? value : fallback;
  const MOTION_TEXT = {
    packet_ready: row => 'Prepared ' + counted(row.waypoint_count, 'the') + ' waypoints at ' + counted(row.cadence_hz, 10) + ' Hz',
    packet_submit: row => 'Sent ' + counted(row.waypoint_count, 'the') + ' waypoints to the gateway',
    packet_dispatched: row => 'Gateway accepted the packet for dispatch',
    packet_accepted: row => 'Gateway reported packet accepted for execution',
    packet_progress: row => 'Executing waypoint ' + counted(row.progress_count, '?') + ' of ' + counted(row.waypoint_count, '?'),
    packet_completed: row => 'Robot reported completion of ' + counted(row.waypoint_count, 'the') + ' waypoints',
    packet_error: row => 'Packet ' + (row.status || 'failed') + (row.code ? ' · ' + row.code : '') +
      (Number.isSafeInteger(row.reported_progress) ? ' after ' + row.reported_progress + ' waypoints' : ''),
    execution_timing: row => 'Robot execution took ' + (seconds(row.elapsed_s) || 'an unreported time'),
    step_timing: row => 'Step ' + counted(row.step, '?') + ' took ' + (seconds(row.total_s) || 'an unreported time'),
    observation: row => 'Measured arm feedback received',
    tool_result: row => Number.isSafeInteger(row.steps) ? 'Controller reported ' + row.steps + ' waypoints'
      : 'Policy outcome: ' + (row.status || 'reported'),
    tool_error: row => 'Controller error reported' + (row.code ? ' · ' + row.code : ''),
    policy_timing: row => (row.stage ? 'Policy stage ' + row.stage + ' ' : 'Policy timing ') + (row.state || 'reported') +
      (seconds(row.duration_s) ? ' · ' + seconds(row.duration_s) : ''),
    model_timing: row => 'Model request timing reported' +
      (seconds(row.elapsed_s ?? row.duration_s) ? ' · ' + seconds(row.elapsed_s ?? row.duration_s) : ''),
    ik_replay: row => 'Inverse kinematics replayed for the packet',
    observation_refreshed: row => 'Observation feed refreshed',
    observation_retry: row => 'Observation feed retrying',
    observation_failure: row => 'Observation feed unavailable',
    observation_recovered: row => 'Observation feed recovered',
    worker_recovery: row => 'Worker recovery ' + (row.state || 'reported') + '; motion is paused',
    stop_requested: row => 'Stop requested',
    stopped: row => 'Session stopped',
    policy_complete: row => 'Policy reported the goal reached',
    home_scene: row => 'Home scene ' + (row.state || 'reported'),
    feedback_check: row => 'Hardware feedback check ' + (row.status || 'reported'),
    feedback_timeout: row => 'Station status fetch exceeded the feedback deadline',
    reconnecting: row => 'Reconnecting to the same session',
    plan_recovery: row => row.state==='exhausted' ? 'Replanning limit reached; no new motion sent'
      : 'Plan changed; checking a fresh view (retry '+row.retry_count+' of '+row.retry_limit+')',
  };
  function motionText(row) {
    const build = MOTION_TEXT[row.kind];
    try { return build ? build(row) : null; } catch (_) { return null; }
  }
  const degrees = values => values.map(value => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) + '°' : '—').join(' ');
  function motionNumbers(row) {
    const parts = [];
    for (const arm of ['left', 'right']) {
      const joints = row[arm + '_joints_deg'] || (row.feedback || {})[arm + '_joints_deg'];
      if (Array.isArray(joints) && joints.length) parts.push((arm === 'left' ? 'L ' : 'R ') + degrees(joints));
      const gripper = row[arm + '_gripper'] ?? (row.feedback || {})[arm + '_gripper'];
      if (typeof gripper === 'number' && Number.isFinite(gripper)) parts.push((arm === 'left' ? 'L' : 'R') + ' grip ' + (gripper * 100).toFixed(0) + '%');
    }
    for (const name of ['first', 'last']) {
      if (Array.isArray(row[name]) && row[name].length) parts.push(name + ' target vector: ' + row[name].map(value => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'Not reported').join(' '));
    }
    return parts.join(' · ');
  }
  const meaningfulMotion = row => {
    if (!row || typeof row.kind !== 'string') return false;
    if (row.kind === 'feedback_check') return [row.status, row.state, row.code, row.reason_code]
      .some(value => typeof value === 'string' && /wait|reject|fail|stale|missing|unsafe|unavailable/.test(value));
    if (row.kind === 'worker_recovery') return !['ready','completed','recovered'].includes(row.state);
    return ['packet_submit','packet_accepted','packet_completed','packet_error','tool_error',
      'stop_requested','stopped','policy_complete','observation_failure','feedback_timeout','reconnecting','plan_recovery'].includes(row.kind);
  };
  function recordedOutcomeGuard(view) {
    const trust=view?.trust,guard=trust?.guard;
    if(trust?.schema!=='clawmetry.trust.v1'||!/^\/clawmetry\/trace\/[a-f0-9]{32}$/.test(view?.detail_path||'')
      ||view.detail_path!=='/clawmetry/trace/'+trust.trace_id||guard?.source!=='duckdb_recorded_events'
      ||guard.coverage_scope!=='local_joint_trajectory'||!['configured','decision_recorded'].includes(guard.state)||!['monitor','block'].includes(guard.mode)
      ||!Number.isSafeInteger(guard.config_version)||guard.config_version<1||!Number.isSafeInteger(guard.sequence)||guard.sequence<1
      ||!/^[a-f0-9]{64}$/.test(guard.config_hash||''))return null;
    return guard;
  }
  function recordedRule(guard) {
    if(!guard)return null;
    const config=guard.config;
    if(!config||config.schema!=='clawmetry.blupe.guard.v1'||config.version!==guard.config_version||config.mode!==guard.mode)return 'Recorded configuration v'+guard.config_version+'; rule values are not loaded.';
    const parts=[],colors=config.object_color_guard?.forbidden_colors;
    if(Array.isArray(colors)&&colors.length&&colors.length<=4&&new Set(colors).size===colors.length
      &&colors.every((color,index)=>['blue','green','red','yellow'].includes(color)&&color===colors.slice().sort()[index]))parts.push('do not grasp '+colors.join(', ')+' objects');
    if(typeof config.max_step_deg==='number'&&Number.isFinite(config.max_step_deg))parts.push('joint steps at most '+config.max_step_deg+'°');
    if(typeof config.max_feedback_age_s==='number'&&Number.isFinite(config.max_feedback_age_s))parts.push('feedback at most '+config.max_feedback_age_s+' s old');
    return 'Recorded configuration v'+guard.config_version+(parts.length?': '+parts.join('; ')+'.':'.');
  }
  function runOutcome(view, rows = []) {
    const guard=recordedOutcomeGuard(view),rule=recordedRule(guard);
    if(guard?.state==='decision_recorded'&&guard.decision==='reject') {
      const reasons=Array.isArray(guard.reasons)?guard.reasons:[],missing=Array.isArray(guard.missing)?guard.missing:[];
      const color=guard.outcome==='violation' ? ['blue','green','red','yellow'].find(value=>reasons.includes('forbidden_'+value+'_grasp')) : null;
      const supplied=new Set([...reasons,...missing]);
      const labels=[['object_color_feedback_stale','Hardware feedback expired during the grasp check.'],
        ['object_color_capture_stale','The paired camera frame expired during the grasp check.'],
        ['color_guard_calibration_unvalidated','Camera geometry needs physical validation.'],
        ['validated_extrinsics','Validated camera geometry was unavailable.'],
        ['fresh_measured_hardware_baseline','Fresh measured hardware feedback was unavailable.'],
        ['fresh_measured_feedback','Fresh measured hardware feedback was unavailable.'],
        ['object_color_capture_unavailable','A usable paired camera capture was unavailable.'],
        ['object_color_evidence_unavailable','The grasp check could not be verified.'],
        ['guard_configuration_changed','Rules changed during the check.']];
      const notes=[...new Set(labels.filter(([code])=>supplied.has(code)).map(([,note])=>note))];
      return {category:'blocked',title:'Blocked by Guard',detail:color?'Guard refused the planned grasp of a recognized '+color+' region.':notes.slice(0,2).join(' ')||'The recorded packet was refused before dispatch by its local checks.',rule,guard_sequence:guard.sequence};
    }
    const failed=['failed','timed_out','safety_aborted'].includes(view?.run?.status);
    if(failed)return {category:'failed',title:'Failed',detail:view.run.status==='timed_out'?'The run deadline expired. Task success was not verified.':view.run.status==='safety_aborted'?'The source reported an aborted run. Task success was not verified.':'The source reported a failed run.',rule,guard_sequence:guard?.sequence||null};
    const ended=['stopped','complete','completed','resetting'].includes(view?.run?.status);
    return {category:'unverified',title:'Unverified',detail:ended?'The run ended without a verified task result.':view?.run?.present?'The run has no verified task result yet.':'No run outcome is recorded.',rule,guard_sequence:guard?.sequence||null};
  }
  function runSummary(view, rows = [], options = {}) {
    const recent = rows.filter(meaningfulMotion).slice().sort((a,b) => b.t-a.t || b.id-a.id).slice(0,3);
    const states = {
      idle:['No active run','Rules can be prepared before the next manual Run.'],
      queued:['Waiting for a turn','No task packet is executing for this queued run.'],
      preparing:['Preparing the robot','Native readiness and Home checks are in progress.'],
      running:['Run in progress','Follow requested actions and measured feedback separately.'],
      stopped:['Run stopped','The session ended. Task success and physical stopping require separate evidence.'],
      completed:['Run ended','The runner reported completion. Review the evidence before assessing the task.'],
      complete:['Run ended','The runner reported completion. Review the evidence before assessing the task.'],
      resetting:['Run ended; station resetting','The source reports resetting. This is not a task-success or physical-stop verdict.'],
      failed:['Run failed','Review the last reported failure and the recorded evidence.'],
      disconnected:['Connection interrupted','Latest state may be out of date; this does not confirm a physical stop.'],
      safety_aborted:['Run aborted','The source reported an abort. Review its reason and measured feedback.'],
      timed_out:['Run timed out','The session deadline ended the run. This is not a task-success verdict.'],
    };
    let state = states[view?.run?.status];
    if (view?.run?.status === 'preparing' && view.run.preparation_before_queue === true)
      state = ['Preparing model','Preparing trajectory solvers before joining the robot queue. The run timer has not started.'];
    const hold=view?.trust?.schema==='clawmetry.trust.v1' ? view.trust.launch_hold : null;
    if(!options.currentRunOnly&&hold?.state==='held'&&['unsupported_policy','unapplied_policy','owner_changed'].includes(hold.reason))state=['Next run held for review','Review or replace the requested rules before the next Run. This does not stop or change an active run.'];
    if (options.disconnected) state = states.disconnected;
    if (!state) state = view?.run?.present ? ['Run status not reported','Evidence is available, but this source did not report a run phase.'] : states.idle;
    return {title:state[0],detail:state[1],latest:recent[0] || null,recent,outcome:runOutcome(view,rows)};
  }
  function guardSummary(view) {
    const trust = view?.trust?.schema === 'clawmetry.trust.v1' ? view.trust : null;
    let guard = trust?.guard || {};
    if (['configured','decision_recorded'].includes(guard.state) && (!/^[a-f0-9]{64}$/.test(guard.config_hash || '')
      || !Number.isSafeInteger(guard.config_version) || guard.config_version<1
      || !Number.isSafeInteger(guard.sequence) || guard.sequence<1)) guard={};
    if (guard.state === 'configured') return {title:'Rules recorded; awaiting a check',detail:'A configuration was recorded for this run, but no packet decision was supplied.',tone:'unknown'};
    if (guard.state !== 'decision_recorded' || !['allow','reject'].includes(guard.decision)) return {
      title:'No Guard decision recorded',detail:'Saved preferences and gateway receipts do not prove that a Guard check ran.',tone:'unknown'};
    const labels = {fresh_measured_feedback:'Fresh measured feedback was not available.',
      forbidden_red_grasp:'The planned grasp overlaps a recognized red region.',
      forbidden_yellow_grasp:'The planned grasp overlaps a recognized yellow region.',
      forbidden_blue_grasp:'The planned grasp overlaps a recognized blue region.',
      forbidden_green_grasp:'The planned grasp overlaps a recognized green region.',
      color_guard_calibration_unvalidated:'Camera calibration needs physical validation.',
      validated_extrinsics:'Validated camera geometry was unavailable.',
      color_guard_stale_capture_horizon:'The image would be too old when the gripper closes.',
      color_guard_unknown_object:'No recognized object could be matched to the grasp.',
      color_guard_ambiguous_object:'The grasp region has more than one possible target.',
      object_color_capture_unavailable:'A usable paired color and depth capture was unavailable.',
      object_color_evidence_unavailable:'The object check could not be verified.',
      guard_configuration_changed:'Rules changed during the check. The packet was refused.',
      source_capture_timestamp:'A required source capture timestamp was not available.',
      source_camera_capture_timestamp:'A required camera capture timestamp was not available.',
      feedback_age:'Feedback exceeded the configured age.', max_step_deg:'A joint step exceeded the configured limit.'};
    const supplied = [...(Array.isArray(guard.reasons)?guard.reasons:[]),...(Array.isArray(guard.missing)?guard.missing:[])];
    const reason = supplied.map(value=>labels[value]).filter(Boolean).join(' ');
    if (guard.decision === 'reject') return {title:'Packet held before dispatch',detail:reason || 'The recorded packet was refused by its configured local checks.',tone:'held'};
    return {title:guard.mode === 'block' ? 'Last recorded packet allowed by Guard' : 'Last recorded packet reviewed in monitor mode',
      detail:reason || 'Only the recorded local trajectory checks are covered; this is not a task-success verdict.',tone:'reviewed'};
  }
  // This is an ephemeral request receipt, not a robot run or history record.
  function createAdmissionState() {
    let pending=null, rejected=null;
    const validLaunch=value=>value && Number.isSafeInteger(value.version) && value.version>=0 &&
      typeof value.robot_id==='string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value.robot_id);
    const colors=value=>Array.isArray(value) && value.length<=4 && value.every((color,index)=>
      ['blue','green','red','yellow'].includes(color) && (!index || value[index-1]<color));
    const hash=value=>typeof value==='string' && /^[0-9a-f]{64}$/.test(value);
    const matches=value=>validLaunch(value) && pending && value.version===pending.version && value.robot_id===pending.robot_id;
    return {
      start(value) { rejected=null; pending=validLaunch(value)?{version:value.version,robot_id:value.robot_id}:null; },
      accept(value) { if(matches(value)) {pending=null;rejected=null;} },
      reject(value) {
        if(!matches(value))return false;
        const guard=value.guard_admission;
        if(!guard || guard.schema!=='clawmetry.intent_guard.v1' || guard.version!==1 ||
          guard.decision!=='reject' || guard.mode!=='block' || guard.scope!=='explicit_color_intent' ||
          guard.physical_permission_granted!==false || !hash(value.task_hash) || guard.task_hash!==value.task_hash ||
          !hash(guard.config_hash) || !colors(guard.forbidden_colors) || !guard.forbidden_colors.length ||
          !colors(guard.requested_colors) || !colors(guard.blocked_colors))return false;
        const blocked=guard.requested_colors.filter(color=>guard.forbidden_colors.includes(color));
        if(JSON.stringify(blocked)!==JSON.stringify(guard.blocked_colors))return false;
        const violation=guard.outcome==='intent_violation' && guard.reason_code==='forbidden_color_requested' && blocked.length>0;
        const uncertain=guard.outcome==='intent_uncertain' && guard.reason_code==='color_intent_needs_clarification' && !blocked.length;
        if(!violation && !uncertain)return false;
        rejected=Object.freeze({category:'blocked',title:'Blocked by Guard',context:'Current request · not queued',
          detail:violation?'The request conflicts with the saved color rule. No model call was made and no robot task was queued.':
            'Guard could not confidently match this request to the saved color rule. Clarify the object before Run. No model call was made and no robot task was queued.',
          rule:'Rule checked for this request: never pick '+guard.forbidden_colors.join(', ')+' objects.',
          robot_id:value.robot_id,version:value.version});
        return true;
      },
      clear() {pending=null;rejected=null;},
      current() {return rejected;},
    };
  }
  const MOTION_SOURCE_TEXT = {
    station_journal: 'Live from this station’s run journal. Every packet, waypoint and measured report on this station, whether or not its conversation is shared.',
    remote_host: 'The move journal for the displayed station run is not available here. Open its saved run to inspect recorded evidence.',
    unavailable: 'The station run journal could not be read for this run. This is a gap in the log, not an idle robot.',
  };

  const api = {createStore, freshness, requestedAction, receiptText, identity, motionText, motionNumbers, motionKey, meaningfulMotion, runSummary, runOutcome, recordedRule, guardSummary, createAdmissionState};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ClawmetryWidget = api;
  if (typeof document === 'undefined') return;

  const store = createStore();
  const admission = createAdmissionState();
  let root, summaryState, nodes, following = true, selected = 0, disconnected = false;
  const add = (parent, tag, content, className) => {
    const node = document.createElement(tag); if (content) node.textContent = content;
    if (className) node.className = className; parent.append(node); return node;
  };
  // Run evidence is a section of the ClawMetry tab, not a second panel. Two
  // ClawMetry surfaces on one screen is one too many; see buildTab below.
  function build(parent) {
    if (root || document.getElementById('clawmetryEvidence')) return;
    if (!parent) return;
    root = document.createElement('details'); root.id = 'clawmetryEvidence'; root.className = 'cm-evidence-widget';
    const summary = add(root, 'summary');
    add(summary, 'strong', 'Run evidence', 'cm-evidence-title');
    summaryState = add(summary, 'span', 'Waiting for reports', 'cm-evidence-status');
    summaryState.setAttribute('role', 'status'); summaryState.setAttribute('aria-live', 'polite');
    const content = add(root, 'div', '', 'cm-evidence-content');
    const scope = add(content, 'p', 'Published output, execution receipts and received measurements. This panel does not control the robot.', 'cm-evidence-intro');
    const grid = add(content, 'div', '', 'cm-evidence-grid');
    nodes = {scope};
    for (const [key, title] of [['task', 'Task'], ['note', 'Published note'], ['action', 'Requested action'], ['receipt', 'Execution receipt']]) {
      const section = add(grid, 'section'); add(section, 'h3', title); nodes[key] = add(section, 'p');
    }
    nodes.targets = add(grid, 'p', '', 'cm-evidence-targets');
    const feedback = add(content, 'section', '', 'cm-evidence-feedback'); add(feedback, 'h3', 'Reported feedback');
    nodes.measurement = add(feedback, 'p', '', 'cm-evidence-intro');
    const table = add(feedback, 'table'); table.setAttribute('aria-label', 'Received arm measurements');
    const header = add(add(table, 'thead'), 'tr');
    for (const label of ['Joint', 'Left arm', 'Right arm']) add(header, 'th', label).setAttribute('scope', 'col');
    nodes.joints = add(table, 'tbody');
    for (let index = 0; index < 7; index++) {
      const row = add(nodes.joints, 'tr'); add(row, 'th', index === 6 ? 'Gripper' : 'Joint ' + (index + 1)).setAttribute('scope', 'row');
      for (const arm of ['left', 'right']) { const cell = add(row, 'td', 'Not reported'); cell.dataset.arm = arm; cell.dataset.index = String(index); }
    }
    const history = add(content, 'div', '', 'cm-evidence-history');
    const label = add(history, 'label', 'Recent reports in this browser'); label.htmlFor = 'cmEvidenceCursor';
    nodes.cursor = add(history, 'input'); nodes.cursor.id = 'cmEvidenceCursor'; nodes.cursor.type = 'range'; nodes.cursor.min = '0'; nodes.cursor.max = '0'; nodes.cursor.value = '0'; nodes.cursor.disabled = true;
    nodes.cursor.oninput = () => { following = false; selected = Number(nodes.cursor.value); render(); };
    const actions = add(history, 'div', '', 'cm-evidence-actions');
    nodes.follow = add(actions, 'button', 'Follow newest'); nodes.follow.type = 'button'; nodes.follow.onclick = () => { following = true; render(); };
    nodes.detail = add(actions, 'a', 'Open full trace'); nodes.detail.hidden = true;
    nodes.detail.target = '_blank'; nodes.detail.rel = 'noopener noreferrer';
    nodes.download = add(actions, 'button', 'Download browser evidence'); nodes.download.type = 'button';
    nodes.download.onclick = () => {
      const exported = store.export(); if (!exported.samples.length) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2) + '\n'], {type: 'application/json'}));
      const link = document.createElement('a'); link.href = url; link.download = 'clawmetry-browser-evidence.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    nodes.history = add(history, 'p', '', 'cm-evidence-intro');
    nodes.recording = add(content, 'p', '', 'cm-evidence-recording');
    const correlation = add(content, 'details', '', 'cm-evidence-identities'); add(correlation, 'summary', 'Evidence identifiers');
    nodes.identities = add(correlation, 'dl');
    add(content, 'p', 'Published notes are not private model reasoning. Requests and packet receipts do not confirm physical movement or stopping. Reports and cameras have independent clocks.', 'cm-evidence-limits');
    parent.append(root);
    root.addEventListener('toggle', render); render();
  }
  function ageLabel(value) { return value === null ? 'Source time unknown' : value < 60 ? value + 's ago' : Math.floor(value / 60) + 'm ago'; }
  function render() {
    renderTrust();
    if (!root) return;
    const samples = store.samples, latest = store.latest;
    if (following) selected = Math.max(0, samples.length - 1);
    else selected = Math.max(0, Math.min(samples.length - 1, selected));
    const view = samples[selected] || latest;
    const fresh = freshness(following ? latest : view);
    summaryState.dataset.state = disconnected ? 'stale' : fresh.state;
    summaryState.textContent = disconnected ? 'Runner reconnecting' : latest ? (following ? 'Report ' : 'Recorded report ') + ageLabel(fresh.age_s) : 'Waiting for reports';
    const detailPath = typeof view?.detail_path === 'string' && /^\/clawmetry\/trace\/[0-9a-f]{32}$/.test(view.detail_path) ? view.detail_path : null;
    nodes.detail.hidden = !detailPath;
    if (detailPath) nodes.detail.href = detailPath; else nodes.detail.removeAttribute('href');
    if (!root.open && view) return;
    nodes.scope.textContent = !view?.run.present ? 'No task is running. Station feedback can still be reviewed.'
      : view.scope === 'shared_public_run' ? 'Shared run evidence. Station reports are separate from action confirmation.'
      : 'Model activity is not shared for this run. Station feedback can still be reviewed.';
    nodes.task.textContent = view?.run.task || 'No shared task supplied.';
    const model = view?.run.model;
    if (model) nodes.task.textContent += ' Model: ' + model + '.';
    if (view?.run.status) nodes.task.textContent += ' Run status: ' + view.run.status.replaceAll('_', ' ') + '.';
    const lastNote = [...(view?.events || [])].reverse().find(event => event.note && event.kind !== 'model_request');
    const lastRequest = [...(view?.events || [])].reverse().find(event => event.tools.length);
    nodes.note.textContent = lastNote?.note || 'No published response note in this window.';
    nodes.action.textContent = requestedAction(lastRequest);
    const targets = lastRequest?.tools.flatMap(call => Object.entries(call.targets).map(([key, value]) => key.replaceAll('_', ' ') + ': ' + value)) || [];
    nodes.targets.textContent = targets.length ? 'Requested targets: ' + targets.join('; ') + '. Position in metres; rotation in radians; gripper from 0 to 1.' : '';
    nodes.targets.hidden = !targets.length;
    nodes.receipt.textContent = receiptText(view?.receipt);
    const measurement = view?.measurement;
    const stamp = measurement?.source_timestamp_s;
    const reportKind = measurement?.observation_kind === 'station'
      ? (following ? 'Latest station report. ' : 'Recorded station report. ') + 'Independent of this run’s session feedback. '
      : following ? 'Latest session feedback. ' : 'Recorded session feedback. ';
    nodes.measurement.textContent = measurement ?
      reportKind + (measurement.source === 'simulation' ? 'Simulation. ' : measurement.source === 'hardware' ? 'Hardware source report. ' : 'Source environment unreported. ') +
      (measurement.mode ? 'Mode: ' + measurement.mode.toLowerCase() + '. ' : '') +
      (measurement.ready === true ? 'Source reports ready. ' : measurement.ready === false ? 'Source is not ready. ' : 'Readiness unreported. ') +
      (stamp ? 'Source time ' + new Date(stamp * 1000).toLocaleTimeString() + '. ' : 'Source time unknown. ') +
      'Joint values in degrees. Motor capture time is not supplied.' : 'No measured report supplied.';
    for (const cell of nodes.joints.querySelectorAll('td')) {
      const arm = measurement?.arms[cell.dataset.arm], index = Number(cell.dataset.index);
      const value = index === 6 ? arm?.gripper_percent : arm?.joints_deg[index];
      cell.textContent = typeof value === 'number' && Number.isFinite(value) ? value.toFixed(index === 6 ? 1 : 2) + (index === 6 ? '%' : '°') : 'Not reported';
    }
    const journalStates = {waiting: 'ClawMetry local journal is waiting for a run.', recording: 'ClawMetry local journal is recording.',
      closed: 'ClawMetry local journal is closed.', incomplete: 'ClawMetry local journal is incomplete.',
      disabled: 'ClawMetry local journal is disabled.', unavailable: 'ClawMetry local journal is unavailable.',
      not_configured: 'ClawMetry local journal is not configured.'};
    nodes.recording.textContent = (journalStates[view?.recording.state] || 'ClawMetry local journal status is unconfirmed for this published run.') +
      ' Database persistence is not confirmed by this panel.';
    nodes.identities.replaceChildren();
    const ids = {Robot: view?.robot_id, Attempt: view?.identity.attempt_id, 'Published run': view?.identity.public_run_id,
      Episode: view?.identity.episode_id, Recording: view?.identity.recording_run_id, 'ClawMetry trace': view?.recording.trace_id};
    for (const [label, value] of Object.entries(ids)) if (value) { add(nodes.identities, 'dt', label); add(nodes.identities, 'dd', value); }
    nodes.cursor.max = String(Math.max(0, samples.length - 1)); nodes.cursor.value = String(selected); nodes.cursor.disabled = samples.length < 2;
    nodes.follow.disabled = following || !samples.length; nodes.download.disabled = !samples.length;
    nodes.history.textContent = samples.length ? (following ? 'Newest received evidence. ' : 'History paused. ') + samples.length + ' changed snapshots retained, up to 80. Download covers this browser window only.' : 'No browser evidence received yet.';
  }
  // --- Move log tab -------------------------------------------------------
  // The tab strip, its panels and hosted.js are upstream's. We add one button
  // and one panel at runtime and never edit either file, so an upstream merge
  // cannot conflict with this. Our own click handler does the whole job, and
  // the upstream `yam:conversation-mode` event is used only to fix up after
  // upstream's generic handler has also run for our button.
  const MODE = 'clawmetry';
  let tab, tabButton, tabNodes, assessmentLocation = null, reviewExpanded = false;
  // Select the optional integration once. Subsequent status polls preserve
  // the visitor's explicit tab and open/closed panel choices.

  function setPressed(active) {
    for (const button of document.querySelectorAll('[data-conversation-mode]')) {
      button.setAttribute('aria-pressed', String(button === active));
    }
  }
  function showMotion(show) {
    if (!show) setReviewExpanded(false);
    if (tab) tab.hidden = !show;
    placeAssessment(show);
    const conversation = document.getElementById('liveConversationPanel');
    const visitors = document.getElementById('visitorChatPanel');
    if (show) {
      if (conversation) conversation.hidden = true;
      if (visitors) visitors.hidden = true;
      const layout = (conversation || tab)?.closest('.watchLayout');
      if (layout) layout.classList.remove('conversationClosed');
      renderMotion();
    }
  }
  function setReviewExpanded(expanded) {
    if (!tab || !tabNodes?.expand) return;
    reviewExpanded = expanded === true;
    if (reviewExpanded) tab.classList.add('cm-review-expanded');
    else {
      tab.classList.remove('cm-review-expanded');
      // CSS resizing writes inline dimensions. Restore the embedded layout
      // without rebuilding the editor or losing its draft and scroll state.
      tab.style.removeProperty('width'); tab.style.removeProperty('height');
    }
    tabNodes.expand.textContent = reviewExpanded ? 'Reduce review' : 'Expand review';
    tabNodes.expand.setAttribute('aria-expanded', String(reviewExpanded));
    tabNodes.resizeHint.hidden = !reviewExpanded;
    tabNodes.tools.hidden = !reviewExpanded;
  }
  function buildTab() {
    if (tab || document.getElementById('clawmetryMotionPanel')) return;
    const strip = document.querySelector('.conversationModes');
    const conversation = document.getElementById('liveConversationPanel');
    if (!strip || !conversation) return;
    tabButton = document.createElement('button');
    tabButton.type = 'button';
    tabButton.dataset.conversationMode = MODE;
    tabButton.id = 'clawmetryMotionTab';
    tabButton.textContent = 'ClawMetry';
    tabButton.setAttribute('aria-pressed', 'false');
    tabButton.setAttribute('aria-controls', 'clawmetryMotionPanel');
    strip.append(tabButton);
    tabButton.addEventListener('click', () => {
      setPressed(tabButton); showMotion(true);
      // The optional button may mount after upstream's static listener list.
      // Publish the native mode so Visitor chat can return to this selection.
      if (typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent('yam:conversation-mode', {detail:{mode:MODE,source:tabButton}}));
    });

    tab = document.createElement('section');
    tab.id = 'clawmetryMotionPanel';
    tab.className = 'panel cm-motion-panel';
    tab.hidden = true;
    tab.tabIndex = -1;
    tab.setAttribute('aria-label', 'ClawMetry run review');
    // Collaboration lockup: ClawMetry's own mark beside BluPe's wordmark, in
    // BluPe's own type. The wordmark uses a light foreground on this dark pane.
    const brand = add(tab, 'div', '', 'cm-brand');
    brand.setAttribute('role', 'img');
    brand.setAttribute('aria-label', 'ClawMetry and BluPe');
    const mark = add(brand, 'img', '', 'cm-brand-mark');
    mark.src = '/static/clawmetry-logo.svg';
    mark.alt = '';
    mark.setAttribute('aria-hidden', 'true');
    add(brand, 'span', '×', 'cm-brand-x').setAttribute('aria-hidden', 'true');
    add(brand, 'span', 'BluPe', 'cm-brand-blupe').setAttribute('aria-hidden', 'true');
    const header = add(tab, 'div', '', 'statusHeader');
    add(header, 'h2', 'Live activity');
    tabNodes = {state:null};
    tabNodes.phase=add(header,'span','No active run','cm-run-phase');tabNodes.phase.id='cm-run-phase';
    tabNodes.phase.setAttribute('role','status');tabNodes.phase.setAttribute('aria-live','polite');
    tabNodes.detail = add(header, 'a', 'Review run ↗', 'cm-motion-detail');
    tabNodes.detail.target = '_blank'; tabNodes.detail.rel = 'noopener noreferrer'; tabNodes.detail.hidden = true;
    const sessions=add(header,'a','Sessions','cm-sessions-link');sessions.href='/clawmetry/';
    tabNodes.outcome=add(tab,'section','','cm-run-outcome');tabNodes.outcome.id='cm-run-outcome';
    tabNodes.outcome.setAttribute('aria-label','Recorded run outcome');
    tabNodes.outcomeContext=add(tabNodes.outcome,'p','Recorded robot run','cm-outcome-context');tabNodes.outcomeContext.id='cm-run-outcome-context';
    tabNodes.outcomeTitle=add(tabNodes.outcome,'h3','Unverified');tabNodes.outcomeTitle.id='cm-run-outcome-title';
    tabNodes.outcomeTitle.setAttribute('role','status');tabNodes.outcomeTitle.setAttribute('aria-live','polite');
    tabNodes.outcomeDetail=add(tabNodes.outcome,'p','No run outcome is recorded.');tabNodes.outcomeDetail.id='cm-run-outcome-detail';
    tabNodes.outcomeRule=add(tabNodes.outcome,'p','','cm-outcome-rule');tabNodes.outcomeRule.id='cm-run-outcome-rule';
    const tools = add(tab, 'div', '', 'cm-review-tools');
    tabNodes.tools=tools;tools.hidden=true;
    tabNodes.expand = add(tools, 'button', 'Expand review', 'cm-review-expand');
    tabNodes.expand.id = 'cm-expand-review'; tabNodes.expand.type = 'button';
    tabNodes.expand.setAttribute('aria-controls', tab.id);
    tabNodes.expand.setAttribute('aria-expanded', 'false');
    tabNodes.expand.addEventListener('click', () => setReviewExpanded(!reviewExpanded));
    tab.append(tabNodes.expand);
    tabNodes.resizeHint = add(tools, 'span', 'Drag the lower-right corner to resize. Esc to reduce.', 'cm-resize-hint');
    tabNodes.resizeHint.hidden = true;
    tab.addEventListener('keydown', event => {
      if (reviewExpanded && event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setReviewExpanded(false);
        tabNodes.expand.focus({preventScroll:true});
      }
    });
    const scroll = add(tab, 'div', '', 'cm-trust-scroll'); scroll.id = 'cm-trust-scroll';
    // Keep Expand reachable in short panels; the result leads the scroll body.
    scroll.append(tabNodes.outcome);
    scroll.tabIndex = 0; scroll.setAttribute('aria-label','Run review and robot rules');
    tabNodes.detailNote = add(scroll, 'p', '', 'cm-motion-detail-note'); tabNodes.detailNote.hidden = true;
    const editor = add(scroll,'div','','cm-guard-editor-slot'); editor.id='cm-guard-editor-slot';
    const activity=add(scroll,'section','','cm-recent-section');activity.setAttribute('aria-label','Live robot activity');
    tabNodes.liveTask=add(activity,'p','','cm-live-task');
    const guide=add(activity,'div','','cm-activity-guide');guide.setAttribute('aria-label','Follow model calls, Guard decisions and robot feedback');
    for(const label of ['Model calls','Guard','Robot feedback'])add(guide,'span',label);
    tabNodes.modelUpdate=add(activity,'section','','cm-model-update');tabNodes.modelUpdate.hidden=true;
    tabNodes.modelUpdate.setAttribute('aria-label','Latest shared model update');
    tabNodes.modelTitle=add(tabNodes.modelUpdate,'strong');tabNodes.modelDetail=add(tabNodes.modelUpdate,'p');
    tabNodes.guardNotice=add(activity,'div','','cm-guard-notice');tabNodes.guardNotice.hidden=true;
    tabNodes.guardNoticeTitle=add(tabNodes.guardNotice,'strong');
    tabNodes.guardNoticeDetail=add(tabNodes.guardNotice,'p');
    tabNodes.recent = add(activity,'ol','','cm-recent-events');tabNodes.recent.id='cm-recent-events';
    tabNodes.recent.setAttribute('aria-label','Recent robot activity');
    tabNodes.activityNote=add(activity,'p','Reported updates. Task success is verified separately.','cm-activity-note');tabNodes.activityNote.hidden=true;
    tabNodes.empty = add(activity,'p','','cm-activity-empty');
    scroll.append(editor);
    const technical=add(scroll,'details','','cm-technical-activity');technical.id='cm-technical-activity';
    tabNodes.technicalSummary=add(technical,'summary','Details');
    const overview = add(technical,'section','','cm-run-summary'); overview.id='cm-run-summary';
    overview.setAttribute('aria-label','Recorded run summary');
    tabNodes.state = add(overview,'h3','No active run','cm-run-state');
    tabNodes.task = add(overview,'p','','cm-run-task');
    tabNodes.explanation = add(overview,'p','','cm-trust-explanation');
    const facts = add(overview,'dl','','cm-trust-facts');
    for(const [key,label] of [['guard','Guard'],['recording','Recording'],['request','Requested'],['measured','Measured']]) {
      add(facts,'dt',label);tabNodes[key]=add(facts,'dd');
    }
    tabNodes.guard.id='cm-guard-state';
    tabNodes.guardDetail=add(overview,'p','','cm-guard-explanation');
    tabNodes.scope=add(technical,'p','','help');
    tabNodes.list=add(technical,'ol','','cm-motion-list');tabNodes.list.id='cm-technical-events';
    tabNodes.list.setAttribute('aria-label','Robot move log');
    add(technical,'p','Requests, gateway receipts and measured reports are separate evidence. A packet decision does not confirm task success or physical stopping.','cm-evidence-limits');
    build(technical);
    tabNodes.assessment=add(scroll,'section','','cm-operator-assessment');tabNodes.assessment.id='cm-operator-assessment';tabNodes.assessment.hidden=true;
    add(tabNodes.assessment,'p','Your assessment is separate from the recorded evidence.','cm-assessment-caption');
    conversation.insertAdjacentElement('afterend', tab);
    document.getElementById('meetingClosePanel')?.addEventListener('click', () => setReviewExpanded(false));
    renderTrust();
    if (typeof CustomEvent === 'function') document.dispatchEvent(new CustomEvent('clawmetry:panel-ready'));

    // Upstream's handler also fires for our button and would re-show its own
    // panel; it dispatches this event last, so we settle the state here.
    document.addEventListener('yam:conversation-mode', event => {
      const mode = event.detail && event.detail.mode;
      if (mode === MODE) showMotion(true); else showMotion(false);
    });
    window.ClawmetryRoom?.mount();
    tabButton.click();
    const activityButton=document.getElementById('meetingNotes');
    if (activityButton?.getAttribute('aria-expanded')==='false') {
      const focused=document.activeElement;
      activityButton.click();
      if (focused && focused!==document.body) focused.focus?.({preventScroll:true});
    }
  }
  function renderDetailLink() {
    if (!tabNodes) return;
    const view = store.latest;
    const path = typeof view?.detail_path === 'string' && /^\/clawmetry\/trace\/[0-9a-f]{32}$/.test(view.detail_path) ? view.detail_path : null;
    // A finished run's trace is still served, so when nothing is live the
    // reader's own last run is offered instead -- labelled as the past run it
    // is, never dressed up as the run the station is showing.
    const recent = !path && view && view.recent_detail ? view.recent_detail : null;
    const target = path || (recent ? recent.path : null);
    tabNodes.detail.hidden = !target;
    tabNodes.detailNote.hidden = !!target;
    if (target) {
      tabNodes.detail.href = target;
      const live=path&&['running','preparing','queued'].includes(view?.run?.status);
      tabNodes.detail.textContent = admission.current() ? 'Previous run \u2197' : live ? 'Open live trace \u2197' : path ? 'Open run \u2197' : 'Last run \u2197';
      tabNodes.detail.title = admission.current() ? 'This opens a previous robot run. The current request was not queued.' : path ? '' :
        'The run this station is showing now is not yours. This opens the last run you started'
        + (recent && recent.task ? ': ' + recent.task : '.');
      tabNodes.detailNote.textContent = '';
    } else {
      tabNodes.detail.removeAttribute('href');
      tabNodes.detail.textContent = 'Review run \u2197';
      tabNodes.detail.title = '';
      tabNodes.detailNote.textContent = '';
      tabNodes.detailNote.hidden = true;
    }
  }
  function placeAssessment(show) {
    const assessment=document.getElementById('liveAssessment');
    if (!tabNodes?.assessment || !assessment) return;
    const parent=assessment.parentElement || assessment.parent;
    if (show) {
      if (parent!==tabNodes.assessment) {
        assessmentLocation={node:assessment,parent,next:assessment.nextSibling || null};
        tabNodes.assessment.append(assessment);
      }
      tabNodes.assessment.hidden=assessment.hidden===true;
    } else if (!show && assessmentLocation && parent===tabNodes.assessment) {
      const original=assessmentLocation;
      if (original.next && (original.next.parentElement || original.next.parent)===original.parent) original.parent.insertBefore(assessment,original.next);
      else original.parent.append(assessment);
      assessmentLocation=null;tabNodes.assessment.hidden=true;
    }
  }
  function renderTrust() {
    if (!tabNodes) return;
    const view=store.latest, rows=store.motion, summary=runSummary(view,rows,{disconnected});
    const current=runSummary(view,rows,{disconnected,currentRunOnly:true});
    tabNodes.phase.textContent=current.title;tabNodes.phase.title=current.detail;
    const local=admission.current(), outcome=local || current.outcome;
    const hasRun=view?.run?.present===true;
    const ended=['stopped','complete','completed','resetting','failed','timed_out','safety_aborted'].includes(view?.run?.status);
    tabNodes.outcome.hidden=!(local || hasRun&&(ended||outcome.category==='blocked'||outcome.category==='failed'));
    tabNodes.outcomeContext.textContent=local?local.context:'Recorded robot run';
    tabNodes.outcome.setAttribute('aria-label',local?'Current request outcome':'Recorded run outcome');
    if(local) {tabNodes.phase.textContent='Request blocked before model';tabNodes.phase.title=local.detail;}
    tabNodes.outcome.dataset.outcome=outcome.category;tabNodes.outcomeTitle.textContent=outcome.title;
    tabNodes.outcomeDetail.textContent=outcome.detail;tabNodes.outcomeRule.textContent=outcome.rule||'';
    tabNodes.outcomeRule.hidden=!outcome.rule;
    tabNodes.state.textContent=(local?'Previous robot run · ':'')+summary.title;
    tabNodes.task.textContent=view?.run?.task || (view?.run?.present ? 'Task text is not shared with this viewer.' : 'Start a task from the normal Run controls when you are ready.');
    tabNodes.task.title=view?.run?.task || '';
    tabNodes.explanation.textContent=store.motionSource && store.motionSource!=='station_journal' ? MOTION_SOURCE_TEXT[store.motionSource] : summary.detail;
    const guard=guardSummary(view);tabNodes.guard.textContent=guard.title;tabNodes.guard.dataset.state=guard.tone;tabNodes.guardDetail.textContent=guard.detail;
    tabNodes.liveTask.textContent=local?'Current request was not queued.':hasRun?(view.run.task||'Task text is private.'):'Ready when you are';
    tabNodes.liveTask.hidden=!hasRun&&!local;
    const recordedGuard=recordedOutcomeGuard(view);
    tabNodes.guardNotice.hidden=!!local||!recordedGuard||outcome.category==='blocked'||outcome.category==='failed';
    tabNodes.guardNotice.dataset.state=guard.tone;
    tabNodes.guardNoticeTitle.textContent=recordedGuard?.state==='configured'?'Waiting for the first Guard check':guard.title;
    tabNodes.guardNoticeDetail.textContent=recordedGuard?.state==='decision_recorded'?guard.detail:'';
    const persistence=view?.trust?.schema==='clawmetry.trust.v1' ? view.trust.persistence : null;
    const sequence=persistence?.through_sequence;
    tabNodes.recording.textContent=persistence?.state==='confirmed'&&Number.isSafeInteger(sequence)&&sequence>0
      ? 'Saved in ClawMetry'+(Number.isSafeInteger(sequence)&&sequence>=0?' through event '+sequence:'')
      : ({recording:'Journal recording; storage not confirmed',closed:'Journal closed; storage not confirmed',disabled:'Recording disabled',incomplete:'Recording incomplete',unavailable:'Recording unavailable'}[view?.recording?.state] || 'Recording not confirmed');
    const request=[...(view?.events || [])].reverse().find(event=>event.tools.length);
    tabNodes.request.textContent=request ? requestedAction(request) : 'No action request shared in this view.';
    const fresh=freshness(view),measurement=view?.measurement;
    tabNodes.measured.textContent=measurement
      ? (measurement.observation_kind==='station'?'Station feedback':'Session feedback')+' · '+ageLabel(fresh.age_s)+(measurement.ready===false?' · source reports not ready':measurement.settled===true?' · source reports settled':'')
      : 'No measured feedback received.';
    const modelUpdate=window.ClawmetryActivity?.modelUpdate(view);
    tabNodes.modelUpdate.hidden=!!local||!modelUpdate;
    tabNodes.modelTitle.textContent=modelUpdate?.title||'';tabNodes.modelDetail.textContent=modelUpdate?.detail||'';
    const motionModel=view?.motion?.run_id&&view.motion.run_id===view?.identity?.recording_run_id?view?.run?.model:null;
    const readable=window.ClawmetryActivity?.motionEntries(rows,motionModel);
    const entries=Array.isArray(readable)?readable:summary.recent.slice().reverse().map(row=>({...row,category:'status',title:motionText(row)||'Recorded update',detail:''}));
    const follow=tabNodes.recent.scrollHeight-tabNodes.recent.scrollTop-tabNodes.recent.clientHeight<80;
    tabNodes.recent.hidden=!!local;
    const activitySignature=JSON.stringify(entries);
    if(activitySignature!==tabNodes.activitySignature){
      tabNodes.activitySignature=activitySignature;
      const categories={model:'Model',input:'Camera & sensors',command:'Motion',execution:'Robot gateway',feedback:'Feedback',status:'Runner',issue:'Attention'};
      tabNodes.recent.replaceChildren(...entries.map(row=>{
        const item=document.createElement('li');item.dataset.kind=row.kind;item.dataset.category=row.category;
        add(item,'span',categories[row.category]||'Reported update','cm-activity-actor');
        add(item,'strong',row.title,'cm-activity-title');add(item,'span',row.detail,'cm-activity-detail');
        const stamp=add(item,'time',new Date(row.t*1000).toLocaleTimeString());stamp.dateTime=new Date(row.t*1000).toISOString();return item;
      }));
      if(follow)tabNodes.recent.scrollTop=tabNodes.recent.scrollHeight;
    }
    tabNodes.activityNote.hidden=!!local||!entries.length;
    tabNodes.empty.textContent=local?'Edit the task, then send it again.':disconnected?'Waiting to reconnect. Reload the page if this continues.':hasRun?'Waiting for the next robot update…':'Send a task to follow model calls, Guard decisions and robot feedback here.';
    tabNodes.empty.hidden=(entries.length>0||!!modelUpdate)&&!local;
    if(tab && !tab.hidden)placeAssessment(true);
  }
  function renderMotion() {
    renderDetailLink();
    if (!tab || tab.hidden) return;
    const rows = store.motion, source = store.motionSource;
    tabNodes.scope.textContent = MOTION_SOURCE_TEXT[source] ||
      'No run is published on this station yet. The move log fills as soon as one starts.';
    tabNodes.technicalSummary.textContent = 'Trace details' + (rows.length ? ' · '+rows.length+' records' : '');
    const follow = tabNodes.list.scrollHeight - tabNodes.list.scrollTop - tabNodes.list.clientHeight < 80;
    tabNodes.list.replaceChildren(...rows.map(row => {
      const item = document.createElement('li');
      item.dataset.kind = row.kind;
      const time = document.createElement('time');
      time.textContent = new Date(row.t * 1000).toLocaleTimeString();
      item.append(time);
      add(item, 'span', motionText(row) || row.kind.replaceAll('_', ' '), 'cm-motion-text');
      const numbers = motionNumbers(row);
      if (numbers) add(item, 'span', numbers, 'cm-motion-numbers');
      return item;
    }));
    if (follow) tabNodes.list.scrollTop = tabNodes.list.scrollHeight;
  }

  const observer = {
    observe(view) { if (!view || view.schema !== 'yam.telemetry.v1') return; const before = store.latest && identity(store.latest); store.update(view); const moved = store.updateMotion(view); if (before !== identity(view)) { following = true; if(before)admission.clear(); } disconnected = false; buildTab(); render(); if (moved) renderMotion(); else renderDetailLink(); },
    reset() { admission.clear(); store.clear(); following = true; disconnected = false; render(); renderMotion(); },
    connection(view) { if (!store.latest || store.latest.robot_id === view.robot_id) { disconnected = true; render(); } },
  };
  window.yamTelemetry = observer;
  for(const [name,action] of [['yam:run-submitting','start'],['yam:run-accepted','accept'],['yam:run-rejected','reject'],['yam:run-cleared','clear']]) {
    window.addEventListener(name,event=>{const verified=admission[action](event.detail);buildTab();render();renderDetailLink();
      if(action==='reject' && verified && tabButton){tabButton.click();const body=document.getElementById('cm-trust-scroll');if(body)body.scrollTop=0;}
    });
  }
  window.addEventListener('blupe-robot-selected', () => { setReviewExpanded(false); observer.reset(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  let clock = null;
  function startClock() { if (clock === null) clock = setInterval(() => { if (!document.hidden) render(); }, 1000); }
  window.addEventListener('pageshow', startClock);
  window.addEventListener('pagehide', () => { admission.clear(); setReviewExpanded(false); clearInterval(clock); clock = null; });
  startClock();
  const start = () => { buildTab(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true}); else start();
})();
