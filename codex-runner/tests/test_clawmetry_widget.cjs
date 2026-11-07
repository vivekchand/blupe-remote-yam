'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const test = require('node:test'), assert = require('node:assert/strict');
const projection = require('../static/telemetry-status.js');
const widget = require('../static/clawmetry-widget.js');
const hosted = fs.readFileSync(path.join(__dirname, '../static/hosted.js'), 'utf8');
const widgetSource = fs.readFileSync(path.join(__dirname, '../static/clawmetry-widget.js'), 'utf8');
const notify = hosted.slice(hosted.indexOf('function notifyYamTelemetry('), hosted.indexOf('// Default to Dream'));
test('typed unsubmitted-plan recovery is meaningful compact progress, never private prose',()=>{
  const raw={id:1,t:100,kind:'plan_recovery',state:'replanning',reason_code:'pre_dispatch_pose_changed',retry_count:1,retry_limit:2,
    step_id:8,trajectory_id:'traj_8',dispatched:false,executed_waypoints:0,message:'PRIVATE_MESSAGE',error:'PRIVATE_ERROR',first:['PRIVATE_TARGET'],status:'PRIVATE_STATUS'};
  const row=projection.motionRow(raw);
  assert.deepEqual(row,{id:1,t:100,kind:'plan_recovery',state:'replanning',reason_code:'pre_dispatch_pose_changed',retry_count:1,retry_limit:2,
    step_id:8,trajectory_id:'traj_8',dispatched:false,executed_waypoints:0});
  assert.equal(widget.meaningfulMotion(row),true);
  assert.equal(widget.motionText(row),'Plan changed; checking a fresh view (retry 1 of 2)');
  assert.equal(widget.motionText({...row,state:'exhausted',retry_count:2}),'Replanning limit reached; no new motion sent');
  assert.equal(JSON.stringify(row).includes('PRIVATE'),false);
  assert.equal(widget.motionNumbers(row),'');
  const meta={motion:{source:'station_journal',run_id:'run_1',rows:Array.from({length:250},(_,id)=>({...raw,id}))}};
  assert.equal(projection.motion(meta).rows.length,200);
  for(const [key,value]of [['state','PRIVATE'],['reason_code','PRIVATE'],['retry_count',true],['retry_count',-1],['retry_count',3],['retry_limit',3],
    ['step_id',-1],['trajectory_id','PRIVATE prose'],['dispatched',true],['executed_waypoints',1],['executed_waypoints',false]])assert.equal(projection.motionRow({...raw,[key]:value}),null,key);
});
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
    this.style = {removeProperty(name){delete this[name];}};
    const names = () => (this.className || '').split(' ').filter(Boolean);
    this.classList = {contains: value => names().includes(value),
      add: value => { if (!names().includes(value)) this.className = [...names(), value].join(' '); },
      remove: value => { this.className = names().filter(name => name !== value).join(' '); }}; }
  append(...nodes) { for (const node of nodes) { if(node.parent)node.parent.children.splice(node.parent.children.indexOf(node),1); node.parent = this; this.children.push(node); } }
  get parentElement(){return this.parent || null;}
  get nextSibling(){return this.parent?.children[this.parent.children.indexOf(this)+1] || null;}
  insertBefore(node,before){if(node.parent)node.parent.children.splice(node.parent.children.indexOf(node),1);node.parent=this;this.children.splice(this.children.indexOf(before),0,node);}
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(' '); }
  setAttribute(key, value) { this[key] = value; }
  removeAttribute(key) { delete this[key]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  click() { if (this.listeners.click) this.listeners.click(); }
  focus() { this.doc.activeElement = this; }
  insertAdjacentElement(position, node) { assert.equal(position, 'afterend'); node.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node); }
  querySelectorAll(selector) { const out = []; for (const child of this.children) { if (child.tagName === selector) out.push(child); out.push(...child.querySelectorAll(selector)); } return out; }
  matches(selector) { return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : this.tagName === selector; }
  closest(selector) { let node = this; while (node) { if (node.matches && node.matches(selector)) return node; node = node.parent; } return null; }
}
function descendants(node) { const out = []; for (const child of node.children) { out.push(child, ...descendants(child)); } return out; }
function browserHarness() {
  const dom = {hidden: false, readyState: 'complete', listeners: {}, events: [],
    dispatchEvent(event){this.events.push(event);this.listeners[event.type]?.(event);return true;},
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
  const close = new Element('button', dom); close.id = 'meetingClosePanel'; dom.interaction.append(close);
  dom.interaction.append(dom.visitors, dom.conversation);
  dom.watch.append(dom.modes, dom.interaction);
  dom.history = new Element('section', dom); dom.history.id = 'past-runs'; dom.body.append(dom.watch, dom.history);
  const window = {listeners: {}, addEventListener(name, fn){this.listeners[name]=fn;}};
  let network = 0, intervals = 0;
  const deferred = [];
  const context = vm.createContext({window, document: dom, console, Object, Number, JSON, Map, Date, Blob, URL, CustomEvent:class {constructor(type,options={}){this.type=type;this.detail=options.detail;}},
    fetch(){network++;throw new Error('Widget must not fetch');},setInterval(){intervals++;return intervals;},clearInterval(){},
    setTimeout(fn){if(typeof fn==='function')deferred.push(fn);return 0;}});
  vm.runInContext(widgetSource, context);
  const flush = () => { while (deferred.length) deferred.shift()(); };
  return {dom, window, context, flush, network:()=>network, intervals:()=>intervals};
}

test('review expansion preserves rule draft, scroll and native layout; reduce and Escape restore sizing', () => {
  const {dom,network} = browserHarness();
  const panel=dom.getElementById('clawmetryMotionPanel'), expand=dom.getElementById('cm-expand-review');
  const scroll=dom.getElementById('cm-trust-scroll'), editor=dom.getElementById('cm-guard-editor-slot');
  const input=dom.createElement('textarea'); input.value="don't pick yellow color"; editor.append(input); scroll.scrollTop=91;
  dom.getElementById('clawmetryMotionTab').click();
  const originalParent=panel.parent;
  expand.click();
  assert.equal(panel.classList.contains('cm-review-expanded'),true);
  assert.equal(expand['aria-expanded'],'true'); assert.equal(expand.textContent,'Reduce review');
  assert.equal(panel.parent,originalParent); assert.equal(input.parent,editor); assert.equal(scroll.scrollTop,91);
  panel.style.width='600px'; panel.style.height='500px';
  expand.click();
  assert.equal(panel.classList.contains('cm-review-expanded'),false);
  assert.equal(panel.style.width,undefined); assert.equal(panel.style.height,undefined);
  assert.equal(input.value,"don't pick yellow color"); assert.equal(expand['aria-expanded'],'false');
  expand.click(); let prevented=0,stopped=0;
  panel.listeners.keydown({key:'Escape',preventDefault(){prevented++;},stopPropagation(){stopped++;}});
  assert.equal(prevented,1); assert.equal(stopped,1); assert.equal(dom.activeElement,expand);
  assert.equal(panel.classList.contains('cm-review-expanded'),false); assert.equal(network(),0);
});

test('leaving or closing review clears expansion without changing native controls', () => {
  for(const leave of ['tab','native-close','robot','pagehide']) {
    const {dom,window}=browserHarness(), panel=dom.getElementById('clawmetryMotionPanel');
    const button=dom.getElementById('cm-expand-review'); dom.getElementById('clawmetryMotionTab').click(); button.click();
    panel.style.width='610px';
    if(leave==='tab') dom.dispatchEvent({type:'yam:conversation-mode',detail:{mode:'reasoning'}});
    if(leave==='native-close') dom.getElementById('meetingClosePanel').click();
    if(leave==='robot') window.listeners['blupe-robot-selected']();
    if(leave==='pagehide') window.listeners.pagehide();
    assert.equal(panel.classList.contains('cm-review-expanded'),false,leave);
    assert.equal(button['aria-expanded'],'false',leave); assert.equal(panel.style.width,undefined,leave);
  }
});

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
  raw.telemetry.detail = {path, attempt_id:'attempt_1',episode_id:'episode_1'};
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
  raw.telemetry.detail = {path: live, attempt_id: 'attempt_1',episode_id:'episode_1'};
  raw.telemetry.detail_recent = {path: mine, task: 'An older task.', ended: true};
  window.yamTelemetry.observe(project(raw));
  dom.getElementById('clawmetryMotionTab').listeners.click();
  const link = dom.getElementById('clawmetryMotionPanel').children
    .find(n => n.className === 'statusHeader').children.find(n => n.tagName === 'a');
  assert.equal(link.hidden, false);
  assert.equal(link.href, live, 'a live run wins over a past one');
  assert.equal(link.textContent.startsWith('Open live trace'), true);

  // Station goes idle. The live link is gone; the reader's own run remains.
  delete raw.telemetry.detail;
  window.yamTelemetry.observe(project(raw));
  assert.equal(link.hidden, false, 'an idle station must not strand the reader');
  assert.equal(link.href, mine);
  assert.equal(link.textContent.startsWith('Last run'), true,
    'a finished run must be labelled as one, never as the live view');
  assert.ok(link.title.includes('not yours') && link.title.includes('An older task.'));
  assert.equal(link.target, '_blank');
  assert.ok(link.rel.includes('noopener'));

  // A reader who started nothing is told why, and is offered no link.
  delete raw.telemetry.detail_recent;
  window.yamTelemetry.observe(project(raw));
  assert.equal(link.hidden, true);
  assert.ok(descendants(dom.getElementById('clawmetryMotionPanel')).some(node=>node.className==='cm-sessions-link'&&node.href==='/clawmetry/'));
  // The widget is fed by the page's own poll; it must still make no request.
  assert.equal(network.length, 0, 'the widget must stay zero-network');
});


