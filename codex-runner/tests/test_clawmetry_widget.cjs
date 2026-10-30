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
    const names = () => (this.className || '').split(' ').filter(Boolean);
    this.classList = {contains: value => names().includes(value),
      add: value => { if (!names().includes(value)) this.className = [...names(), value].join(' '); },
      remove: value => { this.className = names().filter(name => name !== value).join(' '); }}; }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(' '); }
  setAttribute(key, value) { this[key] = value; }
  removeAttribute(key) { delete this[key]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  click() { if (this.listeners.click) this.listeners.click(); }
  insertAdjacentElement(position, node) { assert.equal(position, 'afterend'); node.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node); }
  querySelectorAll(selector) { const out = []; for (const child of this.children) { if (child.tagName === selector) out.push(child); out.push(...child.querySelectorAll(selector)); } return out; }
  matches(selector) { return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : this.tagName === selector; }
  closest(selector) { let node = this; while (node) { if (node.matches && node.matches(selector)) return node; node = node.parent; } return null; }
}
function descendants(node) { const out = []; for (const child of node.children) { out.push(child, ...descendants(child)); } return out; }
function browserHarness() {
  const dom = {hidden: false, readyState: 'complete', listeners: {},
    createElement(tag) { return new Element(tag, this); },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    getElementById(id) { return [this.body, ...this.body.querySelectorAll('*')].find(node => node.id === id) || find(this.body, node => node.id === id); },
    querySelectorAll(selector) { assert.equal(selector, '[data-conversation-mode]');
      return descendants(this.body).filter(node => node.dataset && node.dataset.conversationMode); },
    querySelector(selector) { return selector === '.watchLayout' ? this.watch : selector === '.cameraFooter' ? this.footer
      : selector === '.conversationModes' ? this.modes : selector === '.runnerContent' ? this.body : null; }};
  function find(node, predicate) { if (predicate(node)) return node; for (const child of node.children) { const found = find(child, predicate); if (found) return found; } return null; }
  dom.body = new Element('div', dom); dom.body.className = 'runnerContent';
  dom.watch = new Element('div', dom); dom.watch.className = 'watchLayout';
  dom.footer = new Element('div', dom); dom.footer.className = 'cameraFooter'; dom.watch.append(dom.footer);
  // The upstream conversation tab strip and its two panels.
  dom.modes = new Element('div', dom); dom.modes.className = 'conversationModes';
  for (const mode of ['reasoning', 'conversation', 'hide', 'visitor']) {
    const button = new Element('button', dom); button.dataset.conversationMode = mode; dom.modes.append(button);
  }
  dom.conversation = new Element('section', dom); dom.conversation.id = 'liveConversationPanel'; dom.conversation.hidden = false;
  dom.visitors = new Element('aside', dom); dom.visitors.id = 'visitorChatPanel'; dom.visitors.hidden = true;
  dom.interaction = new Element('div', dom); dom.interaction.className = 'watchInteraction';
  dom.interaction.append(dom.visitors, dom.conversation);
  dom.watch.append(dom.modes, dom.interaction);
  dom.history = new Element('section', dom); dom.history.id = 'past-runs'; dom.body.append(dom.watch, dom.history);
  const window = {listeners: {}, addEventListener(name, fn){this.listeners[name]=fn;}};
  let network = 0, intervals = 0;
  const deferred = [];
  const context = vm.createContext({window, document: dom, console, Object, Number, JSON, Map, Date, Blob, URL,
    fetch(){network++;throw new Error('Widget must not fetch');},setInterval(){intervals++;return intervals;},clearInterval(){},
    setTimeout(fn){if(typeof fn==='function')deferred.push(fn);return 0;}});
  vm.runInContext(widgetSource, context);
  const flush = () => { while (deferred.length) deferred.shift()(); };
  return {dom, window, context, flush, network:()=>network, intervals:()=>intervals};
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
  // One ClawMetry surface, not two: evidence is a section of the move-log tab.
  const panel = dom.getElementById('clawmetryMotionPanel');
  assert.ok(descendants(panel).includes(root));
  assert.equal(dom.body.children.length, 2);
  assert.equal(dom.body.children[0], dom.watch); assert.equal(dom.body.children[1], dom.history);
  assert.equal(dom.watch.children.includes(dom.footer), true);
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

test('server trace link requires exact same-origin path and displayed source identity', () => {
  const raw = state(), path = '/clawmetry/trace/' + 'a'.repeat(32);
  raw.telemetry.detail = {path, attempt_id:'attempt_1'};
  assert.equal(project(raw).detail_path, path);
  raw.telemetry.public_run_shared = false;
  assert.equal(project(raw).detail_path, path); // Owner link does not publish text.
  assert.equal(project(raw).events.length, 0);
  for (const bad of ['https://attacker.example'+path, '//attacker.example'+path, path+'?token=secret', path+'#secret', path+'/', '/clawmetry/trace/'+'A'.repeat(32), 'javascript:alert(1)']) {
    raw.telemetry.detail.path=bad; assert.equal(project(raw).detail_path,null);
  }
  raw.telemetry.detail.path=path; raw.telemetry.detail.attempt_id='foreign';
  assert.equal(project(raw).detail_path,null);
  delete raw.telemetry.detail; assert.equal(project(raw).detail_path,null);
});


test('a finished run stays reachable to the reader who started it', () => {
  const raw = state(), mine = '/clawmetry/trace/' + 'b'.repeat(32);
  // The station is idle: there is no displayed run, so no live link exists.
  delete raw.telemetry.detail;
  raw.telemetry.detail_recent = {path: mine, task: 'Pick up the red block.', ended: true};
  const view = project(raw);
  assert.equal(view.detail_path, null, 'an idle station has no live trace to point at');
  assert.equal(view.recent_detail.path, mine);
  assert.equal(view.recent_detail.task, 'Pick up the red block.');
  assert.equal(view.recent_detail.ended, true);
  // A run the station is still writing must not be reported as finished.
  raw.telemetry.detail_recent = {path: mine, task: 'Still going.', ended: false};
  assert.equal(project(raw).recent_detail.ended, false);
  delete raw.telemetry.detail_recent.ended;
  assert.equal(project(raw).recent_detail.ended, false, 'an unstated end is not an end');
  raw.telemetry.detail_recent = {path: mine, task: 'Pick up the red block.', ended: true};
  // The same path checks as the live link: a past run is not a looser target.
  for (const bad of ['https://attacker.example' + mine, '//attacker.example' + mine, mine + '?token=secret',
                     mine + '#secret', mine + '/', '/clawmetry/trace/' + 'B'.repeat(32), 'javascript:alert(1)',
                     '/clawmetry/trace/' + 'b'.repeat(31)]) {
    raw.telemetry.detail_recent = {path: bad, ended: true};
    assert.equal(project(raw).recent_detail, null, bad + ' must not become a link');
  }
  raw.telemetry.detail_recent = undefined;
  assert.equal(project(raw).recent_detail, null);
});


test('the last-run link never impersonates the run on screen, and needs no request', () => {
  const {dom, window, network} = browserHarness();
  const live = '/clawmetry/trace/' + 'a'.repeat(32), mine = '/clawmetry/trace/' + 'b'.repeat(32);
  const raw = motionState(MOVES);
  raw.telemetry.detail = {path: live, attempt_id: 'attempt_1'};
  raw.telemetry.detail_recent = {path: mine, task: 'An older task.', ended: true};
  window.yamTelemetry.observe(project(raw));
  dom.getElementById('clawmetryMotionTab').listeners.click();
  const link = dom.getElementById('clawmetryMotionPanel').children
    .find(n => n.className === 'statusHeader').children.find(n => n.tagName === 'a');
  assert.equal(link.hidden, false);
  assert.equal(link.href, live, 'a live run wins over a past one');
  assert.equal(link.textContent.startsWith('Open detailed view'), true);

  // Station goes idle. The live link is gone; the reader's own run remains.
  delete raw.telemetry.detail;
  window.yamTelemetry.observe(project(raw));
  assert.equal(link.hidden, false, 'an idle station must not strand the reader');
  assert.equal(link.href, mine);
  assert.equal(link.textContent.startsWith('Open your last run'), true,
    'a finished run must be labelled as one, never as the live view');
  assert.ok(link.title.includes('not yours') && link.title.includes('An older task.'));
  assert.equal(link.target, '_blank');
  assert.ok(link.rel.includes('noopener'));

  // A reader who started nothing is told why, and is offered no link.
  delete raw.telemetry.detail_recent;
  window.yamTelemetry.observe(project(raw));
  assert.equal(link.hidden, true);
  assert.ok(dom.getElementById('clawmetryMotionPanel').textContent.includes('launched the run'));
  // The widget is fed by the page's own poll; it must still make no request.
  assert.equal(network.length, 0, 'the widget must stay zero-network');
});


test('full trace opens safely in a new tab and clears on run reset without fetching', () => {
  const {dom,window,network}=browserHarness();
  const raw=state(), path='/clawmetry/trace/'+'a'.repeat(32);
  raw.telemetry.detail={path,attempt_id:'attempt_1'};
  window.yamTelemetry.observe(project(raw));
  const link=dom.body.querySelectorAll('a').find(node=>node.textContent==='Open full trace');
  assert.equal(link.href,path); assert.equal(link.hidden,false);
  assert.equal(link.target,'_blank'); assert.equal(link.rel,'noopener noreferrer');
  window.yamTelemetry.reset();
  assert.equal(link.hidden,true); assert.equal(link.href,undefined); assert.equal(network(),0);
});

function motionState(rows, source = 'station_journal') {
  const raw = state();
  raw.telemetry.motion = {run_id: 'run_recording', source, rows};
  return raw;
}
const MOVES = [
  {id: 10, t: 200, kind: 'packet_submit', trajectory_id: 'trajectory_1', waypoint_count: 3, cadence_hz: 10},
  {id: 11, t: 201, kind: 'packet_accepted', trajectory_id: 'trajectory_1'},
  {id: 12, t: 202, kind: 'packet_progress', trajectory_id: 'trajectory_1', progress_count: 1, waypoint_count: 3},
  {id: 13, t: 203, kind: 'packet_progress', trajectory_id: 'trajectory_1', progress_count: 2, waypoint_count: 3},
  {id: 14, t: 204, kind: 'observation', step_id: 4, left_joints_deg: [1, 2, 3, 4, 5, 6], left_gripper: 0.25},
];

test('motion rows publish numbers and bounded tokens, never run or wire text', () => {
  const rows = [...MOVES,
    {id: 20, t: 205, kind: 'model_response', message: 'move_to: {"note":"PRIVATE_NOTE"}'},
    {id: 21, t: 206, kind: 'http_exchange', body: 'PRIVATE_WIRE'},
    {id: 22, t: 207, kind: 'packet_error', status: 'rejected', code: 'left_tip_outside_workspace',
      reported_progress: 2, message: 'PRIVATE_GATEWAY_TEXT', note: 'PRIVATE_NOTE'},
    {id: 23, t: 208, kind: 'packet_progress', trajectory_id: 'trajectory_1', progress_count: Infinity, waypoint_count: 3}];
  const view = project(motionState(rows));
  const packed = JSON.stringify(view.motion);
  assert.equal(packed.includes('PRIVATE_'), false);
  assert.equal(packed.includes('move_to'), false);
  assert.equal(view.motion.rows.some(row => row.kind === 'model_response' || row.kind === 'http_exchange'), false);
  const error = view.motion.rows.find(row => row.kind === 'packet_error');
  assert.deepEqual(error, {id: 22, t: 207, kind: 'packet_error', reported_progress: 2,
    status: 'rejected', code: 'left_tip_outside_workspace'});
  // A nonfinite count is dropped, never rendered as a zero the robot never reported.
  const last = view.motion.rows.filter(row => row.kind === 'packet_progress').pop();
  assert.equal('progress_count' in last, false);
  assert.deepEqual(view.motion.rows.find(row => row.kind === 'observation').left_joints_deg, [1, 2, 3, 4, 5, 6]);
});

test('motion is published for every station run, independently of conversation sharing', () => {
  const raw = motionState(MOVES);
  raw.telemetry.public_run_shared = false;
  const view = project(raw);
  // The conversation stays private; the moves still publish. That is the split.
  assert.equal(view.scope, 'not_shared');
  assert.deepEqual(view.events, []);
  assert.equal(view.run.task, null);
  assert.equal(view.motion.rows.length, MOVES.length);
  assert.equal(view.motion.source, 'station_journal');
});

test('an unreadable or remote journal is reported, never rendered as an idle robot', () => {
  for (const source of ['remote_host', 'unavailable']) {
    const view = project(motionState([], source));
    assert.equal(view.motion.source, source);
    assert.deepEqual(view.motion.rows, []);
  }
  assert.equal(project(motionState(MOVES, 'invented_source')).motion, null);
  const missing = state(); delete missing.telemetry.motion;
  assert.equal(project(missing).motion, null);
});

test('move log tab is added beside the upstream modes without editing its markup', () => {
  const {dom, window, network} = browserHarness();
  const button = dom.getElementById('clawmetryMotionTab');
  const panel = dom.getElementById('clawmetryMotionPanel');
  assert.ok(button); assert.ok(panel);
  // Added to upstream's own strip, so upstream's handler wires it like the rest.
  assert.equal(button.parent, dom.modes);
  assert.equal(dom.modes.children.length, 5);
  assert.equal(button.dataset.conversationMode, 'clawmetry');
  assert.equal(panel.parent, dom.interaction);
  assert.equal(dom.interaction.children.indexOf(panel), dom.interaction.children.indexOf(dom.conversation) + 1);
  assert.equal(panel.hidden, true);
  assert.equal(network(), 0);
});

test('choosing the move log shows the station timeline and releases the other panels', () => {
  const {dom, window, network} = browserHarness();
  const button = dom.getElementById('clawmetryMotionTab'), panel = dom.getElementById('clawmetryMotionPanel');
  window.yamTelemetry.observe(project(motionState(MOVES)));
  button.listeners.click();
  assert.equal(panel.hidden, false);
  assert.equal(dom.conversation.hidden, true);
  assert.equal(dom.visitors.hidden, true);
  assert.equal(button.ariaPressed ?? button['aria-pressed'], 'true');
  const text = panel.textContent;
  assert.ok(text.includes('Sent 3 waypoints to the gateway'));
  assert.ok(text.includes('Safety checks passed'));
  assert.ok(text.includes('Measured arm feedback received'));
  assert.ok(text.includes('L 1.0° 2.0° 3.0° 4.0° 5.0° 6.0°'));
  assert.ok(text.includes('L grip 25%'));
  // One advancing row per trajectory: the counter moves, the list does not grow.
  assert.equal((text.match(/Executing waypoint/g) || []).length, 1);
  assert.ok(text.includes('Executing waypoint 2 of 3'));
  assert.equal(network(), 0);
});

test('a later waypoint advances the same row and a new run clears the log', () => {
  const {dom, window} = browserHarness();
  const button = dom.getElementById('clawmetryMotionTab'), panel = dom.getElementById('clawmetryMotionPanel');
  window.yamTelemetry.observe(project(motionState(MOVES)));
  button.listeners.click();
  const advanced = motionState([{id: 30, t: 209, kind: 'packet_progress', trajectory_id: 'trajectory_1',
    progress_count: 3, waypoint_count: 3}]);
  window.yamTelemetry.observe(project(advanced));
  assert.equal((panel.textContent.match(/Executing waypoint/g) || []).length, 1);
  assert.ok(panel.textContent.includes('Executing waypoint 3 of 3'));
  // Earlier rows of the same run survive a server window that no longer lists them.
  assert.ok(panel.textContent.includes('Sent 3 waypoints to the gateway'));
  const next = motionState(MOVES); next.telemetry.motion.run_id = 'run_other';
  window.yamTelemetry.observe(project(next));
  assert.equal((panel.textContent.match(/Sent 3 waypoints/g) || []).length, 1);
});

test('switching to another mode hides the move log and the strip stays upstream-owned', () => {
  const {dom, window} = browserHarness();
  const button = dom.getElementById('clawmetryMotionTab'), panel = dom.getElementById('clawmetryMotionPanel');
  window.yamTelemetry.observe(project(motionState(MOVES)));
  button.listeners.click();
  assert.equal(panel.hidden, false);
  // Upstream dispatches this last; our button must settle after its handler.
  dom.listeners['yam:conversation-mode']({detail: {mode: 'clawmetry'}});
  assert.equal(panel.hidden, false);
  assert.equal(dom.conversation.hidden, true);
  dom.listeners['yam:conversation-mode']({detail: {mode: 'reasoning'}});
  assert.equal(panel.hidden, true);
});

test('an unreadable journal says so in the tab instead of showing an empty log', () => {
  const {dom, window} = browserHarness();
  const button = dom.getElementById('clawmetryMotionTab'), panel = dom.getElementById('clawmetryMotionPanel');
  window.yamTelemetry.observe(project(motionState([], 'remote_host')));
  button.listeners.click();
  assert.ok(panel.textContent.includes('executing on another host'));
  assert.equal(panel.textContent.includes('No moves recorded'), false);
  window.yamTelemetry.observe(project(motionState([], 'unavailable')));
  assert.ok(panel.textContent.includes('gap in the log, not an idle robot'));
});

test('exactly one ClawMetry surface: evidence sits inside the tab, not beside it', () => {
  const {dom, window} = browserHarness();
  window.yamTelemetry.observe(project(motionState(MOVES)));
  const panel = dom.getElementById('clawmetryMotionPanel');
  const evidence = dom.getElementById('clawmetryEvidence');
  assert.ok(evidence);
  // The old standalone disclosure beside the camera/chat grid must not come back.
  assert.ok(descendants(panel).includes(evidence));
  assert.equal(descendants(dom.watch).filter(n => n.id === 'clawmetryEvidence').length, 1);
  assert.equal(dom.body.children.filter(n => n.id === 'clawmetryEvidence').length, 0);
});

test('detailed view link appears only for a server-supplied same-origin trace path', () => {
  const {dom, window} = browserHarness();
  const button = dom.getElementById('clawmetryMotionTab');
  window.yamTelemetry.observe(project(motionState(MOVES)));
  button.listeners.click();
  const link = dom.getElementById('clawmetryMotionPanel').children
    .find(n => n.className === 'statusHeader').children.find(n => n.tagName === 'a');
  assert.equal(link.hidden, true);
  assert.equal(link.href, undefined);
  // Absent metadata explains itself rather than offering a control that does nothing.
  assert.ok(dom.getElementById('clawmetryMotionPanel').textContent.includes('Detailed view available to the browser that launched the run'));

  const raw = motionState(MOVES);
  raw.telemetry.detail = {path: '/clawmetry/trace/' + 'a'.repeat(32), attempt_id: 'attempt_1'};
  window.yamTelemetry.observe(project(raw));
  assert.equal(link.hidden, false);
  assert.equal(link.href, '/clawmetry/trace/' + 'a'.repeat(32));
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');

  for (const bad of ['https://evil.example/clawmetry/trace/' + 'a'.repeat(32), '/clawmetry/trace/zz', '/clawmetry/trace/' + 'a'.repeat(32) + '?x=1']) {
    const other = motionState(MOVES);
    other.telemetry.detail = {path: bad, attempt_id: 'attempt_1'};
    window.yamTelemetry.observe(project(other));
    assert.equal(link.hidden, true, bad);
  }
});

test('the move log is the default tab once upstream has wired its strip', () => {
  const {dom, flush} = browserHarness();
  const button = dom.getElementById('clawmetryMotionTab');
  const panel = dom.getElementById('clawmetryMotionPanel');
  // Not selected during construction: upstream's own deferred script runs after us.
  assert.equal(panel.hidden, true);
  flush();
  assert.equal(panel.hidden, false);
  assert.equal(button['aria-pressed'], 'true');
  assert.equal(dom.conversation.hidden, true);
});

test('a visitor who picks another tab is never overridden by the default', () => {
  const {dom, flush} = browserHarness();
  const panel = dom.getElementById('clawmetryMotionPanel');
  // Upstream dispatches this for a real click on one of its own buttons.
  dom.listeners['yam:conversation-mode']({detail: {mode: 'reasoning'}});
  flush();
  assert.equal(panel.hidden, true);
  assert.equal(dom.getElementById('clawmetryMotionTab')['aria-pressed'], 'false');
});

test('the default selection is applied once, not reasserted on every poll', () => {
  const {dom, window, flush} = browserHarness();
  const panel = dom.getElementById('clawmetryMotionPanel');
  flush();
  assert.equal(panel.hidden, false);
  dom.listeners['yam:conversation-mode']({detail: {mode: 'hide'}});
  assert.equal(panel.hidden, true);
  // Later status polls must not drag the visitor back to our tab.
  window.yamTelemetry.observe(project(motionState(MOVES)));
  window.yamTelemetry.observe(project(motionState(MOVES)));
  assert.equal(panel.hidden, true);
});
