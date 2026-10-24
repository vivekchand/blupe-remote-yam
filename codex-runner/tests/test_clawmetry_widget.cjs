'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const test = require('node:test'), assert = require('node:assert/strict');
const projection = require('../static/telemetry-status.js');
const widget = require('../static/clawmetry-widget.js');
const hosted = fs.readFileSync(path.join(__dirname, '../static/hosted.js'), 'utf8');
const widgetSource = fs.readFileSync(path.join(__dirname, '../static/clawmetry-widget.js'), 'utf8');
const notify = hosted.slice(hosted.indexOf('function notifyYamTelemetry('), hosted.indexOf('// Default to Dream'));
function state() {
  return {telemetry: {public_run_shared: true, recording: {state: 'recording', trace_id: 'trace_1'}},
    attempt_id: 'attempt_1', session_id: 'session_1', episode_id: 'episode_1', packets_submitted: 1,
    interactions: {run_id: 'run_recording', events: [{message: 'PRIVATE_OWNER_NOTES'}]},
    public_run: {run_id: 'run_recording', attempt_id: 'attempt_1', episode_id: 'episode_1', task: 'Inspect the table', model_name: 'Test model', status: 'running',
      events: [{id: 1, timestamp: 100, kind: 'model_request', message: 'PRIVATE_SYSTEM_PROMPT', request: {input: 'PRIVATE_WIRE'}},
        {id: 2, timestamp: 101, kind: 'model_response', message: 'move_to: {"targets":{"left_z":0.2,"left_gripper":0.8,"foreign":"PRIVATE_TARGET"},"note":"Raise the left arm"}'}]},
    last_observation: {jetson_id: 'yam-1', type: 'station_status', source: 'simulation', observed_at: 102, mode: 'DISABLED',
      left_joints_deg: [1, 2, 3, 4, 5, 6], right_joints_deg: [-1, -2, -3, -4, -5, -6], safety: {ok: false},
      left_gripper: 0.5, lease_id: 'PRIVATE_OBSERVATION_LEASE'},
    run_metrics: {accepted_packets: 1}, trajectory: {trajectory_id: 'trajectory_1', state: 'accepted', waypoint_count: 10, progress_count: 2,
      final_observation_received: false, commands: 'PRIVATE_COMMANDS'},
    provider: {api_key: 'PRIVATE_PROVIDER_KEY', endpoint: 'PRIVATE_ENDPOINT'},
    csrf: 'PRIVATE_CSRF', lease_id: 'PRIVATE_LEASE', session_capability: 'PRIVATE_CAPABILITY'};
}
const project = (input = state(), at = 103, displayed = input?.public_run) => projection.project(input,
  {robot_id: 'yam-1', received_at_s: at, displayed_identity: displayed && {attempt_id: displayed.attempt_id, run_id: displayed.run_id, episode_id: displayed.episode_id}});

test('projection rebuilds detached bounded fields and preserves independent run identities', () => {
  const raw = state(), original = JSON.stringify(raw), view = project(raw), packed = JSON.stringify(view);
  assert.equal(view.identity.public_run_id, 'run_recording');
  assert.equal(view.identity.recording_run_id, 'run_recording');
  assert.equal(view.identity.episode_id, 'episode_1');
  assert.equal(view.identity.session_id, 'session_1');
  assert.equal(view.recording.trace_id, 'trace_1');
  assert.equal(view.measurement.source_timestamp_s, 102);
  assert.deepEqual(view.events[1].tools[0].requested_arms, ['left']);
  assert.deepEqual(view.events[1].tools[0].targets, {left_z: 0.2, left_gripper: 0.8});
  assert.equal(view.events[0].note, 'Model request sent.');
  assert.equal(view.measurement.arms.left.gripper_percent, 50);
  assert.equal(packed.includes('PRIVATE_'), false);
  assert.equal(JSON.stringify(raw), original);
  assert.ok(Object.isFrozen(view.measurement.arms.left.joints_deg));
  assert.throws(() => {view.measurement.arms.left.joints_deg[0] = 999;}, TypeError);
  assert.equal(raw.last_observation.left_joints_deg[0], 1);
});