test('full trace opens safely in a new tab and clears on run reset without fetching', () => {
  const {dom,window,network}=browserHarness();
  const raw=state(), path='/clawmetry/trace/'+'a'.repeat(32);
  raw.telemetry.detail={path,attempt_id:'attempt_1',episode_id:'episode_1'};
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
  assert.ok(text.includes('Gateway reported packet accepted for execution'));
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
  assert.equal((dom.getElementById('cm-technical-events').textContent.match(/Sent 3 waypoints/g) || []).length, 1);
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
  assert.ok(panel.textContent.includes('move journal for the displayed station run is not available'));
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
  assert.ok(descendants(dom.getElementById('clawmetryMotionPanel')).some(node=>node.className==='cm-sessions-link'&&node.href==='/clawmetry/'));

  const raw = motionState(MOVES);
  raw.telemetry.detail = {path: '/clawmetry/trace/' + 'a'.repeat(32), attempt_id: 'attempt_1',episode_id:'episode_1'};
  window.yamTelemetry.observe(project(raw));
  assert.equal(link.hidden, false);
  assert.equal(link.href, '/clawmetry/trace/' + 'a'.repeat(32));
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');

  for (const bad of ['https://evil.example/clawmetry/trace/' + 'a'.repeat(32), '/clawmetry/trace/zz', '/clawmetry/trace/' + 'a'.repeat(32) + '?x=1']) {
    const other = motionState(MOVES);
    other.telemetry.detail = {path: bad, attempt_id: 'attempt_1',episode_id:'episode_1'};
    window.yamTelemetry.observe(project(other));
    assert.equal(link.hidden, true, bad);
  }
});

