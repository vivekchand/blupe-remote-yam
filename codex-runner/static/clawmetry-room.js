/* Optional ClawMetry room branding and an explicit integration-contact form. */
(() => {
  'use strict';
  const HOME='https://playground.clawmetry.com/';
  const BOOKING='https://calendly.com/vivek-clawmetry/30min';
  let mounted=false;
  function node(parent,tag,text,className) {
    const item=document.createElement(tag);
    if(text)item.textContent=text;
    if(className)item.className=className;
    parent.append(item);return item;
  }
  function contactDialog(trigger) {
    const dialog=node(document.body,'dialog','','cm-contact-dialog');
    dialog.setAttribute('aria-labelledby','cm-contact-title');
    const close=node(dialog,'button','×','cm-contact-close');
    close.type='button';close.setAttribute('aria-label','Close integration request');
    close.addEventListener('click',()=>dialog.close());
    node(dialog,'p','ClawMetry × BluPe','cm-contact-brand');
    const title=node(dialog,'h2','Connect ClawMetry to your robot');title.id='cm-contact-title';
    node(dialog,'p','Bring model calls, robot feedback and Guard decisions into one clear view. We’ll help you connect your arm or humanoid.');
    const form=node(dialog,'form');
    const label=node(form,'label','Work email');label.htmlFor='cm-contact-email';
    const email=node(form,'input');email.id='cm-contact-email';email.name='email';email.type='email';
    email.required=true;email.maxLength=254;email.autocomplete='email';email.inputMode='email';
    const consent=node(form,'p','By sending, you agree that ClawMetry may email you about integrating your robot.','cm-contact-consent');
    consent.id='cm-contact-consent';email.setAttribute('aria-describedby',consent.id);
    const submit=node(form,'button','Send me integration details','cm-contact-submit');submit.type='submit';
    const status=node(dialog,'p','','cm-contact-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
    const booking=node(dialog,'a','Choose a meeting time','cm-contact-booking');
    booking.href=BOOKING;booking.target='_blank';booking.rel='noopener noreferrer';booking.hidden=true;
    let sending=false;
    form.addEventListener('submit',async event=>{
      event.preventDefault();
      if(sending||!form.reportValidity())return;
      sending=true;submit.disabled=true;email.disabled=true;status.textContent='Saving your request…';status.dataset.state='pending';
      const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),12000);
      try {
        const response=await fetch('/api/robot-integration',{method:'POST',credentials:'omit',mode:'same-origin',redirect:'error',signal:controller.signal,
          headers:{'Content-Type':'application/json','X-Clawmetry-Contact':'1'},
          body:JSON.stringify({email:email.value.trim(),consent:true})});
        if(response.status!==202) {
          status.textContent=response.status===429?'Please wait a little before sending another request.':
            response.status===400?'Enter a valid email address and try again.':'Your request could not be saved. Please try again or choose a meeting time.';
          status.dataset.state='error';booking.hidden=false;return;
        }
        const result=await response.json();
        if(result.status!=='received')throw new Error('Unexpected contact response');
        status.textContent='Your request is saved. You can choose a meeting time below, or look out for an email with the next steps.';
        status.dataset.state='received';form.hidden=true;booking.hidden=false;if(dialog.open)booking.focus();
      } catch (_) {
        status.textContent='We could not confirm your request. Please try again or choose a meeting time.';
        status.dataset.state='error';booking.hidden=false;
      } finally {clearTimeout(deadline);sending=false;submit.disabled=false;email.disabled=false;}
    });
    dialog.addEventListener('close',()=>trigger.focus({preventScroll:true}));
    return dialog;
  }
  function mount() {
    if(mounted)return;
    const header=document.querySelector('.meetingRoom .playgroundHeader'),heading=header?.querySelector('h1');
    if(!heading)return;
    mounted=true;document.body.classList.add('clawmetryRoom');
    heading.classList.add('cm-room-brand');heading.replaceChildren();heading.setAttribute('aria-label','ClawMetry × BluPe');
    const mark=node(heading,'img','','cm-room-logo');mark.src='/static/clawmetry-logo.svg';mark.alt='ClawMetry';
    node(heading,'span','×','cm-room-brand-x').setAttribute('aria-hidden','true');
    node(heading,'span','BluPe','cm-room-blupe');
    document.title='ClawMetry × BluPe · Robot room';
    const integrate=node(header.querySelector('.intro'),'a','Integrate your robot','cm-room-integrate');
    integrate.href=HOME+'?integrate=robot';
    if(window.location.origin!=='https://playground.clawmetry.com') {
      integrate.target='_blank';integrate.rel='noopener noreferrer';return;
    }
    const dialog=contactDialog(integrate);
    integrate.addEventListener('click',event=>{event.preventDefault();if(!dialog.open)dialog.showModal();});
    if(new URLSearchParams(window.location.search).get('integrate')==='robot')dialog.showModal();
  }
  window.ClawmetryRoom={mount};
  // The native meeting shell is a later deferred script. Telemetry can mount
  // our tab before it exists, so finish branding and the initial mobile-open
  // state once that shell has completed. Later updates respect user choices.
  const ready=()=>{
    mount();
    const tab=document.getElementById('clawmetryMotionTab'),activity=document.getElementById('meetingNotes');
    if(tab?.getAttribute('aria-pressed')==='true'&&activity?.getAttribute('aria-expanded')==='false') {
      const focused=document.activeElement;activity.click();
      if(focused&&focused!==document.body)focused.focus?.({preventScroll:true});
    }
  };
  if(document.readyState==='complete')ready();
  else document.addEventListener('DOMContentLoaded',ready,{once:true});
})();
