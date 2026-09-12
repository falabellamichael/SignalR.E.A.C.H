(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReachAgentRun = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const protocol = 'AGENT RUN CONTROL (required; ordinary prose never ends the task):\n'
    + 'Use fenced tool blocks to take the next action. A progress update alone is not an action.\n'
    + 'When the user request is fully handled, finish with exactly one standalone block:\n'
    + '```agent_status\n{"status":"complete","summary":"Concrete result delivered and validation performed."}\n```\n'
    + 'Only claim completion after all plan items are completed and no edits or approvals are pending. '
    + 'If you maintain a todo list, update its completed items through todo_write before sending completion.\n'
    + 'For missing user input or approval use this block, then stop:\n```confirm\n{"question":"What decision is needed?","options":["Choice A","Choice B"]}\n```\n'
    + 'For an external blocker use:\n```agent_status\n{"status":"blocked","reason":"What prevents progress and what is needed."}\n```\n'
    + 'Do not emit completion together with tools, edits, or a question. Do not use these blocks as examples in your answer.';

  function start(previous) {
    return { status: 'running', noActionRounds: 0, reason: '',
      structuredActions: !!(previous && previous.status !== 'completed' && (previous.structuredActions || previous.noActionRounds > 0)),
      todos: previous && previous.status !== 'completed' && Array.isArray(previous.todos)
        ? previous.todos.map(t => ({ ...t })) : [] };
  }

  // Closed, standalone top-level fences only. Never recover malformed JSON
  // into a terminal command or interpret markers inside quoted/code examples.
  function parse(text) {
    const lines = String(text || '').split('\n');
    let fence = null, controlStart = -1, blocks = [], remove = new Set(), invalid = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, '');
      const opener = /^ {0,3}(`{3,}|~{3,})([^`]*)$/.exec(line);
      if (!fence) {
        if (!opener) continue;
        fence = opener[1];
        controlStart = fence === '```' && opener[2].trim() === 'agent_status' ? i : -1;
      } else if (new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}\\s*$').test(line)) {
        if (controlStart >= 0) {
          try {
            const value = JSON.parse(lines.slice(controlStart + 1, i).join('\n'));
            if (!value || Array.isArray(value) || typeof value !== 'object'
                || !['complete', 'blocked', 'continue'].includes(value.status)
                || (value.status === 'complete' && !(typeof value.summary === 'string' && value.summary.trim()))
                || (value.status === 'blocked' && !(typeof value.reason === 'string' && value.reason.trim()))) throw Error();
            blocks.push(value);
            for (let n = controlStart; n <= i; n++) remove.add(n);
          } catch { invalid = true; }
        }
        fence = null; controlStart = -1;
      }
    }
    if (controlStart >= 0) invalid = true;
    if (blocks.length > 1) invalid = true;
    return { text: lines.filter((_, i) => !remove.has(i)).join('\n').trim(),
      control: !invalid && blocks.length === 1 ? blocks[0] : null, invalid };
  }

  function decide(run, input) {
    const state = { ...run, todos: Array.isArray(run.todos) ? run.todos : [] };
    const end = (status, reason, action) => ({ state: { ...state, status, reason }, action, reason });
    if (input.stopped) return end('stopped', 'Stopped by you.', 'stop');
    if (input.answerNow) return end('paused', 'Answer now ended this agent run; work may remain.', 'answer');
    if (!input.enabled) return end('paused', 'Agent mode is off.', 'answer');
    if (input.confirm) return end('waiting_input', input.confirm.question, 'wait');
    if (input.control?.status === 'blocked') return end('waiting_input', input.control.reason, 'wait');
    if (input.edits) return end('waiting_edits', 'Review the proposed edits before continuing.', 'wait');
    if (input.tools) {
      if (input.rounds >= input.roundLimit) return end('paused', 'Agent round limit reached. Send continue to resume.', 'pause');
      return { state: { ...state, status: 'running', reason: '', noActionRounds: 0 }, action: 'tools' };
    }
    const open = state.todos.filter(t => t.status !== 'completed');
    if (input.control?.status === 'complete' && !open.length && !input.invalid) {
      return end('completed', input.control.summary, 'complete');
    }
    const count = (state.noActionRounds || 0) + 1;
    state.noActionRounds = count;
    state.structuredActions = true;
    const limit = Math.min(3, Number.isFinite(input.retryLimit) ? input.retryLimit + 1 : 3);
    if (count >= limit || input.rounds >= input.roundLimit) {
      return end('paused', input.rounds >= input.roundLimit
        ? 'Agent round limit reached. Send continue to resume.'
        : 'The endpoint did not supply a usable action after structured recovery. The task is paused, not complete. The saved run will resume in action mode.', 'pause');
    }
    let reason = input.invalid ? 'The run-control block was invalid.'
      : input.control?.status === 'complete' && open.length ? 'Completion was rejected: ' + open.length + ' plan item(s) remain open.'
      : 'The response ended without an action or an explicit task completion.';
    const instruction = reason + '\nUse the executable action response format now. Request the next actual tools or edits. '
      + 'Complete only when the task is finished; ask a question only when user input is necessary.\n'
      + (open.length ? 'Open plan items: ' + JSON.stringify(open) + '\n' : '');
    return { state: { ...state, status: 'running', reason }, action: 'continue', reason, instruction };
  }
  return { protocol, start, parse, decide };
});
