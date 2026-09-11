'use strict';

/* The REACH tool registry.
 *
 * One source of truth for every agent tool: its name, its class (what it is
 * allowed to touch), whether it needs approval, its result budget, and the help
 * line the model sees. The system prompt, the client-side parser allow-list and
 * the executor all read from here, so the three lists that used to be
 * hand-duplicated (extension.js prompt, media/chat.js extractTools,
 * agent-bridge.js ACTIONS) can no longer drift apart.
 *
 * Tools are grouped by `tier`:
 *   'core'    - described on every agentic turn
 *   'browser' - described only when a browser task is in play, or on demand
 *               through the `tool_help` meta-tool. Keeps a normal coding turn
 *               as cheap as it is today.
 */

const CORE_TOOLS = {
  read: {
    class: 'read',
    tier: 'core',
    approval: false,
    budget: Infinity, // complete files; the model asked for it explicitly
    help: 'reads one file completely (including unsaved editor changes). '
      + 'Optional inclusive 1-based startLine / endLine for a range.',
    example: { action: 'read', path: 'relative/path' },
  },
  glob: {
    class: 'read',
    tier: 'core',
    approval: false,
    budget: 40000,
    help: 'finds files by their path/name pattern, e.g. "**/*.test.cjs", "src/**/pages-*.js" '
      + 'or "**/*{spec,test}*". Optional path scopes the search to a directory. '
      + 'Use this to locate files; use search for their contents.',
    example: { action: 'glob', pattern: '**/*.test.cjs' },
  },
  search: {
    class: 'read',
    tier: 'core',
    approval: false,
    budget: 40000,
    help: 'greps file contents and returns "path:line: text" matches. Options: '
      + 'regex: true for a regular expression, include: "src/**/*.js" to filter files, '
      + 'caseSensitive: true for an exact-case search.',
    example: { action: 'search', pattern: 'function\\s+\\w+', regex: true, include: 'src/**/*.js' },
  },
  list: {
    class: 'read',
    tier: 'core',
    approval: false,
    budget: 40000,
    help: 'prints a directory tree (empty path = workspace root).',
    example: { action: 'list', path: '' },
  },
  shell: {
    class: 'exec',
    tier: 'core',
    approval: true,
    budget: 40000,
    help: 'runs a command in the integrated terminal and returns its stdout, stderr and exit code '
      + '(the user must approve it first). Use it to verify your own changes.',
    example: { action: 'shell', command: 'npm test' },
  },
  websearch: {
    class: 'browse',
    tier: 'core',
    approval: false,
    budget: 40000,
    help: 'searches the web and reads the top pages.',
    example: { action: 'websearch', query: 'latest news' },
  },
  browse: {
    class: 'browse',
    tier: 'core',
    approval: false,
    budget: 40000,
    help: 'opens a web page and reads its text (with a snapshot when the browser engine is installed). '
      + 'One-shot; use the browser_* tools for anything interactive.',
    example: { action: 'browse', url: 'https://example.com' },
  },
  todo_write: {
    class: 'write',
    tier: 'core',
    approval: false,
    budget: 40000,
    help: 'creates or updates the structured plan / checklist for multi-step tasks.',
    example: { action: 'todo_write', todos: [{ text: 'Step 1', status: 'in_progress' }] },
  },
  todo_read: {
    class: 'read',
    tier: 'core',
    approval: false,
    budget: 40000,
    help: 'reads the current structured plan / checklist.',
    example: { action: 'todo_read' },
  },
  tool_help: {
    class: 'read',
    tier: 'core',
    approval: false,
    budget: 40000,
    help: 'shows extended documentation for specific tool suites (e.g. topic: "browser").',
    example: { action: 'tool_help', topic: 'browser' },
  },
  edit_patch: {
    class: 'write',
    tier: 'core',
    approval: false,
    budget: 40000,
    help: 'applies a multi-hunk patch to an existing workspace file.',
    example: { action: 'edit_patch', path: 'relative/path', hunks: [{ search: 'old text', replace: 'new text' }] },
  },
};

/* The VS Code inspection actions live in agent-bridge.js; they are registered
 * here so the allow-list and prompt stay generated from one place. The bridge
 * owns their execution. */