test('the optional move log preserves the upstream initial tab', () => {
  const {dom, window, flush} = browserHarness();
  const button = dom.getElementById('clawmetryMotionTab');
  const panel = dom.getElementById('clawmetryMotionPanel');
  assert.equal(panel.hidden, true);
  flush();
  window.yamTelemetry.observe(project(motionState(MOVES)));
  assert.equal(panel.hidden, true);
  assert.equal(button['aria-pressed'], 'false');
  assert.equal(dom.conversation.hidden, false);
});

test('explicit move log selection opens its pane and polling respects later choices', () => {
  const {dom, window, flush} = browserHarness();
  const panel = dom.getElementById('clawmetryMotionPanel');
  dom.getElementById('clawmetryMotionTab').click();
  assert.equal(panel.hidden, false);
  dom.listeners['yam:conversation-mode']({detail: {mode: 'reasoning'}});
  flush();
  window.yamTelemetry.observe(project(motionState(MOVES)));
  assert.equal(panel.hidden, true);
});


test('trust summary does not promote acceptance, configuration or pending rules into checked protection', () => {
  const view=project(state());
  assert.equal(widget.guardSummary(view).title,'No Guard decision recorded');
  const pending={...view,trust:{schema:'clawmetry.trust.v1',guard:{state:'unconfigured'},next_run_guard:{state:'saved_for_next_run',revision:2}}};
  assert.equal(widget.guardSummary(pending).title,'No Guard decision recorded');
  const configured={...view,trust:{schema:'clawmetry.trust.v1',guard:{state:'configured',mode:'block',config_version:2,sequence:4,config_hash:'a'.repeat(64)}}};
  assert.equal(widget.guardSummary(configured).title,'Rules recorded; awaiting a check');
  const held={...view,trust:{schema:'clawmetry.trust.v1',guard:{state:'decision_recorded',mode:'block',decision:'reject',config_version:2,sequence:5,config_hash:'a'.repeat(64),missing:['fresh_measured_feedback']}}};
  assert.equal(widget.guardSummary(held).title,'Packet held before dispatch');
  assert.match(widget.guardSummary(held).detail,/fresh measured feedback/i);
  assert.doesNotMatch(widget.guardSummary(held).detail,/physically stopped|robot is safe/i);
});

test('default recent events select meaningful outcomes instead of repeated feedback or timing', () => {
  const rows=Array.from({length:200},(_,i)=>({id:i,t:100+i,kind:'observation'}));
  rows[10]={id:10,t:110,kind:'packet_submit',waypoint_count:3};
  rows[50]={id:50,t:150,kind:'model_timing'};
  rows[100]={id:100,t:200,kind:'packet_completed',waypoint_count:3};
  rows[199]={id:199,t:299,kind:'stopped'};
  const summary=widget.runSummary(project(state()),rows);
  assert.equal(summary.recent.length,3);
  assert.equal(summary.recent.map(row=>row.kind).join(','),'stopped,packet_completed,packet_submit');
  assert.equal(summary.latest.kind,'stopped');
});

test('completed-run assessment and 200 records share one bounded body without changing native handlers',()=>{
  const {dom,window}=browserHarness();
  const assessment=dom.createElement('section');assessment.id='liveAssessment';
  const control=dom.createElement('button');let ratings=0;control.addEventListener('click',()=>ratings++);assessment.append(control);
  dom.interaction.append(assessment);
  const rows=Array.from({length:200},(_,i)=>({id:i+1,t:200+i,kind:i===199?'stopped':'observation'}));
  window.yamTelemetry.observe(project(motionState(rows)));
  dom.getElementById('clawmetryMotionTab').click();
  const scroll=dom.getElementById('cm-trust-scroll'),slot=dom.getElementById('cm-guard-editor-slot');
  assert.ok(scroll,'the integration needs one bounded scroll body');
  assert.ok(descendants(scroll).includes(slot));
  assert.ok(descendants(scroll).includes(assessment));
  assert.equal(dom.getElementById('cm-recent-events').children.length,1);
  assert.equal(dom.getElementById('cm-technical-events').children.length,200);
  for(let i=0;i<3;i++){
    control.textContent='Updated native rating '+i;
    window.yamTelemetry.observe(project(motionState(rows)));
    control.click();
  }
  assert.equal(ratings,3);assert.equal(assessment.parent,dom.getElementById('cm-operator-assessment'));
  assessment.hidden=true;window.yamTelemetry.observe(project(motionState(rows)));
  assert.equal(dom.getElementById('cm-operator-assessment').hidden,true);
  assessment.hidden=false;window.yamTelemetry.observe(project(motionState(rows)));
  assert.equal(dom.getElementById('cm-operator-assessment').hidden,false);
  assert.equal(dom.events.filter(event=>event.type==='clawmetry:panel-ready').length,1);
  dom.listeners['yam:conversation-mode']({detail:{mode:'reasoning'}});
  assert.equal(assessment.parent,dom.interaction,'leaving ClawMetry restores the native assessment placement');
  dom.getElementById('clawmetryMotionTab').click();
  assert.equal(assessment.parent,dom.getElementById('cm-operator-assessment'));
  assert.equal(descendants(dom.body).filter(node=>node.id==='liveAssessment').length,1);
});

