const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(process.env.YAM_TEST_HOSTED_JS || path.join(__dirname, '../static/hosted.js'),'utf8');
const start = source.indexOf('  let attentionSession = null;');
const end = source.indexOf('  function render(state)', start);
const elements = {};
const $ = id => elements[id] ||= {hidden:false,textContent:'',classes:new Set(),focusCount:0,scrolls:[],
  classList:{toggle(name,on){
    // DOMTokenList treats an undefined optional force argument as a toggle.
    if(on === undefined) on=!$(id).classes.has(name);
    on ? $(id).classes.add(name) : $(id).classes.delete(name);
  }},
  closest(selector){assert.equal(selector,'.queuePlace');return $('queuePlace');},
  focus(){this.focusCount++;},scrollIntoView(options){this.scrolls.push(options);}};
let selectedMode = null;
const modeButtons = {};
for (const mode of ['reasoning', 'conversation', 'visitor', 'hide', 'clawmetry']) {
  modeButtons[mode] = {dataset:{conversationMode:mode}, clicks:0,
    getAttribute(name) { assert.equal(name,'aria-controls'); return mode === 'clawmetry' ? 'clawmetryMotionPanel'
      : mode === 'visitor' ? 'visitorChatPanel' : 'liveConversationPanel'; },
    click() { this.clicks++; selectedMode = mode; }};
}
const document = {
  querySelector(selector) {
    if (selector === '[data-conversation-mode][aria-pressed="true"]') return modeButtons[selectedMode] || null;
    return modeButtons[/data-conversation-mode="([^"]+)"/.exec(selector)?.[1]] || null;
  },
  getElementById:$,
};
const context = vm.createContext({$,document,window:{matchMedia:()=>({matches:true})}});
const openStart = source.indexOf('  function openConversationPanel()');
vm.runInContext(source.slice(openStart,source.indexOf('  let setupProvider = null;',openStart)),context);
// Run must preserve the user's selected Activity tab, including optional tabs
// mounted after the shared UI. An explicitly hidden panel still reopens notes.
for (const mode of ['clawmetry','conversation','visitor','reasoning']) {
  selectedMode = mode;
  context.openConversationPanel();
  assert.equal(selectedMode,mode);
  assert.equal(modeButtons[mode].clicks,1);
}
for (const mode of ['hide',null]) {
  selectedMode = mode;
  context.openConversationPanel();
  assert.equal(selectedMode,'reasoning');
}
vm.runInContext(source.slice(start,end),context);
const render = state => context.guideRunAttention(state);
render({status:'queued',session_id:'mine',queue_position:3});
assert.equal($('position').textContent,'#3');
assert.equal($('yourQueue').scrolls.length,0);
assert.equal($('yourQueue').focusCount,0);
render({status:'queued',session_id:'mine',queue_position:2});
assert.equal($('position').textContent,'#2');
assert.equal($('yourQueue').scrolls.length,0);
render({status:'preparing',session_id:'mine'});
assert.equal($('position').textContent,'Up next');
assert.equal($('viewerCue').hidden,false);
assert.equal($('viewerCueTitle').textContent,'Your run is preparing');
assert.equal($('yourQueue').scrolls.length,0);
assert.equal($('yourQueue').focusCount,0);
render({status:'running',session_id:'mine',first_call_wander_enabled:true,run_metrics:{model_calls:0}});
assert.equal($('viewerCueTitle').textContent,'Your robot is warming up');
assert.equal($('viewerCueDetail').textContent,'The arms do a short dance while Astra plans the first move. Your task begins after they return.');
assert.equal($('queueGuidance').textContent,'Startup dance — waiting for Astra’s first decision.');
// Repeated warmup polls and the first settled decision must not scroll again.
render({status:'running',session_id:'mine',first_call_wander_enabled:true,run_metrics:{model_calls:0}});
assert.equal($('liveViewer').scrolls.length,1);
render({status:'running',session_id:'mine',first_call_wander_enabled:true,run_metrics:{model_calls:1}});
assert.equal($('viewerCueTitle').textContent,'Your run is live');
assert.equal($('viewerCueDetail').textContent,'Watch your robot here. The video may follow with a short delay.');
// Missing metrics or disabled startup animation must not claim a dance.
render({status:'running',session_id:'mine',first_call_wander_enabled:true});
assert.equal($('viewerCueTitle').textContent,'Your run is live');
render({status:'running',session_id:'mine',first_call_wander_enabled:false,run_metrics:{model_calls:0}});
assert.equal($('viewerCueTitle').textContent,'Your run is live');
render({status:'running',session_id:'mine'});
assert.equal($('viewerCue').hidden,false);
assert.equal($('viewerCueTitle').textContent,'Your run is live');
assert.equal($('liveViewer').scrolls.length,1);
assert.equal($('liveViewer').scrolls[0].behavior,'instant');
render({status:'running',session_id:'mine'});
assert.equal($('liveViewer').scrolls.length,1);
render({status:'stopped',session_id:'mine'});
assert.equal($('viewerCue').hidden,true);
assert.equal($('liveViewer').classes.has('yourRunLive'),false);
render({status:'idle',public_run:{status:'running'}});
assert.equal($('viewerCue').hidden,true);
for(let i=0;i<3;i++) {
  render({status:'idle'});
  assert.equal($('liveConversationPanel').classes.has('yourTaskReview'),false,'idle polling must not alternate the review highlight');
}