const IDE_TOOLS = {
  vscode: { class: 'read', tier: 'core', approval: false, budget: 40000, help: 'inspects the editor: tabs, selections, diagnostics, symbols, tasks, extensions, commands.', example: { action: 'vscode', topic: 'diagnostics' } },
  git: { class: 'read', tier: 'core', approval: false, budget: 40000, help: 'inspects Git state: status, diffs, commits, branches, remotes.', example: { action: 'git', operation: 'status' } },
  pullRequests: { class: 'read', tier: 'core', approval: false, budget: 40000, help: 'looks up pull requests (list, search, current branch, compare).', example: { action: 'pullRequests', operation: 'current' } },
  open: { class: 'write', tier: 'core', approval: false, budget: 40000, help: 'opens a file in the editor at an optional line and column.', example: { action: 'open', path: 'relative/path', line: 1 } },
  runTask: { class: 'exec', tier: 'core', approval: true, budget: 40000, help: 'runs an existing discovered VS Code task, after approval. Discover names with the vscode tool first.', example: { action: 'runTask', name: 'build' } },
  vscodeCommand: { class: 'exec', tier: 'core', approval: true, budget: 40000, help: 'executes a discovered public extension command, without arguments, after approval.', example: { action: 'vscodeCommand', command: 'workbench.action.files.save' } },
};

/* Stateful browser verbs. These drive the same Electron session the REACH
 * Browser panel shows, so the user can watch what the agent does. */
const BROWSER_TOOLS = {
  browser_open: {
    class: 'browse', tier: 'browser', approval: false, budget: 12000,
    help: 'opens a URL in the shared REACH browser and returns the page snapshot (title, url, visible text). '
      + 'Call this before any other browser_* tool.',
    example: { action: 'browser_open', url: 'http://127.0.0.1:21887' },
  },
  browser_navigate: {
    class: 'browse', tier: 'browser', approval: false, budget: 12000,
    help: 'navigates the shared browser to a new URL without closing the session, and returns the new page snapshot.',
    example: { action: 'browser_navigate', url: 'http://127.0.0.1:21887/docs' },
  },
  browser_snapshot: {
    class: 'browse', tier: 'browser', approval: false, budget: 12000,
    help: 'returns the current page snapshot: title, url, and the visible text with interactive elements '
      + 'listed as numbered refs you can click or type into.',
    example: { action: 'browser_snapshot' },
  },
  browser_click: {
    class: 'browse', tier: 'browser', approval: false, budget: 8000,
    help: 'clicks an element by its ref from the last snapshot, or by CSS selector.',
    example: { action: 'browser_click', ref: '3' },
  },
  browser_type: {
    class: 'browse', tier: 'browser', approval: false, budget: 8000,
    help: 'types text into an element by ref or CSS selector. Set submit to true to press Enter afterwards.',
    example: { action: 'browser_type', ref: '5', text: 'hello' },
  },
  browser_press: {
    class: 'browse', tier: 'browser', approval: false, budget: 8000,
    help: 'presses a key (for example Enter, Tab, Escape, PageDown) on the focused element or a given ref.',
    example: { action: 'browser_press', key: 'Enter' },
  },
  browser_scroll: {
    class: 'browse', tier: 'browser', approval: false, budget: 8000,
    help: 'scrolls the page by a delta in pixels. Positive y scrolls down.',
    example: { action: 'browser_scroll', y: 800 },
  },
  browser_wait: {
    class: 'browse', tier: 'browser', approval: false, budget: 8000,
    help: 'waits for a CSS selector to appear, or for a number of milliseconds.',
    example: { action: 'browser_wait', selector: '#results' },
  },
  browser_find: {
    class: 'browse', tier: 'browser', approval: false, budget: 8000,
    help: 'searches the page text for a phrase and reports how many matches exist, highlighting the current one. '
      + 'Set findNext: true to jump to the next match; forward: false to search upwards.',
    example: { action: 'browser_find', text: 'release notes' },
  },
  browser_forward: {
    class: 'browse', tier: 'browser', approval: false, budget: 12000,
    help: 'goes forward in the browser history and returns the new snapshot.',
    example: { action: 'browser_forward' },
  },
  browser_reload: {
    class: 'browse', tier: 'browser', approval: false, budget: 12000,
    help: 'reloads the current page and returns the refreshed snapshot. Use this to recover from a crashed or failed page.',
    example: { action: 'browser_reload' },
  },
  browser_back: {
    class: 'browse', tier: 'browser', approval: false, budget: 12000,
    help: 'goes back in the browser history and returns the new snapshot.',
    example: { action: 'browser_back' },
  },
  browser_forward: {
    class: 'browse', tier: 'browser', approval: false, budget: 12000,
    help: 'goes forward in the browser history and returns the new snapshot.',
    example: { action: 'browser_forward' },
  },
  browser_reload: {
    class: 'browse', tier: 'browser', approval: false, budget: 12000,
    help: 'reloads the current page and returns the new snapshot. Use this to recover from a crashed or failed page.',
    example: { action: 'browser_reload' },
  },
  browser_navigate: {
    class: 'browse', tier: 'browser', approval: false, budget: 12000,
    help: 'navigates the existing browser session to a new public http(s) URL and returns the snapshot. Use this to change pages without recreating the session.',
    example: { action: 'browser_navigate', url: 'https://example.com' },
  },
  browser_find: {
    class: 'browse', tier: 'browser', approval: false, budget: 8000,
    help: 'searches the page for a text string and reports the match count plus which match is highlighted. Step through matches with findNext: true.',
    example: { action: 'browser_find', text: 'search term' },
  },
  browser_console: {
    class: 'browse', tier: 'browser', approval: false, budget: 12000,
    help: 'returns console messages (and uncaught errors) captured since the page loaded. '
      + 'Use this to diagnose a broken page.',
    example: { action: 'browser_console' },
  },
  browser_network: {
    class: 'browse', tier: 'browser', approval: false, budget: 12000,
    help: 'returns recent network requests with their status, including failed and 4xx/5xx responses.',
    example: { action: 'browser_network' },
  },
  browser_screenshot: {
    class: 'browse', tier: 'browser', approval: false, budget: 8000,
    help: 'captures a screenshot of the current page and shows it to you as an image.',
    example: { action: 'browser_screenshot' },
  },
  browser_close: {
    class: 'browse', tier: 'browser', approval: false, budget: 8000,
    help: 'closes the shared browser session. Call it when the browser work is finished.',
    example: { action: 'browser_close' },
  },
};

