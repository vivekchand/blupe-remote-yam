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
      if (!['model_request', 'model_response', 'model_progress'].includes(kind)) continue;
      if (kind === 'model_progress' && !['summary', 'status'].includes(row.progress_type)) continue;
      const identity = id(typeof row.id === 'number' ? String(row.id) : row.id);
      if (!identity || !finite(row.timestamp) || row.timestamp <= 0) continue;
      const calls = kind === 'model_response' ? toolCalls(row.message) : [];
      out.push({id: identity, timestamp_s: row.timestamp, kind,
        note: kind === 'model_request' ? 'Model request sent.' : calls.length ? calls.map(call => call.note).filter(Boolean).join('\n').slice(0, 2000) || null : text(row.message),
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
    'feedback_check', 'feedback_timeout', 'reconnecting'];
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
    const same = id(detail.attempt_id) && id(displayed.attempt_id) ? detail.attempt_id === displayed.attempt_id
      : id(detail.public_run_id) && id(displayed.run_id) ? detail.public_run_id === displayed.run_id
      : !!(id(detail.episode_id) && detail.episode_id === id(displayed.episode_id));
    return same ? detail.path : null;
  }
  function project(input, options = {}) {
    const state = object(input), metadata = object(state.telemetry), candidate = object(state.public_run);
    const displayed = object(options.displayed_identity);
    const sameDisplayed = id(displayed.attempt_id) && id(candidate.attempt_id) ? displayed.attempt_id === candidate.attempt_id
      : id(displayed.run_id) && id(candidate.run_id) ? displayed.run_id === candidate.run_id
      : !!(id(displayed.episode_id) && displayed.episode_id === id(candidate.episode_id));
    const shared = metadata.public_run_shared === true && sameDisplayed;
    const run = shared ? candidate : {}, robot = id(options.robot_id);
    const attempt = id(run.attempt_id), episode = id(run.episode_id), publicRun = id(run.run_id);
    const ownAttempt = id(state.attempt_id), ownEpisode = id(state.episode_id);
    const matchesOwn = !!(shared && (attempt && ownAttempt ? attempt === ownAttempt
      : ownEpisode && (episode === ownEpisode || publicRun === ownEpisode)));
    const recording = matchesOwn ? object(metadata.recording) : {}, trajectory = matchesOwn ? object(state.trajectory) : {};
    const metrics = matchesOwn ? object(state.run_metrics) : {};
    const receiptStates = ['prepared', 'submitted', 'dispatched', 'accepted', 'running', 'executing', 'completed', 'failed', 'stopped', 'pending', 'recovering'];
    const phase = ['idle', 'queued', 'preparing', 'running', 'stopped', 'completed', 'failed', 'disconnected', 'safety_aborted', 'timed_out'];
    return freeze({schema: 'yam.telemetry.v1', robot_id: robot,
      received_at_s: finite(options.received_at_s) ? options.received_at_s : Date.now() / 1000,
      scope: shared ? 'shared_public_run' : 'not_shared',
      detail_path: detailPath(metadata, displayed),
      identity: {attempt_id: attempt, public_run_id: publicRun, episode_id: episode,
        recording_run_id: shared && matchesOwn ? id(object(state.interactions).run_id) : null,
        session_id: matchesOwn ? id(state.session_id) : null},
      run: {present: !!(id(displayed.attempt_id) || id(displayed.run_id) || id(displayed.episode_id)),
        task: text(run.task), model: text(run.model_name, 120), status: phase.includes(run.status) ? run.status : null},
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
  const api = {project, toolCalls, measurement, text, detailPath, motion, motionRow};
  if (typeof window !== 'undefined') window.YamTelemetryStatus = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