// Prompt submission highlights review immediately; acceptance/queueing alone is not active execution.
render({status:'preparing',new_submission:true});
assert.equal($('viewerCue').hidden,false);
assert.equal($('viewerCueTitle').textContent,'Reviewing your prompt…');
assert.equal($('viewerCueDetail').textContent,'Working through your prompt and preparing the next steps.');
assert.equal($('queuePlace').hidden,true);
assert.equal($('position').textContent,'—');
assert.equal($('yourQueue').classes.has('yourTurnWaiting'),false);
assert.equal($('liveConversationPanel').classes.has('yourTaskReview'),true);
assert.equal($('liveConversationPanel').focusCount,1);
assert.equal($('liveViewer').classes.has('yourRunLive'),false);
render({status:'queued',new_submission:true,session_id:'fixture-session',queue_position:2});
assert.equal($('viewerCueTitle').textContent,'Waiting in the robot queue');
assert.equal($('position').textContent,'#2');
assert.equal($('yourQueue').classes.has('yourTurnWaiting'),true);
assert.equal($('liveConversationPanel').classes.has('yourTaskReview'),false);
assert.equal($('liveViewer').classes.has('yourRunLive'),false);
render({status:'preparing',session_id:'fixture-session',provider:{task_progress:{task:'Fixture'}}});
assert.equal($('viewerCueTitle').textContent,'Your run is preparing');
assert.equal($('yourQueue').classes.has('yourTurnWaiting'),false);
assert.equal($('queuePlace').hidden,true);
assert.equal($('liveViewer').classes.has('yourRunLive'),false);
render({status:'running',session_id:'fixture-session',provider:{task_progress:{task:'Fixture'}}});
assert.equal($('viewerCueTitle').textContent,'Your run is active');
assert.equal($('liveViewer').classes.has('yourRunLive'),true);
assert.equal($('liveConversationPanel').classes.has('yourTaskReview'),false);
const scrolls=$('liveViewer').scrolls.length;
render({status:'running',session_id:'fixture-session',provider:{task_progress:{task:'Fixture'}}});
assert.equal($('liveViewer').scrolls.length,scrolls);
// With ClawMetry selected, prompt review focuses the visible evidence panel,
// never the hidden native notes panel. Queue/start polls keep that selection.
selectedMode = 'clawmetry';
$('liveConversationPanel').hidden = true;
const previousFocus = $('liveConversationPanel').focusCount;
render({status:'preparing',new_submission:true});
assert.equal(selectedMode,'clawmetry');
assert.equal($('clawmetryMotionPanel').focusCount,1);
assert.equal($('liveConversationPanel').focusCount,previousFocus);
render({status:'queued',session_id:'next',queue_position:1});
render({status:'running',session_id:'next'});
assert.equal(selectedMode,'clawmetry');
console.log('Queue handoff checks passed');
