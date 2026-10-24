/* Optional embedded evidence panel. The existing runner remains authoritative. */
(() => {
  'use strict';
  function identity(view) {
    const ids = view.identity || {};
    return JSON.stringify([view.robot_id, view.scope, ids.attempt_id, ids.public_run_id, ids.episode_id]);
  }
  function createStore() {
    let key = null, samples = [], events = new Map(), signature = null, latest = null;
    return {
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
      clear() { key = signature = latest = null; samples = []; events.clear(); },
      get samples() { return samples.slice(); },
      get latest() { return latest; },
      export() { return {schema: 'yam.telemetry.browser.v1', exported_at_s: Date.now() / 1000,
        coverage: 'This browser window only. A recording receipt does not confirm durable daemon ingestion.',
        events: [...events.values()], samples: samples.slice()}; },
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
  const api = {createStore, freshness, requestedAction, receiptText, identity};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ClawmetryWidget = api;
  if (typeof document === 'undefined') return;

  const store = createStore();
  let root, summaryState, nodes, following = true, selected = 0, disconnected = false;
  const add = (parent, tag, content, className) => {
    const node = document.createElement(tag); if (content) node.textContent = content;
    if (className) node.className = className; parent.append(node); return node;
  };
  function build() {
    if (root || document.getElementById('clawmetryEvidence')) return;
    // The camera/chat grid has a viewport-sized height. A disclosure inside it
    // would grow over run history instead of increasing the document's height.
    const anchor = document.querySelector('.watchLayout') || document.querySelector('.runnerContent');
    if (!anchor) return;
    root = document.createElement('details'); root.id = 'clawmetryEvidence'; root.className = 'cm-evidence-widget';
    const summary = add(root, 'summary');
    add(summary, 'strong', 'ClawMetry'); add(summary, 'span', 'Run evidence', 'cm-evidence-title');
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
    if (anchor.classList.contains('watchLayout')) anchor.insertAdjacentElement('afterend', root); else anchor.append(root);
    root.addEventListener('toggle', render); render();
  }
  function ageLabel(value) { return value === null ? 'Source time unknown' : value < 60 ? value + 's ago' : Math.floor(value / 60) + 'm ago'; }
  function render() {
    if (!root) return;
    const samples = store.samples, latest = store.latest;
    if (following) selected = Math.max(0, samples.length - 1);
    else selected = Math.max(0, Math.min(samples.length - 1, selected));
    const view = samples[selected] || latest;
    const fresh = freshness(following ? latest : view);
    summaryState.dataset.state = disconnected ? 'stale' : fresh.state;
    summaryState.textContent = disconnected ? 'Runner reconnecting' : latest ? (following ? 'Report ' : 'Recorded report ') + ageLabel(fresh.age_s) : 'Waiting for reports';
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
  const observer = {
    observe(view) { if (!view || view.schema !== 'yam.telemetry.v1') return; const before = store.latest && identity(store.latest); store.update(view); if (before !== identity(view)) following = true; disconnected = false; build(); render(); },
    reset() { store.clear(); following = true; disconnected = false; render(); },
    connection(view) { if (!store.latest || store.latest.robot_id === view.robot_id) { disconnected = true; render(); } },
  };
  window.yamTelemetry = observer;
  window.addEventListener('blupe-robot-selected', () => observer.reset());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
  let clock = null;
  function startClock() { if (clock === null) clock = setInterval(() => { if (!document.hidden) render(); }, 1000); }
  window.addEventListener('pageshow', startClock);
  window.addEventListener('pagehide', () => { clearInterval(clock); clock = null; });
  startClock();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build, {once: true}); else build();
})();