const TOOLS = { ...CORE_TOOLS, ...IDE_TOOLS, ...BROWSER_TOOLS };

/* Names the client parser will accept. Kept in registry order for stable
 * help text and tests. */
function allowedNames() {
  return Object.keys(TOOLS);
}

function browserNames() {
  return Object.keys(BROWSER_TOOLS);
}

function namesByTier(tier) {
  return Object.keys(TOOLS).filter((name) => TOOLS[name].tier === tier);
}

/* One-line-per-tool help for the given tier(s), generated from the registry.
 * Browser verbs are omitted unless asked for, so the common turn stays small. */
const CORE_PROMPT_TOOLS = ['read', 'glob', 'search', 'list', 'shell', 'browse', 'websearch'];

function toolHelp(tier = 'core') {
  const tiers = Array.isArray(tier) ? tier : [tier];
  const lines = [];
  for (const name of CORE_PROMPT_TOOLS) {
    if (!TOOLS[name]) continue;
    lines.push('- ' + name + ': ' + TOOLS[name].help);
    lines.push('  ' + JSON.stringify(TOOLS[name].example));
  }
  if (tiers.includes('browser')) {
    lines.push('Browser tools (drive the shared REACH browser; call browser_open first):');
    for (const name of namesByTier('browser')) {
      lines.push('- ' + name + ': ' + TOOLS[name].help);
      lines.push('  ' + JSON.stringify(TOOLS[name].example));
    }
  } else {
    lines.push('More tools are available on request: emit '
      + JSON.stringify({ action: 'tool_help', topic: 'browser' })
      + ' to receive the browser tool set (' + browserNames().join(', ') + ').');
  }
  return lines.join('\n');
}

/* Approval policy: only exec-class tools prompt, and only when the registry
 * says so. The bridge tools keep their own modal prompts. */
function needsApproval(name) {
  const tool = TOOLS[name];
  return !!(tool && tool.approval);
}

function budgetFor(name, fallback = 40000) {
  const tool = TOOLS[name];
  if (!tool || tool.budget === Infinity) return fallback;
  return tool.budget || fallback;
}

module.exports = {
  TOOLS,
  CORE_TOOLS,
  IDE_TOOLS,
  BROWSER_TOOLS,
  allowedNames,
  browserNames,
  namesByTier,
  toolHelp,
  needsApproval,
  budgetFor,
};
