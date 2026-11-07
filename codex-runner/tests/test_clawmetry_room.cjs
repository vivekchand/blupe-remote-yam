'use strict';
// Local fake DOM and fetch receipts only; no invitation or network is sent.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../static/clawmetry-room.js'),'utf8');
const HOME='https://playground.clawmetry.com',BOOKING='https://calendly.com/vivek-clawmetry/30min';
const all=root=>[root,...root.children.flatMap(all)];
function matches(node,selector){return selector[0]==='.'?node.classList.contains(selector.slice(1)):node.tagName===selector;}
function select(root,selector){
  const parts=selector.trim().split(/\s+/);
  return all(root).find(node=>{
    if(!matches(node,parts.at(-1)))return false;
    let parent=node.parent;
    for(let i=parts.length-2;i>=0;i--){while(parent&&!matches(parent,parts[i]))parent=parent.parent;if(!parent)return false;parent=parent.parent;}
    return true;
  })||null;
}
class Element {
  constructor(tag,document){
    this.tagName=tag;this.document=document;this.children=[];this.attrs={};this.listeners=new Map();this.dataset={};
    this._text='';this.className='';this.hidden=false;this.open=false;this.disabled=false;this.value='';this.valid=true;
    this.classList={add:name=>{if(!this.classList.contains(name))this.className=[this.className,name].filter(Boolean).join(' ');},
      contains:name=>this.className.split(/\s+/).includes(name)};
  }
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(node=>node.textContent).join(' ');}
  setAttribute(name,value){this.attrs[name]=String(value);}
  getAttribute(name){return this.attrs[name]??null;}
  addEventListener(type,listener){const listeners=this.listeners.get(type)||[];listeners.push(listener);this.listeners.set(type,listeners);}
  emit(type){const event={type,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}};
    const results=(this.listeners.get(type)||[]).map(listener=>listener(event));return {event,pending:Promise.all(results)};}
  click(){return this.emit('click');}
  querySelector(selector){return select(this,selector);}
  reportValidity(){return this.valid;}
  focus(){this.document.activeElement=this;}
  showModal(){this.open=true;}
  close(){this.open=false;this.emit('close');}
}
function harness({origin=HOME,search='',readyState='loading',shellInitially=false,selected=true,response={status:202,json:async()=>({status:'received'})}}={}){
  const listeners=new Map(),requests=[],timers=new Map();let serial=0,activityClicks=0;
  const document={readyState,title:'Original room',activeElement:null,
    createElement:tag=>new Element(tag,document),
    getElementById:id=>all(document.body).find(node=>node.id===id)||null,
    querySelector:selector=>select(document.body,selector),
    addEventListener(type,fn,options={}){const entries=listeners.get(type)||[];entries.push({fn,once:options.once===true});listeners.set(type,entries);},
    fire(type){const entries=listeners.get(type)||[];listeners.set(type,entries.filter(entry=>!entry.once));for(const entry of entries)entry.fn();}};
  document.body=new Element('body',document);document.activeElement=document.body;
  function shell(){
    const room=new Element('section',document);room.className='meetingRoom';
    const header=new Element('header',document);header.className='playgroundHeader';
    const intro=new Element('div',document);intro.className='intro';const heading=new Element('h1',document);heading.textContent='BluPe';
    intro.append(heading);header.append(intro);room.append(header);
    const tab=document.getElementById('clawmetryMotionTab')||new Element('button',document);
    tab.id='clawmetryMotionTab';tab.setAttribute('aria-pressed',String(selected));
    const activity=new Element('button',document);activity.id='meetingNotes';activity.setAttribute('aria-expanded','false');
    activity.addEventListener('click',()=>{activityClicks++;activity.setAttribute('aria-expanded',String(activity.getAttribute('aria-expanded')!=='true'));activity.focus();});
    room.append(tab,activity);document.body.append(room);return {room,header,intro,heading,tab,activity};
  }
  const window={location:{origin,search}},context={window,document,URLSearchParams,AbortController,
    fetch:async(url,options)=>{requests.push({url,options});return typeof response==='function'?response(url,options):response;},
    setTimeout(fn,ms){const id=++serial;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)};
  if(shellInitially)shell();vm.runInNewContext(source,context);
  const byClass=name=>all(document.body).find(node=>node.classList.contains(name));
  return {window,document,shell,requests,timers,byClass,activityClicks:()=>activityClicks,
    dialog:()=>all(document.body).find(node=>node.tagName==='dialog'),
    form:()=>all(document.body).find(node=>node.tagName==='form')};
}