test('reset clears a prior run summary and trust decision without removing the English editor mount',()=>{
  const {dom,window}=browserHarness();
  const view={...project(motionState(MOVES)),trust:{schema:'clawmetry.trust.v1',guard:{state:'decision_recorded',mode:'block',decision:'reject',config_version:2,sequence:5,config_hash:'a'.repeat(64),missing:['fresh_measured_feedback']}}};
  window.yamTelemetry.observe(view);dom.getElementById('clawmetryMotionTab').click();
  assert.match(dom.getElementById('cm-guard-state').textContent,/held before dispatch/);
  const slot=dom.getElementById('cm-guard-editor-slot');
  const editor=dom.createElement('div');editor.textContent='My rule editor';slot.append(editor);
  window.yamTelemetry.reset();
  assert.equal(slot.children[0],editor);
  assert.equal(dom.getElementById('cm-guard-state').textContent,'No Guard decision recorded');
  assert.doesNotMatch(dom.getElementById('cm-run-summary').textContent,/Raise the left arm|held before dispatch/);
});

function trustedState(){
  const raw=state(),trace='a'.repeat(32);
  raw.telemetry.detail={path:'/clawmetry/trace/'+trace,attempt_id:'attempt_1',episode_id:'episode_1'};
  raw.telemetry.trust={schema:'clawmetry.trust.v1',trace_id:trace,
    persistence:{state:'confirmed',through_sequence:42,capability:'PRIVATE_CAPABILITY'},
    guard:{state:'decision_recorded',mode:'block',decision:'reject',config_version:2,config_hash:'b'.repeat(64),sequence:41,
      outcome:'unknown',coverage:['max_step_deg'],reasons:[],missing:['fresh_measured_feedback'],
      source:'duckdb_recorded_events',coverage_scope:'local_joint_trajectory',partial_window:false,raw:'PRIVATE_GUARD'},
    next_run_guard:{state:'saved_for_next_run',revision:3,config_hash:'c'.repeat(64),
      config:{schema:'clawmetry.blupe.guard.v1',version:1,mode:'block',max_step_deg:2,secret:'PRIVATE_CONFIG'},
      policy:{policy_hash:'d'.repeat(64),status:'saved_for_next_run',text:'PRIVATE_RULE',
        rules:[{field:'max_step_deg',value:2,description:'PRIVATE_DESCRIPTION'}]}}};
  return raw;
}

test('trust projection keeps only bounded source-matched evidence and separate next-run rules',()=>{
  const raw=trustedState(),view=project(raw);
  assert.equal(view.trust.persistence.state,'confirmed');assert.equal(view.trust.persistence.through_sequence,42);
  assert.equal(view.trust.guard.decision,'reject');assert.equal(view.trust.next_run_guard.state,'saved_for_next_run');
  assert.equal(view.trust.next_run_guard.config.max_step_deg,2);
  assert.equal(JSON.stringify(view.trust).includes('PRIVATE_'),false);
  assert.match(view.trust.next_run_guard.policy.rules[0].description,/2/);
  raw.telemetry.public_run_shared=false;
  assert.equal(project(raw).trust.guard.decision,'reject','an authorized private trace may expose its own Guard without publishing task text');
  assert.equal(project(raw).events.length,0);
});

test('foreign, missing or malformed trust never supplies current Guard or storage confirmation',()=>{
  for(const mutate of [raw=>{raw.telemetry.trust.trace_id='e'.repeat(32);},raw=>{delete raw.telemetry.detail;},
    raw=>{raw.telemetry.detail.attempt_id='foreign';},raw=>{raw.telemetry.trust.schema='untrusted';}]){
    const raw=trustedState();mutate(raw);const view=project(raw);
    assert.notEqual(view.trust?.persistence.state,'confirmed');assert.notEqual(view.trust?.guard.decision,'reject');
  }
  const raw=trustedState();raw.telemetry.trust.guard.source='PRIVATE_SOURCE';raw.telemetry.trust.persistence.through_sequence=Infinity;
  raw.telemetry.trust.next_run_guard.config.max_step_deg=NaN;
  const view=project(raw);assert.equal(view.trust.guard.state,'unavailable');
  assert.equal(view.trust.persistence.through_sequence,null);assert.equal(view.trust.next_run_guard,null);
  assert.equal(JSON.stringify(view.trust).includes('PRIVATE_'),false);
});