test('model text defaults to private unless server explicitly attests public sharing', () => {
  for (const metadata of [undefined, {}, {public_run_shared: false}, {public_run_shared: 'true'}]) {
    const raw = state(); raw.telemetry = metadata;
    const view = project(raw);
    assert.equal(view.scope, 'not_shared'); assert.deepEqual(view.events, []);
    assert.equal(view.run.task, null); assert.equal(view.run.model, null);
    assert.equal(view.identity.public_run_id, null); assert.equal(view.identity.session_id, null);
    assert.equal(view.receipt, null); assert.equal(view.recording.trace_id, null);
    assert.equal(view.recording.state, 'unconfirmed');
  }
});

test('idle presence differs from an unshared task without exposing its identity', () => {
  const raw = state(); raw.telemetry.public_run_shared = false;
  const hidden = project(raw);
  assert.equal(hidden.run.present, true); assert.equal(hidden.identity.public_run_id, null);
  assert.equal(project(raw, 103, null).run.present, false);
  assert.equal(project({public_run: null}).run.present, false);
});

test('journal receipt states remain distinct from unconfirmed database persistence', () => {
  for (const status of ['waiting', 'recording', 'closed', 'incomplete', 'disabled', 'unavailable']) {
    const raw = state(); raw.telemetry.recording.state = status;
    const view = project(raw);
    assert.equal(view.recording.state, status); assert.equal(view.recording.trace_id, 'trace_1');
    assert.equal(view.recording.persistence, 'unconfirmed');
  }
  const raw = state(); raw.telemetry.recording.state = 'persisted'; raw.telemetry.recording.persistence = 'confirmed';
  assert.equal(project(raw).recording.state, 'unconfirmed');
  assert.equal(project(raw).recording.persistence, 'unconfirmed');
});

test('foreign public task never borrows owned receipt, session or recording status', () => {
  const raw = state(); raw.public_run.attempt_id = 'another_attempt'; raw.public_run.episode_id = 'another_episode';
  const view = project(raw);
  assert.equal(view.receipt, null); assert.equal(view.identity.recording_run_id, null); assert.equal(view.identity.session_id, null);
  assert.equal(view.recording.state, 'unconfirmed'); assert.equal(view.events.length, 2);
  // Even a matching episode cannot override an explicit attempt mismatch.
  raw.public_run.episode_id = raw.episode_id;
  assert.equal(project(raw).receipt, null);
});


test('new displayed attempts suppress a previous raw public run until publication catches up', () => {
  const raw = state(); raw.attempt_id = 'new_attempt';
  const view = project(raw, 103, {attempt_id: 'new_attempt'});
  assert.equal(view.scope, 'not_shared'); assert.deepEqual(view.events, []); assert.equal(view.run.task, null);
  assert.equal(project(raw, 103, null).run.task, null);
  assert.equal(projection.project(raw, {robot_id:'yam-1'}).run.task, null);
});

test('queue episode IDs remain distinct from local recording IDs', () => {
  const raw = state(); delete raw.public_run.attempt_id; delete raw.public_run.episode_id;
  raw.public_run.run_id = raw.episode_id;
  const view = project(raw);
  assert.equal(view.identity.public_run_id, 'episode_1'); assert.equal(view.identity.episode_id, null);
  assert.equal(view.identity.recording_run_id, 'run_recording'); assert.equal(view.receipt.state, 'accepted');
});

