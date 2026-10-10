const $ = (s) => document.querySelector(s);
const reachApi = window.reach;
const isMac = reachApi.platform === 'darwin';
if (isMac) {
  $('#composer-input').placeholder = $('#composer-input').placeholder.replace('Ctrl+', 'Cmd+');
  $('#btn-save-file').textContent = 'Save (Cmd+S)';
  $('#browser-new').title = 'New browser tab (Cmd+T)';
}
$('#set-reach-cli-help').textContent = reachApi.platform === 'win32'
  ? 'Native Reach compiler path inside WSL Ubuntu. Leave blank to find reachc on PATH.'
  : 'Native Reach compiler (reachc) path. Leave blank to find reachc on PATH, including Homebrew and ~/.local/bin. The reach launcher uses Docker and is rejected.';
const md = window.ReachMarkdown;
const composerIntents = window.ReachComposerIntents;
const showNotice = message => window.ReachDialogs.notice(message);
const confirmAction = message => window.ReachDialogs.confirm(message);

let currentProject = null;
let projectSelectionRevision = 0;
const projectCommandStates = new Map(); // project dir -> { tabs, activeId, nextIndex }
const projectCommandRuns = new Map(); // runId -> tab, including background tabs/projects
const projectCommandEarlyEvents = new Map(); // events emitted before invoke() returns
const projectCommandPending = new Set();
let projectCommandCreating = 0;
let projectCommandTabSeq = 0;
let visibleCommandTab = null;
let reachCliAvailable = false;
let currentAgent = null;
let jevAutoDefault = false;
let jevAutoRoutingAgentId = null;
let jevAutoCancelled = false;
function jevAutoModeEnabled() { return (currentAgent?.settings?.jevAutoMode ?? jevAutoDefault) === true; }
function jevAutoDescription(plan) {
  if (plan.token) {
    const controls = plan.features || {};
    const tools = controls.agent === false ? 'direct answer' : ['workspace', 'web', 'terminal'].filter(key => controls[key] !== false).join(', ');
    return `Auto: ${plan.label || 'your selected model'}${tools ? ` · ${tools}` : ''}`;
  }
  const reason = plan.reason === 'missing-key' ? 'add a TypeSafe key in Settings'
    : ['vague-request', 'unusable-request'].includes(plan.reason) ? 'using your selection for this follow-up or long request'
      : plan.reason === 'too-many-candidates' ? 'too many configured options for automatic selection'
        : plan.reason === 'jev-keep' ? 'your current selection fits this request'
          : plan.reason === 'disabled' ? 'using your selected setup'
            : 'Jev is unavailable or uncertain; using your selected setup';
  return `Auto: ${reason}`;
}
const newChatDrafts = new Map(); // unsent composer text and attachments, keyed by draft id
let agents = [];
let agentRunning = false;
const runningAgentIds = new Set();
let stoppingAll = false;

// ---------- editor state ----------
const openFiles = new Map(); // relPath -> { editor, el (tab), dirty, savedText }
let activeFile = null;

function hasUnsavedFilesOutside(dir) {
  return [...openFiles.values()].some(file => file.dir !== dir && file.dirty);
}

function resetEditors() {
  for (const file of openFiles.values()) { file.editor.destroy(); file.el.remove(); file.host.remove(); }
  openFiles.clear();
  activeFile = null;
  editorHost.innerHTML = '';
  editorEmpty.classList.remove('hidden');
  editorStatus.textContent = '';
  $('#btn-save-file').classList.add('hidden');
}

// ---------- elements ----------
const projectList = $('#project-list');
const wslStatus = $('#wsl-status');
const reachVersion = $('#reach-version');
const noProject = $('#no-project');
const projectView = $('#project-view');
const projectName = $('#project-name');
const projectPath = $('#project-path');
const logEl = $('#log');
const cmdInput = $('#cmd-input');
const cmdMode = $('#cmd-mode');
const cmdPrompt = $('#cmd-prompt');
const cmdHint = $('#cmd-hint');
const commandTabsEl = $('#project-command-tabs');
const commandTabStatusEl = $('#project-tab-status');
const runMenuEl = $('#project-run-menu');
const modal = $('#modal');
const approvalModal = $('#approval-modal');
const noAgent = $('#no-agent');
const agentView = $('#agent-view');
const agentNameEl = $('#agent-name');
const agentMetaEl = $('#agent-meta');
const chatLog = $('#chat-log');
const chatScroll = $('#chat-scroll');
const teamDeckSlot = $('#team-deck-slot');
const composerInput = $('#composer-input');
const composerSuggestionsEl = $('#composer-suggestions');
const composerSuggestionStatus = $('#composer-suggestion-status');
const backgroundAgentAlertsEl = $('#background-agent-alerts');
const composerAttachmentsEl = $('#composer-attachments');
let composerAttachments = [];
let composerIntentPending = false;
let composerSuggestionItems = [];
let composerSuggestionIndex = 0;
let composerSuggestionContext = null;
let composerCatalogRevision = 0;
let composerCatalog = [];
let composerModelsCache = { key: '', at: 0, items: [] };
const backgroundAgentGates = new Map();
let composerMentionRetry = null;
let composerOutputContextAgentId = null;
const todosPanel = $('#agent-todos');
const todoList = $('#agent-todo-list');
const queuedIndicator = $('#queued-indicator');
const fileTreeEl = $('#file-tree');
const editorTabsEl = $('#editor-tabs');
const editorHost = $('#editor-host');
const editorEmpty = $('#editor-empty');
const editorStatus = $('#editor-status');

// ---------- tabs ----------
async function showTab(name) {
  if (name === 'settings' && window.ReachAccountMenu) {
    return openSettingsPanel(document.querySelector('.settings-nav button.active')?.dataset.settingsPanel || 'connection');
  }
  const page = $('#page-' + name);
  // A rail view (workspace, playground, about) has no header tab. Without this
  // guard the null lookup below throws a TypeError and the page never shows.
  if (!page) return;
  window.ReachAccountMenu?.close({ returnFocus: false });
  const nextDir = drawerDir(name);
  if (hasUnsavedFilesOutside(nextDir) && !await confirmAction('There are unsaved editor changes. Discard them and switch project?')) return;
  for (const p of document.querySelectorAll('.page')) p.classList.remove('active');
  for (const tab of document.querySelectorAll('.tab')) tab.classList.remove('active');
  page.classList.add('active');
  $('#tab-' + name)?.classList.add('active');
  window.ReachWorkspace?.sync();
  window.ReachWorkspaceShell?.markRail();
  if (name === 'workspace') window.ReachWorkspaceDash?.sync();
  if (name === 'home') window.ReachHome?.sync?.();
  if (name === 'about') window.ReachAbout?.sync();
  if (name === 'refactor') window.ReachRefactor?.sync();
  return refreshFileTree();
}
$('#tab-home').onclick = () => showTab('home');
$('#tab-projects').onclick = () => showTab('projects');
$('#tab-agents').onclick = () => showTab('agents');
$('#tab-create').onclick = () => showTab('create');