test('private owned trace identity resets history and loss of motion metadata clears the old feed',()=>{
  const raw=trustedState();raw.telemetry.public_run_shared=false;
  const store=widget.createStore();store.update(project(raw));
  const next=trustedState();next.telemetry.public_run_shared=false;
  next.telemetry.trust.trace_id='f'.repeat(32);next.telemetry.detail.path='/clawmetry/trace/'+'f'.repeat(32);
  store.update(project(next));assert.equal(store.samples.length,1);
  store.updateMotion(project(motionState(MOVES)));assert.equal(store.motion.length,4);
  store.updateMotion(project(state()));assert.equal(store.motion.length,0);assert.equal(store.motionSource,null);
});


test('malformed persisted cursor or incomplete Guard identity cannot earn a confirmed or checked badge',()=>{
  for(const value of [null,undefined,0,-1,1.5,NaN,Infinity,true,'42']) {
    const raw=trustedState();raw.telemetry.trust.persistence.through_sequence=value;
    const view=project(raw);assert.equal(view.trust.persistence.state,'unavailable',String(value));
  }
  for(const field of ['config_version','config_hash','sequence'])for(const value of [null,undefined,0,-1,true,'invalid']) {
    const raw=trustedState();raw.telemetry.trust.guard[field]=value;
    const view=project(raw);assert.equal(view.trust.guard.state,'unavailable',field+':'+value);
    assert.equal(widget.guardSummary(view).title,'No Guard decision recorded');
  }
  const raw=trustedState();raw.telemetry.trust.next_run_guard.config.max_rate_deg_s=5;
  raw.telemetry.trust.next_run_guard.policy.rules=[{field:'max_rate_deg_s',value:5}];
  assert.match(project(raw).trust.next_run_guard.policy.rules[0].description,/joint target rate/);
});


test('an unapplied or unsupported draft holds the next launch without pretending to stop an active run',()=>{
  for(const reason of ['unsupported_policy','unapplied_policy','owner_changed']){
    const raw=trustedState();raw.telemetry.trust.launch_hold={state:'held',reason,text:'PRIVATE_DRAFT'};
    const view=project(raw);assert.deepEqual(view.trust.launch_hold,{state:'held',reason});
    assert.equal(JSON.stringify(view.trust).includes('PRIVATE_DRAFT'),false);
    assert.equal(widget.runSummary(view).title,'Next run held for review');
    assert.match(widget.runSummary(view).detail,/does not stop or change an active run/);
  }
  const raw=trustedState();raw.telemetry.trust.launch_hold={state:'held',reason:'PRIVATE_UNKNOWN'};
  assert.equal(project(raw).trust.launch_hold,null);
  assert.equal(widget.runSummary(project(raw)).title,'Run in progress');
});


test('equal attempt IDs cannot override conflicting or one-sided episode bindings',()=>{
  for(const change of ['different','missing_detail','missing_display']){
    const raw=trustedState();
    if(change==='different')raw.telemetry.detail.episode_id='other_episode';
    if(change==='missing_detail')delete raw.telemetry.detail.episode_id;
    if(change==='missing_display'){delete raw.public_run.episode_id;}
    const view=project(raw);assert.equal(view.detail_path,null,change);
    assert.equal(view.trust.guard.state,'unavailable',change);assert.equal(view.trust.persistence.state,'unavailable',change);
  }
});

test('documented complete and resetting source phases remain terminal without implying task success',()=>{
  for(const phase of ['complete','resetting']){
    const raw=state();raw.public_run.status=phase;const view=project(raw);
    assert.equal(view.run.status,phase);assert.match(widget.runSummary(view).title,/Run ended/);
    assert.doesNotMatch(widget.runSummary(view).title,/success|safe|stopped/i);
  }
});

test('private run phase requires exact displayed attempt and episode while text remains private',()=>{
  const raw=state();raw.telemetry.public_run_shared=false;
  raw.public_run.task='PRIVATE_TASK';raw.public_run.model_name='PRIVATE_MODEL';raw.public_run.status='stopped';
  const view=project(raw);
  assert.equal(view.run.status,'stopped');assert.equal(widget.runSummary(view).title,'Run stopped');
  assert.equal(view.run.task,null);assert.equal(view.run.model,null);assert.deepEqual(view.events,[]);
  assert.equal(view.identity.attempt_id,null);assert.equal(view.receipt,null);
  assert.equal(JSON.stringify(view).includes('PRIVATE_'),false);
  for(const displayed of [{attempt_id:'other_attempt',episode_id:'episode_1'},
    {attempt_id:'attempt_1',episode_id:'other_episode'},{attempt_id:'attempt_1'},
    {episode_id:'episode_1'},null]) {
    assert.equal(project(raw,103,displayed).run.status,null,JSON.stringify(displayed));
  }
  raw.public_run.status='PRIVATE_PHASE';assert.equal(project(raw).run.status,null);
  raw.public_run.status=undefined;raw.trajectory.state='stopped';assert.equal(project(raw).run.status,null,'receipt cannot supply run phase');
  raw.telemetry.public_run_shared=true;raw.public_run.task='PRIVATE_TASK';
  const mismatched=project(raw,103,{attempt_id:'attempt_1',episode_id:'other_episode'});
  assert.equal(mismatched.run.task,null);assert.deepEqual(mismatched.events,[]);
});

