/* Optional embedded evidence panel. The existing runner remains authoritative. */
(() => {
  'use strict';
  function identity(view) {
    const ids = view.identity || {};
    return JSON.stringify([view.robot_id, view.scope, ids.attempt_id, ids.public_run_id, ids.episode_id]);
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
        if (!next) return false;
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
    packet_accepted: row => 'Safety checks passed; executing the packet',
    packet_progress: row => 'Executing waypoint ' + counted(row.progress_count, '?') + ' of ' + counted(row.waypoint_count, '?'),
    packet_completed: row => 'Completed ' + counted(row.waypoint_count, 'the') + ' waypoints; arms settled',
    packet_error: row => 'Packet ' + (row.status || 'failed') + (row.code ? ' · ' + row.code : '') +
      (Number.isSafeInteger(row.reported_progress) ? ' after ' + row.reported_progress + ' waypoints' : ''),
    execution_timing: row => 'Robot execution took ' + (seconds(row.elapsed_s) || 'an unreported time'),
    step_timing: row => 'Step ' + counted(row.step, '?') + ' took ' + (seconds(row.total_s) || 'an unreported time'),
    observation: row => 'Measured arm feedback received',
    tool_result: row => Number.isSafeInteger(row.steps) ? 'Completed ' + row.steps + ' waypoints; feedback ready for the next call'
      : 'Policy outcome: ' + (row.status || 'reported'),
    tool_error: row => 'No motion sent' + (row.code ? ' · ' + row.code : ''),
    policy_timing: row => 'Policy stage ' + (row.stage || 'unnamed') + ' ' + (row.state || 'reported') +
      (seconds(row.duration_s) ? ' · ' + seconds(row.duration_s) : ''),
    model_timing: row => 'Model stage ' + (row.stage || 'unnamed') + ' ' + (row.state || 'reported') +
      (seconds(row.duration_s) ? ' · ' + seconds(row.duration_s) : ''),
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
      if (Array.isArray(row[name]) && row[name].length) parts.push(name + ' ' + degrees(row[name]));
    }
    return parts.join(' · ');
  }
  const MOTION_SOURCE_TEXT = {
    station_journal: 'Live from this station’s run journal. Every packet, waypoint and measured report on this station, whether or not its conversation is shared.',
    remote_host: 'This run is executing on another host. Its move journal is not readable from this station, so no timeline is shown rather than an empty one.',
    unavailable: 'The station run journal could not be read for this run. This is a gap in the log, not an idle robot.',
  };

  const api = {createStore, freshness, requestedAction, receiptText, identity, motionText, motionNumbers, motionKey};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ClawmetryWidget = api;
  if (typeof document === 'undefined') return;

  const store = createStore();
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
  let tab, tabButton, tabNodes;
  // The move log is the default view, selected once upstream has wired its own
  // strip. `choosing` distinguishes our own programmatic selection from a
  // visitor's, so a visitor who picks another tab is never overridden.
  let defaultApplied = false, visitorChose = false, choosing = false;
  function applyDefaultMode() {
    if (defaultApplied || visitorChose || !tabButton) return;
    defaultApplied = true;
    choosing = true;
    try { tabButton.click(); } finally { choosing = false; }
  }

  function setPressed(active) {
    for (const button of document.querySelectorAll('[data-conversation-mode]')) {
      button.setAttribute('aria-pressed', String(button === active));
    }
  }
  function showMotion(show) {
    if (tab) tab.hidden = !show;
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
    tabButton.addEventListener('click', () => { setPressed(tabButton); showMotion(true); });

    tab = document.createElement('section');
    tab.id = 'clawmetryMotionPanel';
    tab.className = 'panel cm-motion-panel';
    tab.hidden = true;
    tab.tabIndex = -1;
    tab.setAttribute('aria-label', 'ClawMetry move log');
    // Collaboration lockup: ClawMetry's own mark beside BluPe's wordmark, in
    // BluPe's own type. Neither brand is redrawn or recoloured.
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
    add(header, 'h2', 'Move log');
    tabNodes = {state: add(header, 'span', 'Waiting for a run', 'tag')};
    // A control that cannot work must say why rather than quietly do nothing,
    // so the link only appears once the server supplies a detail path for the
    // displayed run, and the note beside it explains the usual reason it has not.
    tabNodes.detail = add(header, 'a', 'Open detailed view ↗', 'cm-motion-detail');
    tabNodes.detail.target = '_blank';
    tabNodes.detail.rel = 'noopener noreferrer';
    tabNodes.detail.hidden = true;
    tabNodes.detailNote = add(header, 'span', '', 'cm-motion-detail-note');
    tabNodes.detailNote.hidden = true;
    tabNodes.scope = add(tab, 'p', '', 'help');
    tabNodes.list = add(tab, 'ol', '', 'cm-motion-list');
    tabNodes.list.tabIndex = 0;
    tabNodes.list.setAttribute('aria-label', 'Robot move log');
    tabNodes.list.setAttribute('aria-live', 'polite');
    tabNodes.list.setAttribute('aria-relevant', 'additions');
    tabNodes.empty = add(tab, 'p', '', 'help');
    add(tab, 'p', 'Packets, waypoints and measured reports from the station’s own run journal. ' +
      'Model notes and prompts are not shown here and keep their separate sharing choice. ' +
      'A reported waypoint is what the gateway said; it does not by itself confirm the arm moved.', 'cm-evidence-limits');
    // The published-run evidence lives here as a section, not as a second panel.
    build(tab);
    conversation.insertAdjacentElement('afterend', tab);

    // Upstream's handler also fires for our button and would re-show its own
    // panel; it dispatches this event last, so we settle the state here.
    document.addEventListener('yam:conversation-mode', event => {
      const mode = event.detail && event.detail.mode;
      // A selection we did not make is the visitor's; never override it later.
      if (!choosing) { visitorChose = true; defaultApplied = true; }
      if (mode === MODE) showMotion(true); else showMotion(false);
    });
    // Upstream wires the strip from its own deferred script, so select the
    // default after this task rather than during construction.
    setTimeout(applyDefaultMode, 0);
  }
  function renderDetailLink() {
    if (!tabNodes) return;
    const view = store.latest;
    const path = typeof view?.detail_path === 'string' && /^\/clawmetry\/trace\/[0-9a-f]{32}$/.test(view.detail_path) ? view.detail_path : null;
    tabNodes.detail.hidden = !path;
    tabNodes.detailNote.hidden = !!path;
    if (path) { tabNodes.detail.href = path; tabNodes.detailNote.textContent = ''; }
    else {
      tabNodes.detail.removeAttribute('href');
      tabNodes.detailNote.textContent = 'Detailed view available to the browser that launched the run, when detailed capture was chosen for it.';
    }
  }
  function renderMotion() {
    renderDetailLink();
    if (!tab || tab.hidden) return;
    const rows = store.motion, source = store.motionSource;
    tabNodes.scope.textContent = MOTION_SOURCE_TEXT[source] ||
      'No run is published on this station yet. The move log fills as soon as one starts.';
    tabNodes.state.textContent = !source ? 'Waiting for a run'
      : source === 'station_journal' ? rows.length + ' entries' : 'Not available here';
    tabNodes.empty.textContent = rows.length ? ''
      : source === 'station_journal' ? 'No moves recorded for this run yet.' : '';
    tabNodes.empty.hidden = !tabNodes.empty.textContent;
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
    observe(view) { if (!view || view.schema !== 'yam.telemetry.v1') return; const before = store.latest && identity(store.latest); store.update(view); const moved = store.updateMotion(view); if (before !== identity(view)) following = true; disconnected = false; buildTab(); applyDefaultMode(); render(); if (moved) renderMotion(); else renderDetailLink(); },
    reset() { store.clear(); following = true; disconnected = false; render(); renderMotion(); },
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
  const start = () => { buildTab(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true}); else start();
})();
