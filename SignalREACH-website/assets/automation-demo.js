/* Scripted documentation example. No network calls, account access, or email sending. */
(() => {
  'use strict';
  function mount(root, {motionEnabled = () => true} = {}) {
    if (!root) return () => {};
    const controller = new AbortController();
    const signal = controller.signal;
    const find = selector => root.querySelector(selector);
    const play = find('[data-automation-play]');
    const next = find('[data-automation-next]');
    const approve = find('[data-automation-approve]');
    const status = find('[data-automation-status]');
    const messages = [...root.querySelectorAll('[data-automation-message]')];
    const phases = [...root.querySelectorAll('[data-automation-phase]')];
    const on = (node, event, fn) => node.addEventListener(event, fn, {signal});
    const labels = ['Ready to play the example.', 'Step 1 of 4: reading the sample client email.',
      'Step 2 of 4: preparing the email draft.', 'Step 3 of 4: review the draft. Approve the simulated send to continue.',
      'Step 4 of 4: example complete. No real email was sent.'];
    let step = motionEnabled() ? 0 : 3;
    let playing = false;
    let timer = null;
    let destroyed = false;
    const stopTimer = () => { clearTimeout(timer); timer = null; };
    const render = () => {
      root.dataset.automationStep = String(step);
      root.dataset.playing = String(playing);
      messages.forEach(message => { message.hidden = Number(message.dataset.automationMessage) > step; });
      phases.forEach(phase => {
        const number = Number(phase.dataset.automationPhase);
        phase.classList.toggle('complete', number < step || step === 4);
        if (number === step) phase.setAttribute('aria-current', 'step');
        else phase.removeAttribute('aria-current');
      });
      find('[data-automation-mail-empty]').hidden = step >= 2;
      find('[data-automation-mail-draft]').hidden = step < 2;
      find('[data-automation-mail-status]').textContent = step === 4 ? 'Sent · simulation' : step >= 2 ? 'Draft for review' : 'Waiting for draft';
      find('[data-automation-review-note]').textContent = step === 4 ? 'Example complete. No real email was sent.'
        : step === 3 ? 'You decide when the draft is ready.' : 'The example pauses here for your review before sending.';
      find('[data-automation-working]').hidden = !playing;
      approve.hidden = step !== 3;
      play.disabled = step >= 3;
      play.textContent = playing ? 'Pause' : step > 0 ? 'Resume' : 'Play example';
      if (step >= 3) play.textContent = step === 3 ? 'Awaiting review' : 'Complete';
      next.disabled = step >= 3;
      status.textContent = labels[step] + (step < 3 && !playing && step > 0 ? ' Playback paused.' : '');
      const log = find('.automation-messages');
      log.scrollTop = log.scrollHeight;
    };
    const schedule = () => {
      stopTimer();
      if (!playing || destroyed) return;
      timer = setTimeout(() => {
        timer = null;
        if (destroyed || !root.isConnected) return;
        step = Math.min(3, step + 1);
        if (step === 3) playing = false;
        render();
        schedule();
      }, 2200);
    };
    const pause = () => { playing = false; stopTimer(); render(); };
    on(play, 'click', () => {
      if (step >= 3) return;
      if (!motionEnabled()) { step = 3; pause(); return; }
      playing = !playing;
      render();
      schedule();
    });
    on(next, 'click', () => { if (step < 3) { step++; pause(); } });
    on(find('[data-automation-replay]'), 'click', () => { step = 0; pause(); });
    on(approve, 'click', () => { if (step === 3) { step = 4; pause(); } });
    on(document, 'visibilitychange', () => { if (document.hidden && playing) pause(); });
    const motionObserver = new MutationObserver(() => { if (!motionEnabled() && playing) pause(); });
    motionObserver.observe(document.documentElement, {attributes: true, attributeFilter: ['data-motion']});
    find('[data-automation-controls]').hidden = false;
    render();
    return () => { destroyed = true; stopTimer(); controller.abort(); motionObserver.disconnect(); };
  }
  window.REACHAutomationDemo = {mount};
})();