test('fixed header shows current run phase before English editor without borrowing next-run hold',()=>{
  const {dom,window}=browserHarness(),raw=trustedState();
  raw.telemetry.public_run_shared=false;raw.public_run.status='stopped';
  raw.telemetry.trust.launch_hold={state:'held',reason:'unapplied_policy'};
  window.yamTelemetry.observe(project(raw));dom.getElementById('clawmetryMotionTab').click();
  const phase=dom.getElementById('cm-run-phase'),scroll=dom.getElementById('cm-trust-scroll');
  assert.equal(phase.textContent,'Run stopped');assert.notEqual(phase.parent,scroll);
  assert.equal(phase.parent.parent,dom.getElementById('clawmetryMotionPanel'));
  assert.match(dom.getElementById('cm-run-summary').textContent,/Next run held for review/);
  window.yamTelemetry.observe(project(raw,103,{attempt_id:'attempt_1',episode_id:'different'}));
  assert.equal(phase.textContent,'Run status not reported');
});

test('recorded semantic refusals explain red or unknown evidence and config races remain held in monitor',()=>{
  for(const [reason,phrase] of [['forbidden_yellow_grasp',/recognized yellow/],['forbidden_blue_grasp',/recognized blue/],['forbidden_green_grasp',/recognized green/],['forbidden_red_grasp',/recognized red/],['color_guard_calibration_unvalidated',/physical validation/],['guard_configuration_changed',/Rules changed/]]){
    const view={trust:{schema:'clawmetry.trust.v1',guard:{state:'decision_recorded',mode:'monitor',decision:'reject',config_version:2,sequence:5,config_hash:'a'.repeat(64),missing:[reason]}}};
    const summary=widget.guardSummary(view);assert.equal(summary.title,'Packet held before dispatch');assert.match(summary.detail,phrase);
  }
});

test('actual trust projection retains color config and fixed yellow/red explanations without raw text',()=>{
  for(const color of ['yellow','red','blue','green']){
    const raw=trustedState(),trust=raw.telemetry.trust;
    const rule={forbidden_colors:[color],max_capture_age_s:2};
    trust.next_run_guard.config.object_color_guard=rule;
    trust.next_run_guard.policy.rules.push({field:'object_color_guard',value:rule,description:'PRIVATE_DESCRIPTION'});
    trust.guard.reasons=['forbidden_'+color+'_grasp','PRIVATE_GUARD'];trust.guard.missing=[];trust.guard.coverage=['object_color_guard'];
    const view=project(raw);
    assert.deepEqual(view.trust.next_run_guard.config.object_color_guard,rule);
    assert.match(view.trust.next_run_guard.policy.rules[1].description,new RegExp(color));
    assert.match(widget.guardSummary(view).detail,new RegExp('recognized '+color));
    assert.deepEqual(view.trust.guard.coverage,['object_color_guard']);
    assert.equal(JSON.stringify(view).includes('PRIVATE_'),false);
    raw.telemetry.detail.attempt_id='foreign';assert.notEqual(widget.guardSummary(project(raw)).tone,'held');
  }
});
test('projected color rules reject malformed subsets and retain calibration hold reasons',()=>{
  for(const forbidden_colors of [[],['purple'],['red','red'],['yellow','red'],Array(5).fill('red')]){
    const raw=trustedState();raw.telemetry.trust.next_run_guard.config.object_color_guard={forbidden_colors,max_capture_age_s:2};
    assert.equal(project(raw).trust.next_run_guard,null);
  }
  const raw=trustedState();raw.telemetry.trust.guard.reasons=['color_guard_calibration_unvalidated'];raw.telemetry.trust.guard.missing=['validated_extrinsics'];
  assert.match(widget.guardSummary(project(raw)).detail,/physical validation|Validated camera/);
});

test('recorded outcome separates actual yellow/red feedback holds from next-run settings',()=>{
  for(const color of ['yellow','red']){
    const raw=trustedState(),guard=raw.telemetry.trust.guard;
    guard.config={schema:'clawmetry.blupe.guard.v1',version:2,mode:'block',max_step_deg:2,
      object_color_guard:{forbidden_colors:[color],max_capture_age_s:2}};
    guard.missing=['fresh_measured_hardware_baseline','object_color_feedback_stale'];
    raw.telemetry.trust.next_run_guard.config.object_color_guard={forbidden_colors:[color==='red'?'yellow':'red'],max_capture_age_s:2};
    const view=project(raw),outcome=widget.runSummary(view).outcome;
    assert.equal(outcome.title,'Blocked by Guard');assert.match(outcome.detail,/feedback expired/i);
    assert.doesNotMatch(outcome.detail,/recognized/);assert.match(outcome.rule,new RegExp(color));
    assert.deepEqual(view.trust.guard.config,guard.config);
  }
});

test('a calibrated-region veto and an unqualified camera hold have different outcome explanations',()=>{
  const raw=trustedState();raw.telemetry.trust.guard.missing=['validated_extrinsics'];
  let outcome=widget.runOutcome(project(raw));assert.match(outcome.detail,/camera geometry/);
  assert.doesNotMatch(outcome.detail,/recognized yellow/);
  raw.telemetry.trust.guard.missing=[];raw.telemetry.trust.guard.reasons=['forbidden_yellow_grasp'];
  raw.telemetry.trust.guard.outcome='violation';
  outcome=widget.runOutcome(project(raw));assert.match(outcome.detail,/recognized yellow region/);
});