test('an early widget mount waits for the shell, then DOMContentLoaded brands and opens only once',()=>{
  const h=harness();h.window.ClawmetryRoom.mount();assert.equal(h.document.title,'Original room');assert.equal(h.dialog(),undefined);
  const focused=h.document.createElement('input');h.document.body.append(focused);focused.focus();
  const ui=h.shell();h.document.fire('DOMContentLoaded');
  assert.equal(h.document.title,'ClawMetry × BluPe · Robot room');assert.equal(ui.heading.getAttribute('aria-label'),'ClawMetry × BluPe');
  assert.equal(h.document.body.classList.contains('clawmetryRoom'),true);
  assert.equal(ui.heading.children.find(node=>node.tagName==='img').src,'/static/clawmetry-logo.svg');
  assert.equal(ui.activity.getAttribute('aria-expanded'),'true');assert.equal(h.activityClicks(),1);assert.equal(h.document.activeElement,focused);
  ui.activity.click();assert.equal(ui.activity.getAttribute('aria-expanded'),'false');
  h.window.ClawmetryRoom.mount();h.window.ClawmetryRoom.mount();h.document.fire('DOMContentLoaded');
  assert.equal(ui.activity.getAttribute('aria-expanded'),'false');assert.equal(h.activityClicks(),2);
  assert.equal(all(h.document.body).filter(node=>node.tagName==='dialog').length,1);
  assert.equal(all(h.document.body).filter(node=>node.classList.contains('cm-room-integrate')).length,1);assert.equal(h.requests.length,0);
});

test('a different explicitly selected tab remains closed, and dialog close restores its trigger focus',()=>{
  const h=harness({shellInitially:true,readyState:'complete',selected:false}),button=h.document.getElementById('meetingNotes');
  assert.equal(button.getAttribute('aria-expanded'),'false');assert.equal(h.activityClicks(),0);
  const link=h.byClass('cm-room-integrate');const click=link.click();assert.equal(click.event.defaultPrevented,true);assert.equal(h.dialog().open,true);
  h.byClass('cm-contact-close').click();assert.equal(h.dialog().open,false);assert.equal(h.document.activeElement,link);
  assert.equal(h.requests.length,0);
});