test('only public progress categories enter; known credential patterns are redacted', () => {
  const raw = state(); raw.public_run.events = [
    {id: 1, timestamp: 100, kind: 'model_progress', progress_type: 'raw_reasoning', message: 'PRIVATE_REASONING'},
    {id: 2, timestamp: 101, kind: 'model_progress', progress_type: 'summary', message: 'Visible summary Bearer credential-value'},
    {id: 3, timestamp: 102, kind: 'model_response', message: 'Published sk-verysecretcredentialvalue'},
    {id: 4, timestamp: 103, kind: 'model_request', message: 'PRIVATE_SYSTEM', request: {headers: 'PRIVATE_HEADERS'}},
  ];
  const view = project(raw), text = JSON.stringify(view);
  assert.equal(view.events.length, 3); assert.equal(text.includes('PRIVATE_'), false);
  assert.equal(text.includes('credential-value'), false); assert.equal(text.includes('sk-verysecret'), false);
  assert.ok(text.includes('Visible summary'));
});

test('malformed records and nonfinite measurements stay missing, never invented zeroes', () => {
  for (const input of [null, [], 'invalid']) assert.doesNotThrow(() => project(input));
  const raw = state(); raw.last_observation.left_joints_deg = [NaN, Infinity, true, 4];
  raw.last_observation.right_gripper = 2; raw.public_run.events = [{kind: 'model_response', id: 1, timestamp: NaN, message: 'bad'}];
  const view = project(raw);
  assert.deepEqual(view.measurement.arms.left.joints_deg, [null, null, null, 4]);
  assert.equal(view.measurement.arms.right.gripper_percent, null); assert.deepEqual(view.events, []);
  raw.last_observation.jetson_id = 'foreign_robot'; assert.equal(project(raw).measurement, null);
});

test('typed tools copy targets and public notes, never hindsight or arbitrary tool payloads', () => {
  const calls = projection.toolCalls('move_to: {"targets":{"right_x":0.2,"right_y":0.1,"left_y":null},"note":"Look at {the box}","wire":"PRIVATE"}\n\ngive_up: {"reason":"No ready hardware","hindsight":"PRIVATE_HINT"}');
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].requested_arms, ['right']);
  assert.equal(calls[0].note, 'Look at {the box}'); assert.equal(JSON.stringify(calls).includes('PRIVATE'), false);
  assert.equal(calls[1].note, 'No ready hardware'); assert.deepEqual(projection.toolCalls('move_to: {broken'), []);
});

test('requests and acknowledgments remain distinct from physical outcomes', () => {
  const view = project();
  assert.equal(view.coverage.physical_motion_confirmed, false); assert.equal(view.coverage.physical_stop_confirmed, false);
  assert.equal(widget.requestedAction(view.events[1]), 'Requested left arm targets');
  assert.ok(widget.receiptText(view.receipt).includes('Packet accepted'));
  assert.equal(widget.receiptText(null), 'No execution receipt for this published run.');
  assert.equal(widget.receiptText({}).includes('undefined'), false);
});

test('source freshness ages without polling and reception never refreshes old feedback', () => {
  const view = project(state(), 1000);
  assert.deepEqual(widget.freshness(view, 105), {state: 'fresh', age_s: 3});
  assert.deepEqual(widget.freshness(view, 200), {state: 'stale', age_s: 98});
  assert.deepEqual(widget.freshness({...view, measurement: null}, 200), {state: 'unknown', age_s: null});
  assert.deepEqual(widget.freshness(view, 90), {state: 'unknown', age_s: null});
});

test('browser history deduplicates unchanged delivery, bounds samples and resets on identity/scope', () => {
  const store = widget.createStore();
  assert.equal(store.update(project()), true); assert.equal(store.update(project(state(), 104)), false);
  assert.equal(store.samples.length, 1); assert.equal(store.export().events.length, 2);
  for (let i = 0; i < 120; i++) { const raw = state(); raw.last_observation.observed_at = 200 + i; store.update(project(raw, 201 + i)); }
  assert.equal(store.samples.length, 80);
  const other = state(); other.public_run.attempt_id = 'new_attempt'; other.episode_id = 'new_episode'; store.update(project(other));
  assert.equal(store.samples.length, 1);
  other.telemetry.public_run_shared = false; store.update(project(other));
  assert.equal(store.export().events.length, 0);
  assert.equal(JSON.stringify(store.export()).includes('Raise the left arm'), false);
  store.clear(); assert.equal(store.samples.length, 0);
});