test('stopped and model completion stay unverified while explicit terminal failure is failed',()=>{
  for(const status of ['stopped','completed','complete','resetting']){
    const raw=state();raw.public_run.status=status;
    raw.public_run.task_success=true;raw.public_run.success=true;
    raw.public_run.events.push({id:3,timestamp:102,kind:'model_response',message:'done: {"summary":"success"}'});
    assert.equal(widget.runOutcome(project(raw)).title,'Unverified');
  }
  for(const status of ['failed','timed_out','safety_aborted']){
    const raw=state();raw.public_run.status=status;assert.equal(widget.runOutcome(project(raw)).title,'Failed');
  }
});

test('foreign Guard evidence and mismatched recorded config never borrow draft values',()=>{
  const raw=trustedState();raw.telemetry.trust.guard.config={schema:'clawmetry.blupe.guard.v1',version:1,mode:'block',object_color_guard:{forbidden_colors:['yellow'],max_capture_age_s:2}};
  let view=project(raw);assert.equal(view.trust.guard.config,undefined);
  assert.doesNotMatch(widget.runOutcome(view).rule,/yellow/);
  raw.telemetry.detail.attempt_id='foreign';view=project(raw);
  assert.equal(widget.runOutcome(view).title,'Unverified');assert.equal(widget.runOutcome(view).rule,null);
});

test('prominent recorded outcome remains above the editor and survives review resizing',()=>{
  const {dom,window}=browserHarness(),raw=trustedState();
  raw.telemetry.trust.guard.missing=['object_color_capture_stale'];
  window.yamTelemetry.observe(project(raw));dom.getElementById('clawmetryMotionTab').click();
  const card=dom.getElementById('cm-run-outcome'),scroll=dom.getElementById('cm-trust-scroll');
  assert.equal(dom.getElementById('cm-run-outcome-title').textContent,'Blocked by Guard');
  assert.match(dom.getElementById('cm-run-outcome-detail').textContent,/camera frame expired/);
  assert.equal(card.parent,scroll);assert.ok(scroll.children.indexOf(card)<scroll.children.indexOf(dom.getElementById('cm-guard-editor-slot')));
  const editor=dom.getElementById('cm-guard-editor-slot');
  dom.getElementById('cm-expand-review').click();dom.getElementById('cm-expand-review').click();
  assert.equal(dom.getElementById('cm-guard-editor-slot'),editor);
  assert.equal(dom.getElementById('cm-run-outcome'),card);
});


function admissionEvent(version=1,robot_id='yam-1',uncertain=false) {
  return {version,robot_id,task_hash:'c'.repeat(64),guard_admission:{schema:'clawmetry.intent_guard.v1',version:1,
    decision:'reject',mode:'block',scope:'explicit_color_intent',physical_permission_granted:false,
    outcome:uncertain?'intent_uncertain':'intent_violation',
    reason_code:uncertain?'color_intent_needs_clarification':'forbidden_color_requested',
    task_hash:'c'.repeat(64),config_hash:'d'.repeat(64),forbidden_colors:['yellow'],
    requested_colors:uncertain?[]:['yellow'],blocked_colors:uncertain?[]:['yellow'],
    summary:'PRIVATE_SERVER_TEXT'},task:'PRIVATE_TASK',runner_name:'PRIVATE_RUNNER'};
}
test('task-bound admission state accepts exact typed veto only and stores no raw task or prose',()=>{
  const state=widget.createAdmissionState(),event=admissionEvent();
  assert.equal(state.reject(event),false);state.start(event);assert.equal(state.reject(event),true);
  assert.equal(state.current().title,'Blocked by Guard');assert.match(state.current().rule,/yellow/);
  assert.equal(JSON.stringify(state.current()).includes('PRIVATE_'),false);
  state.start(admissionEvent(2));assert.equal(state.current(),null);assert.equal(state.reject(event),false);
  state.reject(admissionEvent(2));state.accept(admissionEvent(1));assert.ok(state.current());
  state.accept(admissionEvent(2));assert.equal(state.current(),null);
  state.start(event);assert.equal(state.reject(admissionEvent(1,'other-robot')),false);
  for(const change of [value=>value.task_hash='e'.repeat(64),value=>value.guard_admission.decision='continue',
    value=>value.guard_admission.forbidden_colors=['yellow','red'],value=>value.guard_admission.physical_permission_granted=true,
    value=>value.guard_admission.blocked_colors=[],value=>value.guard_admission.config_hash='bad',
    value=>value.guard_admission.outcome='no_conflict']) {
    const bad=admissionEvent();change(bad);assert.equal(state.reject(bad),false);
  }
  assert.equal(state.reject(admissionEvent(1,'yam-1',true)),true);assert.match(state.current().detail,/Clarify/);
  state.clear();assert.equal(state.current(),null);assert.equal(state.reject(event),false);
});
test('verified local veto opens existing review without borrowing previous run or creating history',()=>{
  const {dom,window,network}=browserHarness(),raw=trustedState();
  window.yamTelemetry.observe(project(raw));
  const before=dom.getElementById('cm-technical-events').textContent;
  const send=(name,detail)=>window.listeners[name]({detail});
  const event=admissionEvent();send('yam:run-submitting',event);
  assert.equal(dom.getElementById('clawmetryMotionPanel').hidden,true);
  send('yam:run-rejected',admissionEvent(0));assert.equal(dom.getElementById('clawmetryMotionPanel').hidden,true);
  const body=dom.getElementById('cm-trust-scroll');body.scrollTop=250;
  send('yam:run-rejected',event);
  assert.equal(body.scrollTop,0);
  assert.equal(dom.getElementById('clawmetryMotionPanel').hidden,false);
  assert.equal(dom.getElementById('cm-run-outcome-context').textContent,'Current request · not queued');
  assert.equal(dom.getElementById('cm-run-outcome-title').textContent,'Blocked by Guard');
  assert.match(dom.getElementById('cm-run-outcome-detail').textContent,/No model call.*no robot task was queued/);
  assert.match(dom.getElementById('cm-run-outcome-rule').textContent,/yellow/);
  assert.match(dom.getElementById('cm-run-summary').textContent,/Previous robot run/);
  const link=descendants(dom.getElementById('clawmetryMotionPanel')).find(node=>node.className==='cm-motion-detail');
  assert.equal(link.textContent,'Previous run ↗');
  assert.equal(dom.getElementById('clawmetryMotionPanel').textContent.includes('PRIVATE_'),false);
  assert.equal(widget.runOutcome(project(raw)).detail.includes('No model call'),false);
  assert.equal(dom.getElementById('cm-technical-events').textContent,before);
  assert.equal(network(),0);
  send('yam:run-accepted',event);assert.equal(dom.getElementById('cm-run-outcome-context').textContent,'Recorded robot run');
});
test('local admission is cleared on submit, accepted launch, owner reset, robot and source changes',()=>{
  for(const action of ['submit','accepted','cleared','robot','source','pagehide']) {
    const {dom,window}=browserHarness();window.yamTelemetry.observe(project(trustedState()));
    const event=admissionEvent();window.listeners['yam:run-submitting']({detail:event});window.listeners['yam:run-rejected']({detail:event});
    if(action==='submit')window.listeners['yam:run-submitting']({detail:admissionEvent(2)});
    if(action==='accepted')window.listeners['yam:run-accepted']({detail:event});
    if(action==='cleared')window.listeners['yam:run-cleared']({detail:{}});
    if(action==='robot')window.listeners['blupe-robot-selected']();
    if(action==='source'){const raw=trustedState();raw.public_run.episode_id='next';window.yamTelemetry.observe(project(raw));}
    if(action==='pagehide')window.listeners.pagehide();
    if(action==='pagehide')window.listeners.pageshow();
    // Visibility/render also proves the cleared state cannot reappear from a timer.
    dom.listeners.visibilitychange();
    assert.equal(dom.getElementById('cm-run-outcome-context').textContent,'Recorded robot run',action);
  }
});