test('canonical contact submits only the trimmed email and explicit consent without browser credentials',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});
  const h=harness({shellInitially:true,readyState:'complete',response:()=>pending}),form=h.form();
  const email=h.document.getElementById('cm-contact-email'),submit=h.byClass('cm-contact-submit'),status=h.byClass('cm-contact-status');
  email.value='  person@example.test  ';h.byClass('cm-room-integrate').click();
  const submitting=form.emit('submit');assert.equal(submitting.event.defaultPrevented,true);
  assert.equal(h.requests.length,1);assert.equal(submit.disabled,true);assert.equal(email.disabled,true);assert.equal(status.dataset.state,'pending');
  await form.emit('submit').pending;assert.equal(h.requests.length,1,'duplicate submits must not create another email request');
  const request=h.requests[0];assert.equal(request.url,'/api/robot-integration');assert.equal(request.options.method,'POST');
  assert.deepEqual(JSON.parse(request.options.body),{email:'person@example.test',consent:true});
  assert.equal(request.options.credentials,'omit');assert.equal(request.options.mode,'same-origin');assert.equal(request.options.redirect,'error');
  assert.deepEqual(Object.keys(request.options.headers).sort(),['Content-Type','X-Clawmetry-Contact']);
  assert.equal(request.options.headers['X-Clawmetry-Contact'],'1');assert.equal(request.options.headers['Content-Type'],'application/json');
  assert.equal(request.options.signal.aborted,false);assert.equal([...h.timers.values()][0].ms,12000);
  release({status:202,json:async()=>({status:'received',email:'PRIVATE_RECIPIENT',email_sent:true,message:'PRIVATE_SERVER_PROSE'})});
  await submitting.pending;
  assert.equal(status.dataset.state,'received');assert.match(status.textContent,/request is saved/);
  assert.doesNotMatch(status.textContent,/PRIVATE|person@example|delivered|email sent/i);
  assert.equal(form.hidden,true);assert.equal(submit.disabled,false);assert.equal(email.disabled,false);assert.equal(h.timers.size,0);
  const booking=h.byClass('cm-contact-booking');assert.equal(booking.href,BOOKING);assert.equal(booking.rel,'noopener noreferrer');
  assert.equal(booking.hidden,false);assert.equal(h.document.activeElement,booking);
});

test('a 503 uses fixed retry copy, keeps the form usable and never renders server or recipient text',async()=>{
  let jsonReads=0;
  const h=harness({shellInitially:true,readyState:'complete',response:{status:503,json:async()=>{jsonReads++;throw new Error('PRIVATE_SERVER_RESPONSE');}}});
  h.document.getElementById('cm-contact-email').value='person@example.test';await h.form().emit('submit').pending;
  const status=h.byClass('cm-contact-status');assert.equal(status.dataset.state,'error');assert.match(status.textContent,/could not be saved/);
  assert.doesNotMatch(status.textContent,/PRIVATE|person@example|503/);assert.equal(jsonReads,0);
  assert.equal(h.form().hidden,false);assert.equal(h.byClass('cm-contact-submit').disabled,false);assert.equal(h.timers.size,0);
  assert.equal(h.byClass('cm-contact-booking').hidden,false);assert.equal(h.requests.length,1);
});

test('invalid form and malformed 202 receipts cannot claim a saved request',async()=>{
  const h=harness({shellInitially:true,readyState:'complete',response:{status:202,json:async()=>({status:'delivered',email:'PRIVATE_RECIPIENT'})}});
  h.form().valid=false;await h.form().emit('submit').pending;assert.equal(h.requests.length,0);
  h.form().valid=true;h.document.getElementById('cm-contact-email').value='person@example.test';await h.form().emit('submit').pending;
  const status=h.byClass('cm-contact-status');assert.equal(status.dataset.state,'error');assert.match(status.textContent,/could not confirm/);
  assert.doesNotMatch(status.textContent,/PRIVATE|delivered/);assert.equal(h.form().hidden,false);
});

test('noncanonical rooms link to the canonical opt-in page and never mount or POST a contact form',()=>{
  for(const origin of ['http://127.0.0.1:8796','https://playground.blupe.io','https://playground.clawmetry.com.evil.test','http://playground.clawmetry.com']){
    const h=harness({origin,search:'?integrate=robot',shellInitially:true,readyState:'complete'}),link=h.byClass('cm-room-integrate');
    assert.equal(link.href,HOME+'/?integrate=robot');assert.equal(link.target,'_blank');assert.equal(link.rel,'noopener noreferrer');
    assert.equal(link.click().event.defaultPrevented,false);assert.equal(h.dialog(),undefined);assert.equal(h.form(),undefined);assert.equal(h.requests.length,0);
  }
  const canonical=harness({search:'?integrate=robot',shellInitially:true,readyState:'complete'});
  assert.equal(canonical.dialog().open,true);assert.equal(canonical.requests.length,0,'opening a link must not submit consent');
});