test('history retains the most recent typed request when later progress arrives', () => {
  const store = widget.createStore(); store.update(project());
  const raw = state();
  raw.public_run.events = Array.from({length: 40}, (_, i) => ({id: i + 3, timestamp: i + 103, kind: 'model_progress', progress_type: 'summary', message: 'Progress ' + i}));
  store.update(project(raw));
  assert.ok(store.samples.at(-1).events.some(event => event.tools.length));
  for (let i = 0; i < 150; i++) { raw.public_run.events = [{id: i + 100, timestamp: i + 500, kind: 'model_response', message: 'Note ' + i}]; store.update(project(raw)); }
  assert.ok(store.export().events.length <= 96);
});

test('neutral observer is absent-safe and contains synchronous errors and promise rejections', async () => {
  let projected = 0, delivered, warnings = 0;
  const context = vm.createContext({window: {}, Promise, Object, Date, console: {warn(){warnings++;}}});
  vm.runInContext(notify, context);
  assert.doesNotThrow(() => context.notifyYamTelemetry('observe', {}));
  context.window.YamTelemetryStatus = {project(state, options){projected++;return {schema: 'safe', robot_id: options.robot_id};}};
  context.window.yamTelemetry = {observe(view){delivered = view;}};
  context.notifyYamTelemetry('observe', {state: {secret: 'not delivered raw'}, robot_id: 'yam-1'});
  assert.equal(delivered.schema, 'safe'); assert.equal(projected, 1); assert.equal(delivered.secret, undefined);
  context.window.yamTelemetry.observe = () => {throw new Error('observer failure');};
  assert.doesNotThrow(() => context.notifyYamTelemetry('observe', {state: {}, robot_id: 'yam-1'}));
  context.window.yamTelemetry.observe = () => Promise.reject(new Error('async observer failure'));
  context.notifyYamTelemetry('observe', {state: {}, robot_id: 'yam-1'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warnings, 2);
});

test('existing render/poll owns delivery and stale robot responses never notify', () => {
  const render = hosted.slice(hosted.indexOf('  function render(state)'), hosted.indexOf('  async function history()'));
  assert.equal((render.match(/notifyYamTelemetry\('observe'/g) || []).length, 1);
  assert.ok(render.indexOf("notifyYamTelemetry('observe'") > render.indexOf('    buttons();'));
  const poll = hosted.slice(hosted.indexOf("  let statusPollError ="), hosted.indexOf("  window.addEventListener('pagehide'", hosted.indexOf("  let statusPollError =")));
  const calls = [];
  const context = vm.createContext({csrf: 'valid', ended: false, runLaunchGuard: {version: 1}, lastHistory: Date.now(),
    api: async () => {throw Object.assign(new Error('stale request'), {stale: true});},
    notifyYamTelemetry: (...args) => calls.push(args), renderRobotStatus(){},$:()=>({textContent:''}),message(){},setTimeout(){},Date});
  vm.runInContext(poll, context);
  return context.poll().then(() => {assert.equal(calls.length, 0);});
});

class Element {
  constructor(tag, doc) { this.tagName = tag; this.doc = doc; this.children = []; this.dataset = {}; this.listeners = {}; this._text = ''; this.open = false;
    this.classList = {contains: value => (this.className || '').split(' ').includes(value)}; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(' '); }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  insertAdjacentElement(position, node) { assert.equal(position, 'afterend'); node.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node); }
  querySelectorAll(selector) { const out = []; for (const child of this.children) { if (child.tagName === selector) out.push(child); out.push(...child.querySelectorAll(selector)); } return out; }
}
function browserHarness() {
  const dom = {hidden: false, readyState: 'complete', listeners: {},
    createElement(tag) { return new Element(tag, this); },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    getElementById(id) { return [this.body, ...this.body.querySelectorAll('*')].find(node => node.id === id) || find(this.body, node => node.id === id); },
    querySelector(selector) { return selector === '.watchLayout' ? this.watch : selector === '.cameraFooter' ? this.footer : selector === '.runnerContent' ? this.body : null; }};
  function find(node, predicate) { if (predicate(node)) return node; for (const child of node.children) { const found = find(child, predicate); if (found) return found; } return null; }
  dom.body = new Element('div', dom); dom.body.className = 'runnerContent';
  dom.watch = new Element('div', dom); dom.watch.className = 'watchLayout';
  dom.footer = new Element('div', dom); dom.footer.className = 'cameraFooter'; dom.watch.append(dom.footer);
  dom.history = new Element('section', dom); dom.history.id = 'past-runs'; dom.body.append(dom.watch, dom.history);
  const window = {listeners: {}, addEventListener(name, fn){this.listeners[name]=fn;}};
  let network = 0, intervals = 0;
  const context = vm.createContext({window, document: dom, console, Object, Number, JSON, Map, Date, Blob, URL,
    fetch(){network++;throw new Error('Widget must not fetch');},setInterval(){intervals++;return intervals;},clearInterval(){},setTimeout(){}});
  vm.runInContext(widgetSource, context);
  return {dom, window, context, network:()=>network, intervals:()=>intervals};
}

test('embedded widget uses text nodes, does not fetch and leaves upstream camera/control nodes intact', () => {
  const {dom,window,network} = browserHarness();
  const root = dom.getElementById('clawmetryEvidence'); assert.ok(root);
  const raw = state(); raw.public_run.task = '<img src=x onerror=alert(1)>'; raw.public_run.events[1].message = '<script>bad()</script>';
  window.yamTelemetry.observe(project(raw)); root.open = true; root.listeners.toggle();
  assert.ok(root.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.ok(root.textContent.includes('<script>bad()</script>'));
  assert.equal(root.querySelectorAll('img').length, 0); assert.equal(root.querySelectorAll('script').length, 0);
  assert.equal(network(), 0);
  // The expanding panel must take normal page space outside the fixed camera/chat grid.
  assert.equal(dom.body.children.length, 3); assert.equal(dom.body.children[0], dom.watch);
  assert.equal(dom.body.children[1], root); assert.equal(dom.body.children[2], dom.history);
  assert.equal(dom.watch.children.length, 1); assert.equal(dom.watch.children[0], dom.footer);
  window.yamTelemetry.reset(); assert.ok(root.textContent.includes('No shared task supplied.'));
  assert.ok(root.textContent.includes('No task is running.'));
  raw.telemetry.public_run_shared = false; window.yamTelemetry.observe(project(raw));
  assert.ok(root.textContent.includes('Model activity is not shared for this run.'));
  window.yamTelemetry.observe(project(raw)); window.listeners['blupe-robot-selected'](); assert.ok(root.textContent.includes('No shared task supplied.'));
});

test('widget shows closed journal and independent station versus session report labels', () => {
  const {dom,window} = browserHarness(), root = dom.getElementById('clawmetryEvidence'); root.open = true;
  const raw = state(); raw.telemetry.recording.state = 'closed'; window.yamTelemetry.observe(project(raw));
  assert.ok(root.textContent.includes('ClawMetry local journal is closed.'));
  assert.ok(root.textContent.includes('Database persistence is not confirmed by this panel.'));
  assert.ok(root.textContent.includes('Latest station report. Independent of this run’s session feedback.'));
  raw.last_observation.type = 'observation'; raw.last_observation.step_id = 2; window.yamTelemetry.observe(project(raw));
  assert.ok(root.textContent.includes('Latest session feedback.'));
  const cursor = dom.getElementById('cmEvidenceCursor'); cursor.value = '0'; cursor.oninput();
  assert.ok(root.textContent.includes('Recorded station report.'));
});