test('idle chat hides nonexistent outcomes and keeps technical facts collapsed',()=>{
  const {dom,window,network}=browserHarness();
  window.yamTelemetry.observe(project({public_run:null,telemetry:{public_run_shared:false}}));
  dom.getElementById('clawmetryMotionTab').click();
  assert.equal(dom.getElementById('cm-run-outcome').hidden,true);
  const technical=dom.getElementById('cm-technical-activity');
  assert.notEqual(technical.open,true);
  assert.ok(descendants(technical).includes(dom.getElementById('cm-guard-state')));
  const empty=descendants(dom.getElementById('clawmetryMotionPanel')).find(node=>node.className==='cm-activity-empty');
  assert.equal(empty.hidden,false);assert.match(empty.textContent,/Send a task/);
  assert.equal(network(),0);
});

test('live trace stays distinct from last recording and visible activity is chronological',()=>{
  const {dom,window}=browserHarness(),raw=motionState(MOVES);
  raw.telemetry.detail={path:'/clawmetry/trace/'+'a'.repeat(32),attempt_id:'attempt_1',episode_id:'episode_1'};
  window.yamTelemetry.observe(project(raw));dom.getElementById('clawmetryMotionTab').click();
  const link=descendants(dom.getElementById('clawmetryMotionPanel')).find(node=>node.className==='cm-motion-detail');
  assert.equal(link.textContent,'Open live trace ↗');
  const rows=dom.getElementById('cm-recent-events').children;
  const times=rows.map(row=>row.children.find(child=>child.tagName==='time').dateTime);
  assert.deepEqual(times,[...times].sort());
  assert.equal(dom.getElementById('cm-run-outcome').hidden,true,'a running task has no final result yet');
});


test('private ended run does not claim a task is still in progress',()=>{
  const {dom,window}=browserHarness(),raw=state();raw.telemetry.public_run_shared=false;
  raw.public_run.status='stopped';window.yamTelemetry.observe(project(raw));
  const task=descendants(dom.getElementById('clawmetryMotionPanel')).find(node=>node.className==='cm-live-task');
  assert.equal(task.textContent,'Task text is private.');assert.doesNotMatch(task.textContent,/in progress/);
});

test('local request refusal never presents previous run moves as current activity',()=>{
  const {dom,window}=browserHarness();window.yamTelemetry.observe(project(motionState(MOVES)));
  const event=admissionEvent();window.listeners['yam:run-submitting']({detail:event});window.listeners['yam:run-rejected']({detail:event});
  assert.equal(dom.getElementById('cm-recent-events').hidden,true);
  assert.equal(dom.getElementById('cm-run-outcome').hidden,false);
  window.listeners['yam:run-cleared']({detail:{}});
  assert.equal(dom.getElementById('cm-recent-events').hidden,false);
});
