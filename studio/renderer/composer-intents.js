'use strict';

/* Reach Studio composer intent grammar.
 *
 * This module is deliberately pure and dual-loaded (browser + CommonJS). The
 * renderer uses it for completion and dispatch planning; Node tests use the
 * exact same registry and parser so the menu can never drift from execution.
 *
 * Commands are recognized only at the first non-whitespace character. Routing
 * mentions are executable only as a leading block, for example:
 *
 *   @team:"Reviewer"#m1-persona-123 Please inspect the failing test.
 *   @agent:"Research"#agent-abc @model:"qwen3" Continue independently.
 *
 * An @ later in prose, an email address, URL or Windows path remains ordinary
 * message content.
 */
(function expose(factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ReachComposerIntents = api;
})(function buildComposerIntents() {
  const MAX_SUGGESTIONS = 12;

  const COMMANDS = Object.freeze([
    { id: 'help', path: '/help', aliases: ['/commands', '/?'], usage: '/help [command]', description: 'Show the command guide or help for one command.', readOnly: true },
    { id: 'say', path: '/say', aliases: [], usage: '/say literal message', description: 'Send literal text that would otherwise look like a slash command.' },
    { id: 'message', path: '/msg', aliases: ['/message', '/tell', '/dm'], usage: '/msg @target [--model ID] -- message', description: 'Message a team member, saved chat, or custom agent independently.', targetKinds: ['team', 'agent', 'persona', 'current'] },
    { id: 'reply', path: '/reply', aliases: [], usage: '/reply [@team] -- message', description: 'Reply to a team member; defaults to the selected team tab.', targetKinds: ['team'] },
    { id: 'answer', path: '/answer', aliases: ['/team answer'], usage: '/answer [@team-member] -- response', description: 'Answer a pending team-member question; defaults to the selected tab.', targetKinds: ['team'] },
    { id: 'team-run', path: '/team run', aliases: ['/run-team'], usage: '/team run @team-template -- task', description: 'Dispatch a saved team on the current project.', targetKinds: ['team-template'] },
    { id: 'team-add', path: '/team add', aliases: ['/add'], usage: '/team add @persona [--model ID] [--role TEXT] -- task', description: 'Add a temporary working agent to the active Links team.', targetKinds: ['persona', 'agent'] },
    { id: 'team-message', path: '/team message', aliases: ['/team msg'], usage: '/team message @team-member -- message', description: 'Send operator guidance to a live team member.', targetKinds: ['team'] },
    { id: 'team-list', path: '/team list', aliases: [], usage: '/team list', description: 'List saved teams.', readOnly: true, noArgs: true },
    { id: 'team-status', path: '/team status', aliases: ['/who'], usage: '/team status', description: 'Show live team members, workers, and delivery state.', readOnly: true, noArgs: true },
    { id: 'team-pause', path: '/team pause', aliases: ['/pause'], usage: '/team pause', description: 'Pause the active team without discarding its state.', noArgs: true },
    { id: 'team-resume', path: '/team resume', aliases: ['/resume'], usage: '/team resume', description: 'Resume the active team.', noArgs: true },
    { id: 'team-stop', path: '/team stop', aliases: [], usage: '/team stop', description: 'Pause the active team. Use the header control to resume it.', noArgs: true },
    { id: 'agent-new', path: '/agent new', aliases: ['/new'], usage: '/agent new NAME [--model ID] -- first message', description: 'Create and optionally message a new independent chat.' },
    { id: 'agent-message', path: '/agent message', aliases: ['/agent msg'], usage: '/agent message @agent -- message', description: 'Message a saved chat or custom agent independently.', targetKinds: ['agent', 'persona', 'current'] },
    { id: 'agent-open', path: '/agent open', aliases: ['/open'], usage: '/agent open @agent', description: 'Open a saved conversation.', targetKinds: ['agent'] },
    { id: 'agent-list', path: '/agent list', aliases: [], usage: '/agent list', description: 'List saved conversations and custom agents.', readOnly: true, noArgs: true },
    { id: 'agent-status', path: '/agent status', aliases: ['/status'], usage: '/agent status [@agent]', description: 'Show current or named agent state.', readOnly: true, targetKinds: ['agent', 'current'] },
    { id: 'model-current', path: '/model current', aliases: ['/model'], usage: '/model current', description: 'Show this chat override and the default model.', readOnly: true, noArgs: true },
    { id: 'model-list', path: '/model list', aliases: ['/models'], usage: '/model list [filter]', description: 'List models advertised by the active connection.', readOnly: true },
    { id: 'model-use', path: '/model use', aliases: [], usage: '/model use MODEL_ID', description: 'Set the current conversation model override.', targetKinds: ['model'] },
    { id: 'model-reset', path: '/model reset', aliases: ['/model inherit'], usage: '/model reset', description: 'Make this conversation inherit the default model.', noArgs: true },
    { id: 'model-default', path: '/model default', aliases: [], usage: '/model default MODEL_ID', description: 'Set the active connection default model.', targetKinds: ['model'] },
    { id: 'telemetry-summary', path: '/telemetry summary', aliases: ['/telemetry', '/telemetry refresh'], usage: '/telemetry summary', description: 'Sample CPU, GPU, RAM, VRAM, models, and processes.', readOnly: true, noArgs: true },
    { id: 'telemetry-cpu', path: '/telemetry cpu', aliases: [], usage: '/telemetry cpu', description: 'Show the current CPU sample.', readOnly: true, noArgs: true },
    { id: 'telemetry-gpu', path: '/telemetry gpu', aliases: [], usage: '/telemetry gpu', description: 'Show GPU utilization and dedicated/shared memory.', readOnly: true, noArgs: true },
    { id: 'telemetry-memory', path: '/telemetry memory', aliases: ['/telemetry ram'], usage: '/telemetry memory', description: 'Show physical RAM and VRAM usage.', readOnly: true, noArgs: true },
    { id: 'telemetry-io', path: '/telemetry io', aliases: [], usage: '/telemetry io', description: 'Show measured disk and network rates.', readOnly: true, noArgs: true },
    { id: 'telemetry-models', path: '/telemetry models', aliases: [], usage: '/telemetry models', description: 'Show provider-reported models currently in memory.', readOnly: true, noArgs: true },
    { id: 'telemetry-processes', path: '/telemetry processes', aliases: [], usage: '/telemetry processes', description: 'Show the largest process working sets.', readOnly: true, noArgs: true },
    { id: 'telemetry-sources', path: '/telemetry sources', aliases: [], usage: '/telemetry sources', description: 'Show configured model telemetry sources.', readOnly: true, noArgs: true },
    { id: 'stop-all', path: '/stop', aliases: ['/stop all'], usage: '/stop', description: 'Stop active chats and pause the active team.', noArgs: true },
  ]);

  function tokenize(text) {
    const source = String(text || '');
    const tokens = [];
    let index = 0;
    while (index < source.length) {
      while (index < source.length && /\s/.test(source[index])) index++;
      if (index >= source.length) break;
      const start = index;
      let value = '';
      let quote = '';
      let escaped = false;
      while (index < source.length) {
        const char = source[index];
        if (escaped) { value += char; escaped = false; index++; continue; }
        if (char === '\\' && quote) { escaped = true; index++; continue; }
        if (quote) {
          if (char === quote) { quote = ''; index++; continue; }
          value += char; index++; continue;
        }
        if (char === '"' || char === "'") { quote = char; index++; continue; }
        if (/\s/.test(char)) break;
        value += char;
        index++;
      }
      tokens.push({ value, raw: source.slice(start, index), start, end: index, unterminated: !!quote });
    }
    return tokens;
  }

  function commandForms(command) {
    return [command.path, ...(command.aliases || [])];
  }

  function matchCommand(text) {
    const source = String(text || '');
    const leading = /^\s*/.exec(source)[0].length;
    if (source[leading] !== '/') return null;
    const tokens = tokenize(source.slice(leading));
    if (!tokens.length) return { error: 'unknown-command', input: '' };
    let best = null;
    for (const command of COMMANDS) {
      for (const form of commandForms(command)) {
        const words = form.toLowerCase().split(/\s+/);
        if (tokens.length < words.length) continue;
        if (words.every((word, i) => tokens[i].value.toLowerCase() === word)) {
          if (!best || words.length > best.words.length) best = { command, form, words, tokens, leading };
        }
      }
    }
    if (!best) return { error: 'unknown-command', input: tokens[0].value };
    const last = tokens[best.words.length - 1];
    return {
      kind: 'command',
      id: best.command.id,
      command: best.command,
      matched: best.form,
      remainder: source.slice(leading + last.end).replace(/^\s+/, ''),
      prefixEnd: leading + last.end,
    };
  }

  function parseMentionValue(value) {
    const raw = String(value || '');
    if (!raw.startsWith('@')) return null;
    if (raw === '@current') return { kind: 'current', selector: 'current', id: '' };
    if (raw === '@default') return { kind: 'default', selector: 'default', id: '' };
    const match = /^@(?:(team|agent|persona|model|team-template):)?(.+)$/i.exec(raw);
    if (!match) return { error: 'invalid-mention', raw };
    const kind = (match[1] || 'any').toLowerCase();
    let selector = String(match[2] || '').trim();
    let id = '';
    if (kind !== 'model') {
      const marker = selector.lastIndexOf('#');
      if (marker > 0 && marker < selector.length - 1) {
        id = selector.slice(marker + 1);
        selector = selector.slice(0, marker);
      }
    }
    if (!selector && !id) return { error: 'invalid-mention', raw };
    return { kind, selector, id, raw };
  }

  function parseMentionPrefix(text) {
    const source = String(text || '');
    const leading = /^\s*/.exec(source)[0].length;
    const tokens = tokenize(source.slice(leading));
    if (!tokens.length || !tokens[0].value.startsWith('@')) return null;
    const mentions = [];
    let last = null;
    for (const token of tokens) {
      if (!token.value.startsWith('@')) break;
      const mention = parseMentionValue(token.value);
      if (!mention || mention.error) return { error: mention?.error || 'invalid-mention', token: token.raw };
      mentions.push(mention);
      last = token;
    }
    const body = last ? source.slice(leading + last.end).replace(/^\s+/, '') : source;
    return { kind: 'mentions', mentions, body, prefixEnd: last ? leading + last.end : leading };
  }

  function parse(text) {
    const source = String(text || '');
    const leading = /^\s*/.exec(source)[0].length;
    if (source[leading] === '/') return matchCommand(source);
    return parseMentionPrefix(source) || { kind: 'chat', text: source };
  }

  function completionContext(text, cursor) {
    const source = String(text || '');
    const at = Math.max(0, Math.min(source.length, Number.isInteger(cursor) ? cursor : source.length));
    const leading = /^\s*/.exec(source)[0].length;
    if (source[leading] === '/' && at >= leading) {
      const before = source.slice(leading, at);
      if (!before.includes('\n')) {
        const lower = before.toLowerCase();
        const candidates = COMMANDS.flatMap(command => commandForms(command).map(form => ({ command, form })))
          .filter(item => item.form.toLowerCase().startsWith(lower));
        const exact = COMMANDS.some(command => commandForms(command).some(form => lower === form.toLowerCase()));
        const enteringArguments = COMMANDS.some(command => commandForms(command).some(form => lower.startsWith(form.toLowerCase() + ' ')));
        if (candidates.length || (!exact && !enteringArguments)) return { mode: 'command', start: leading, end: at, query: before };
      }
    }
    const before = source.slice(0, at);
    const tokens = tokenize(before);
    const token = tokens.at(-1);
    const prior = token ? tokens.slice(0, -1) : [];
    // Submission executes only a leading routing block. Do not offer an inline
    // completion that would look actionable but be sent as ordinary prose.
    const commandPrefix = token ? matchCommand(before.slice(0, token.start)) : null;
    const commandAcceptsTarget = commandPrefix?.kind === 'command'
      && !commandPrefix.remainder.trim()
      && Array.isArray(commandPrefix.command.targetKinds)
      && commandPrefix.command.targetKinds.length > 0;
    const inLeadingRoutingBlock = prior.every(item => item.value.startsWith('@')) || commandAcceptsTarget;
    if (token && token.end === before.length && token.value.startsWith('@') && inLeadingRoutingBlock) {
      const fullToken = tokenize(source).find(item => item.start === token.start && item.end >= at);
      return {
        mode: 'mention', start: token.start, end: fullToken?.end || at, query: token.value.slice(1), raw: fullToken?.raw || token.raw,
        ...(commandAcceptsTarget ? { commandId: commandPrefix.id } : {}),
      };
    }
    return null;
  }

  function scoreCandidate(candidate, query) {
    const needle = String(query || '').toLocaleLowerCase();
    const hay = String(candidate.search || candidate.label || '').toLocaleLowerCase();
    if (!needle) return 3;
    if (hay === needle) return 0;
    if (hay.startsWith(needle)) return 1;
    if (hay.includes(needle)) return 2;
    return Infinity;
  }

  function filterCandidates(candidates, query, limit = MAX_SUGGESTIONS) {
    const seen = new Set();
    return (Array.isArray(candidates) ? candidates : [])
      .filter(item => {
        const key = `${item.kind || ''}:${item.id || item.insert || item.label || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((item, order) => ({ item, order, score: scoreCandidate(item, query) }))
      .filter(entry => Number.isFinite(entry.score))
      .sort((a, b) => a.score - b.score
        || Number(a.item.priority || 0) - Number(b.item.priority || 0)
        || String(a.item.label || '').localeCompare(String(b.item.label || ''), undefined, { sensitivity: 'base' })
        || String(a.item.kind || '').localeCompare(String(b.item.kind || ''))
        || String(a.item.id || '').localeCompare(String(b.item.id || ''))
        || a.order - b.order)
      .slice(0, Math.max(1, Number(limit) || MAX_SUGGESTIONS))
      .map(entry => entry.item);
  }

  function commandCandidates(query) {
    const source = String(query || '').toLowerCase();
    const candidates = [];
    for (const command of COMMANDS) {
      const forms = commandForms(command);
      for (const form of forms) {
        if (!form.toLowerCase().startsWith(source)) continue;
        candidates.push({
          kind: 'command', id: `${command.id}:${form}`, label: form,
          detail: command.description, insert: form + ' ', search: `${form} ${command.usage} ${command.description}`,
          tooltip: `${form}\nUsage: ${command.usage}\n${command.description}`,
        });
      }
    }
    return filterCandidates(candidates, source, MAX_SUGGESTIONS);
  }

  function quote(value) {
    const text = String(value || '');
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  function mentionInsert(kind, label, id = '') {
    if (kind === 'current' || kind === 'default') return `@${kind}`;
    if (kind === 'model') return `@model:${quote(label)}`;
    const prefix = kind === 'team-template' ? 'team-template' : kind;
    return `@${prefix}:${quote(label)}${id ? `#${id}` : ''}`;
  }

  function suggestionTooltip(item) {
    if (item?.tooltip) return String(item.tooltip);
    return [item?.label, item?.detail].filter(Boolean).map(String).join(' — ');
  }

  function replaceCompletion(text, context, insert) {
    const source = String(text || '');
    if (!context) return { text: source, cursor: source.length };
    const suffix = source.slice(context.end);
    const value = String(insert || '');
    // Completion should always leave the caret ready for the message body.
    // Without a trailing space, choosing a target at the end of the composer
    // produces `#stable-idNext word` and the route no longer parses.
    const needsSpace = value && !/\s$/.test(value) && (!suffix || !/^\s/.test(suffix));
    const next = source.slice(0, context.start) + value + (needsSpace ? ' ' : '') + suffix;
    return { text: next, cursor: context.start + value.length + (needsSpace ? 1 : 0) };
  }

  function takeTargetAndMessage(remainder, allowedOptions = []) {
    const source = String(remainder || '');
    const tokens = tokenize(source);
    if (!tokens.length) return { target: '', message: '', options: {} };
    const targetToken = tokens[0];
    const options = {};
    let cursor = targetToken.end;
    let index = 1;
    while (index < tokens.length) {
      const token = tokens[index];
      if (token.value === '--') { cursor = token.end; break; }
      if (!token.value.startsWith('--')) { cursor = token.start; break; }
      const optionMatch = /^--([a-z-]+)(?:=(.*))?$/i.exec(token.value);
      if (!optionMatch || !allowedOptions.includes(optionMatch[1])) {
        throw new Error(`Unknown option “${token.value}”. Use -- before message text that starts with a dash.`);
      }
      const key = optionMatch[1];
      if (optionMatch[2] !== undefined) {
        options[key] = optionMatch[2]; cursor = token.end; index++; continue;
      }
      const next = tokens[index + 1];
      if (!next || next.value.startsWith('--')) { options[key] = true; cursor = token.end; index++; continue; }
      options[key] = next.value; cursor = next.end; index += 2;
    }
    return {
      target: targetToken.value,
      targetRaw: targetToken.raw,
      message: source.slice(cursor).replace(/^\s+/, ''),
      options,
    };
  }

  function optionValue(options, name) {
    if (!Object.hasOwn(options || {}, name)) return null;
    const value = options[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} requires a value.`);
    return value.trim();
  }

  function singleArgument(text, usage, { optional = false } = {}) {
    const tokens = tokenize(String(text || ''));
    if (tokens.length > 1 || (!optional && tokens.length !== 1)) {
      throw new Error(`Usage: ${usage}`);
    }
    return tokens[0] || null;
  }

  function stripDelimiter(message) {
    return String(message || '').replace(/^\s*--(?:\s+|$)/, '');
  }

  function deliveryKey(target) {
    // `@current` is an alias for the same persisted conversation also exposed
    // as an `@agent` row. They must share one delivery/idempotency identity.
    if (target?.kind === 'current' || target?.kind === 'agent') return `agent:${target?.id || ''}`;
    return `${target?.kind || ''}:${target?.id || ''}`;
  }

  function modelIdFromToken(value) {
    const raw = String(value || '').trim();
    const decoded = tokenize(raw);
    const token = decoded.length === 1 ? decoded[0].value : raw;
    if (!token) return '';
    if (!token.startsWith('@')) return token;
    const mention = parseMentionValue(token);
    if (mention?.kind === 'model' && mention.selector) return mention.selector;
    throw new Error('Choose a model row from the @ menu or enter a model ID.');
  }

  return {
    COMMANDS,
    MAX_SUGGESTIONS,
    tokenize,
    parse,
    matchCommand,
    parseMentionValue,
    parseMentionPrefix,
    completionContext,
    filterCandidates,
    commandCandidates,
    suggestionTooltip,
    mentionInsert,
    replaceCompletion,
    takeTargetAndMessage,
    optionValue,
    singleArgument,
    stripDelimiter,
    deliveryKey,
    modelIdFromToken,
  };
});
