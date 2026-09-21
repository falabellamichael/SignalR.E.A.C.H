import { app, nativeTheme, BrowserWindow, ipcMain, dialog, shell, safeStorage, Notification } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { randomUUID, createHash } from 'crypto';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('./agent/agent-store.cjs');
const { AgentLoop } = require('./agent/agent-loop.cjs');
const { decideAuto, intersectFeatures } = require('./agent/jev-auto.cjs');
const { parseAgentResponse } = require('./agent/agent-response.cjs');
const { createReachToolExecutor } = require('./agent/reach-tool-executor.cjs');
const { PersonaStore } = require('./agent/persona-store.cjs');
const { TeamRunner } = require('./agent/team-runner.cjs');
const { teamConversationTask, teamAnswerNote, teamFollowupTarget } = require('./agent/team-conversation.cjs');
const { listRoleChoices } = require('./agent/roles.cjs');
const reachProcess = require('./agent/reach-process.cjs');
const { resolveInProject } = require('./agent/tool-registry.cjs');
const { readTextFile, writeTextFile } = require('./agent/text-files.cjs');
const { fields: budgetFields, defaults: budgetDefaults, presets: budgetPresets, validateBudgets, resolveBudgets } = require('./agent/budgets.cjs');
const { listDirectory } = require('./agent/file-browser.cjs');
const { StudioBrowser } = require('./browser/host.cjs');
const { Telemetry, defaults: telemetryDefaults, validateSources } = require('./agent/telemetry.cjs');
const { validatePolicy } = require('./agent/tool-policy.cjs');
const { TOOLS } = require('./agent/tool-registry.cjs');
const { readChatResponse } = require('./agent/chat-response.cjs');
const codeIndex = require('./agent/code-index.cjs');
// Refactor workbench engines. Named distinctly from the local `refactorPlans`
// bookkeeping below so a reader can tell engine calls from session handling.
const refactorEngine = require('./agent/refactor.cjs');
const patchEngine = require('./agent/patch-manager.cjs');
const testLoop = require('./agent/test-loop.cjs');
const { runCommand } = require('./agent/platform.cjs');
// The index cache is owned by code-context.cjs, which is also what prompt
// injection and the code.* agent tools use. This file previously kept its own
// Map; three caches for one tree disagree the moment anything writes a file, and
// this one had no TTL and no write-invalidation, so the dashboard could keep
// showing symbols the agent had already renamed or deleted.
const { getIndex: sharedGetIndex, invalidateIndex } = require('./agent/code-context.cjs');
const { AuditLog } = require('./agent/audit-log.cjs');
const { atomicWriteJson } = require('./agent/atomic-write.cjs');
const connections = require('./agent/connections.cjs');
const { createSettingsStore } = require('./agent/settings-store.cjs');
const { resolveEndpoint } = require('./agent/endpoint.cjs');
const { createAttention } = require('./agent/attention.cjs');
const { resolveTeamConnections, summarizeResolutions, hasUnresolvableMember, unsupportedTeamModels } = require('./agent/team-connections.cjs');
const telemetry = new Telemetry({ getSettings: loadSettings });
let studioBrowser = null;

/* The security audit log (PRD, Terminal & Tool Execution Sandbox: "All terminal
 * commands ... are logged to an immutable security audit log").
 *
 * audit-log.cjs existed and was fully tested, but nothing ever constructed one,
 * so the tool runner's `if (context.auditLog)` was always false and every
 * sandbox denial was refused WITHOUT being recorded. One shared instance for the
 * whole app: the log is hash-chained, so two writers would each maintain a
 * different chain and neither file would verify.
 *
 * Lazy and cached because app.getPath('userData') is only valid once Electron is
 * ready, and the smoke harness repoints userData at a temp profile before any
 * agent runs — resolving it at module load would pin the log to the real
 * profile and lose those records.
 */
let securityAuditLog = null;
function getAuditLog() {
  if (!securityAuditLog) {
    securityAuditLog = new AuditLog(path.join(app.getPath('userData'), 'security-audit.jsonl'));
    try { securityAuditLog.open(); }
    catch (error) {
      // An unreadable log must not stop the app: keep writing (open() is called
      // again by write()), and surface the failure rather than swallowing it.
      console.error('Security audit log could not be opened:', error && error.message);
    }
  }
  return securityAuditLog;
}

/* Prompt-console runs in flight, keyed by the renderer-supplied runId so Stop
 * aborts exactly the run the user is looking at. Bounded: a leaked run must not
 * grow this forever. */
const playgroundRuns = new Map();
const MAX_PLAYGROUND_RUNS = 8;

const isDev = !app.isPackaged;
// ESM has no __dirname; import.meta.dirname is supported by the bundled Node runtime.
const rootDir = import.meta.dirname;
// Smoke checks create conversations; keep them out of the user's real store.
const smokeRoot = process.argv.includes('--smoke') ? fs.mkdtempSync(path.join(os.tmpdir(), 'reach-studio-smoke-')) : null;
const smokeProject = smokeRoot ? path.join(smokeRoot, 'project') : null;
if (smokeRoot) app.setPath('userData', path.join(smokeRoot, 'profile'));

let win = null;
const attention = createAttention({ Notification, app, shell, getWindow: () => win });
let agentStore = null;
let personaStore = null;
let agentLoops = new Map(); // agentId -> AgentLoop
let teamRuns = new Map();   // teamRunId -> TeamRunner
const startingTeamConversations = new Set(); // reserve a chat across async validation
const autoPlans = new Map(); // short-lived, one-use routes; never persisted
const autoPlanning = new Map(); // agentId -> AbortController
const autoDecisionCache = new Map();

/* Crash recovery: an unhandled exception or rejection must never silently kill
 * the app mid-run. Log to userData/crash.log, mark any running conversation
 * `failed` in the store (so it is not stuck `running` after a reload), and keep
 * the process alive. Only genuinely fatal errors should quit the app — this
 * handler never does. */
function appendCrashLog(err) {
  try {
    const message = err && err.stack ? String(err.stack)
      : err && err.message ? String(err.message)
      : String(err);
    const line = `${new Date().toISOString()} ${message}\n`;
    const target = path.join(app.getPath('userData'), 'crash.log');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, line, 'utf8');
    // A crash attributable to a running agent run should mark that run failed.
    for (const [id, loop] of agentLoops) {
      if (loop && loop.running && agentStore) {
        try { agentStore.setRunState(id, { status: 'failed', reason: 'Unhandled error: ' + message.slice(0, 200) }); }
        catch { /* a failed store write must not mask the crash */ }
      }
    }
  } catch { /* never throw from a crash handler */ }
}
process.on('uncaughtException', (err) => { console.error('Uncaught exception:', err); appendCrashLog(err); });
process.on('unhandledRejection', (reason) => { console.error('Unhandled rejection:', reason); appendCrashLog(reason); });

const pendingAttachments = new Map(); // opaque picker token -> local file until message send
const MAX_PENDING_ATTACHMENTS = 100;
const MAX_INLINE_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_MIME = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.bmp', 'image/bmp'],
]);

function safeAttachmentName(value) {
  const name = path.basename(String(value || '')).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim();
  return name && name !== '.' && name !== '..' ? name.slice(0, 180) : 'attachment';
}

function stageAgentAttachments(agent, ids) {
  const chosen = [...new Set(Array.isArray(ids) ? ids.map(String) : [])].slice(0, 20);
  if (!chosen.length) return { content: null, display: '', attachments: [] };
  if (!agent?.dir) throw new Error('This conversation is not bound to a project directory.');
  const root = path.join(agent.dir, '.reach', 'attachments', safeAttachmentName(agent.id));
  fs.mkdirSync(root, { recursive: true });
  const files = [];
  for (let index = 0; index < chosen.length; index++) {
    const token = chosen[index], pending = pendingAttachments.get(token);
    if (!pending || pending.agentId !== agent.id) throw new Error('An attachment selection expired. Choose the file again.');
    const stat = fs.statSync(pending.sourcePath);
    if (!stat.isFile()) throw new Error(`${pending.name} is no longer a regular file.`);
    const base = safeAttachmentName(pending.name);
    const destination = path.join(root, `${Date.now()}-${index + 1}-${base}`);
    fs.copyFileSync(pending.sourcePath, destination);
    const relativePath = path.relative(agent.dir, destination).split(path.sep).join('/');
    const mime = IMAGE_MIME.get(path.extname(base).toLowerCase()) || '';
    files.push({ token, name: base, path: relativePath, size: stat.size, mime, destination });
  }
  for (const file of files) pendingAttachments.delete(file.token);
  return { attachments: files };
}

function attachmentMessage(text, staged) {
  const files = staged.attachments || [];
  const prompt = [String(text || '').trim() || 'Inspect the attached file(s).', '',
    'USER-ATTACHED FILES (copied into the project; inspect these exact paths with the available tools):',
    ...files.map(file => `- ${file.path} (${file.size} bytes${file.mime ? `, ${file.mime}` : ''})`),
  ].join('\n');
  const display = [String(text || '').trim(), files.length ? `Attachments: ${files.map(file => file.name).join(', ')}` : ''].filter(Boolean).join('\n\n');
  const images = files.filter(file => file.mime && file.size <= MAX_INLINE_IMAGE_BYTES).map(file => ({
    type: 'image_url', image_url: { url: `data:${file.mime};base64,${fs.readFileSync(file.destination).toString('base64')}` },
  }));
  return {
    content: images.length ? [{ type: 'text', text: prompt }, ...images] : prompt,
    display,
    meta: { source: 'user', attachments: files.map(({ name, path: filePath, size, mime }) => ({ name, path: filePath, size, mime })) },
  };
}

// ---------- stores ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
const settingsStore = createSettingsStore({ file: settingsFile, safeStorage });
/* Settings are normalized on READ so every consumer sees a consistent shape:
 * `connections` (the source of truth) plus the legacy endpoint/accessKey/model
 * projection of whichever connection is active. Normalizing here rather than at
 * each call site is what keeps the ~10 existing `settings.endpoint` readers
 * correct without touching them. */
function loadSettings() {
  return settingsStore.load();
}
function saveSettings(s) {
  settingsStore.save(s);
}
function autoModeEnabled(settings, agent) {
  return (agent?.settings?.jevAutoMode ?? settings.jevAutoMode) === true;
}
function jevConfig(settings, agent = null) {
  return { enabled: settings.jevEnabled === true || autoModeEnabled(settings, agent),
    apiKey: settings.jevApiKey || process.env.TYPESAFE_API_KEY || '' };
}

function autoSnapshot(settings, agent) {
  const ps = getPersonaStore();
  // A hash binds the plan to credentials and configuration without returning
  // either to the renderer or TypeSafe. Any changed selection needs a new plan.
  return createHash('sha256').update(JSON.stringify({ settings,
    agent: { id: agent.id, dir: agent.dir, model: agent.model, connectionId: agent.connectionId,
      settings: agent.settings, personaPrompt: agent.personaPrompt, messages: agent.messages?.length },
    teams: ps.listTeams(), personas: ps.listPersonas(),
  })).digest('hex');
}

function autoCandidates(settings, agent, hasAttachments) {
  const pinned = agent.connectionId ? connections.findConnection(settings, agent.connectionId) : null;
  const current = pinned?.enabled !== false && pinned ? pinned : connections.activeConnection(settings);
  const currentModel = agent.model || current?.model || settings.model || 'gpt-4o-mini';
  const candidates = [{ id: 'current-model', kind: 'model', label: `${current?.name || 'Current connection'} · ${currentModel}`,
    model: currentModel, connectionId: current?.id || '', description: 'The current conversation model.' }];
  for (const connection of connections.enabledPool(settings)) {
    if (!connection.model || connection.id === current?.id && connection.model === currentModel) continue;
    candidates.push({ id: `model:${connection.id}`, kind: 'model', label: `${connection.name} · ${connection.model}`,
      model: connection.model, connectionId: connection.id, description: 'A saved enabled connection and its configured model.' });
  }
  if (!hasAttachments && agent.settings?.features?.agent !== false) {
    const ps = getPersonaStore();
    for (const team of ps.listTeams()) {
      const members = (team.members || []).map(member => ({ member, persona: ps.getPersona(member.personaId) })).filter(row => row.persona);
      if (!members.length) continue;
      candidates.push({ id: `team:${team.id}`, kind: 'team', teamId: team.id, label: team.name,
        description: `${members.length} members working in ${team.mode} mode. Use only if multiple specialists are necessary.`,
        members: members.map(({ member, persona }) => ({ name: persona.name, role: member.role || '' })) });
    }
  }
  return candidates;
}

function consumeAutoPlan(token, { id, text, kind, teamId = '', hasAttachments = false }) {
  if (!token) return null;
  const plan = autoPlans.get(token);
  autoPlans.delete(token);
  const agent = getAgentStore().get(id), settings = loadSettings();
  if (!plan || !agent || plan.expires < Date.now() || plan.id !== id || plan.text !== text
    || plan.route.kind !== kind || kind === 'team' && plan.route.teamId !== teamId
    || plan.hasAttachments !== hasAttachments || !autoModeEnabled(settings, agent)
    || plan.snapshot !== autoSnapshot(settings, agent)) {
    throw new Error('Auto selection expired or the conversation changed. Send again to choose a fresh route.');
  }
  // Keep Stop effective through endpoint and team-catalog validation, until the
  // accepted run takes over its own abort controller.
  cancelAutoPlan(id);
  plan.controller = new AbortController();
  autoPlanning.set(id, plan.controller);
  return plan;
}

function validateAutoDispatch(plan) {
  if (!plan) return;
  if (plan.controller.signal.aborted) throw new Error('Auto selection cancelled.');
  const agent = getAgentStore().get(plan.id);
  if (!agent || plan.snapshot !== autoSnapshot(loadSettings(), agent)) throw new Error('Conversation settings changed while Auto was starting. Send again.');
}

function finishAutoDispatch(plan) {
  if (plan && autoPlanning.get(plan.id) === plan.controller) autoPlanning.delete(plan.id);
}

function cancelAutoPlan(id) {
  autoPlanning.get(id)?.abort();
  autoPlanning.delete(id);
  for (const [token, plan] of autoPlans) if (plan.id === id) autoPlans.delete(token);
}

const projectsFile = () => path.join(app.getPath('userData'), 'projects.json');
function loadProjects() {
  try { return JSON.parse(fs.readFileSync(projectsFile(), 'utf8')); }
  catch { return []; }
}
function saveProjects(ps) {
  atomicWriteJson(projectsFile(), ps);
}

// ---------- agent helpers ----------
function getAgentStore() {
  if (!agentStore) {
    agentStore = new AgentStore(path.join(app.getPath('userData'), 'agents.json'), loadSettings);
  }
  return agentStore;
}

function getPersonaStore() {
  if (!personaStore) {
    personaStore = new PersonaStore(path.join(app.getPath('userData'), 'personas.json'));
  }
  return personaStore;
}

/* Team member edit reviews: members run on ephemeral MemoryStores, so their
 * pending edits live here (main process) keyed by editId until resolved. */
const pendingTeamEdits = new Map(); // editId -> { edit, teamRunId }
const pendingEditResolvers = new Map(); // editId -> fn(accepted) that unblocks a paused member
const pendingMemberAnswers = new Map(); // questionId -> {resolve, teamRunId, agentId, name}

/* Approval bus: the main process owns the map of pending approval requests.
 * Renderer responses arrive over ipcMain.handle('agents:respondApproval')
 * (invoke — which actually reaches main; webContents.send does not). */
const pendingApprovals = new Map(); // requestId -> resolve

function requestApprovalFromRenderer(payload, timeoutMs = 300000) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(false);
    const requestId = 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    pendingApprovals.set(requestId, resolve);
    attention.request(requestId, 'approval');
    win.webContents.send('agent:approval-request', { requestId, ...payload });
    // Zero removes the app's approval deadline; Stop still cancels the run.
    if (timeoutMs > 0) setTimeout(() => {
      if (pendingApprovals.delete(requestId)) { attention.resolve(requestId); resolve(false); }
    }, timeoutMs);
  });
}

async function getAgentLoop(agentId, { autoRoute, newTurn = false } = {}) {
  const cached = agentLoops.get(agentId);
  if (cached?.running) {
    if (autoRoute) throw new Error('Wait for the current run before applying a new Auto selection.');
    return cached;
  }
  if (cached && !cached.settingsStale && (!newTurn || !autoRoute && !cached.autoRoute)) return cached;
  // Edit-review resumes retain the same turn's route. A new prompt replaces it.
  if (!newTurn && autoRoute === undefined) autoRoute = cached?.autoRoute || null;
  const store = getAgentStore();
  const agent = store.get(agentId);
  if (!agent) throw new Error('Agent not found.');

  const settings = loadSettings();
  const route = autoRoute?.route;
  const connectionId = route?.connectionId || agent.connectionId;
  const pinnedCandidate = connectionId ? connections.findConnection(settings, connectionId) : null;
  const pinnedConnection = pinnedCandidate?.enabled === false ? null : pinnedCandidate;
  const selectedConnection = pinnedConnection || connections.activeConnection(settings);
  // Follow gist/.txt endpoint pointers (same rule as models:list) so the
  // agent runs against the same endpoint the user sees in Settings.
  let endpoint = selectedConnection?.endpoint || settings.endpoint || '';
  try { endpoint = await resolveEndpoint(endpoint); }
  catch (e) {
    if (agent.draft) throw new Error('Endpoint: ' + e.message);
    console.warn('endpoint resolve failed, using raw:', e.message);
  }
  // An intentionally keyless selected endpoint must not inherit another
  // connection's credential when Auto routes away from the active default.
  const accessKey = selectedConnection ? selectedConnection.accessKey || '' : settings.accessKey || '';

  const budgets = resolveBudgets(settings, agent.settings);
  const loop = new AgentLoop({
    agentId,
    store,
    endpoint,
    accessKey,
    model: route?.model || agent.model || selectedConnection?.model || settings.model || 'gpt-4o-mini',
    personaPrompt: agent.personaPrompt || '',
    budgets,
    jev: jevConfig(settings, agent),
    featureMask: autoRoute?.features || null,
    projectDir: agent.dir,
    reachExecutor: createReachToolExecutor(),
    browserExecutor: (op, args, ctx) => studioBrowser.agentCommand(op, args, { ...ctx, owner: 'chat:' + ctx.agentId }),
    sendEvent: (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
    requestApproval: payload => requestApprovalFromRenderer(payload, budgets.approvalTimeoutMs),
    auditLog: getAuditLog(),
    requestEditReview: (edit) => {
      store.addPendingEdit(agentId, edit);
      attention.request(edit.editId, 'edit');
      if (win && !win.isDestroyed()) {
        win.webContents.send('agent:edit-pending', { agentId, edit });
      }
    },
  });
  loop.autoRoute = autoRoute || null;
  agentLoops.set(agentId, loop);
  return loop;
}

// ---------- ipc ----------
function registerIpc() {
  ipcMain.handle('telemetry:sample', () => telemetry.sample());
  ipcMain.handle('telemetry:sources', () => loadSettings().telemetrySources || telemetryDefaults);
  ipcMain.handle('telemetry:saveSources', (_event, sources) => {
    saveSettings({ ...loadSettings(), telemetrySources: validateSources(sources) });
    telemetry.providerCache = null; telemetry.cache = null;
    return { ok: true };
  });
  ipcMain.handle('agents:toolSchema', () => Object.entries(TOOLS).map(([name, tool]) => ({ name, class: tool.class, help: tool.help, tier: tool.tier })));
  ipcMain.on('theme:get', event => { event.returnValue = loadSettings().theme === 'light' ? 'light' : 'dark'; });
  ipcMain.handle('theme:set', (_event, theme) => {
    if (!['light', 'dark'].includes(theme)) throw new Error('Invalid theme');
    // Appearance changes must not invalidate an active agent's settings.
    saveSettings({ ...loadSettings(), theme });
    nativeTheme.themeSource = theme;
    if (win && !win.isDestroyed()) win.setBackgroundColor(theme === 'light' ? '#fdf6e3' : '#0a0a0a');
    return theme;
  });
  ipcMain.handle('reach:version', () => reachProcess.reachVersion());
  ipcMain.handle('reach:run', (_e, { cwd, args }) => reachProcess.runReach({ cwd, args }));
  ipcMain.handle('reach:kill', (_e, runId) => reachProcess.killRun(runId));

  ipcMain.handle('projects:get', () => loadProjects());
  ipcMain.handle('projects:remove', (_e, dir) => {
    if (typeof dir !== 'string' || !dir.trim()) return { ok: false, err: 'Choose a project to remove.' };
    // Forget the saved shortcut only. Never remove files, chats, or live runs.
    saveProjects(loadProjects().filter(project => project.dir !== dir));
    return { ok: true };
  });
  ipcMain.handle('projects:save', (_e, ps) => saveProjects(ps));

  ipcMain.handle('settings:get', () => {
    const settings = loadSettings();
    const { jevApiKey, ...publicSettings } = settings;
    return { ...publicSettings, jevKeyConfigured: !!(jevApiKey || process.env.TYPESAFE_API_KEY),
      jevKeySource: jevApiKey ? 'saved' : process.env.TYPESAFE_API_KEY ? 'environment' : '' };
  });
  ipcMain.handle('settings:budgetSchema', () => ({ fields: budgetFields, defaults: budgetDefaults, presets: budgetPresets }));
  ipcMain.handle('settings:save', (_e, s) => {
    const patch = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
    const current = loadSettings();
    const next = { ...current, ...patch };
    if (Object.hasOwn(patch, 'jevEnabled')) next.jevEnabled = patch.jevEnabled === true;
    if (Object.hasOwn(patch, 'jevAutoMode')) next.jevAutoMode = patch.jevAutoMode === true;
    if (patch.jevApiKeyAction === 'clear') next.jevApiKey = '';
    else if (typeof patch.jevApiKey === 'string' && patch.jevApiKey.trim()) next.jevApiKey = patch.jevApiKey.trim();
    else next.jevApiKey = current.jevApiKey || '';
    delete next.jevApiKeyAction;
    delete next.jevKeyConfigured;
    delete next.jevKeySource;
    if (patch.budgets !== undefined) next.budgets = { ...budgetDefaults, ...validateBudgets(patch.budgets) };
    /* Fold a legacy single-endpoint write into the active connection.
     *
     * The merged `next` always carries a `connections` array (loadSettings
     * normalizes it in), so presence cannot mean "the caller manages
     * connections" — only the PATCH can say that. Without this, a
     * saveSettings({endpoint, accessKey, model}) call would report success and
     * then be silently reverted on the next read, because those three fields are
     * derived from the active connection. The smoke suite relies on exactly that
     * call shape in several places.
     */
    const connectionsAuthoritative = Array.isArray(patch.connections);
    saveSettings(connections.applyLegacyWrite(next, { connectionsAuthoritative }));
    // Settings drive every agent loop's endpoint + default model — drop the
    // cache so the next message builds a fresh loop with the new values.
    for (const [id, loop] of agentLoops) {
      if (loop.running || loop.autoRoute && getAgentStore().get(id)?.runState?.status === 'waiting_edits') loop.settingsStale = true;
      else agentLoops.delete(id);
    }
    return { ok: true };
  });

  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('agents:pickAttachments', async (_e, id) => {
    try {
      const agent = getAgentStore().get(String(id || ''));
      if (!agent) throw new Error('Select a conversation before attaching files.');
      const result = await dialog.showOpenDialog(win, {
        title: 'Attach files to this chat',
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled) return { ok: true, attachments: [] };
      const attachments = [];
      for (const sourcePath of result.filePaths.slice(0, 20)) {
        const stat = fs.statSync(sourcePath);
        if (!stat.isFile()) continue;
        const attachmentId = randomUUID();
        const name = safeAttachmentName(sourcePath);
        pendingAttachments.set(attachmentId, { attachmentId, agentId: agent.id, sourcePath, name, size: stat.size, selectedAt: Date.now() });
        attachments.push({ attachmentId, name, size: stat.size });
      }
      while (pendingAttachments.size > MAX_PENDING_ATTACHMENTS) pendingAttachments.delete(pendingAttachments.keys().next().value);
      return { ok: true, attachments };
    } catch (error) {
      return { ok: false, err: error.message };
    }
  });

  ipcMain.handle('project:create', async (_e, { name, parent }) => {
    if (!name || !/^[A-Za-z0-9 _-]+$/.test(name)) return { ok: false, err: 'Invalid project name' };
    const dir = path.join(parent, name);
    if (fs.existsSync(dir)) return { ok: false, err: 'Folder already exists' };
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { return { ok: false, err: e.message }; }
    const runId = reachProcess.runReach({ cwd: dir, args: ['init'] });
    return { ok: true, dir, runId };
  });

  ipcMain.handle('project:list', (_e, dir) => {
    try {
      return fs.readdirSync(dir).filter((f) => !fs.statSync(path.join(dir, f)).isDirectory());
    } catch (e) { return []; }
  });

  ipcMain.handle('shell:openDir', (_e, dir) => shell.openPath(dir));

  // ---------- agent ipc ----------
  ipcMain.handle('agents:list', () => getAgentStore().list());
  ipcMain.handle('agents:get', (_e, id) => {
    const agent = getAgentStore().get(id);
    if (!agent) return null;
    // Format older saved conversations without rewriting their original history.
    return { ...agent, messages: agent.messages.map((m, index) => {
      // Older saved retries remain in the audit history, but are one UI reply.
      if (m.role === 'assistant' && agent.messages[index + 1]?._reachMeta?.source === 'recovery') {
        return { ...m, _reachMeta: { ...m._reachMeta, source: 'recovery-attempt' } };
      }
      if (m.role === 'assistant' && m._reachMeta?.display === undefined) {
        const parsed = parseAgentResponse(m.content);
        if (!parsed.invalid) return { ...m, _reachMeta: { ...m._reachMeta, display: parsed.display, question: parsed.confirm } };
      }
      if (m.role === 'user' && /^(TOOL RESULTS\n|The run-control block was invalid\.|The response ended without an action)/.test(m.content)) {
        return { ...m, _reachMeta: { ...m._reachMeta, source: 'recovery' } };
      }
      return m;
    }) };
  });
  ipcMain.handle('agents:tree', (_e, dir) => ({ ok: true, tree: getAgentStore().tree(dir) }));
  /* Conversation export/import (item 4.4). Export returns a full, self-contained
   * snapshot; import validates + sanitizes it and mints a fresh id so an imported
   * file can never overwrite an existing conversation. */
  ipcMain.handle('agents:export', (_e, id) => {
    const agent = getAgentStore().get(id);
    if (!agent) return { ok: false, err: 'Conversation not found.' };
    const { id: _exportedId, ...agentData } = agent;
    return {
      ok: true,
      conversation: {
        format: 'reach-studio.conversation',
        version: 1,
        exportedAt: new Date().toISOString(),
        agent: agentData,
      },
    };
  });
  ipcMain.handle('agents:import', (_e, payload) => {
    try {
      const data = payload && payload.format === 'reach-studio.conversation' ? payload.agent : payload;
      const agent = getAgentStore().importConversation(data);
      return { ok: true, agent };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  });
  ipcMain.handle('agents:create', (_e, payload = {}) => {
    try {
      const { name, dir, model, personaId, personaPrompt, connectionId } = payload;
      let spec = { name, dir, model, personaId, personaPrompt, connectionId, draft: payload.draft === true && !personaId };
      if (personaId) {
        // Persona identity is authoritative in main. A stale or tampered
        // renderer snapshot cannot pair one persona id with different prompts
        // or connection credentials.
        const persona = getPersonaStore().getPersona(String(personaId));
        if (!persona) throw new Error('Custom agent not found. Refresh the @ menu and try again.');
        const modelOverride = Object.hasOwn(payload, 'modelOverride') ? String(payload.modelOverride || '') : null;
        spec = {
          name: persona.name,
          dir,
          model: modelOverride === null ? persona.model || '' : modelOverride,
          personaId: persona.id,
          personaPrompt: persona.prompt || '',
          connectionId: persona.connectionId || '',
        };
      }
      const agent = getAgentStore().create(spec);
      return { ok: true, agent };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  });
  ipcMain.handle('agents:fork', (_e, { id, upToIndex, name }) => {
    try {
      const child = getAgentStore().fork(id, { upToIndex, name });
      return { ok: true, agent: child };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  });
  ipcMain.handle('agents:update', (_e, { id, ...patch }) => {
    if (patch.settings) validatePolicy(patch.settings, TOOLS);
    if (patch.settings?.jevAutoMode !== undefined && typeof patch.settings.jevAutoMode !== 'boolean') throw new Error('Auto mode must be on or off.');
    if (patch.settings?.budgetOverrides != null) patch.settings.budgetOverrides = validateBudgets(patch.settings.budgetOverrides);
    const agent = getAgentStore().update(id, patch);
    if (agent) for (const runner of teamRuns.values()) if (runner.conversationId === id) {
      runner.agentSettings = structuredClone(agent.settings);
      if (runner.net) runner.net.agentSettings = structuredClone(agent.settings);
      for (const [key, store] of runner.memberStores) Object.assign(store.get(key).settings, structuredClone(agent.settings));
      for (const member of runner.net?.agents.values() || []) if (member.store) Object.assign(member.store.get(member.id).settings, structuredClone(agent.settings));
    }
    // A settings save must not orphan an active loop or break Stop.
    const loop = agentLoops.get(id);
    if (loop?.running || loop?.autoRoute && agent?.runState?.status === 'waiting_edits') loop.settingsStale = true;
    else agentLoops.delete(id);
    return agent ? { ok: true, agent } : { ok: false, err: 'Agent not found' };
  });
  ipcMain.handle('agents:delete', (_e, id) => {
    cancelAutoPlan(id);
    const loop = agentLoops.get(id);
    if (loop) loop.stop();
    agentLoops.delete(id);
    for (const runner of teamRuns.values()) if (runner.conversationId === id) runner.stop();
    return { ok: getAgentStore().remove(id) };
  });
  ipcMain.handle('agents:clear', (_e, id) => {
    try {
      if (agentLoops.get(id)?.running || startingTeamConversations.has(id) || [...teamRuns.values()].some(r => r.conversationId === id)) throw new Error('Finish the current agent or team run before clearing this conversation.');
      const agent = getAgentStore().clear(id);
      agentLoops.delete(id);
      return agent ? { ok: true, agent } : { ok: false, err: 'Conversation not found.' };
    } catch (error) { return { ok: false, err: error.message }; }
  });
  ipcMain.handle('agents:autoPlan', async (_e, { id, text, hasAttachments = false }) => {
    let controller;
    try {
      const agent = getAgentStore().get(id), settings = loadSettings();
      if (!agent) throw new Error('Conversation not found.');
      if (!autoModeEnabled(settings, agent)) return { ok: true, kind: 'current', reason: 'disabled' };
      if (agentLoops.get(id)?.running || startingTeamConversations.has(id)
        || [...teamRuns.values()].some(runner => runner.conversationId === id && !runner.paused)) {
        throw new Error('Wait for the current run before choosing an Auto route.');
      }
      cancelAutoPlan(id);
      controller = new AbortController();
      autoPlanning.set(id, controller);
      const snapshot = autoSnapshot(settings, agent);
      const candidates = autoCandidates(settings, agent, hasAttachments === true);
      const decision = await decideAuto({ apiKey: jevConfig(settings, agent).apiKey, query: String(text || ''),
        candidates, features: agent.settings?.features, signal: controller.signal, cache: autoDecisionCache });
      controller.signal.throwIfAborted();
      const latest = getAgentStore().get(id);
      if (!latest || snapshot !== autoSnapshot(loadSettings(), latest)) throw new Error('Conversation settings changed during Auto selection. Send again.');
      // A valid keep-current judgment can still narrow this turn's features.
      // Transport/configuration fallbacks use the ordinary send path unchanged.
      const route = candidates.find(candidate => candidate.id === decision.candidateId)
        || (['jev-auto', 'jev-keep'].includes(decision.reason) ? candidates[0] : null);
      const summary = { ok: true, kind: route?.kind || 'current', label: route?.label || 'Current selection',
        reason: decision.reason, features: intersectFeatures(agent.settings || {}, decision.features).features,
        usage: decision.usage || null, cached: decision.cached === true };
      if (!route) return summary;
      const token = randomUUID();
      for (const [key, plan] of autoPlans) if (plan.expires < Date.now()) autoPlans.delete(key);
      if (autoPlans.size >= 64) autoPlans.delete(autoPlans.keys().next().value);
      autoPlans.set(token, { id, text: String(text || ''), hasAttachments: hasAttachments === true,
        route, features: summary.features, summary, snapshot, expires: Date.now() + 60000 });
      return { ...summary, token, ...(route.kind === 'team' ? { team: getPersonaStore().listTeams().find(team => team.id === route.teamId) } : {}) };
    } catch (error) {
      return { ok: false, err: controller?.signal.aborted ? 'Auto selection cancelled.' : error.message };
    } finally {
      if (controller && autoPlanning.get(id) === controller) autoPlanning.delete(id);
    }
  });
  ipcMain.handle('agents:send', async (_e, { id, text, attachmentIds = [], autoToken }) => {
    let autoRoute;
    try {
      if (!String(text || '').trim() && !(Array.isArray(attachmentIds) && attachmentIds.length)) {
        throw new Error('A message is required.');
      }
      autoRoute = consumeAutoPlan(autoToken, { id, text: String(text || ''), kind: 'model', hasAttachments: Array.isArray(attachmentIds) && attachmentIds.length > 0 });
      const loop = await getAgentLoop(id, { autoRoute, newTurn: true });
      validateAutoDispatch(autoRoute);
      if (loop.running && Array.isArray(attachmentIds) && attachmentIds.length) {
        throw new Error('Wait for the current run to finish before sending attachments.');
      }
      // Auto-title: the first user message names an untitled chat.
      const store = getAgentStore();
      // Check the saved-history limit before copying selected attachments. A
      // failed picker/staging operation must still leave New Chat unsaved.
      const agent = store.validateMaterialization(id);
      const staged = stageAgentAttachments(agent, attachmentIds);
      const message = staged.attachments.length ? attachmentMessage(text, staged) : String(text || '');
      store.materialize(id);
      if (agent && (!agent.name || agent.name === 'Chat' || agent.name.startsWith('Chat '))) {
        const title = String(text).trim().replace(/\s+/g, ' ').slice(0, 42)
          || staged.attachments.map(file => file.name).join(', ').slice(0, 42) || 'Chat';
        store.update(id, { name: title });
        if (win && !win.isDestroyed()) win.webContents.send('agent:event', { agentId: id, type: 'renamed', name: title, draft: false });
      }
      loop.sendUserMessage(message).catch((err) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('agent:event', { agentId: id, type: 'error', message: err.message });
        }
      });
      if (autoRoute) loop._emit('jev-auto', autoRoute.summary);
      return { ok: true, draft: false, display: staged.attachments.length ? message.display : String(text || '') };
    } catch (e) {
      return { ok: false, err: e.message };
    } finally {
      finishAutoDispatch(autoRoute);
    }
  });
  ipcMain.handle('agents:context', async (_e, id) => {
    const agent = getAgentStore().get(id);
    if (!agent) return null;
    const loop = agentLoops.get(id) || new AgentLoop({ agentId: id, store: getAgentStore(), endpoint: '', projectDir: agent.dir, budgets: resolveBudgets(loadSettings(), agent.settings) });
    return loop.contextStatus();
  });
  ipcMain.handle('agents:compact', async (_e, id) => {
    try { return { ok: true, context: await (await getAgentLoop(id)).compactNow() }; }
    catch (error) { return { ok: false, err: error.message }; }
  });
  ipcMain.handle('agents:stop', (_e, id) => {
    cancelAutoPlan(id);
    const loop = agentLoops.get(id);
    if (loop) loop.stop();
    return { ok: true };
  });
  ipcMain.handle('runs:stop', () => {
    for (const id of autoPlanning.keys()) cancelAutoPlan(id);
    autoPlans.clear();
    for (const loop of agentLoops.values()) if (loop.running) loop.stop();
    for (const runner of teamRuns.values()) runner.pause();
    return { ok: true };
  });
  ipcMain.handle('agents:setTodos', (_e, { id, todos }) => {
    const agent = getAgentStore().setTodos(id, todos);
    return agent ? { ok: true } : { ok: false, err: 'Agent not found' };
  });
  ipcMain.handle('agents:appendNote', (_e, { id, content }) => {
    // Renderer-side summaries (e.g. a finished team run) get persisted so a
    // reload still shows what happened.
    const agent = getAgentStore().appendMessage(id, {
      role: 'assistant',
      content: String(content || '').slice(0, 20000),
      _reachMeta: { source: 'team-run' },
    });
    return agent ? { ok: true } : { ok: false, err: 'Agent not found' };
  });
  ipcMain.handle('agents:respondApproval', (_e, { requestId, approved }) => {
    const resolve = pendingApprovals.get(requestId);
    if (resolve) {
      pendingApprovals.delete(requestId);
      attention.resolve(requestId);
      resolve(approved === true);
    }
    return { ok: true };
  });
  ipcMain.handle('agents:resolveEdit', async (_e, { id, editId, accepted }) => {
    if (typeof accepted !== 'boolean') return { ok: false, err: 'Edit decision must be a boolean.' };
    const store = getAgentStore();
    const edit = store.getPendingEdit(id, editId);
    if (!edit) return { ok: false, err: 'Edit not found (already resolved?)' };
    if (accepted) {
      try {
        fs.mkdirSync(path.dirname(edit.absPath), { recursive: true });
        writeTextFile(edit.absPath, edit.proposed);
      } catch (e) {
        return { ok: false, err: e.message };
      }
    }
    store.resolvePendingEdit(id, editId, accepted);
    store.appendMessage(id, { role: 'user', content: `TOOL RESULTS\nEdit ${edit.path}: ${accepted ? 'accepted and written to disk' : 'rejected by the user'}.`, _reachMeta: { source: 'tool-summary' } });

    // A model turn may propose several files. Resume only after the final card
    // is resolved, then let the model validate, do more work, or give its final
    // response. Do not await the whole model run: the review button should
    // acknowledge the verdict immediately while normal activity events stream.
    let resuming = false;
    attention.resolve(editId);
    const agent = store.get(id);
    if (agent?.runState?.status === 'waiting_edits' && !Object.keys(agent.pendingEdits || {}).length) {
      const loop = await getAgentLoop(id);
      resuming = true;
      void loop.resumeAfterEditReview().catch((error) => {
        if (win && !win.isDestroyed()) win.webContents.send('agent:event', { agentId: id, type: 'error', message: error.message });
      });
    }
    return { ok: true, accepted: !!accepted, resuming };
  });

  // ---------- persona + team ipc ----------
  ipcMain.handle('personas:list', () => getPersonaStore().listPersonas());
  ipcMain.handle('personas:get', (_e, id) => getPersonaStore().getPersona(id));
  ipcMain.handle('personas:create', (_e, p) => {
    try { return { ok: true, persona: getPersonaStore().createPersona(p) }; }
    catch (e) { return { ok: false, err: e.message }; }
  });
  ipcMain.handle('personas:update', (_e, { id, ...patch }) => {
    const p = getPersonaStore().updatePersona(id, patch);
    return p ? { ok: true, persona: p } : { ok: false, err: 'Persona not found' };
  });
  ipcMain.handle('personas:delete', (_e, id) => ({ ok: getPersonaStore().removePersona(id) }));

  /* Preset crew roles (agent/roles.cjs) — a static catalog the team editor
   * renders as a dropdown; nothing here is persisted. */
  ipcMain.handle('roles:list', () => listRoleChoices());

  ipcMain.handle('teams:list', () => getPersonaStore().listTeams());
  ipcMain.handle('teams:get', (_e, id) => getPersonaStore().getTeam(id));
  ipcMain.handle('teams:create', (_e, t) => {
    try { return { ok: true, team: getPersonaStore().createTeam(t) }; }
    catch (e) { return { ok: false, err: e.message }; }
  });
  ipcMain.handle('teams:update', (_e, { id, ...patch }) => {
    try {
      const t = getPersonaStore().updateTeam(id, patch);
      return t ? { ok: true, team: t } : { ok: false, err: 'Team not found' };
    } catch (e) { return { ok: false, err: e.message }; }
  });
  ipcMain.handle('teams:delete', (_e, id) => ({ ok: getPersonaStore().removeTeam(id) }));

  ipcMain.handle('teams:run', async (_e, { teamId, task, dir, agentId, useHistory = true, autoToken }) => {
    let reservedConversation, autoRoute;
    try {
      autoRoute = consumeAutoPlan(autoToken, { id: agentId, text: String(task || ''), kind: 'team', teamId });
      const ps = getPersonaStore();
      const team = ps.getTeam(teamId);
      if (!team) return { ok: false, err: 'Team not found.' };
      if (!team.members || !team.members.length) return { ok: false, err: 'The team has no members.' };
      if (!String(task || '').trim()) return { ok: false, err: 'A task is required.' };
      const conversation = agentId ? getAgentStore().get(agentId) : null;
      if (agentId && !conversation) return { ok: false, err: 'Conversation not found.' };
      if (agentLoops.get(agentId)?.running) return { ok: false, err: 'Wait for this conversation to finish before starting the team.' };
      const conversationKey = agentId || null;
      if (startingTeamConversations.has(conversationKey)) return { ok: false, err: 'A team is already starting in this conversation.' };
      if ([...teamRuns.values()].some(runner => runner.conversationId === conversationKey && !runner.paused)) {
        return { ok: false, err: 'A team is already running in this conversation. Send it a follow-up or pause it first.' };
      }
      startingTeamConversations.add(conversationKey);
      reservedConversation = conversationKey;
      const conversationTask = teamConversationTask(conversation?.messages, task, useHistory !== false);

      const settings = loadSettings();
      let endpoint = settings.endpoint || '';
      try { endpoint = await resolveEndpoint(endpoint); } catch (e) { return { ok: false, err: 'Endpoint: ' + e.message }; }
      for (const [id, runner] of teamRuns) {
        if (runner.conversationId !== conversationKey) continue;
        runner.stop(); teamRuns.delete(id);
      }
      const accessKey = settings.accessKey || '';
      const defaultModel = settings.model || 'gpt-4o-mini';

      // Resolve the roster (personas in member order; skip deleted ones).
      // Keep persona+role PAIRED while filtering — filtering personas alone
      // would misalign roles against indexes after a deletion.
      const roster = team.members
        .map(m => ({ persona: ps.getPersona(m.personaId), role: String(m.role || ''), member: m }))
        .filter(r => r.persona);
      if (!roster.length) return { ok: false, err: 'All team personas were deleted.' };
      const personas = roster.map(r => r.persona);
      const roles = roster.map(r => r.role);

      /* --- Teams are the multi-endpoint case ---------------------------------
       * Everything else in the app runs against the single ACTIVE connection. A
       * team may instead spread its members across the enabled pool, and any
       * member may be pinned to one connection explicitly (persona.connectionId).
       *
       * Resolution happens HERE rather than inside TeamRunner because main.mjs is
       * the only layer that owns settings; the runner stays settings-free and just
       * consumes the roster it is handed. It runs once per run, not per member.
       */
      const memberConnections = resolveTeamConnections({
        settings,
        personas,
        spread: team.spreadConnections === true,
        defaultModel,
      });
      if (hasUnresolvableMember(memberConnections)) {
        return { ok: false, err: 'No connection is available for every team member. Enable at least one connection in Settings > Connections.' };
      }
      /* resolveEndpoint() expands the auto-discovery placeholder and rejects a
       * malformed URL, so each member's endpoint needs the same treatment the
       * team-wide one got above. Distinct endpoints are resolved once each and
       * cached: a 5-member crew on one connection must not resolve it 5 times,
       * and a failure must name the connection that failed rather than surfacing
       * as a mysterious member error mid-run. */
      const resolvedEndpoints = new Map();
      for (const mc of memberConnections) {
        if (resolvedEndpoints.has(mc.endpoint)) continue;
        try {
          resolvedEndpoints.set(mc.endpoint, await resolveEndpoint(mc.endpoint));
        } catch (err) {
          const label = mc.connectionName || mc.endpoint || 'the selected connection';
          return { ok: false, err: `Endpoint (${label}): ${err.message}` };
        }
      }
      for (const mc of memberConnections) {
        mc.endpoint = resolvedEndpoints.get(mc.endpoint) || mc.endpoint;
      }

      /* Fail before launching a crew when a successful OpenAI-compatible
       * /models response proves that a persona model belongs to a different
       * endpoint. Failed/unimplemented catalog requests do not block the run;
       * they provide no evidence either way. Requests are per connection, in
       * parallel, and credentials never enter the returned error or logs. */
      const catalogEntries = new Map();
      for (const mc of memberConnections) {
        if (!catalogEntries.has(mc.endpoint)) catalogEntries.set(mc.endpoint, mc);
      }
      const catalogs = new Map();
      await Promise.all([...catalogEntries.entries()].map(async ([memberEndpoint, mc]) => {
        try {
          const headers = {};
          if (mc.accessKey) headers.Authorization = 'Bearer ' + mc.accessKey;
          const response = await fetch(memberEndpoint.replace(/\/+$/, '') + '/models', {
            headers,
            // A catalog is an optional safety check, never a reason to make the
            // Run button feel hung on an endpoint that omits GET /models.
            signal: AbortSignal.timeout(3000),
          });
          if (!response.ok) return;
          const data = await response.json();
          const ids = new Set((Array.isArray(data?.data) ? data.data : []).map(model => model?.id).filter(id => typeof id === 'string' && id));
          if (ids.size) catalogs.set(memberEndpoint, ids);
        } catch { /* No usable catalog: let the normal chat request decide. */ }
      }));
      const unsupported = unsupportedTeamModels(memberConnections, catalogs);
      if (unsupported.length) {
        const detail = unsupported.map(mc => {
          const name = personas[mc.index]?.name || `Member ${mc.index + 1}`;
          const connection = mc.connectionName || mc.endpoint;
          return `${name}: model "${mc.model}" is not advertised by ${connection}`;
        }).join('; ');
        return { ok: false, err: `Team model routing check failed before launch. ${detail}. Choose a model from that connection or pin the member to the connection that serves it.` };
      }

      // Project dir: explicit → the bound conversation's dir.
      let projectDir = dir || '';
      if (!projectDir && agentId) {
        const agent = getAgentStore().get(agentId);
        if (agent && agent.dir) projectDir = agent.dir;
      }

      if (agentId && !getAgentStore().get(agentId)) return { ok: false, err: 'Conversation was deleted while the team was starting.' };
      const teamRunId = 'teamrun-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const sendEvent = (channel, payload) => {
        // Save before announcing completion so a follow-up sees the answer
        // even after the user switches views or reloads the renderer.
        if (payload.type === 'done' && agentId && payload.answer) {
          getAgentStore().appendMessage(agentId, {
            role: 'assistant', content: teamAnswerNote(team, payload),
            _reachMeta: { source: 'team-run', teamId, teamRunId },
          });
          payload = { ...payload, historySaved: true };
        }
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
      };
      const budgets = resolveBudgets(settings, agentId ? getAgentStore().get(agentId)?.settings : {});
      const runner = new TeamRunner({
        agentSettings: structuredClone(agentId ? getAgentStore().get(agentId)?.settings || {} : {}),
        team: { ...team, members: roster.map(r => r.member) },
        personas,
        roles,
        task: conversationTask,
        projectDir,
        endpoint,
        accessKey,
        defaultModel,
        /* Per-member routing. endpoint/accessKey above remain the crew default —
         * used for anything the runner does not have a member resolution for, and
         * as the documented fallback when a member's resolution is unusable. */
        memberConnections,
        budgets,
        jev: jevConfig(settings, conversation),
        featureMask: autoRoute?.features || null,
        // Shared with the orchestrator loop: members and their subagents run
        // tools, and one hash-chained log means one chain to verify.
        auditLog: getAuditLog(),
        reachExecutor: createReachToolExecutor(),
        browserExecutor: (op, args, ctx) => studioBrowser.agentCommand(op, args, { ...ctx, owner: teamRunId + ':' + ctx.agentId }),
        sendEvent,
        requestApproval: payload => requestApprovalFromRenderer(payload, budgets.approvalTimeoutMs),
        requestEditReview: (edit) => {
          pendingTeamEdits.set(edit.editId, { edit, teamRunId });
          attention.request(edit.editId, 'edit');
          sendEvent('team:edit-pending', { teamRunId, edit });
        },
        // A member paused on waiting_edits: block until the user resolves
        // every edit it proposed this cycle (accept/reject), then hand the
        // decisions back so the member can resume. The renderer drives
        // teams:resolveEdit, which records the verdict into pendingEditResolves.
        awaitEditResolution: (editRefs) => new Promise((resolve) => {
          const pending = new Map(editRefs.map(e => [e.editId, null]));
          const tryFinish = () => {
            for (const v of pending.values()) if (v === null) return;
            const decisions = editRefs.map(e => ({ editId: e.editId, path: e.path, accepted: pending.get(e.editId) }));
            for (const id of pending.keys()) pendingEditResolvers.delete(id);
            resolve(decisions);
          };
          for (const e of editRefs) pendingEditResolvers.set(e.editId, (accepted) => { pending.set(e.editId, accepted); tryFinish(); });
          // If Stop is pressed the runner races its own stop signal; also
          // settle on window teardown so no promise leaks.
          if (win && !win.isDestroyed()) {
            win.once('closed', () => { for (const id of pending.keys()) pendingEditResolvers.delete(id); resolve([]); });
          }
        }),
        requestMemberAnswer: ({ questionId, agentId: waitingAgentId, index, name, question }) => new Promise((resolve) => {
          const agentKey = String(waitingAgentId || (Number.isInteger(index) ? `m${index}-${personas[index]?.id || ''}` : ''));
          pendingMemberAnswers.set(questionId, { resolve, teamRunId, agentId: agentKey, name: String(name || agentKey) });
          if (budgets.questionTimeoutMs > 0) setTimeout(() => {
            const pending = pendingMemberAnswers.get(questionId);
            if (pending && pendingMemberAnswers.delete(questionId)) pending.resolve(null);
          }, budgets.questionTimeoutMs);
        }),
      });
      // Roster, endpoints and advertised models have been validated. Only an
      // accepted team task turns the reusable New Chat draft into saved history.
      validateAutoDispatch(autoRoute);
      if (conversation) {
        const store = getAgentStore();
        store.materialize(agentId);
        if (!conversation.name || conversation.name === 'Chat' || conversation.name.startsWith('Chat ')) {
          const title = String(task).trim().replace(/\s+/g, ' ').slice(0, 42);
          store.update(agentId, { name: title });
          if (win && !win.isDestroyed()) win.webContents.send('agent:event', { agentId, type: 'renamed', name: title, draft: false });
        }
      }
      runner.conversationId = agentId || null;
      teamRuns.set(teamRunId, runner);
      /* Human-readable routing for this run: which connection each member ended
       * up on and WHY (pinned / spread / fallback / stale-pin). Logged to the main
       * process console and returned to the renderer so a team that silently ran
       * three members against one endpoint is diagnosable instead of mysterious.
       * summarizeResolutions names connections and models but NEVER access keys. */
      const routing = summarizeResolutions(memberConnections);
      console.log(`[teams] ${team.name} (${memberConnections.length} members): ${routing}`);
      if (conversation) {
        getAgentStore().appendMessage(agentId, { role: 'user', content: String(task).trim(), _reachMeta: { source: 'team-user', teamId, teamRunId } });
        if (!autoRoute) getAgentStore().update(agentId, { settings: { teamChat: { ...conversation.settings?.teamChat, enabled: true, teamId, useHistory: useHistory !== false } } });
      }
      runner.run(teamRunId).catch((err) => {
        sendEvent('team:event', { teamRunId, type: 'error', message: err.message });
      }).finally(() => {
        for (const [questionId, pending] of pendingMemberAnswers) {
          if (pending.teamRunId !== teamRunId) continue;
          pendingMemberAnswers.delete(questionId);
          pending.resolve(null);
        }
        teamRuns.delete(teamRunId);
      });
      if (autoRoute && win && !win.isDestroyed()) win.webContents.send('agent:event', { agentId, type: 'jev-auto', ...autoRoute.summary, at: Date.now() });
      return { ok: true, teamRunId, routing, autoRouted: !!autoRoute };
    } catch (e) {
      return { ok: false, err: e.message };
    } finally {
      finishAutoDispatch(autoRoute);
      if (reservedConversation !== undefined) startingTeamConversations.delete(reservedConversation);
    }
  });

  ipcMain.handle('teams:stop', (_e, { teamRunId }) => {
    const runner = teamRuns.get(teamRunId);
    if (!runner) return { ok: false, err: 'Team run is no longer available.' };
    runner.pause();
    return { ok: true };
  });
  ipcMain.handle('teams:start', (_e, { teamRunId }) => {
    const runner = teamRuns.get(teamRunId);
    if (!runner) return { ok: false, err: 'Team run is no longer available.' };
    runner.resume();
    return { ok: true };
  });
  ipcMain.handle('teams:controlMember', (_e, { teamRunId, index, agentId, start }) => {
    try {
      const runner = teamRuns.get(teamRunId);
      if (!runner) throw new Error('Team run is no longer available.');
      if (agentId) { runner.net.controlWorker(agentId, start === true); runner.updatePausedState(); }
      else runner.controlMember(index, start === true);
      return { ok: true };
    } catch (error) { return { ok: false, err: error.message }; }
  });

  ipcMain.handle('teams:members', (_e, { teamRunId }) => {
    const runner = teamRuns.get(String(teamRunId || ''));
    if (!runner) return { ok: false, err: 'Team run is no longer available.' };
    const result = runner.members();
    return result.ok ? result : { ok: false, err: result.error };
  });

  ipcMain.handle('teams:followup', (_e, { teamRunId, agentId, teamId, target, message }) => {
    try {
      const runner = teamRuns.get(String(teamRunId || ''));
      if (!runner || runner.conversationId !== agentId || runner.team.id !== teamId) throw new Error('This team run does not belong to the selected conversation and team.');
      if (runner.team.mode !== 'links') throw new Error('Wait for this run to finish, then send your follow-up. Live team messages require Links mode.');
      const text = String(message || '').trim();
      if (!text || text.length > 20000) throw new Error('Team messages must contain 1–20,000 characters.');
      const recipient = teamFollowupTarget(runner, target);
      const result = runner.messageMember(recipient, text);
      if (!result.ok) return { ok: false, err: result.error };
      getAgentStore().appendMessage(agentId, { role: 'user', content: text, _reachMeta: { source: 'team-user', teamId, teamRunId } });
      return { ok: true, name: runner.net.agents.get(recipient)?.name, paused: runner.paused };
    } catch (error) { return { ok: false, err: error.message }; }
  });

  ipcMain.handle('teams:message', (_e, { teamRunId, target, message }) => {
    try {
      const runner = teamRuns.get(String(teamRunId || ''));
      if (!runner) throw new Error('Team run is no longer available.');
      const text = String(message || '').trim();
      if (!text) throw new Error('A message is required.');
      if (text.length > 20000) throw new Error('Team messages are limited to 20,000 characters.');
      const result = runner.messageMember(String(target || ''), text);
      return result.ok ? result : { ok: false, err: result.error, candidates: result.candidates };
    } catch (error) { return { ok: false, err: error.message }; }
  });

  ipcMain.handle('teams:addAgent', async (_e, payload = {}) => {
    try {
      const runner = teamRuns.get(String(payload.teamRunId || ''));
      if (!runner) throw new Error('Team run is no longer available.');
      if (runner.team.mode !== 'links') throw new Error('Run-only agents can join Links teams. Parallel and chain teams have a fixed result roster.');
      const ps = getPersonaStore();
      const saved = payload.agentId ? getAgentStore().get(String(payload.agentId)) : null;
      const persona = payload.personaId ? ps.getPersona(String(payload.personaId)) : null;
      if (payload.personaId && !persona) throw new Error('Custom agent not found. Refresh the @ menu and try again.');
      if (payload.agentId && !saved) throw new Error('Saved conversation not found. Refresh the @ menu and try again.');
      const template = persona || saved || {};
      const name = String(payload.name || template.name || '').trim().slice(0, 80);
      if (!name) throw new Error('Choose a custom agent or provide a name.');
      const task = String(payload.task || '').trim().slice(0, 20000);
      const role = String(payload.role || '').trim().slice(0, 240);
      const modelOverride = String(payload.model || '').trim().slice(0, 240);
      const routePersona = {
        id: persona?.id || saved?.personaId || '',
        name,
        model: modelOverride || template.model || '',
        connectionId: persona?.connectionId || saved?.connectionId || '',
      };
      const settings = loadSettings();
      const [route] = resolveTeamConnections({ settings, personas: [routePersona], spread: false, defaultModel: settings.model || runner.defaultModel });
      if (!route?.endpoint) throw new Error('No enabled connection is available for this agent.');
      route.endpoint = await resolveEndpoint(route.endpoint);
      const result = runner.addRuntimeAgent({
        name,
        model: modelOverride || route.model,
        prompt: persona?.prompt || saved?.personaPrompt || '',
        role,
        task,
        endpoint: route.endpoint,
        accessKey: route.accessKey,
      });
      if (!result.ok) return { ok: false, err: result.error };
      return {
        ...result,
        connectionName: route.connectionName || '',
        connectionReason: route.reason || '',
      };
    } catch (error) { return { ok: false, err: error.message }; }
  });

  ipcMain.handle('teams:resolveEdit', (_e, { editId, accepted }) => {
    if (typeof accepted !== 'boolean') return { ok: false, err: 'Edit decision must be a boolean.' };
    const entry = pendingTeamEdits.get(editId);
    if (!entry) return { ok: false, err: 'Edit not found (already resolved?)' };
    if (accepted) {
      try {
        fs.mkdirSync(path.dirname(entry.edit.absPath), { recursive: true });
        writeTextFile(entry.edit.absPath, entry.edit.proposed);
      } catch (e) {
        // Keep the proposal pending so the review card can report the error
        // and let the user retry after fixing the underlying filesystem issue.
        return { ok: false, err: e.message };
      }
    }
    pendingTeamEdits.delete(editId);
    attention.resolve(editId);
    // Unblock the paused team member (if this edit belongs to one).
    const resolver = pendingEditResolvers.get(editId);
    if (resolver) { pendingEditResolvers.delete(editId); resolver(!!accepted); }
    return { ok: true, accepted: !!accepted };
  });

  ipcMain.handle('teams:answerQuestion', (_e, { questionId, answer }) => {
    const pending = pendingMemberAnswers.get(questionId);
    if (!pending) return { ok: false, err: 'No member is waiting for this question (expired or already answered).' };
    pendingMemberAnswers.delete(questionId);
    pending.resolve(String(answer === undefined ? '' : answer));
    return { ok: true };
  });

  ipcMain.handle('teams:answerMember', (_e, { teamRunId, agentId, answer }) => {
    const runId = String(teamRunId || '');
    const targetId = String(agentId || '');
    if (!teamRuns.has(runId)) return { ok: false, err: 'Team run is no longer available.' };
    const matches = [...pendingMemberAnswers.entries()].filter(([, pending]) => pending.teamRunId === runId && pending.agentId === targetId);
    if (!matches.length) return { ok: false, err: 'That member is not waiting for a structured answer. Use /reply for ordinary guidance.' };
    if (matches.length > 1) return { ok: false, err: 'That member has more than one pending question. Answer it from the visible question card.' };
    const [questionId, pending] = matches[0];
    const text = String(answer || '').trim();
    if (!text) return { ok: false, err: 'An answer is required.' };
    if (text.length > 20000) return { ok: false, err: 'Answers are limited to 20,000 characters.' };
    pendingMemberAnswers.delete(questionId);
    pending.resolve(text);
    return { ok: true, questionId, name: pending.name };
  });

  // ---------- file ipc (scoped to an agent's project directory) ----------
  ipcMain.handle('files:tree', async (_e, { agentId, projectDir, directory, offset }) => {
    let root = projectDir;
    if (!root && agentId) {
      const agent = getAgentStore().get(agentId);
      if (agent && agent.dir) root = agent.dir;
    }
    if (!root) return { ok: false, err: 'No project bound.', tree: [] };
    try { return await listDirectory(root, directory, offset); }
    catch (error) { return { ok: false, err: error.message, tree: [], root }; }
  });
  ipcMain.handle('files:read', (_e, { agentId, projectDir, path: rel }) => {
    let root = projectDir;
    if (!root && agentId) {
      const agent = getAgentStore().get(agentId);
      if (agent && agent.dir) root = agent.dir;
    }
    if (!root) return { ok: false, err: 'No project bound.' };
    try {
      const abs = resolveInProject(root, rel);
      const stat = fs.statSync(abs);
      if (stat.size > 2 * 1024 * 1024) return { ok: false, err: 'File is too large to open (2 MB limit).' };
      const { content, encoding } = readTextFile(abs);
      return { ok: true, content, encoding };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  });
  ipcMain.handle('files:write', (_e, { agentId, projectDir, path: rel, content }) => {
    let root = projectDir;
    if (!root && agentId) {
      const agent = getAgentStore().get(agentId);
      if (agent && agent.dir) root = agent.dir;
    }
    if (!root) return { ok: false, err: 'No project bound.' };
    try {
      const abs = resolveInProject(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      writeTextFile(abs, String(content === undefined ? '' : content));
      return { ok: true };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  });

  // ---------- models ----------
  ipcMain.handle('models:list', async (_e, payload = {}) => {
    /* Three ways to pick the provider to list, in priority order:
     *
     *  1. `endpoint` (+ optional `accessKey`) — an AD-HOC lookup. Needed because
     *     the Connection page edits rows in place: while the user is typing a new
     *     URL there is nothing saved to resolve an id against, so Browse must be
     *     able to list from the URL on screen. Without this, Browse only works
     *     after saving, which reads as a broken button.
     *  2. `connectionId` — a saved connection that is NOT the active one, so a
     *     row's Browse does not have to activate that provider first.
     *  3. neither — the active connection. This is what playground, refactor and
     *     the agent settings form pass, so those callers are unchanged.
     *
     * An ad-hoc endpoint is validated exactly like a stored one (resolveEndpoint
     * rejects non-HTTP and embedded credentials) and is never persisted.
     */
    const settings = loadSettings();
    let endpoint = '';
    let accessKey = '';
    let label = '';
    let connectionId = null;

    const adHoc = payload && typeof payload.endpoint === 'string' && payload.endpoint.trim();
    if (adHoc) {
      endpoint = connections.normalizeEndpoint(payload.endpoint);
      accessKey = String(payload.accessKey == null ? '' : payload.accessKey);
      label = connections.defaultName(endpoint) || endpoint;
    } else {
      const requested = payload && typeof payload === 'object' ? payload.connectionId : null;
      const connection = (requested && connections.findConnection(settings, requested))
        || connections.activeConnection(settings);
      if (!connection || !connection.endpoint) {
        return { ok: false, err: 'No endpoint configured in Settings.' };
      }
      endpoint = connection.endpoint;
      accessKey = connection.accessKey || '';
      label = connection.name;
      connectionId = connection.id;
    }

    try {
      const base = await resolveEndpoint(endpoint);
      const headers = {};
      if (accessKey) headers.Authorization = 'Bearer ' + accessKey;
      const res = await fetch(base + '/models', { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { ok: false, err: `HTTP ${res.status}` };
      const data = await res.json();
      const ids = (data.data || []).map(m => m.id).filter(Boolean).sort();
      // Tell the caller which connection these models came from, so the UI can
      // say so instead of implying they came from the active one.
      return { ok: true, models: ids, connectionId, connectionName: label, endpoint };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  });

  /* ---------------- multiple endpoint connections (VS Code parity) --------------
   * The renderer gets the whole list INCLUDING access keys: unlike a web page,
   * this is a local desktop app whose own settings form must be able to redisplay
   * and re-save a key. The keys never leave the machine — they are read from and
   * written to userData/settings.json, exactly as the single-endpoint form did.
   */
  ipcMain.handle('connections:list', () => connections.publicConnections(loadSettings()));

  /* One handler for add/update/remove/activate rather than four, because all
   * four are "change the list, persist, tell the loops". A per-action handler set
   * would duplicate the persist-and-invalidate tail and drift.
   *
   * Every branch returns either {ok, connections} or {ok:false, err}. The caller
   * never receives a partially applied change: mutations are pure until the
   * write, so a validation error leaves settings.json untouched.
   */
  ipcMain.handle('connections:save', (_e, payload = {}) => {
    const action = String(payload.action || '').trim();
    const current = loadSettings();
    let result;
    switch (action) {
      case 'add':
        result = connections.addConnection(current, {
          endpoint: payload.endpoint,
          accessKey: payload.accessKey,
          model: payload.model,
          name: payload.name,
          // Adding a connection while configuring the list should not yank the
          // active provider out from under a running conversation unless asked.
          activate: payload.activate !== false,
        });
        break;
      case 'update':
        result = connections.updateConnection(current, payload.id, {
          name: payload.name,
          endpoint: payload.endpoint,
          accessKey: payload.accessKey,
          model: payload.model,
        });
        break;
      case 'remove':
        result = connections.removeConnection(current, payload.id);
        break;
      case 'activate':
        result = connections.setActiveConnection(current, payload.id);
        break;
      case 'enable':
        // Pool membership: which connections a TEAM may spread across. Does not
        // change the active connection, so existing conversations keep running.
        result = connections.setConnectionEnabled(current, payload.id, payload.enabled !== false);
        break;
      default:
        return { ok: false, err: 'Unknown connection action.' };
    }
    if (result.error) return { ok: false, err: result.error };
    saveSettings(result.settings);
    /* Switching provider changes endpoint AND access key, so cached loops must
     * not keep talking to the old one. Same rule as settings:save.
     *
     * Compare rather than invalidate unconditionally: an `enable` toggle on a
     * NON-active connection changes nothing a running chat uses, and marking
     * every loop stale for a pool checkbox would needlessly interrupt work. */
    const routingBefore = connections.activeConnection(current);
    const routingAfter = connections.activeConnection(result.settings);
    const routingChanged = !routingBefore || !routingAfter
      || routingBefore.id !== routingAfter.id
      || routingBefore.endpoint !== routingAfter.endpoint
      || routingBefore.accessKey !== routingAfter.accessKey;
    if (routingChanged) {
      for (const [id, loop] of agentLoops) {
        if (loop.running || loop.autoRoute && getAgentStore().get(id)?.runState?.status === 'waiting_edits') loop.settingsStale = true;
        else agentLoops.delete(id);
      }
    }
    return { ok: true, connections: connections.publicConnections(result.settings) };
  });

  /* Ping one specific connection (default: the active one) so the Connection
   * page can verify a row before the user switches to it. Read-only: it calls
   * GET /models, never a completion, so it cannot cost tokens. */
  ipcMain.handle('connections:ping', async (_e, payload = {}) => {
    const settings = loadSettings();
    const requested = payload && typeof payload === 'object' ? payload.connectionId : null;
    const connection = (requested && connections.findConnection(settings, requested))
      || connections.activeConnection(settings);
    if (!connection || !connection.endpoint) return { ok: false, err: 'No endpoint configured.' };
    const started = Date.now();
    try {
      const base = await resolveEndpoint(connection.endpoint);
      const headers = {};
      if (connection.accessKey) headers.Authorization = 'Bearer ' + connection.accessKey;
      const res = await fetch(base + '/models', { headers, signal: AbortSignal.timeout(10000) });
      const latencyMs = Date.now() - started;
      if (!res.ok) return { ok: false, status: res.status, latencyMs, err: `HTTP ${res.status}` };
      let modelCount = null;
      try {
        const data = await res.json();
        modelCount = Array.isArray(data.data) ? data.data.length : null;
      } catch { /* a non-JSON body still proved reachability */ }
      return { ok: true, status: res.status, latencyMs, models: modelCount, connectionId: connection.id, connectionName: connection.name };
    } catch (e) {
      return { ok: false, err: e.message, latencyMs: Date.now() - started };
    }
  });

  // ---------- workspace dashboard (PRD: Studio Workspace Dashboard) ----------

  /* Measure round-trip latency to the configured endpoint. Read-only: it calls
   * GET /models, never a completion, so a ping cannot cost tokens or mutate
   * anything. Reports the HTTP status and latency the PRD asks for. */
  ipcMain.handle('workspace:pingEndpoint', async () => {
    const settings = loadSettings();
    if (!settings.endpoint) return { ok: false, err: 'No endpoint configured in Settings.' };
    const started = Date.now();
    try {
      const base = await resolveEndpoint(settings.endpoint);
      const headers = {};
      if (settings.accessKey) headers.Authorization = 'Bearer ' + settings.accessKey;
      const res = await fetch(base + '/models', { headers, signal: AbortSignal.timeout(10000) });
      const latencyMs = Date.now() - started;
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, latencyMs, err: `HTTP ${res.status}${body ? ': ' + body.slice(0, 200) : ''}` };
      }
      let models = null;
      try {
        const data = await res.json();
        models = Array.isArray(data.data) ? data.data.length : null;
      } catch { /* a non-JSON body still proves reachability */ }
      return { ok: true, status: res.status, latencyMs, models };
    } catch (e) {
      // Distinguish a timeout from a refused connection so the message is useful.
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { ok: false, latencyMs: Date.now() - started, err: timeout ? 'Timed out after 10 s.' : e.message };
    }
  });

  /* Models routinely wrap JSON in ``` fences or preface it with prose despite
   * being told not to. Extracting the first balanced object is more useful than
   * failing the run — but only a balanced one: a naive first-{-to-last-} slice
   * would merge two objects or return truncated JSON that throws on parse. */
  function extractJsonObject(text) {
    const src = String(text || '');
    const start = src.indexOf('{');
    if (start < 0) return null;
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(src.slice(start, i + 1)); }
          catch { return null; }
        }
      }
    }
    return null;
  }

  /* Resolve a renderer-supplied project directory to something safe to index.
   * Indexing walks the tree, so it is restricted to a real existing directory
   * and bounded by the indexer's own file and size caps. */
  function resolveIndexableDir(raw) {
    const text = String(raw || '').trim();
    if (!text) throw new Error('No project directory was supplied.');
    const abs = path.resolve(text);
    let stat;
    try { stat = fs.statSync(abs); } catch { throw new Error('Project directory does not exist.'); }
    if (!stat.isDirectory()) throw new Error('The project path is not a directory.');
    return abs;
  }

  function cachedIndex(dir, { force = false } = {}) {
    return sharedGetIndex(dir, { force });
  }

  ipcMain.handle('workspace:indexCode', (_e, { projectDir } = {}) => {
    let dir;
    try { dir = resolveIndexableDir(projectDir); }
    catch (e) { return { ok: false, err: e.message }; }
    try {
      const index = cachedIndex(dir, { force: true });
      return {
        ok: true,
        summary: codeIndex.summarize(index),
        // Cap the list so a huge repo cannot blow the IPC payload.
        warnings: index.warnings.slice(0, 40),
        truncated: index.warnings.length > 40,
      };
    } catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('workspace:searchSymbols', (_e, { projectDir, query, limit = 20 } = {}) => {
    let dir;
    try { dir = resolveIndexableDir(projectDir); }
    catch (e) { return { ok: false, err: e.message }; }
    const text = String(query || '').trim();
    if (!text) return { ok: true, symbols: [] };
    const max = Number.isSafeInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20;
    try {
      const index = cachedIndex(dir);
      const ctx = codeIndex.contextForQuery(index, text, { maxSymbols: max, maxChars: 8000, includeSnippets: false });
      // Strip snippets: the list view shows path/line/signature only, and
      // sending thousands of source lines over IPC would stall the renderer.
      return { ok: true, symbols: ctx.symbols.map(s => ({ ...s, snippet: undefined })), total: ctx.total };
    } catch (e) { return { ok: false, err: e.message }; }
  });

  /* Prompt-context injection (PRD: Codebase AST Context Search). Returns the
   * formatted block plus the symbols behind it so a caller can show what will
   * be injected instead of trusting an opaque string. */
  ipcMain.handle('workspace:extractContext', (_e, { projectDir, query, maxChars = 6000, maxSymbols = 12 } = {}) => {
    let dir;
    try { dir = resolveIndexableDir(projectDir); }
    catch (e) { return { ok: false, err: e.message }; }
    const text = String(query || '').trim();
    if (!text) return { ok: true, context: '', symbols: [] };
    try {
      const index = cachedIndex(dir);
      const ctx = codeIndex.contextForQuery(index, text, {
        maxChars: Number.isSafeInteger(maxChars) ? Math.max(500, Math.min(24000, maxChars)) : 6000,
        maxSymbols: Number.isSafeInteger(maxSymbols) ? Math.max(1, Math.min(40, maxSymbols)) : 12,
        includeSnippets: true,
      });
      return {
        ok: true,
        context: codeIndex.formatContext(ctx),
        chars: ctx.chars,
        symbols: ctx.symbols.map(s => ({ name: s.qualified, kind: s.kind, path: s.path, line: s.line, score: s.score })),
        dependencies: ctx.dependencies,
      };
    } catch (e) { return { ok: false, err: e.message }; }
  });

  // ---------- prompt console (PRD US-2: Interactive Prompt Console) ----------

  /* Runs one completion against the configured endpoint and streams tokens to
   * the renderer. The access key stays in the main process; the renderer never
   * sees it. Reuses readChatResponse so streaming, usage accounting and
   * reasoning separation behave exactly as they do for agent conversations. */
  ipcMain.handle('playground:run', async (_e, payload = {}) => {
    // Scoped to the connection chosen in the console. An absent or stale id falls
    // back to the active connection rather than failing, so a renderer holding an
    // id for a connection that was since deleted still runs somewhere sane.
    const settings = connections.scopedSettings(loadSettings(), payload.connectionId);
    if (!settings.endpoint) return { ok: false, err: 'No endpoint configured in Settings.' };
    const model = String(payload.model || settings.model || '').trim();
    if (!model) return { ok: false, err: 'No model selected.' };
    const prompt = String(payload.prompt || '');
    if (!prompt.trim()) return { ok: false, err: 'Enter a prompt.' };
    const runId = String(payload.runId || 'pg_' + Date.now().toString(36));

    // Bound concurrent runs so a stuck stream cannot accumulate controllers.
    if (playgroundRuns.size >= MAX_PLAYGROUND_RUNS) {
      const oldest = playgroundRuns.keys().next().value;
      if (oldest !== undefined) {
        try { playgroundRuns.get(oldest)?.abort(); } catch { /* already gone */ }
        playgroundRuns.delete(oldest);
      }
    }

    const controller = new AbortController();
    playgroundRuns.set(runId, controller);
    const send = (data) => {
      if (win && !win.isDestroyed()) win.webContents.send('playground:token', { runId, ...data });
    };

    const started = Date.now();
    let tokens = 0;
    try {
      const base = await resolveEndpoint(settings.endpoint);
      const headers = { 'Content-Type': 'application/json' };
      if (settings.accessKey) headers.Authorization = 'Bearer ' + settings.accessKey;

      const system = String(payload.system || '').trim();
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: prompt });

      const stream = payload.stream !== false;
      const maxTokens = Number.isSafeInteger(payload.maxTokens) && payload.maxTokens > 0 ? payload.maxTokens : 0;
      const temperature = Number.isFinite(payload.temperature) ? Math.max(0, Math.min(2, payload.temperature)) : 0.7;
      const body = { model, messages, stream, temperature };
      if (maxTokens > 0) body.max_tokens = maxTokens;

      const response = await fetch(base + '/chat/completions', {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // Surface the provider's own message: "429 rate limit exceeded" is far
        // more useful to a developer than "request failed".
        return { ok: false, status: response.status, err: text ? text.slice(0, 400) : `HTTP ${response.status}` };
      }

      const reply = await readChatResponse(response, {
        stream,
        signal: controller.signal,
        onText: (chunk) => {
          tokens += Math.max(1, Math.round(chunk.length / 4));
          send({ delta: chunk, tokens });
        },
      });

      const latencyMs = Date.now() - started;
      if (reply.error) return { ok: false, status: response.status, latencyMs, err: reply.error, usage: reply.usage || null };
      return {
        ok: true, status: response.status, latencyMs,
        // Non-streaming runs deliver their text in one piece.
        text: stream ? undefined : reply.content,
        usage: reply.usage || null,
        finishReason: reply.finishReason || null,
        reasoningChars: reply.reasoningChars || 0,
      };
    } catch (e) {
      if (controller.signal.aborted) return { ok: false, cancelled: true, err: 'Stopped.', latencyMs: Date.now() - started };
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { ok: false, err: timeout ? 'The request timed out.' : e.message, latencyMs: Date.now() - started };
    } finally {
      playgroundRuns.delete(runId);
      send({ done: true, tokens, elapsedMs: Date.now() - started });
    }
  });

  ipcMain.handle('playground:stop', (_e, runId) => {
    const controller = playgroundRuns.get(String(runId || ''));
    if (!controller) return { ok: false, err: 'That run already finished.' };
    controller.abort();
    playgroundRuns.delete(String(runId));
    return { ok: true };
  });

  // ---------- about (PRD: About REACH Studio) ----------
  ipcMain.handle('about:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    v8: process.versions.v8,
    userData: app.getPath('userData'),
  }));

  /* ---------- refactor workbench (PRD: /refactor) ----------
   *
   * Plans live HERE, keyed by an opaque id, rather than in the renderer. A plan
   * holds full file contents, so round-tripping it through the UI would bloat
   * every IPC message and let the renderer hold a mutated copy that no longer
   * matches disk. The renderer keeps the id plus its chunk selections.
   *
   * Bounded and time-expired like the agent tool's plan sessions, because an
   * abandoned plan holds whole file contents in memory.
   */
  const refactorPlans = new Map();
  const MAX_REFACTOR_PLANS = 12;
  const REFACTOR_PLAN_TTL_MS = 30 * 60 * 1000;
  const refactorRuns = new Map();
  const MAX_REFACTOR_RUNS = 6;

  /* `contextLines` is stored with the plan because chunk ids are a function of
   * the context width. The preview the user approves is built with it, so apply
   * must re-derive chunks with the SAME value or an accepted id can silently map
   * onto a different chunk than the one on screen. */
  function storeRefactorPlan(projectDir, plan, reviews, contextLines) {
    const now = Date.now();
    for (const [id, e] of refactorPlans) if (now - e.at > REFACTOR_PLAN_TTL_MS) refactorPlans.delete(id);
    while (refactorPlans.size >= MAX_REFACTOR_PLANS) {
      const oldest = refactorPlans.keys().next().value;
      if (oldest === undefined) break;
      refactorPlans.delete(oldest);
    }
    const planId = 'rfp-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    refactorPlans.set(planId, {
      at: now,
      projectDir: path.resolve(String(projectDir)),
      plan,
      reviews,
      context: Number.isSafeInteger(contextLines) && contextLines >= 0 ? contextLines : 3,
    });
    return planId;
  }

  function getRefactorPlan(planId) {
    const entry = refactorPlans.get(String(planId || ''));
    if (!entry) return null;
    if (Date.now() - entry.at > REFACTOR_PLAN_TTL_MS) { refactorPlans.delete(String(planId)); return null; }
    return entry;
  }

  /**
   * Trim a plan to what the review UI needs.
   *
   * Diff rows carry PLAIN TEXT, not HTML. Highlighting happens in the renderer
   * (CodeMirror is bundled there, not here), and sending escaped markup from main
   * would mean two escaping passes whose interaction is easy to get wrong —
   * double-escaped entities in the diff, or a raw-text path that bypasses
   * escaping entirely. The renderer draws these through textContent or through
   * ReachEditor.highlight(), which escapes internally.
   *
   * Payload is bounded: chunk rows are capped so one enormous file cannot stall
   * IPC. buildReview already refuses oversize files outright.
   */
  function reviewPayload(plan, reviews) {
    const MAX_ROWS_PER_CHUNK = 4000;
    return {
      summary: refactorEngine.summarizePlan(plan),
      order: plan.order,
      cycles: plan.cycles,
      warnings: plan.warnings.slice(0, 20),
      files: plan.files.map((f, i) => {
        const review = reviews[i];
        return {
          path: f.path,
          creating: !!f.creating,
          identical: !!review.identical,
          stats: review.stats,
          chunks: review.chunks.map(c => ({
            id: c.id,
            added: c.added,
            removed: c.removed,
            origStart: c.origStart,
            origEnd: c.origEnd,
            nextStart: c.nextStart,
            nextEnd: c.nextEnd,
            truncated: c.sideBySide.length > MAX_ROWS_PER_CHUNK,
            rows: c.sideBySide.slice(0, MAX_ROWS_PER_CHUNK).map(r => ({
              kind: r.kind,
              left: r.left ? { line: r.left.line, text: r.left.text } : null,
              right: r.right ? { line: r.right.line, text: r.right.text } : null,
            })),
          })),
        };
      }),
    };
  }

  // async: the syntax guard shells out to `node --check` (see validateSyntax).
  ipcMain.handle('refactor:plan', async (_e, payload = {}) => {
    let dir;
    try { dir = resolveIndexableDir(payload.projectDir); }
    catch (e) { return { ok: false, err: e.message }; }
    const edits = Array.isArray(payload.edits) ? payload.edits : null;
    if (!edits || !edits.length) return { ok: false, err: 'A plan needs at least one edit.' };
    if (edits.length > 60) return { ok: false, err: `Too many edits at once (${edits.length}); split into batches of 60 or fewer files.` };
    try {
      const contextLines = Number.isSafeInteger(payload.context) ? Math.max(0, Math.min(40, payload.context)) : 3;
      const plan = refactorEngine.planFromEdits(edits, { projectDir: dir });
      if (plan.errors.length) {
        // No planId for an invalid plan: handing one back would let the UI offer
        // "Apply" on changes that cannot be applied.
        return { ok: false, err: plan.errors[0], errors: plan.errors.slice(0, 12), warnings: plan.warnings.slice(0, 12) };
      }
      // PRD: "If dependency cycles or syntax errors are detected, the agent halts
      // refactoring and displays an error trace highlighting affected modules."
      // Cycles are caught by planFromEdits above; this is the syntax half. It runs
      // BEFORE a planId is issued, so a plan that cannot be applied is never
      // offered an Apply button in the first place.
      const syntax = await refactorEngine.validateSyntax(plan, { tmpDir: os.tmpdir() });
      if (!syntax.ok) {
        return {
          ok: false,
          err: syntax.errors[0],
          errors: syntax.errors.slice(0, 12),
          warnings: [...syntax.warnings, ...plan.warnings.map(w => w.message || JSON.stringify(w))].slice(0, 12),
          halted: 'syntax',
        };
      }
      for (const w of syntax.warnings) plan.warnings.push({ path: null, message: w });
      const reviews = plan.files.map(f =>
        patchEngine.buildReview(f.before, f.after, { path: f.path, context: contextLines }));
      const failed = reviews.find(r => !r.ok);
      if (failed) return { ok: false, err: failed.error || 'Could not build a diff for review.' };
      const planId = storeRefactorPlan(dir, plan, reviews, contextLines);
      return { ok: true, planId, plan: reviewPayload(plan, reviews) };
    } catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('refactor:apply', async (_e, payload = {}) => {
    const entry = getRefactorPlan(payload.planId);
    if (!entry) return { ok: false, err: 'Unknown or expired plan. Re-run the refactor task to build a fresh one.' };
    const dir = String(payload.projectDir || entry.projectDir);
    // A plan carries `before` contents captured for one project root; applying it
    // elsewhere would overwrite that project's files with this one's text.
    if (path.resolve(dir) !== entry.projectDir) {
      return { ok: false, err: 'This plan belongs to a different project directory. Build a fresh plan.' };
    }
    try {
      let plan = entry.plan;
      const accepted = payload.accepted && typeof payload.accepted === 'object' ? payload.accepted : null;
      let selection = null;
      if (accepted) {
        const files = entry.reviews.map((review, i) => ({
          path: plan.files[i].path,
          before: plan.files[i].before,
          after: plan.files[i].after,
        }));
        const sel = patchEngine.applySelections(files, accepted, { context: entry.context });
        if (!sel.edits.length) {
          return { ok: false, err: 'No chunks are accepted, so nothing would change.', skipped: sel.skipped };
        }
        selection = { skipped: sel.skipped };
        plan = refactorEngine.planFromEdits(sel.edits, { projectDir: dir });
        if (plan.errors.length) return { ok: false, err: plan.errors[0], errors: plan.errors.slice(0, 12) };
      }
      // Re-validate the ACTUAL content about to be written. This is not redundant
      // with the plan-time check: chunk-level selection can produce a combination
      // the plan never contained — accepting a chunk that opens a block while
      // rejecting the one that closes it yields unbalanced braces even though
      // every chunk was individually valid. Checking only the full plan would
      // let that through to disk.
      const syntax = await refactorEngine.validateSyntax(plan, { tmpDir: os.tmpdir() });
      if (!syntax.ok) {
        // Nothing was written yet, so no rollback is needed — but the plan is
        // deliberately NOT consumed, so the user can change their selection and
        // retry instead of re-running the whole refactor task.
        return { ok: false, err: syntax.errors[0], errors: syntax.errors.slice(0, 12), halted: 'syntax', wrote: false };
      }
      const res = refactorEngine.applyPlan(plan, { projectDir: dir });
      // The tree changed either way: a failed apply may have written some files
      // before rolling back, so the index must not claim otherwise.
      invalidateIndex(dir);
      // Single-use. The plan's `before` snapshots no longer match disk, so a
      // replay would either fail its own hash check or write stale content.
      refactorPlans.delete(String(payload.planId));
      if (!res.ok) {
        return {
          ok: false, err: res.error, rolledBack: !!res.rolledBack,
          rollbackFailed: !!res.rollbackFailed, restoreErrors: res.restoreErrors || [],
        };
      }
      const out = { ok: true, applied: res.applied, summary: refactorEngine.summarizePlan(plan) };
      if (selection) out.selection = selection;
      if (payload.commit === true) {
        // Best-effort checkpoint. A project that is not a git repository yields
        // {skipped:true}, which is not an error — the apply already succeeded.
        out.checkpoint = await refactorEngine.commitCheckpoint(dir, payload.commitMessage);
      }
      return out;
    } catch (e) {
      invalidateIndex(dir);
      return { ok: false, err: e.message };
    }
  });

  /* Infer the gates a project actually has rather than assuming `npm test`
   * exists. A gate that cannot run reports a misleading failure; better to omit
   * it and say so. */
  function defaultGates(dir) {
    const gates = [];
    const hasPkg = fs.existsSync(path.join(dir, 'package.json'));
    let scripts = {};
    if (hasPkg) {
      try { scripts = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {}; }
      catch { /* malformed package.json: treat as no scripts */ }
    }
    const testScript = String(scripts.test || '');
    if (testScript) {
      const runner = /vitest/i.test(testScript) ? 'vitest' : /jest/i.test(testScript) ? 'jest' : 'node';
      gates.push({ id: 'test', command: 'npm test', runner });
    }
    if (scripts.lint) gates.push({ id: 'lint', command: 'npm run lint', runner: 'eslint' });
    const typeScript = scripts.typecheck || scripts['type-check'];
    if (typeScript) {
      gates.push({ id: 'typecheck', command: `npm run ${scripts.typecheck ? 'typecheck' : 'type-check'}`, runner: 'tsc' });
    } else if (fs.existsSync(path.join(dir, 'tsconfig.json')) && scripts.build) {
      gates.push({ id: 'typecheck', command: 'npm run build', runner: 'tsc' });
    }
    if (fs.existsSync(path.join(dir, 'pyproject.toml')) || fs.existsSync(path.join(dir, 'pytest.ini'))) {
      gates.push({ id: 'pytest', command: 'python -m pytest -q', runner: 'pytest' });
    }
    return gates;
  }

  ipcMain.handle('refactor:defaultGates', (_e, payload = {}) => {
    let dir;
    try { dir = resolveIndexableDir(payload.projectDir); }
    catch (e) { return { ok: false, err: e.message, gates: [] }; }
    return { ok: true, gates: defaultGates(dir) };
  });

  /* Run quality gates and return STRUCTURED diagnostics (file, line, rule,
   * message) rather than raw output — that is what the Review Modal shows and
   * what a follow-up fix round consumes. Stops at the first failing gate for fast
   * feedback, matching the self-correction loop. */
  ipcMain.handle('refactor:gates', async (_e, payload = {}) => {
    let dir;
    try { dir = resolveIndexableDir(payload.projectDir); }
    catch (e) { return { ok: false, err: e.message }; }
    const gates = Array.isArray(payload.gates) && payload.gates.length ? payload.gates : defaultGates(dir);
    if (!gates.length) {
      return { ok: false, err: 'No quality gates were found for this project. Add a test or lint script, or specify gates explicitly.' };
    }
    if (gates.length > 8) return { ok: false, err: 'At most 8 gates per run.' };
    const results = [];
    let firstFailure = null;
    for (const gate of gates) {
      const command = String(gate.command || '').trim();
      if (!command) { results.push({ gate: gate.id || '?', ok: false, err: 'A gate needs a command.' }); continue; }
      const started = Date.now();
      const raw = await runCommand(command, [], { cwd: dir, shell: true, timeoutMs: 300000 });
      const interpreted = testLoop.interpret({ ...raw, durationMs: Date.now() - started }, gate.runner);
      const row = {
        gate: gate.id || command,
        command,
        runner: interpreted.runner,
        ok: interpreted.ok,
        exitCode: interpreted.exitCode,
        durationMs: interpreted.durationMs,
        counts: interpreted.counts,
        failures: interpreted.failures.slice(0, 40).map(f => ({
          name: String(f.name || '').slice(0, 200),
          file: f.file || null,
          message: String(f.message || '').slice(0, 600),
          code: f.code || null,
          severity: f.severity || null,
        })),
        failureCount: interpreted.failures.length,
        // Raw tail for failures the parser cannot structure — better than
        // reporting "failed" with nothing to show.
        tail: String(raw.stderr || raw.stdout || '').slice(-1500),
      };
      results.push(row);
      if (!interpreted.ok && !firstFailure) { firstFailure = row; break; }
    }
    return { ok: !firstFailure, passed: !firstFailure, results, failingGate: firstFailure ? firstFailure.gate : null };
  });

  /* Ask the model for edits against REAL file contents, then normalise the reply
   * into the shapes planFromEdits accepts.
   *
   * Shared by refactor:generate and the self-correction fix provider so both ask
   * the same way and parse the same way — two copies of a prompt and a JSON
   * extractor drift apart, and the drift shows up as edits that cannot be
   * located.
   *
   * @param {string[]} extraRules  additional instructions appended to the system
   *        prompt (the fix loop adds the failing-gate context).
   * @returns {Promise<{ok:boolean, edits?:Array, notes?:string, err?:string,
   *          raw?:string, status?:number, parseFailed?:boolean}>}
   *   Throws on transport failure; the caller's catch turns that into a result.
   */
  async function proposeEditsViaModel({ settings, model, task, contextBlock = '', files, controller, send = () => {}, extraRules = [] }) {
    const base = await resolveEndpoint(settings.endpoint);
    const headers = { 'Content-Type': 'application/json' };
    if (settings.accessKey) headers.Authorization = 'Bearer ' + settings.accessKey;

    const system = [
      'You are a precise refactoring engine for REACH Studio.',
      'Return ONLY a JSON object — no prose, no markdown fences — shaped exactly:',
      '{"edits":[{"path":"relative/path","hunks":[{"search":"exact existing text","replace":"new text"}]}],"notes":"one line"}',
      'Rules:',
      '- One entry per file. Put every change to that file in its hunks array.',
      '- `search` must be copied VERBATIM from the file contents below, including indentation, and must be UNIQUE in that file.',
      '- Prefer small uniquely-locatable search strings over whole functions.',
      '- Do not invent files, imports, or symbols that are not shown.',
      '- If the task cannot be done safely from the supplied files, return {"edits":[],"notes":"why"}.',
      ...extraRules,
    ].join('\n');
    const user = [
      'TASK: ' + task,
      '',
      contextBlock ? 'MATCHED SYMBOLS AND DEFINITIONS:\n' + contextBlock + '\n' : '',
      'FILES IN SCOPE (exact current contents):',
      ...files.map(f => f.content === undefined
        ? `--- ${f.path} ---\n(${f.missing ? 'file not found' : f.skipped || 'unreadable: ' + (f.error || '')})`
        : `--- ${f.path} ---\n${f.content}`),
    ].join('\n');

    const response = await fetch(base + '/chat/completions', {
      method: 'POST', headers,
      body: JSON.stringify({
        model, stream: true, temperature: 0.1,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // Surface the provider's own message: "429 rate limit exceeded" is far more
      // useful to a developer than "request failed".
      return { ok: false, status: response.status, err: text ? text.slice(0, 400) : `HTTP ${response.status}` };
    }
    let streamed = 0;
    const reply = await readChatResponse(response, {
      stream: true, signal: controller.signal,
      onText: (chunk) => { streamed += chunk.length; send({ stage: 'model', note: 'Generating edits', chars: streamed }); },
    });
    if (reply.error) return { ok: false, err: reply.error };

    const text = String(reply.content || '').trim();
    const parsed = extractJsonObject(text);
    if (!parsed) return { ok: false, parseFailed: true, err: 'The model did not return a parseable edit list.', raw: text.slice(0, 2000) };

    const rawEdits = Array.isArray(parsed.edits) ? parsed.edits : [];
    if (!rawEdits.length) {
      return { ok: true, edits: [], notes: String(parsed.notes || 'The model proposed no changes.') };
    }
    // Normalise into the shapes planFromEdits accepts, dropping malformed hunks.
    const edits = [];
    for (const e of rawEdits) {
      if (!e || typeof e !== 'object' || typeof e.path !== 'string' || !e.path.trim()) continue;
      const hunks = Array.isArray(e.hunks)
        ? e.hunks.filter(h => h && typeof h.search === 'string' && typeof h.replace === 'string' && h.search.length)
            .map(h => ({ search: h.search, replace: h.replace }))
        : [];
      if (hunks.length) { edits.push({ path: e.path.trim(), hunks }); continue; }
      if (typeof e.content === 'string') edits.push({ path: e.path.trim(), content: e.content });
    }
    if (!edits.length) {
      return { ok: false, err: 'The model returned edits in an unusable shape (no valid hunks or content).', raw: text.slice(0, 2000) };
    }
    return { ok: true, edits, notes: String(parsed.notes || '') };
  }


  /* Model-driven edit generation for a natural-language refactor task.
   *
   * Grounded in the real index: the model receives matched symbol definitions and
   * the exact current contents of the files in scope, so it proposes search /
   * replace hunks that actually exist. Proposing against imagined source is how
   * such a feature produces edits that cannot be located or applied.
   */
  ipcMain.handle('refactor:generate', async (_e, payload = {}) => {
    let dir;
    try { dir = resolveIndexableDir(payload.projectDir); }
    catch (e) { return { ok: false, err: e.message }; }
    const settings = connections.scopedSettings(loadSettings(), payload.connectionId);
    if (!settings.endpoint) return { ok: false, err: 'No endpoint configured in Settings.' };
    const model = String(payload.model || settings.model || '').trim();
    if (!model) return { ok: false, err: 'No model selected.' };
    const task = String(payload.task || '').trim();
    if (!task) return { ok: false, err: 'Describe the refactor task.' };
    if (task.length > 8000) return { ok: false, err: 'That task description is too long (8000 characters max).' };

    const runId = String(payload.runId || 'rf_' + Date.now().toString(36));
    if (refactorRuns.size >= MAX_REFACTOR_RUNS) {
      const oldest = refactorRuns.keys().next().value;
      if (oldest !== undefined) {
        try { refactorRuns.get(oldest)?.abort(); } catch { /* already gone */ }
        refactorRuns.delete(oldest);
      }
    }
    const controller = new AbortController();
    refactorRuns.set(runId, controller);
    const send = (data) => { if (win && !win.isDestroyed()) win.webContents.send('refactor:progress', { runId, ...data }); };

    try {
      let scope = Array.isArray(payload.files) ? payload.files.map(String).filter(Boolean) : [];
      send({ stage: 'index', note: 'Reading the project index' });
      let contextBlock = '';
      let matched = [];
      try {
        const index = sharedGetIndex(dir);
        const found = codeIndex.contextForQuery(index, task, { maxSymbols: 12, maxChars: 9000, includeSnippets: true });
        matched = found.symbols.map(s => ({ name: s.qualified, kind: s.kind, path: s.path, line: s.line }));
        contextBlock = codeIndex.formatContext(found);
        if (!scope.length) scope = [...new Set(found.symbols.map(s => s.path))].slice(0, 8);
      } catch (e) {
        send({ stage: 'index', note: 'Index unavailable (' + e.message + '); using the supplied file list only' });
      }
      if (!scope.length) {
        return { ok: false, err: 'Could not determine which files to change. Add files to the scope, or make the task more specific.' };
      }
      scope = scope.slice(0, 12);

      // Exact current contents, capped per file and in total: one huge file must
      // not consume the whole context window before the model answers.
      const files = [];
      let totalChars = 0;
      for (const rel of scope) {
        if (totalChars > 120000) { files.push({ path: rel, skipped: 'scope budget reached' }); continue; }
        try {
          const abs = resolveInProject(dir, rel);
          if (!fs.existsSync(abs)) { files.push({ path: rel, missing: true }); continue; }
          const text = readTextFile(abs).content;
          const clipped = text.length > 40000 ? text.slice(0, 40000) + '\n/* truncated */' : text;
          totalChars += clipped.length;
          files.push({ path: rel, content: clipped });
        } catch (e) { files.push({ path: rel, error: e.message }); }
      }
      if (!files.some(f => f.content)) return { ok: false, err: 'None of the scoped files could be read.' };

      send({ stage: 'model', note: 'Asking ' + model + ' to propose edits', files: files.map(f => f.path) });
      const proposed = await proposeEditsViaModel({ settings, model, task, contextBlock, files, controller, send });
      if (!proposed.ok) {
        if (proposed.parseFailed) send({ stage: 'parse', note: 'The model did not return usable JSON' });
        return { ok: false, err: proposed.err, ...(proposed.raw ? { raw: proposed.raw } : {}), ...(proposed.status ? { status: proposed.status } : {}) };
      }
      if (!proposed.edits.length) {
        return { ok: true, edits: [], notes: proposed.notes, matched, scope };
      }
      send({ stage: 'done', note: `Proposed ${proposed.edits.length} file change(s)` });
      return { ok: true, edits: proposed.edits, notes: proposed.notes, matched, scope };
    } catch (e) {
      if (controller.signal.aborted) return { ok: false, cancelled: true, err: 'Stopped.' };
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return { ok: false, err: timeout ? 'The request timed out.' : e.message };
    } finally {
      refactorRuns.delete(runId);
    }
  });

  /* ---------- self-correction loop (PRD: Autonomous Test & Lint Self-Correction) ----------
   *
   * Runs the project's quality gates, asks the model to fix what failed, applies
   * the fix through the refactor engine, and repeats — up to 10 attempts (the PRD
   * figure). On giving up it emits 'stopped' with the real failing traces so the
   * Review Modal can offer Revert / Adjust Scope / Manually Edit.
   *
   * Uses testLoop.runSelfCorrectionLoop rather than a second loop here: that
   * module owns the rollback semantics, no-progress detection and the parsers, and
   * it is already unit-tested against real tool output. This handler supplies the
   * three things it cannot know: how to run a command, how to ask the model, and
   * where to report progress.
   *
   * A deterministic quick-fix pass runs BEFORE the model on each attempt, which is
   * what the PRD asks for ("automatically applies suggested quick-fixes for ESLint
   * and tsc diagnostics before re-running tests").
   */
  ipcMain.handle('refactor:selfCorrect', async (_e, payload = {}) => {
    let dir;
    try { dir = resolveIndexableDir(payload.projectDir); }
    catch (e) { return { ok: false, err: e.message }; }
    const settings = connections.scopedSettings(loadSettings(), payload.connectionId);
    if (!settings.endpoint) return { ok: false, err: 'No endpoint configured in Settings.' };
    const model = String(payload.model || settings.model || '').trim();
    if (!model) return { ok: false, err: 'No model selected.' };

    const gates = Array.isArray(payload.gates) && payload.gates.length ? payload.gates : defaultGates(dir);
    if (!gates.length) {
      return { ok: false, err: 'No quality gates were found for this project. Add a test or lint script.' };
    }
    const scope = Array.isArray(payload.files) ? payload.files.map(String).filter(Boolean).slice(0, 12) : [];

    const runId = String(payload.runId || 'sc_' + Date.now().toString(36));
    if (refactorRuns.size >= MAX_REFACTOR_RUNS) {
      const oldest = refactorRuns.keys().next().value;
      if (oldest !== undefined) {
        try { refactorRuns.get(oldest)?.abort(); } catch { /* already gone */ }
        refactorRuns.delete(oldest);
      }
    }
    const controller = new AbortController();
    refactorRuns.set(runId, controller);
    const send = (data) => { if (win && !win.isDestroyed()) win.webContents.send('refactor:progress', { runId, ...data }); };

    try {
      // The loop calls this for each gate. runCommand goes through the same
      // platform layer as the shell tool, so timeouts and process-tree kills
      // behave identically.
      const runGate = async (gate) => {
        const command = String(gate.command || '').trim();
        if (!command) return { ok: false, exitCode: 1, stdout: '', stderr: 'A gate needs a command.' };
        const started = Date.now();
        const raw = await runCommand(command, [], { cwd: dir, shell: true, timeoutMs: 300000, signal: controller.signal });
        return { ...raw, durationMs: Date.now() - started };
      };

      // Read the CURRENT contents of the files in scope on every attempt: the
      // loop edits between attempts, so a snapshot taken once would make the model
      // propose hunks against text that no longer exists.
      const readScope = async (failures) => {
        const wanted = scope.length ? scope : [...new Set(
          (failures || []).map(f => f.file && f.file.path).filter(p => typeof p === 'string' && p.length)
        )].slice(0, 8);
        if (!wanted.length) return [];
        const files = [];
        let total = 0;
        for (const rel of wanted) {
          if (total > 120000) break;
          try {
            const abs = resolveInProject(dir, rel);
            if (!fs.existsSync(abs)) { files.push({ path: rel, missing: true }); continue; }
            const text = readTextFile(abs).content;
            const clipped = text.length > 40000 ? text.slice(0, 40000) + '\n/* truncated */' : text;
            total += clipped.length;
            files.push({ path: rel, content: clipped });
          } catch (e) { files.push({ path: rel, error: e.message }); }
        }
        return files;
      };

      const proposeFix = async ({ attempt, gate, interpreted, syntaxErrors }) => {
        const failures = (interpreted && interpreted.failures) || [];
        send({ stage: 'fix', note: `Attempt ${attempt}: asking ${model} to fix ${gate.id || gate.command}`, failures: failures.length });
        const files = await readScope(failures);
        if (!files.length || !files.some(f => f.content)) return null;

        // The diagnostics ARE the task: quote them verbatim so the model fixes
        // what actually failed rather than guessing at the goal.
        const trace = failures.slice(0, 25).map(f => {
          const where = f.file ? `${f.file.path}${f.file.line ? ':' + f.file.line : ''}${f.file.column ? ':' + f.file.column : ''}` : '';
          return `- ${f.name || 'failure'}${where ? ' @ ' + where : ''}${f.code ? ' [' + f.code + ']' : ''}${f.message ? ': ' + f.message : ''}`;
        }).join('\n');
        // Set when the loop rejected the PREVIOUS attempt's edit because it would
        // not parse. That rejection wrote nothing, so the gate output above is
        // unchanged and the model would otherwise have no idea its last edit was
        // discarded — leading it to reproduce the same syntax error.
        const syntaxBlock = Array.isArray(syntaxErrors) && syntaxErrors.length
          ? '\nYOUR PREVIOUS EDIT WAS REJECTED — IT DOES NOT PARSE (nothing was written):\n'
            + syntaxErrors.map(e => '- ' + e).join('\n')
            + '\nProduce syntactically valid code this time. Balanced braces, parens and brackets.\n'
          : '';
        const task = [
          `The quality gate "${gate.id || gate.command}" (runner: ${interpreted.runner}) failed with ${failures.length} problem(s).`,
          'Fix the code so this gate passes. Do not weaken, skip, or delete tests, and do not disable lint rules, to make it pass.',
          '',
          'FAILURES:',
          trace || '- (the gate failed without structured diagnostics; see the raw output below)',
          syntaxBlock,
          interpreted.stderrTail ? '\nRAW OUTPUT TAIL:\n' + String(interpreted.stderrTail).slice(-1200) : '',
        ].join('\n');

        const proposed = await proposeEditsViaModel({
          settings, model, task, files, controller, send,
          extraRules: [
            '- Fix the reported failures. Never change a test expectation, skip a test, or disable a lint rule to make a gate pass.',
            '- Only edit files shown below.',
          ],
        });
        if (!proposed.ok) { send({ stage: 'fix', note: 'The model could not propose a fix: ' + (proposed.err || 'unknown') }); return null; }
        return proposed.edits.length ? proposed.edits : null;
      };

      // Mechanical fixes first: they are cheaper than a model round and handle the
      // bulk of formatting/lint churn. Returns EDITS (never writes), so the loop
      // stays the only writer and rollback still covers these changes.
      const quickFix = async ({ gate, interpreted }) => {
        const counts = (interpreted && interpreted.counts) || {};
        if (!(counts.fixable > 0)) return null;
        // ESLint only. The PRD asks for quick-fixes on "ESLint and tsc
        // diagnostics", but tsc has no --fix: a type error has no mechanical
        // correction, only a semantic one. Returning null for tsc gates is the
        // honest behaviour — the loop then falls through to proposeFix, which is
        // where a type error actually gets addressed. Reporting tsc diagnostics
        // as "fixable" (so this hook would claim them) would be the wrong answer:
        // counts.fixable is set by the ESLint parser from its own "N fixable with
        // the --fix option" summary and is not populated for tsc at all.
        const runner = String(gate.runner || '').toLowerCase();
        if (runner !== 'eslint' && !/eslint/i.test(String(gate.command || ''))) return null;
        // Only run on files we can snapshot and restore. A bare `.` would let
        // eslint rewrite files OUTSIDE this set, and those writes could not be
        // undone by the loop's rollback.
        const targets = scope.length ? scope : [...new Set(
          ((interpreted && interpreted.failures) || []).map(f => f.file && f.file.path).filter(p => typeof p === 'string' && p.length)
        )].slice(0, 40);
        if (!targets.length) return null;
        const before = new Map();
        for (const rel of targets) {
          try {
            const abs = resolveInProject(dir, rel);
            if (fs.existsSync(abs)) before.set(rel, fs.readFileSync(abs, 'utf8'));
          } catch { /* unreadable: skip */ }
        }
        if (!before.size) return null;
        send({ stage: 'quickfix', note: `Running eslint --fix on ${counts.fixable} fixable problem(s) in ${before.size} file(s)` });

        // `eslint --fix` WRITES, so run it, harvest the result as edits, then put
        // the originals back — the tree must be untouched when we return.
        //
        // Why this matters: the loop builds a plan by reading the CURRENT file as
        // `before`. If the fixer has already rewritten it, before === after, the
        // plan has nothing to apply, and the loop reports a no-change stall even
        // though the fix landed on disk OUTSIDE the rollback set. Verified
        // 2026-09-18 with a probe mirroring this shape: passed=false, phases
        // ["baseline","no-change"], file already fixed. Returning edits instead
        // lets the loop apply them atomically, so rollback covers them.
        const quoted = [...before.keys()].map(rel => `"${String(rel).replace(/["\\]/g, '\\$&')}"`).join(' ');
        const edits = [];
        try {
          await runCommand(`npx eslint --fix ${quoted}`, [], { cwd: dir, shell: true, timeoutMs: 180000, signal: controller.signal });
          for (const [rel, oldText] of before) {
            try {
              const abs = resolveInProject(dir, rel);
              if (!fs.existsSync(abs)) continue;
              const now = fs.readFileSync(abs, 'utf8');
              if (now !== oldText) edits.push({ path: rel, content: now });
            } catch { /* skip */ }
          }
        } finally {
          // Restore whatever eslint touched, even if the run threw or was
          // cancelled mid-way. Best effort: a file we cannot restore is reported
          // by the loop's own diff on the next gate run.
          for (const [rel, oldText] of before) {
            try {
              const abs = resolveInProject(dir, rel);
              if (fs.existsSync(abs) && fs.readFileSync(abs, 'utf8') !== oldText) fs.writeFileSync(abs, oldText, 'utf8');
            } catch { /* best effort */ }
          }
          invalidateIndex(dir);
        }

        if (!edits.length) return null;
        send({ stage: 'quickfix', note: `Auto-fixed ${edits.length} file(s) mechanically` });
        return { edits, summary: `eslint --fix on ${edits.length} file(s)` };
      };

      const result = await testLoop.runSelfCorrectionLoop({
        gates,
        runGate,
        proposeFix,
        quickFix,
        projectDir: dir,
        maxAttempts: Number.isSafeInteger(payload.maxAttempts) ? Math.max(1, Math.min(10, payload.maxAttempts)) : 10,
        // Keep the last attempted fix on failure: the Review Modal offers
        // "Manually edit", which is useless if the tree was already rolled back.
        // "Revert changes" performs the rollback explicitly instead.
        keepOnFailure: true,
        signal: controller.signal,
        onEvent: (event) => {
          // The loop writes through the refactor engine (fs, not writeTextFile),
          // so the write observer does not fire — invalidate explicitly or the
          // index would keep serving pre-refactor symbols. 'applied' is the only
          // write event the loop emits; there is no 'rollback' event, so the
          // post-loop invalidateIndex below covers that path.
          if (event.type === 'applied') invalidateIndex(dir);
          send({ stage: 'loop', ...event });
        },
      });

      // Whatever the outcome (pass, give-up with keepOnFailure, or an internal
      // rollback), the tree may differ from when we started, so the index must
      // not claim otherwise.
      invalidateIndex(dir);

      send({ stage: 'done', note: result.passed ? 'All gates pass' : 'Stopped without passing all gates' });
      return {
        ok: true,
        passed: !!result.passed,
        cancelled: !!result.cancelled,
        attempts: result.attempts,
        report: result.report,
        restoredFiles: result.restoredFiles || [],
        // The Review Modal needs the actual traces, not just a summary line.
        iterations: (result.iterations || []).map(i => ({
          attempt: i.attempt,
          phase: i.phase,
          gate: i.gate || null,
          error: i.error || null,
          failures: (i.interpreted && i.interpreted.failures || []).slice(0, 20).map(f => ({
            name: String(f.name || '').slice(0, 200),
            file: f.file || null,
            message: String(f.message || '').slice(0, 600),
            code: f.code || null,
          })),
          tail: i.interpreted && i.interpreted.stderrTail ? String(i.interpreted.stderrTail).slice(-1200) : null,
          files: i.applied || null,
        })),
      };
    } catch (e) {
      invalidateIndex(dir);
      if (controller.signal.aborted) return { ok: false, cancelled: true, err: 'Stopped.' };
      return { ok: false, err: e.message };
    } finally {
      refactorRuns.delete(runId);
    }
  });

  /* Revert the tree to its pre-refactor state, for the Review Modal's first
   * option. Uses git when the project is a repository (the apply step can create a
   * checkpoint), and reports honestly when it cannot. */
  ipcMain.handle('refactor:revert', async (_e, payload = {}) => {
    let dir;
    try { dir = resolveIndexableDir(payload.projectDir); }
    catch (e) { return { ok: false, err: e.message }; }
    if (!fs.existsSync(path.join(dir, '.git'))) {
      return { ok: false, err: 'This project is not a git repository, so there is no committed state to revert to. Undo the changes manually, or restore from your own backup.' };
    }
    try {
      // `git checkout -- .` restores tracked files; clean -fd would DELETE
      // untracked files, which is not a revert and could destroy new work.
      const res = await runCommand('git', ['checkout', '--', '.'], { cwd: dir, timeoutMs: 60000 });
      invalidateIndex(dir);
      if (!res.ok) return { ok: false, err: res.error || res.stderr || 'git checkout failed' };
      return { ok: true, note: 'Tracked files restored to their last committed state. Untracked new files were left alone.' };
    } catch (e) { return { ok: false, err: e.message }; }
  });

  ipcMain.handle('refactor:stop', (_e, runId) => {
    const controller = refactorRuns.get(String(runId || ''));
    if (!controller) return { ok: false, err: 'That run already finished.' };
    controller.abort();
    refactorRuns.delete(String(runId));
    return { ok: true };
  });

}

// ---------- window ----------
function createWindow({ show = true } = {}) {
  win = new BrowserWindow({
    width: 1440,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: loadSettings().theme === 'light' ? '#fdf6e3' : '#0a0a0a',
    icon: path.join(rootDir, 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(rootDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (show) win.once('ready-to-show', () => win.show());
  studioBrowser = new StudioBrowser(win);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Mirror reach run events to the renderer (Projects page log).
  const detachReachEvents = reachProcess.onRunEvent((ev) => {
    if (!win || win.isDestroyed()) return;
    if (ev.type === 'output') win.webContents.send('reach:output', ev);
    else if (ev.type === 'exit') win.webContents.send('reach:exit', ev);
  });

  win.once('closed', detachReachEvents);
  return win.loadFile(path.join(rootDir, 'renderer', 'index.html'));
}

// ---------- lifecycle ----------
app.whenReady().then(() => {
  nativeTheme.themeSource = loadSettings().theme === 'light' ? 'light' : 'dark';
  reachProcess.configure(loadSettings);
  registerIpc();
  if (process.argv.includes('--smoke')) {
    (async () => {
      const timeout = setTimeout(() => {
        console.error('SMOKE FAIL: renderer/backend check timed out after 30 seconds');
        app.exit(1);
      }, 30_000);
      try {
        console.log(`SMOKE RUNTIME: Electron ${process.versions.electron}; Chromium ${process.versions.chrome}; Node ${process.versions.node}`);
        fs.mkdirSync(smokeProject, { recursive: true });
        fs.mkdirSync(path.join(smokeProject, '__pycache__'));
        fs.writeFileSync(path.join(smokeProject, 'sample.pyc'), Buffer.from([0xa7, 0x0d, 0x0d, 0x0a, 0, 1]));
        fs.writeFileSync(path.join(smokeProject, '__pycache__', 'sample.pyc'), Buffer.from([0, 1]));
        fs.writeFileSync(path.join(smokeProject, 'hello.py'), 'print("hello")\n');
        const smokeOtherProject = path.join(smokeRoot, 'other-project');
        fs.mkdirSync(smokeOtherProject);
        fs.writeFileSync(path.join(smokeProject, 'index.rsh'), '// FIRST PROJECT');
        fs.writeFileSync(path.join(smokeOtherProject, 'index.rsh'), '// SECOND PROJECT');
        fs.writeFileSync(path.join(smokeOtherProject, 'only-second.txt'), 'second project only');
        fs.mkdirSync(path.join(smokeProject, 'build'));
        for (let i = 0; i < 501; i++) fs.writeFileSync(path.join(smokeProject, 'build', `artifact-${String(i).padStart(3, '0')}.txt`), 'fixture');
        await createWindow({ show: false });
        const v = await win.webContents.executeJavaScript(`
          (async () => {
            if (!window.reach) throw new Error('Reach preload bridge is unavailable');
            const version = await window.reach.getVersion();
            if (typeof version !== 'string' || !version) throw new Error('CLI status missing');
            if (!['darwin', 'win32', 'linux'].includes(window.reach.platform)) throw new Error('Platform bridge missing');
            if (window.reach.platform === 'darwin' && !document.querySelector('#btn-save-file').textContent.includes('Cmd+S')) throw new Error('Mac shortcut label missing');
            await window.reach.getProjects();
            await window.reach.agents.list();
            document.querySelector('#btn-new').click();
            if (document.querySelector('#modal').classList.contains('hidden')) {
              throw new Error('New Project handler did not open the dialog');
            }
            document.querySelector('#btn-cancel').click();
            if (!document.querySelector('#modal').classList.contains('hidden')) {
              throw new Error('Cancel handler did not close the dialog');
            }
            document.querySelector('#tab-projects').click();
            if (!document.querySelector('#page-projects').classList.contains('active')) {
              throw new Error('Projects tab did not activate');
            }
            document.querySelector('#tab-agents').click();
            if (!document.querySelector('#page-agents').classList.contains('active')) {
              throw new Error('Agents tab did not activate');
            }
            document.querySelector('#tab-create').click();
            if (!document.querySelector('#page-create').classList.contains('active')) {
              throw new Error('Create tab did not activate');
            }
            document.querySelector('#tab-settings').click();
            if (document.querySelector('#tab-settings-menu').classList.contains('hidden')) throw new Error('Settings dropdown did not open');
            await openSettingsPanel('connection');
            if (!document.querySelector('#page-settings').classList.contains('active')) {
              throw new Error('Settings tab did not activate');
            }
            // Conversation CRUD + branching round-trip against a real store.
            const created = await window.reach.agents.create('smoke-agent', ${JSON.stringify(smokeProject)}, 'test-model');
            if (!created.ok) throw new Error('agents.create failed: ' + created.err);
            const got = await window.reach.agents.get(created.agent.id);
            if (!got || got.name !== 'smoke-agent') throw new Error('agents.get returned wrong agent');
            // Fork lineage: fork the fresh chat, assert parent/child links.
            const forkRes = await window.reach.agents.fork(created.agent.id, -1, 'smoke-branch');
            if (!forkRes.ok) throw new Error('agents.fork failed: ' + forkRes.err);
            if (forkRes.agent.parentChatId !== created.agent.id) throw new Error('fork lost parent lineage');
            const treeRes = await window.reach.agents.tree(${JSON.stringify(smokeProject)});
            if (!treeRes.ok) throw new Error('agents.tree failed');
            const rootNode = treeRes.tree.find(n => n.id === created.agent.id);
            if (!rootNode) throw new Error('fork parent missing from project tree');
            if (!rootNode.children.some(c => c.id === forkRes.agent.id)) throw new Error('branch missing from tree children');
            await window.reach.agents.delete(forkRes.agent.id);
            await window.reach.agents.delete(created.agent.id);
            const after = await window.reach.agents.get(created.agent.id);
            if (after) throw new Error('agents.delete did not remove the agent');

            // Persona + team CRUD round-trip (Create page data model).
            const pa = await window.reach.personas.create({ name: 'Smoke Auditor', model: 'smoke-model', prompt: 'You audit.' });
            if (!pa.ok) throw new Error('personas.create failed: ' + pa.err);
            const pb = await window.reach.personas.create({ name: 'Smoke Writer', model: '', prompt: 'You write.' });
            if (!pb.ok) throw new Error('personas.create #2 failed: ' + pb.err);
            const team = await window.reach.teams.create({ name: 'Smoke Crew', mode: 'chain', members: [{ personaId: pa.persona.id, role: 'audit' }, { personaId: pb.persona.id, role: 'docs' }] });
            if (!team.ok) throw new Error('teams.create failed: ' + team.err);
            const teamList = await window.reach.teams.list();
            const listed = teamList.find(t => t.id === team.team.id);
            if (!listed) throw new Error('created team missing from teams.list');
            if (listed.members.length !== 2 || listed.members[0].personaName !== 'Smoke Auditor') throw new Error('team roster wrong: ' + JSON.stringify(listed.members));
            // Deleting a persona must drop it from the team.
            await window.reach.personas.delete(pb.persona.id);
            const afterPersonaDel = await window.reach.teams.get(team.team.id);
            if (afterPersonaDel.members.length !== 1) throw new Error('persona delete did not shrink the team roster');
            // teams:run must reject an empty task rather than dispatch.
            const badRun = await window.reach.teams.run(team.team.id, '   ', null, null);
            if (badRun.ok) throw new Error('teams.run accepted an empty task');
            await window.reach.teams.delete(team.team.id);
            await window.reach.personas.delete(pa.persona.id);
            const teamsAfter = await window.reach.teams.list();
            if (teamsAfter.some(t => t.id === team.team.id)) throw new Error('teams.delete did not remove the team');
            // Editor + markdown assets must be present in the packaged DOM.
            if (typeof ReachMarkdown === 'undefined') throw new Error('markdown.js did not load');
            if (typeof ReachEditor === 'undefined') throw new Error('editor bundle did not load');
            // Create + select a conversation through the real UI path so the
            // chat workbench (composer included) is actually laid out, then
            // check geometry. New Chat stems from the project selected in the
            // sidebar dropdown.
            const sleep = (ms) => new Promise(r => setTimeout(r, ms));
            document.querySelector('#tab-agents').click();
            await sleep(300);
            const projSelect = document.querySelector('#agent-project-select');
            if (!projSelect) throw new Error('project select missing from Agents sidebar');
            // Ensure a known project dir is selectable.
            if (![...projSelect.options].some(o => o.value === ${JSON.stringify(smokeProject)})) {
              const opt = document.createElement('option');
              opt.value = ${JSON.stringify(smokeProject)};
              opt.textContent = 'reach-projects';
              projSelect.appendChild(opt);
            }
            projSelect.value = ${JSON.stringify(smokeProject)};
            projSelect.dispatchEvent(new Event('change'));
            await sleep(400);
            document.querySelector('#btn-new-chat').click();
            await sleep(700);
            const target = document.querySelector('#tree-new-chat');
            if (!target || !currentAgent?.draft) throw new Error('New Chat did not open the reusable draft');
            if ((await window.reach.agents.list()).some(agent => agent.id === currentAgent.id)) throw new Error('Empty New Chat was saved before sending');
            target.click();
            await sleep(400);
            if (document.querySelector('#agent-view').classList.contains('hidden')) {
              throw new Error('clicking a tree node did not open the conversation');
            }
            // Real renderer -> IPC -> filesystem checks for the reported bytecode bug.
            const files = await window.reach.files.tree(null, ${JSON.stringify(smokeProject)});
            if (files.tree.some(f => f.path.includes('__pycache__'))) throw new Error('Python cache leaked into source tree');
            if (!files.tree.some(f => f.path === 'hello.py')) throw new Error('Build artifacts hid a top-level source file');
            await refreshFileTree();
            const folder = document.querySelector('#file-tree [data-path="build"]');
            if (!folder || folder.getAttribute('aria-expanded') !== 'false') throw new Error('Folders must start collapsed');
            folder.click();
            for (let i = 0; i < 100 && !document.querySelector('#file-tree .tree-more'); i++) await sleep(20);
            if (!document.querySelector('#file-tree [data-path="build/artifact-000.txt"]')) throw new Error('Folder expansion failed');
            for (let page = 0; page < 2; page++) {
              const more = document.querySelector('#file-tree .tree-more');
              if (!more) throw new Error('Large folder missing Show more');
              more.click();
              const target = page === 0 ? 'build/artifact-499.txt' : 'build/artifact-500.txt';
              for (let i = 0; i < 100 && !document.querySelector('[data-path="' + target + '"]'); i++) await sleep(20);
              if (!document.querySelector('[data-path="' + target + '"]')) throw new Error('File missing after pagination: ' + target);
            }
            folder.click();
            if (folder.getAttribute('aria-expanded') !== 'false' || !folder.nextElementSibling.hidden) throw new Error('Folder collapse failed');
            document.querySelector('#file-tree [data-path="hello.py"]').click();
            for (let i = 0; i < 100 && !openFiles.has('hello.py'); i++) await sleep(20);
            if (!openFiles.has('hello.py')) throw new Error('Source file click did not open editor');
            await openFile('sample.pyc');
            if (openFiles.has('sample.pyc')) throw new Error('Bytecode was opened in the editor');
            if (!document.querySelector('#editor-status').textContent.includes('bytecode')) throw new Error('Missing binary explanation');
            const blockedWrite = await window.reach.files.write(null, 'sample.pyc', 'bad', ${JSON.stringify(smokeProject)});
            if (blockedWrite.ok) throw new Error('Binary overwrite was permitted');
            await openFile('hello.py');
            if (!openFiles.has('hello.py')) throw new Error('Python source did not open');
            openFiles.get('hello.py').editor.setText('print("updated")');
            await saveActiveFile();
            const savedSource = await window.reach.files.read(null, 'hello.py', ${JSON.stringify(smokeProject)});
            if (savedSource.content !== 'print("updated")') throw new Error('Editor save did not round-trip');
            closeFile('hello.py');
            appendQuestion({ question: 'Which source?', options: ['hello.py'] });
            const choice = [...document.querySelectorAll('#chat-log button')].find(b => b.textContent === 'hello.py');
            if (!choice) throw new Error('Question choices were not rendered');
            choice.click();
            if (document.querySelector('#composer-input').value !== 'hello.py') throw new Error('Question choice did not fill composer');
            // Branching applies to saved conversations, not the empty draft.
            if (!document.querySelector('#btn-branch-chat').disabled) throw new Error('Empty New Chat must not allow branching');
            const branchFixture = await window.reach.agents.create('Branch fixture', ${JSON.stringify(smokeProject)}, 'fixture');
            await selectAgent(branchFixture.agent);
            await loadAgentTree();
            // Branch toggle: forking the open chat must add an indented child.
            const before = document.querySelectorAll('#agent-tree .tree-node').length;
            document.querySelector('#btn-branch-chat').click();
            await sleep(700);
            const afterBranch = document.querySelectorAll('#agent-tree .tree-node').length;
            if (afterBranch !== before + 1) throw new Error('branch did not appear in tree (' + before + ' -> ' + afterBranch + ')');
            const branchNames = [...document.querySelectorAll('#agent-tree .tree-name')].map(n => n.textContent);
            if (!branchNames.some(t => t.startsWith('⑂'))) throw new Error('branch node not marked with ⑂');
            // File drawer toggle + geometry: drawer must sit to the RIGHT of
            // main (not below it), and the chat composer must stay visible.
            const drawer = document.querySelector('#file-drawer');
            const toggle = document.querySelector('#btn-toggle-files');
            const mainEl = document.querySelector('main');
              setDrawer(true);
              const dr = drawer.getBoundingClientRect();
            const mr = mainEl.getBoundingClientRect();
            if (dr.left < mr.right - 1) {
              throw new Error('file drawer is not to the right of main (left=' + dr.left + ' mainRight=' + mr.right + ')');
            }
            if (dr.width < 300) throw new Error('drawer width collapsed: ' + dr.width);
            const composer = document.querySelector('.composer');
            const ch = composer.getBoundingClientRect().height;
            if (ch < 20) throw new Error('composer collapsed (height=' + ch + 'px)');
            const composerVisible = composer.getBoundingClientRect().top < window.innerHeight;
            if (!composerVisible) throw new Error('composer is off-screen (top=' + composer.getBoundingClientRect().top + ')');
            const attach = document.querySelector('#btn-attach');
            const attachRect = attach.getBoundingClientRect();
            const inputRect = document.querySelector('#composer-input').getBoundingClientRect();
            if (attach.textContent.trim() !== '+' || attach.getAttribute('aria-label') !== 'Attach files') throw new Error('attachment control is not the simple accessible + button');
            if (attachRect.right > inputRect.left + 1 || attachRect.bottom < inputRect.top || attachRect.top > inputRect.bottom) {
              throw new Error('attachment + is not directly left of the chatbox: ' + JSON.stringify({ attach: attachRect.toJSON(), input: inputRect.toJSON() }));
            }
            const existingToolCalls = document.querySelectorAll('.tool-call-message').length;
            handleAgentEvent({ agentId: currentAgent.id, type: 'tool-call', tool: 'write', arguments: { path: 'large.txt', content: 'large payload '.repeat(240) } });
            const longToolCall = [...document.querySelectorAll('.tool-call-message')].at(-1);
            const dropdown = longToolCall.querySelector('.tool-call-dropdown');
            if (!dropdown || dropdown.open) throw new Error('tool calls over three lines must start in a closed dropdown');
            if (getComputedStyle(dropdown.querySelector('.tool-call-text')).webkitLineClamp !== '3') throw new Error('closed tool-call dropdown is not clamped to three lines');
            dropdown.querySelector('summary').click();
            if (!dropdown.open) throw new Error('long tool-call dropdown cannot be expanded');
            handleAgentEvent({ agentId: currentAgent.id, type: 'tool-call', tool: 'read', arguments: { path: 'short.txt' } });
            const shortToolCall = [...document.querySelectorAll('.tool-call-message')].at(-1);
            if (shortToolCall.querySelector('.tool-call-dropdown')) throw new Error('short tool calls should not become dropdowns');
            if (document.querySelectorAll('.tool-call-message').length !== existingToolCalls + 2) throw new Error('tool-call smoke messages were not rendered');

            // Edit review regression: all files from one AI work batch live in
            // one outer dropdown, and each detailed file review is a nested
            // dropdown. Exercise the bulk resolver without touching disk.
            const reviewDecisions = [];
            const reviewGroup = createEditReviewGroup({
              key: 'smoke:grouped-review', host: chatLog, title: 'Proposed changes', actor: 'Smoke AI',
              resolve: async (editId, accepted) => { reviewDecisions.push({ editId, accepted }); return { ok: true, accepted }; },
            });
            appendEditCardToGroup(reviewGroup, {
              editId: 'smoke-edit-one', path: 'src/one.js', isNew: false,
              stats: { added: 3, removed: 1 }, hunks: [{ type: 'add', text: 'const one = 1;' }],
            });
            appendEditCardToGroup(reviewGroup, {
              editId: 'smoke-edit-two', path: 'src/two.js', isNew: true, memberName: 'Builder',
              stats: { added: 2, removed: 0 }, hunks: [{ type: 'add', text: 'const two = 2;' }],
            });
            if (!reviewGroup.element.open) throw new Error('edit review batch must start expanded');
            const reviewFiles = reviewGroup.element.querySelectorAll('.edit-review-file');
            if (reviewFiles.length !== 2 || [...reviewFiles].some(file => file.open)) throw new Error('edit files must be grouped as closed nested dropdowns');
            if (reviewGroup.count.textContent !== '2 files' || reviewGroup.added.textContent !== '+5' || reviewGroup.removed.textContent !== '−1') throw new Error('edit review batch metadata is wrong');
            if (!reviewGroup.guidance.textContent.includes('continues automatically')) throw new Error('edit review batch does not explain how the run resumes');
            const firstReview = reviewFiles[0];
            firstReview.querySelector('summary').click();
            if (!firstReview.open || !firstReview.querySelector('.edit-review-file-meta')) throw new Error('edit file details cannot be expanded');
            reviewGroup.element.querySelector('.edit-review-summary').click();
            if (reviewGroup.element.open) throw new Error('edit review batch cannot be collapsed');
            reviewGroup.element.querySelector('.edit-review-summary').click();
            if (!reviewGroup.element.open) throw new Error('edit review batch cannot be reopened');
            await reviewGroup.acceptAll.onclick();
            if (reviewDecisions.length !== 2 || reviewDecisions.some(item => !item.accepted)) throw new Error('Accept all did not resolve every edit');
            if (reviewGroup.element.querySelectorAll('.edit-review-file.accepted').length !== 2 || !reviewGroup.acceptAll.disabled || !reviewGroup.rejectAll.disabled) throw new Error('bulk edit verdict state is wrong');
            reviewGroup.element.remove();

            if (drawer.classList.contains('closed')) throw new Error('drawer should start open');
            toggle.click();
            if (document.querySelector('#drawer-menu').classList.contains('hidden')) throw new Error('Files/Browser menu did not open');
            document.querySelector('#btn-close-drawer').click();
            if (!drawer.classList.contains('closed')) throw new Error('drawer did not close');
            await document.querySelector('#btn-show-files').onclick();
            if (drawer.classList.contains('closed')) throw new Error('Files menu did not reopen drawer');
            // Overflow regression: seed a LONG chat history into the live DOM
            // and assert the composer stays on-screen while the conversation
            // scrolls. A broken min-height:0 chain stretches the column and
            // clips the textbox at the bottom (shipped once, 2026-09-13).
            const log = document.querySelector('#chat-log');
            log.innerHTML = '';
            const emitAgent = (event) => handleAgentEvent({ agentId: currentAgent.id, ...event });
            for (let attempt = 0; attempt < 3; attempt++) {
              emitAgent({ type: 'message-start', role: 'assistant' });
              emitAgent({ type: 'delta', text: 'Hello ' + attempt });
              emitAgent({ type: 'message-end', role: 'assistant', content: 'Hello ' + attempt, provisional: attempt < 2 });
            }
            emitAgent({ type: 'run-state', status: 'completed', reason: 'Hello 2' });
            if (log.querySelectorAll('.chat-msg.assistant').length !== 1) throw new Error('Recovery duplicated reply bubbles');
            if (!log.textContent.includes('Hello 2') || /Hello [01]/.test(log.textContent)) throw new Error('Stale retry text remained visible');
            if (log.textContent.includes('Run completed')) throw new Error('Completion echoed the answer');
            log.innerHTML = '';
            for (let i = 0; i < 80; i++) {
              const m = document.createElement('div');
              m.className = 'chat-msg ' + (i % 2 ? 'assistant' : 'user');
              m.textContent = 'Message ' + i + ': lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. '.repeat(3);
              log.appendChild(m);
            }
            await sleep(200);
            const compR = composer.getBoundingClientRect();
            if (compR.bottom > window.innerHeight || compR.height < 20) {
              throw new Error('composer clipped with long history (bottom=' + compR.bottom + ' height=' + compR.height + ' innerH=' + window.innerHeight + ')');
            }
            const conversation = document.querySelector('#chat-scroll');
            if (conversation.scrollHeight <= conversation.clientHeight) {
              throw new Error('Conversation is not scrolling with 80 seeded messages');
            }
            log.innerHTML = '';
            // Cleanup: remove every conversation the smoke run created in the
            // test project (the UI-created Chat + its ⑂ branch).
            const leftovers = (await window.reach.agents.list()).filter(a => a.dir === ${JSON.stringify(smokeProject)});
            for (const a of leftovers) await window.reach.agents.delete(a.id);
            return version;
          })()
        `);
        // Exercise actual team IPC, workers, renderer updates and cancellation
        // against synthetic files and a local endpoint, never private projects.
        fs.mkdirSync(path.join(smokeProject, 'slow'));
        fs.writeFileSync(path.join(smokeProject, 'slow', 'regex.txt'), 'a'.repeat(50000) + '!');
        fs.writeFileSync(path.join(smokeProject, 'dsml-dialect.txt'), 'DSMLSMOKE read-through-ok\n');
        fs.writeFileSync(path.join(smokeProject, 'native-fixture.txt'), 'NATIVEMARK native-ok\n');
        const { createServer } = require('node:http');
        // Links-stage observations recorded by the fixture endpoint and
        // asserted in the main process after the renderer block runs.
        const linksChecks = { protocolSeen: false, roleSeen: false, messageSeen: false, dsmlToolRan: false, jsonCrewSawTools: false };
        // Native-protocol observations (OpenAI tool_calls crew).
        const nativeChecks = { toolsAdvertised: false, toolRan: false };
        const teamServer = createServer((req, res) => {
          if (req.method === 'GET' && /\/models\/?$/.test(req.url || '')) {
            const ids = ['fixture', 'fixture-a', 'fixture-b', 'fixture-d', 'fixture-sub',
              'fixture-l1', 'fixture-l2', 'fixture-l3', 'fixture-n1'];
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ object: 'list', data: ids.map(id => ({ id, object: 'model' })) }));
            return;
          }
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            const request = JSON.parse(body);
            const hasResults = request.messages.some(m => m.content.startsWith('TOOL RESULTS'));
            // startsWith, not ===: the runner now appends CREW CONTEXT to the
            // task, so the raw task text is a prefix of the member prompt.
            const cancel = request.messages.some(m => m.content.startsWith('Cancel the slow search'));
            const all = request.messages.map(m => String(m.content || '')).join('\n');
            if (request.model === 'fixture-l1' || request.model === 'fixture-l2' || request.model === 'fixture-l3') {
              if (Array.isArray(request.tools) && request.tools.length) linksChecks.jsonCrewSawTools = true;
              if (all.includes('LINKS MODE')) linksChecks.protocolSeen = true;
              if (all.includes('YOUR CREW ROLE')) linksChecks.roleSeen = true;
              if (all.includes('Review my draft')) linksChecks.messageSeen = true;
            }
            // Team follow-ups include conversation history. Only hold the
            // regular-chat fixture, not members that inherit its stop marker.
            if ((request.model === 'fixture' && all.includes('Conversation stop regular fixture'))
              || (request.model === 'fixture-sub' && !all.includes('Continue the original task'))) {
              res.writeHead(200, { 'content-type': 'text/event-stream' });
              res.write(': waiting for stop\n\n');
              return;
            }
            const complete = message => JSON.stringify({ status: 'complete', message, actions: [], options: [] });
            const acts = (message, actions) => JSON.stringify({ status: 'actions', message, actions, options: [] });
            let content;
            if (request.model === 'fixture-sub') {
              // The spawned worker: one answer, no tools.
              content = complete('Sub scan done.');
            } else if (request.model === 'fixture-d') {
              // The delegator: spawn → await → final answer (Grok-Bot flow).
              content = all.includes('Sub scan done.')
                ? complete('Crew delegation finished.')
                : hasResults
                  ? acts('Awaiting the spawned worker.', [{ name: 'agent.await', arguments: { agent: 'Sub Worker', timeoutMs: 8000 } }])
                  : acts('Delegating to a spawned worker.', [{ name: 'agent.spawn', arguments: { name: 'Sub Worker', task: 'Sub scan the fixture', model: 'fixture-sub' } }]);
            } else if (request.model === 'fixture-l1') {
              // Links member C: hands a real message to its peer via the
              // collab tool, then finishes its own turn.
              content = hasResults
                ? complete('C draft finished.')
                : acts('Handing my draft to D for review.', [{ name: 'agent.send', arguments: { to: 'Worker D', message: 'Review my draft.' } }]);
            } else if (request.model === 'fixture-l2') {
              // Links member D: idle until the peer's message arrives, then
              // declares the crew complete (the LINKS: COMPLETE sentinel).
              content = all.includes('Review my draft')
                ? complete('Reviewed and verified. LINKS: COMPLETE')
                : complete('D standing by.');
            } else if (request.model === 'fixture-l3') {
              // Links member E answers in the DeepSeek DSML native tool markup
              // (byte-exact dialect captured 2026-09-19). The app must execute
              // the read and strip the markup from the card, or the member
              // stalls and the run pauses.
              if (all.includes('DSMLSMOKE')) linksChecks.dsmlToolRan = true;
              content = all.includes('DSMLSMOKE')
                ? complete('DSML dialect executed.')
                : 'Reading the dialect fixture.\n'
                  + '<\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>\n'
                  + '<\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke name="read">\n'
                  + '<\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter name="path" string="true">dsml-dialect.txt</\uFF5C\uFF5CDSML\uFF5C\uFF5C parameter>\n'
                  + '</\uFF5C\uFF5CDSML\uFF5C\uFF5C invoke>\n'
                  + '</\uFF5C\uFF5CDSML\uFF5C\uFF5C calls>';
            } else if (request.model === 'fixture-n1') {
              // Native protocol member: the request must carry OpenAI tools; the
              // member executes a real read, then ends via task_complete.
              if (Array.isArray(request.tools) && request.tools.some(t => t.function && t.function.name === 'read')
                && request.tools.some(t => t.function && t.function.name === 'task_complete')) nativeChecks.toolsAdvertised = true;
              if (all.includes('NATIVEMARK')) nativeChecks.toolRan = true;
              const ncall = all.includes('NATIVEMARK')
                ? { name: 'task_complete', arguments: JSON.stringify({ summary: 'Native fixture done.' }) }
                : { name: 'read', arguments: JSON.stringify({ path: 'native-fixture.txt' }) };
              const ndelta = { tool_calls: [{ index: 0, id: 'call-native', type: 'function', function: ncall }] };
              res.writeHead(200, { 'content-type': 'text/event-stream' });
              res.write('data: ' + JSON.stringify({ choices: [{ delta: ndelta, finish_reason: null }] }) + '\n\n');
              res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
              res.end('data: [DONE]\n\n');
              return;
            } else {
              content = hasResults
                ? complete('Fixture scan completed.')
                : acts('Scanning the fixture.', [{ name: 'search', arguments: cancel
                  ? { path: 'slow', pattern: '(a+)+$', regex: true }
                  : { pattern: 'hello', include: '*.py' } }]);
            }
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
          });
        });
        await new Promise(resolve => teamServer.listen(0, '127.0.0.1', resolve));
        try {
          await win.webContents.executeJavaScript(`
            (async () => {
              const until = async (predicate, label) => {
                const deadline = Date.now() + 5000;
                while (!predicate()) {
                  if (Date.now() > deadline) throw new Error('Team smoke timeout: ' + label + '; ' + (document.querySelector('dialog.app-dialog')?.textContent || chatLog.textContent.slice(-1600)) + '; renderer: ' + window.__errors.join('; '));
                  await new Promise(resolve => setTimeout(resolve, 20));
                }
              };
              // Border widths are reported scaled by the display factor on some
              // machines (a 1px border reads 0.571429px at 175% Windows
              // scaling), so a finished card's left edge is compared against a
              // freshly-created resting card instead of the literal '1px'.
              const restingEdgeWidth = () => {
                const probe = document.createElement('div');
                probe.className = 'member-card';
                document.body.appendChild(probe);
                const width = getComputedStyle(probe).borderLeftWidth;
                probe.remove();
                return width;
              };
              await reachApi.saveSettings({ endpoint: 'http://127.0.0.1:${teamServer.address().port}/v1', model: 'fixture', accessKey: '' });
              const a = await reachApi.personas.create({ name: 'Worker A', model: 'fixture-a' });
              const b = await reachApi.personas.create({ name: 'Worker B', model: 'fixture-b' });
              const t = await reachApi.teams.create({ name: 'Runtime crew', mode: 'parallel', members: [{ personaId: a.persona.id }, { personaId: b.persona.id }] });
              const agent = await reachApi.agents.create('Team runtime', ${JSON.stringify(smokeProject)}, 'fixture');
              currentAgent = await reachApi.agents.get(agent.agent.id);
              showTab('agents');
              noAgent.classList.add('hidden'); agentView.classList.remove('hidden');
              const dispatch = async (team, task) => {
                openTeamRunModal(team);
                document.querySelector('#team-run-task').value = task;
                // A local mock can finish before a 20 ms polling tick. Capture
                // the real view when it is created, even if already completed.
                const originalStart = startTeamRunView;
                let view;
                startTeamRunView = (...args) => { originalStart(...args); view = activeTeamRun; };
                try { await document.querySelector('#btn-team-run-go').onclick(); }
                finally { startTeamRunView = originalStart; }
                if (!view) throw new Error('Team run view missing: ' + document.querySelector('dialog.app-dialog')?.textContent);
                return view;
              };
              const slow = await dispatch(t.team, 'Cancel the slow search');
              await until(() => slow.cards.size === 2 && [...slow.cards.values()].every(c => c.querySelector('.member-state').textContent === 'Running search…'), 'both workers searching');
              await new Promise(resolve => setTimeout(resolve, 150));
              await until(() => [...slow.cards.values()].every(c => c.querySelector('.activity-panel')?.dataset.active === 'true'), 'live team activity panels');
              const tick = Date.now();
              await reachApi.getProjects();
              if (Date.now() - tick > 1000) throw new Error('Main-process IPC blocked during team search');
              const duplicate = await reachApi.teams.run(t.team.id, 'duplicate', ${JSON.stringify(smokeProject)}, agent.agent.id);
              if (duplicate.ok) throw new Error('Concurrent dispatch replaced the current team');
              slow.cards.get(0).querySelector('.member-control').click();
              await until(() => slow.cards.get(0).dataset.paused === 'true', 'stop individual member');
              if (slow.cards.get(1).dataset.paused === 'true') throw new Error('Individual Stop interrupted teammate');
              await new Promise(resolve => setTimeout(resolve, 100));
              slow.cards.get(0).querySelector('.member-control').click();
              // A finished response flashes the border once (just-finished) and
              // keeps no colored edge bar afterwards.
              let memberFlashSeen = false;
              await until(() => {
                const card = slow.cards.get(0);
                if (card.classList.contains('just-finished')) memberFlashSeen = true;
                return card.classList.contains('done');
              }, 'restart individual member');
              if (!memberFlashSeen) throw new Error('Finished member card did not flash');
              if (getComputedStyle(slow.cards.get(0)).borderLeftWidth !== restingEdgeWidth()) throw new Error('Finished member card must not keep a colored edge bar');
              // Team drafts are messages, not Stop commands. Initialize the
              // draft explicitly: earlier smoke sections also use the composer.
              const setDraft = text => {
                composerInput.value = text;
                composerInput.dispatchEvent(new Event('input', { bubbles: true }));
              };
              if (!window.ReachTeamComposer.enabled()) throw new Error('Dispatch did not enable team chat');
              setDraft('Keep this unsent draft');
              if (document.querySelector('#btn-send').textContent !== 'Send') throw new Error('Team draft must keep Send available');
              await reachApi.agents.send(currentAgent.id, 'Conversation stop regular fixture');
              await until(() => agentRunning, 'regular chat alongside team');
              setDraft('');
              if (document.querySelector('#btn-send').textContent !== 'Stop') throw new Error('Empty composer did not become conversation Stop');
              await document.querySelector('#btn-send').onclick();
              await until(() => activeTeamRun?.paused, 'stop selected conversation team from composer');
              await until(() => currentAgent.runState?.status === 'stopped', 'stop regular chat alongside team');
              if (composerInput.value !== '') throw new Error('Stop changed the empty composer');
              if (document.querySelector('#btn-stop-team').textContent !== 'Start team') throw new Error('Stopped team has no Start');
              if (slow.cards.get(1).querySelector('.member-control').textContent !== 'Start') throw new Error('Stopped member has no Start');
              document.querySelector('#btn-stop-team').click();
              await until(() => !activeTeamRun, 'resume unfinished team');
              if (![...slow.cards.values()].every(c => c.classList.contains('done'))) throw new Error('Restarted team failed');
              composerInput.value = '';
              const good = await dispatch(t.team, 'Find hello in the fixture');
              await until(() => !activeTeamRun, 'successful parallel team');
              if (![...good.cards.values()].every(c => c.classList.contains('done'))) throw new Error('Parallel scans did not complete');
              for (const card of good.cards.values()) {
                if (getComputedStyle(card).borderLeftWidth !== restingEdgeWidth()) throw new Error('Done member cards must not keep a colored edge bar');
              }
              if ([...good.cards.values()].some(c => c.querySelector('.member-body').textContent !== 'Fixture scan completed.')) throw new Error('Team answer polluted by prior rounds or structured JSON');
              await new Promise(resolve => setTimeout(resolve, 150));
              const saved = await reachApi.agents.get(agent.agent.id);
              if (!saved.messages.some(m => m.content.includes('Fixture scan completed.'))) throw new Error('Team result not saved');

              // Grok-Bot-style delegation: a member spawns a background
              // worker (agent.spawn), awaits it (agent.await), and the worker
              // must get its own nested card and complete.
              const d = await reachApi.personas.create({ name: 'Delegator', model: 'fixture-d' });
              const td = await reachApi.teams.create({ name: 'Delegation crew', mode: 'parallel', members: [{ personaId: d.persona.id }] });
              const del = await dispatch(td.team, 'Delegate a sub scan');
              await until(() => del.subCards.size === 1, 'spawned worker card');
              const workerCard = [...del.subCards.values()][0];
              workerCard.querySelector('.member-control').click();
              await until(() => workerCard.dataset.paused === 'true', 'stop spawned worker');
              workerCard.querySelector('.member-control').click();
              let subFlashSeen = false;
              await until(() => {
                const card = [...del.subCards.values()][0];
                if (card && card.classList.contains('just-finished')) subFlashSeen = true;
                return !activeTeamRun;
              }, 'delegation run');
              if (![...del.cards.values()].every(c => c.classList.contains('done'))) throw new Error('Delegator did not complete');
              const sub = del.subCards && [...del.subCards.values()][0];
              if (!sub) throw new Error('Spawned worker got no card');
              if (!sub.classList.contains('done')) throw new Error('Spawned worker did not complete');
              if (!sub.querySelector('.member-state').textContent.includes('done')) throw new Error('Spawned worker state wrong: ' + sub.querySelector('.member-state').textContent);
              if (!sub.classList.contains('subagent')) throw new Error('Spawned worker card not styled as subagent');
              if (!subFlashSeen) throw new Error('Finished subagent card did not flash');
              if (getComputedStyle(sub).borderLeftWidth !== restingEdgeWidth()) throw new Error('Done subagent card must not keep a colored edge bar');
              const saved2 = await reachApi.agents.get(agent.agent.id);
              if (!saved2.messages.some(m => m.content.includes('Crew delegation finished.'))) throw new Error('Delegation answer not saved');
              await reachApi.teams.delete(td.team.id);
              await reachApi.personas.delete(d.persona.id);

              // LINKS mode: the 20-role catalog, role ids persisting on team
              // members, and a peer network run where a member's agent.send
              // reaches its peer and the peer's LINKS: COMPLETE declaration
              // ends the crew — saved with the final answer.
              const roleList = await reachApi.roles.list();
              if (!Array.isArray(roleList) || roleList.length !== 20) throw new Error('roles:list must return the 20 presets, got ' + (roleList && roleList.length));
              const c = await reachApi.personas.create({ name: 'Worker C', model: 'fixture-l1' });
              const wd = await reachApi.personas.create({ name: 'Worker D', model: 'fixture-l2' });
              const we = await reachApi.personas.create({ name: 'Worker E', model: 'fixture-l3' });
              const lt = await reachApi.teams.create({
                name: 'Links crew', mode: 'links',
                members: [
                  { personaId: c.persona.id, roleId: 'builder', role: 'Builder' },
                  { personaId: wd.persona.id, roleId: 'verifier', role: 'Verifier' },
                  { personaId: we.persona.id, roleId: 'tester', role: 'Tester' },
                ],
              });
              if (lt.team.mode !== 'links') throw new Error('links team mode was not stored');
              if (lt.team.members[0].roleId !== 'builder' || lt.team.members[1].roleId !== 'verifier' || lt.team.members[2].roleId !== 'tester') throw new Error('roleId was not stored on team members');
              const lk = await dispatch(lt.team, 'Draft and review the fixture summary');
              await until(() => !activeTeamRun, 'links crew finished');
              if (![...lk.cards.values()].every(card => card.classList.contains('done'))) throw new Error('Links members did not complete');
              if (!lk.cards.get(1).querySelector('.member-body').textContent.includes('LINKS: COMPLETE')) throw new Error('Links completion declaration missing from the declaring member answer');
              const dsmlCard = lk.cards.get(2).querySelector('.member-body').textContent;
              if (dsmlCard.includes('parameter name=') || dsmlCard.includes('invoke name=')) throw new Error('The DSML markup leaked into the member card');
              if (!dsmlCard.includes('DSML dialect executed.')) throw new Error('The DSML member did not finish cleanly');
              const savedL = await reachApi.agents.get(agent.agent.id);
              if (!savedL.messages.some(m => m.content.includes('LINKS: COMPLETE'))) throw new Error('Links answer not saved');
              await reachApi.teams.delete(lt.team.id);
              await reachApi.personas.delete(c.persona.id);
              await reachApi.personas.delete(wd.persona.id);
              await reachApi.personas.delete(we.persona.id);

              // NATIVE tool protocol: requests advertise real OpenAI tools, the
              // model's tool_calls execute, and task_complete ends the member.
              const wn = await reachApi.personas.create({ name: 'Worker N', model: 'fixture-n1' });
              const nt = await reachApi.teams.create({
                name: 'Native crew', mode: 'parallel', toolProtocol: 'native',
                members: [{ personaId: wn.persona.id, roleId: 'builder', role: 'Builder' }],
              });
              if (nt.team.toolProtocol !== 'native') throw new Error('toolProtocol was not stored on the team');
              const nv = await dispatch(nt.team, 'Run the native fixture');
              await until(() => !activeTeamRun, 'native crew finished');
              if (![...nv.cards.values()].every(card => card.classList.contains('done'))) throw new Error('Native member did not complete');
              const nvCard = nv.cards.get(0).querySelector('.member-body').textContent;
              if (!nvCard.includes('Native fixture done.')) throw new Error('Native completion summary missing from the card');
              const savedN = await reachApi.agents.get(agent.agent.id);
              if (!savedN.messages.some(m => m.content.includes('Native fixture done.'))) throw new Error('Native crew answer not saved');
              await reachApi.teams.delete(nt.team.id);
              await reachApi.personas.delete(wn.persona.id);

              await reachApi.agents.delete(agent.agent.id);
              await reachApi.teams.delete(t.team.id);
              await reachApi.personas.delete(a.persona.id);
              await reachApi.personas.delete(b.persona.id);
            })()
          `);
          if (!linksChecks.protocolSeen) throw new Error('Links member prompts must carry the peer-network protocol');
          if (!linksChecks.roleSeen) throw new Error('Preset crew roles must reach member prompts');
          if (!linksChecks.messageSeen) throw new Error('The agent.send message never reached its peer');
          if (!linksChecks.dsmlToolRan) throw new Error('The DSML native tool markup never executed in Links');
          if (linksChecks.jsonCrewSawTools) throw new Error('The JSON-contract crew must not advertise native tools');
          if (!nativeChecks.toolsAdvertised) throw new Error('Native crew requests must advertise OpenAI tools');
          if (!nativeChecks.toolRan) throw new Error('The native tool call never executed in the Native crew');
          await win.webContents.executeJavaScript(`
            (async () => {
              const created = await reachApi.agents.create('Input verification', ${JSON.stringify(smokeProject)}, 'fixture');
              await selectAgent(created.agent);
              composerInput.value = '';
              composerInput.focus();
              // Cancel really keeps the chat; confirm really removes it.
              const cancelled = deleteAgentById(currentAgent.id, currentAgent.name);
              await new Promise(resolve => setTimeout(resolve, 20));
              document.querySelector('dialog.app-dialog button.ghost').click();
              await cancelled;
              if (!await reachApi.agents.get(created.agent.id)) throw new Error('Cancelled deletion removed a chat');
              const doomed = await reachApi.agents.create('Delete fixture', ${JSON.stringify(smokeProject)}, 'fixture');
              const accepted = deleteAgentById(doomed.agent.id, doomed.agent.name);
              await new Promise(resolve => setTimeout(resolve, 20));
              document.querySelector('dialog.app-dialog button.gold').click();
              await accepted;
              if (await reachApi.agents.get(doomed.agent.id)) throw new Error('Confirmed deletion did not remove the fixture');
              if (document.activeElement !== composerInput) throw new Error('Delete dialog did not restore composer focus');
            })()
          `);
          // Use Chromium's text input path, not assignment to textarea.value.
          await win.webContents.insertText('typed after deletion');
          for (const kind of ['notice', 'confirm', 'prompt']) {
            await win.webContents.executeJavaScript(`
              (async () => {
                if (composerInput.value !== 'typed after deletion') throw new Error('Composer rejected text input');
                const result = window.ReachDialogs[${JSON.stringify(kind)}]('Dialog focus check');
                await new Promise(resolve => setTimeout(resolve, 20));
                const dialog = document.querySelector('dialog.app-dialog');
                dialog.querySelector('button.gold').click();
                await result;
                if (document.activeElement !== composerInput) throw new Error('Dialog did not restore keyboard focus');
                composerInput.value = '';
              })()
            `);
            await win.webContents.insertText('typed after deletion');
          }
          await win.webContents.executeJavaScript(`
            (async () => {
              if (composerInput.value !== 'typed after deletion') throw new Error('Composer rejected final text input');
              // Sending exercises the real composer handler and local agent endpoint.
              const id = currentAgent.id;
              await sendComposer();
              const deadline = Date.now() + 5000;
              while ((await reachApi.agents.get(id)).runState?.status !== 'completed') {
                if (Date.now() > deadline) throw new Error('Sending after dialogs did not complete');
                await new Promise(resolve => setTimeout(resolve, 20));
              }
              const saved = await reachApi.agents.get(id);
              if (!saved.messages.some(m => m.role === 'user' && m.content === 'typed after deletion')) throw new Error('Typed message was not sent');
              await reachApi.agents.delete(id);
              if (window.__errors.length) throw new Error('Renderer errors: ' + window.__errors.join('; '));
            })()
          `);
        } finally { teamServer.closeAllConnections(); teamServer.close(); }
        await win.webContents.executeJavaScript(`
          (async () => {
            const first = ${JSON.stringify(smokeProject)}, second = ${JSON.stringify(smokeOtherProject)};
            const until = async predicate => {
              const deadline = Date.now() + 3000;
              while (!predicate()) {
                if (Date.now() > deadline) throw new Error('Project-switch view did not settle');
                await new Promise(resolve => setTimeout(resolve, 20));
              }
            };
            await reachApi.saveProjects([{ name: 'SimpleREACH', dir: first }, { name: 'SingalREACH', dir: second }]);
            await showTab('projects');
            await loadProjectList();
            const clickProject = dir => [...projectList.children].find(li => li.title === dir).click();
            clickProject(first);
            await until(() => drawerContext.textContent === first && fileTreeEl.querySelector('[data-path="index.rsh"]'));
            await openFile('index.rsh');
            if (openFiles.get('index.rsh').editor.getText() !== '// FIRST PROJECT') throw new Error('First project source wrong');
            clickProject(second);
            await until(() => drawerContext.textContent === second && fileTreeEl.querySelector('[data-path="only-second.txt"]'));
            await until(() => document.querySelector('#agent-project-select').value === second);
            if (projectPath.textContent !== drawerContext.textContent) throw new Error('Project and Files paths disagree');
            if (openFiles.size || editorTabsEl.children.length) throw new Error('Previous project editor tabs survived selection');
            if (fileTreeEl.querySelector('[data-path="hello.py"]')) throw new Error('Previous project files survived selection');
            await openFile('index.rsh');
            if (openFiles.get('index.rsh').editor.getText() !== '// SECOND PROJECT') throw new Error('Same-name file reused content from previous project');
            openFiles.get('index.rsh').editor.setText('// SECOND PROJECT EDITED');
            const cancelled = selectProject({ name: 'SimpleREACH', dir: first });
            await until(() => document.querySelector('dialog.app-dialog'));
            document.querySelector('dialog.app-dialog button.ghost').click();
            await cancelled;
            if (currentProject.dir !== second || !openFiles.get('index.rsh').dirty) throw new Error('Cancelled switch lost project or unsaved edits');
            await saveActiveFile();
            if ((await reachApi.files.read(null, 'index.rsh', first)).content !== '// FIRST PROJECT') throw new Error('Save changed the wrong project');
            if ((await reachApi.files.read(null, 'index.rsh', second)).content !== '// SECOND PROJECT EDITED') throw new Error('Save missed selected project');
            await selectProject({ name: 'SimpleREACH', dir: first });
            // Rapid selections: an older directory response must not win.
            await Promise.all([selectProject({ name: 'SingalREACH', dir: second }), selectProject({ name: 'SimpleREACH', dir: first })]);
            if (drawerContext.textContent !== first || fileTreeEl.querySelector('[data-path="only-second.txt"]')) throw new Error('Stale project response replaced the current files');
            await openFile('index.rsh');
            const a = await reachApi.agents.create('Other project chat', second, 'fixture');
            await selectAgent(a.agent);
            await showTab('agents');
            if (drawerContext.textContent !== second) throw new Error('Agents page failed to select its project');
            await openFile('index.rsh');
            await showTab('projects');
            if (drawerContext.textContent !== second || projectPath.textContent !== second || !openFiles.size) throw new Error('Page navigation lost the shared project or its editor');
            await showTab('agents');
            const dropdown = document.querySelector('#agent-project-select');
            openFiles.get('index.rsh').editor.setText('// UNSAVED DROPDOWN CHECK');
            dropdown.value = first;
            const cancelDropdown = dropdown.onchange({ target: dropdown });
            await until(() => document.querySelector('dialog.app-dialog'));
            document.querySelector('dialog.app-dialog button.ghost').click();
            await cancelDropdown;
            if (dropdown.value !== second || currentProject.dir !== second || currentAgent.id !== a.agent.id || !openFiles.get('index.rsh').dirty) throw new Error('Cancelled dropdown changed project, chat, or edits');
            dropdown.value = first;
            const switchDropdown = dropdown.onchange({ target: dropdown });
            await until(() => document.querySelector('dialog.app-dialog'));
            document.querySelector('dialog.app-dialog button.gold').click();
            await switchDropdown;
            if (drawerContext.textContent !== first || projectPath.textContent !== first || !currentAgent?.draft || currentAgent.dir !== first || openFiles.size || agentView.classList.contains('hidden')) throw new Error('Dropdown did not open the selected project draft');
            await showTab('projects');
            if (drawerContext.textContent !== first || projectPath.textContent !== first || document.querySelector('#project-list li.active')?.title !== first) throw new Error('Dropdown did not synchronize Projects');
            await selectAgent(a.agent);
            if (currentProject.dir !== second || dropdown.value !== second || drawerContext.textContent !== second) throw new Error('Opening chat did not synchronize all project controls');
            const emptyDir = first + '/build';
            await selectProject({ name: 'No chats', dir: emptyDir });
            await showTab('agents');
            if (!currentAgent?.draft || currentAgent.dir !== emptyDir || !document.querySelector('#agent-tree').textContent.includes('New Chat') || drawerContext.textContent !== emptyDir || dropdown.value !== emptyDir || !fileTreeEl.querySelector('[data-path="artifact-000.txt"]')) throw new Error('Project without chats did not synchronize');
            // Removing a project means forgetting its shortcut, never deleting
            // its folder/chat or interrupting the current editor session.
            await selectAgent(a.agent);
            await showTab('projects');
            await openFile('index.rsh');
            const retainedEditor = openFiles.get('index.rsh');
            retainedEditor.editor.setText('// UNSAVED REMOVE CHECK');
            const removeRow = async (dir, accepted) => {
              const row = [...projectList.children].find(li => li.title === dir);
              const button = row.querySelector('.project-remove');
              const labelBounds = row.querySelector('.project-open').getBoundingClientRect();
              if (button.getBoundingClientRect().left < labelBounds.right - 1) throw new Error('Remove button must sit to the right of the project label');
              if (!button.getAttribute('aria-label')?.includes('from Projects')) throw new Error('Remove button needs an accessible name');
              button.focus(); button.click();
              await until(() => document.querySelector('dialog.app-dialog'));
              if (!document.querySelector('dialog.app-dialog').textContent.includes('Files, conversations, and open work are kept')) throw new Error('Removal must explain that files are kept');
              document.querySelector('dialog.app-dialog button.' + (accepted ? 'gold' : 'ghost')).click();
              await until(() => !removingProjects.has(dir));
            };
            await removeRow(first, false);
            if ((await reachApi.getProjects()).length !== 2) throw new Error('Cancelled removal changed saved projects');
            await removeRow(first, true);
            if ((await reachApi.getProjects()).some(p => p.dir === first)) throw new Error('Project shortcut was not removed');
            if (currentProject.dir !== second || currentAgent.id !== a.agent.id) throw new Error('Remove click also selected another project');
            await removeRow(second, true);
            await loadProjectList();
            if (projectList.children.length || (await reachApi.getProjects()).length) throw new Error('Removed active project was resurrected');
            if (openFiles.get('index.rsh') !== retainedEditor || !retainedEditor.dirty || retainedEditor.editor.getText() !== '// UNSAVED REMOVE CHECK') throw new Error('Removal lost unsaved editor work');
            if (!(await reachApi.agents.get(a.agent.id)) || currentAgent.id !== a.agent.id) throw new Error('Removal deleted or closed a conversation');
            if ((await reachApi.files.read(null, 'index.rsh', first)).content !== '// FIRST PROJECT'
              || (await reachApi.files.read(null, 'index.rsh', second)).content !== '// SECOND PROJECT EDITED') throw new Error('Removal changed files on disk');
            // Re-adding the open folder should preserve its unsaved editor too.
            await rememberProject(second);
            if (projectList.children.length !== 1 || openFiles.get('index.rsh') !== retainedEditor) throw new Error('Could not re-add removed project safely');
            resetEditors();
            await reachApi.saveProjects([{ name: 'SimpleREACH', dir: first }, { name: 'SingalREACH', dir: second }]);
            await loadProjectList();
            console.log('PROJECT REMOVAL SMOKE OK: right-side button, cancel, exact-path removal, active work preserved, files/chats kept, re-add.');
            await reachApi.agents.delete(a.agent.id);
            if (window.__errors.length) throw new Error('Renderer errors: ' + window.__errors.join('; '));
          })()
        `);
        await win.webContents.executeJavaScript(`
          (async () => {
            const fixture = await reachApi.agents.create('Budget settings check', ${JSON.stringify(smokeProject)}, 'fixture');
            await selectAgent(fixture.agent);
            await showTab('agents');
            document.querySelector('#btn-agent-settings').click();
            if (document.querySelector('#btn-agent-settings-menu').classList.contains('hidden')) throw new Error('Conversation Settings dropdown did not open');
            if (document.querySelector('#agent-settings-modal')) throw new Error('Old Settings overlay remains');
            await openSettingsPanel('budgeting');
            if (document.querySelectorAll('.settings-content:not(.hidden)').length !== 1) throw new Error('Settings panels overlap');
            document.querySelector('[data-budget-preset="unrestricted"]').click();
            if (document.querySelector('#budget-maxTokens').value !== '0' || document.querySelector('#budget-autoCompact').checked) throw new Error('Unrestricted preset incorrect');
            await document.querySelector('#btn-save-budgets').onclick();
            let saved = await reachApi.getSettings();
            if (saved.budgets.maxRounds !== 0 || saved.budgets.storedMessages !== 0) throw new Error('Zero budgets did not persist');
            await reachApi.saveSettings({ endpoint: 'http://127.0.0.1:9/v1', accessKey: 'isolated-smoke-fixture', model: 'fixture' });
            await openSettingsPanel('budgeting');
            document.querySelector('[data-budget-preset="heavy"]').click();
            await document.querySelector('#btn-save-budgets').onclick();
            saved = await reachApi.getSettings();
            if (saved.budgets.maxTokens !== 32768 || saved.accessKey !== 'isolated-smoke-fixture' || saved.model !== 'fixture') throw new Error('Budget save lost connection settings');
            await openSettingsPanel('connection');
            await loadSettings();
            await document.querySelector('#btn-save-settings').onclick();
            if ((await reachApi.getSettings()).budgets.maxTokens !== 32768) throw new Error('Connection save lost budgets');

            // --- Multiple endpoint connections (VS Code extension parity) ---
            // Deliberately placed BEFORE the browser suite: browser/smoke.cjs is
            // flaky on Windows and aborts the whole run, so anything after it is
            // never exercised locally. No template literals below — this block
            // lives inside main.mjs's template string.
            const connFixtureKey = 'isolated-smoke-fixture';
            const connSecond = 'https://second.example.com/v1';
            await openSettingsPanel('connection');
            await loadSettings();
            if (document.querySelectorAll('#conn-list .conn-card').length !== 1) throw new Error('Connection list did not render the migrated single connection');
            if (!document.querySelector('#conn-list .conn-url')) throw new Error('Connection card has no Base URL field');
            if (!document.querySelector('#conn-list .conn-radio')) throw new Error('Connection card has no active-connection radio');
            if (document.querySelector('#conn-list .conn-remove').disabled !== true) throw new Error('The only connection must not be removable');

            // Add a second connection through the UI and save it.
            document.querySelector('#btn-add-connection').onclick();
            if (document.querySelectorAll('#conn-list .conn-card').length !== 2) throw new Error('Add connection did not append a card');
            const connNewUrl = document.querySelector('#conn-list .conn-card:last-child .conn-url');
            connNewUrl.value = connSecond;
            connNewUrl.dispatchEvent(new Event('input', { bubbles: true }));
            await document.querySelector('#btn-save-settings').onclick();
            const connTwo = await reachApi.getSettings();
            if (connTwo.connections.length !== 2) throw new Error('Second connection did not persist, got ' + connTwo.connections.length);
            // Adding activates, so the legacy projection must follow the new row —
            // that projection is what every agent/playground call reads.
            if (connTwo.endpoint !== connSecond) throw new Error('Active projection did not follow the new connection: ' + connTwo.endpoint);
            const connFirst = connTwo.connections.find(c => c.endpoint !== connSecond);
            if (!connFirst || connFirst.accessKey !== connFixtureKey) throw new Error('Adding a connection clobbered the access key of the other connection');
            if (connTwo.budgets.maxTokens !== 32768) throw new Error('Adding a connection lost the budget preset');

            // Switching the active connection moves the projection, not the list.
            await loadSettings();
            const connRadio = document.querySelector('#conn-list .conn-card .conn-radio');
            connRadio.checked = true;
            connRadio.dispatchEvent(new Event('change', { bubbles: true }));
            await document.querySelector('#btn-save-settings').onclick();
            const connSwitched = await reachApi.getSettings();
            if (connSwitched.connections.length !== 2) throw new Error('Activating a connection changed the count');
            if (connSwitched.endpoint !== connFirst.endpoint) throw new Error('Activation did not move the projection: ' + connSwitched.endpoint + ' vs ' + connFirst.endpoint);
            if (connSwitched.activeConnection !== connFirst.id) throw new Error('activeConnection did not follow the radio');

            // A duplicate endpoint is refused rather than silently stored twice.
            const connDup = await reachApi.connections.save({ action: 'add', endpoint: connFirst.endpoint });
            if (connDup.ok !== false) throw new Error('A duplicate endpoint was accepted');
            // An unknown id must not silently activate something else.
            const connBad = await reachApi.connections.save({ action: 'activate', id: 'conn_does-not-exist' });
            if (connBad.ok !== false) throw new Error('Activating an unknown connection succeeded');

            // --- Team pool: click-to-toggle membership -----------------------
            // Both connections start enabled. The pool button is how a user adds a
            // connection to (or removes it from) what teams may spread across.
            const connSecondIdForPool = connSwitched.connections.find(c => c.endpoint === connSecond).id;
            await loadSettings();
            const poolButtons = () => document.querySelectorAll('#conn-list .conn-pool');
            if (poolButtons().length !== 2) throw new Error('Every connection card needs a pool toggle');
            // The ACTIVE connection cannot leave the pool (it is the fallback), so
            // its button is disabled; the non-active one is not.
            const poolStates = [...poolButtons()].map(b => b.disabled);
            if (poolStates[0] !== true) throw new Error('The active connection pool button must be disabled (it is the fallback)');
            if (poolStates[1] !== false) throw new Error('The non-active connection pool button must be enabled');

            // Click the second card's toggle to remove it from the pool, then save.
            poolButtons()[1].onclick();
            if (document.querySelectorAll('#conn-list .conn-pool.on').length !== 1) throw new Error('Toggling the pool must leave only the active connection in it');
            await document.querySelector('#btn-save-settings').onclick();
            const poolSaved = await reachApi.getSettings();
            const enabledAfter = poolSaved.connections.filter(c => c.enabled !== false);
            if (enabledAfter.length !== 1) throw new Error('Pool toggle did not persist, got ' + enabledAfter.length + ' enabled');
            if (enabledAfter[0].id !== poolSaved.activeConnection) throw new Error('The surviving pool member must be the active connection');

            // IPC refusal: disabling the ACTIVE connection must be rejected with a
            // reason, not silently ignored (the checkbox would otherwise lie).
            const disableActive = await reachApi.connections.save({ action: 'enable', id: poolSaved.activeConnection, enabled: false });
            if (disableActive.ok !== false) throw new Error('Disabling the active connection must be refused');

            // Re-enable the second connection so the two-connection state survives
            // into the removal check that follows.
            const reEnable = await reachApi.connections.save({ action: 'enable', id: connSecondIdForPool, enabled: true });
            if (reEnable.ok !== true) throw new Error('Re-enabling a connection failed: ' + reEnable.err);

            // --- Team spread + persona pin persistence -----------------------
            // The resolver itself is unit-tested (25 cases); here we assert the
            // fields actually round-trip through the IPC + store, because a field
            // that renders but never persists is exactly the bug class that has
            // shipped twice this session.
            const connIds = (await reachApi.getSettings()).connections.map(c => c.id);
            const pinP = await reachApi.personas.create({ name: 'Pool Pinner', model: '', prompt: 'pinned', connectionId: connIds[0] });
            if (!pinP.ok || pinP.persona.connectionId !== connIds[0]) throw new Error('Persona connectionId did not persist');
            const looseP = await reachApi.personas.create({ name: 'Pool Loose', model: '', prompt: 'loose', connectionId: '' });
            if (!looseP.ok || looseP.persona.connectionId !== '') throw new Error('Empty persona connectionId did not persist');
            const spreadTeam = await reachApi.teams.create({ name: 'Pool Crew', mode: 'parallel', members: [{ personaId: pinP.persona.id }, { personaId: looseP.persona.id }], spreadConnections: true });
            if (!spreadTeam.ok || spreadTeam.team.spreadConnections !== true) throw new Error('Team spreadConnections did not persist');
            const teamList = await reachApi.teams.list();
            const listed = teamList.find(t => t.id === spreadTeam.team.id);
            if (!listed || listed.spreadConnections !== true) throw new Error('listTeams did not surface spreadConnections');
            if (listed.members.find(m => m.personaId === pinP.persona.id).personaConnectionId !== connIds[0]) throw new Error('listTeams did not surface the member pin');
            // Clean up the fixtures so later smoke stages see a tidy store.
            await reachApi.personas.delete(pinP.persona.id);
            await reachApi.personas.delete(looseP.persona.id);
            await reachApi.teams.delete(spreadTeam.team.id);

            // Remove the second connection and confirm the UI follows.
            const connSecondId = connSwitched.connections.find(c => c.endpoint === connSecond).id;
            const connRm = await reachApi.connections.save({ action: 'remove', id: connSecondId });
            if (connRm.ok !== true) throw new Error('Removing a connection failed: ' + connRm.err);
            await loadSettings();
            if (document.querySelectorAll('#conn-list .conn-card').length !== 1) throw new Error('Removed connection still rendered');
            if (document.querySelector('#conn-list .conn-remove').disabled !== true) throw new Error('The last remaining connection must not be removable');
            const connAfter = await reachApi.getSettings();
            if (connAfter.connections.length !== 1) throw new Error('Expected one connection after cleanup');
            if (connAfter.endpoint !== connFirst.endpoint) throw new Error('Cleanup changed the active endpoint');
            if (connAfter.accessKey !== connFixtureKey) throw new Error('Cleanup lost the access key');
            if (connAfter.budgets.maxTokens !== 32768) throw new Error('Connection edits lost the budget preset');

            // Both model-driven pages carry a connection picker, and with a single
            // connection it is present but disabled (nothing to choose).
            // goView() fires the page's sync() WITHOUT awaiting it, so awaiting
            // sync() again here is what makes the options count deterministic
            // rather than a race against an in-flight IPC round trip.
            await window.ReachWorkspaceShell.goView('playground');
            await window.ReachPlayground.sync();
            const pgConn = document.querySelector('#pg-conn');
            if (!pgConn) throw new Error('Playground has no connection picker');
            if (pgConn.options.length !== 1) throw new Error('Playground picker should list the one connection, got ' + pgConn.options.length);
            if (pgConn.disabled !== true) throw new Error('A single-connection picker should be disabled, there is nothing to choose');
            if (pgConn.value !== connAfter.connections[0].id) throw new Error('Playground picker did not select the active connection');
            await window.ReachWorkspaceShell.goView('refactor');
            await window.ReachRefactor.sync();
            if (!document.querySelector('#rf-conn')) throw new Error('Refactor page has no connection picker');
            if (document.querySelector('#rf-conn').options.length !== 1) throw new Error('Refactor picker should list the one connection');
            if (!document.querySelector('#pg-model-src') || !document.querySelector('#rf-model-src')) throw new Error('Model pickers lack a source caption');

            // --- Status-bar quick-switch: connection + model from the footer ---
            // The endpoint and model chips are buttons now: the endpoint chip
            // opens a popover whose rows ACTIVATE a connection immediately (no
            // Settings detour), and the model chip opens the shared picker to
            // set the ACTIVE connection's default model. These assertions drive
            // the real DOM handlers; persistence goes through connections:save.
            await window.ReachWorkspaceShell.goView('settings');
            await openSettingsPanel('connection');
            await loadSettings();
            const sbEndpointChip = document.querySelector('#sb-endpoint');
            const sbModelChip = document.querySelector('#sb-model');
            if (!sbEndpointChip || sbEndpointChip.tagName !== 'BUTTON') throw new Error('Endpoint status chip must be a button');
            if (!sbModelChip || sbModelChip.tagName !== 'BUTTON') throw new Error('Model status chip must be a button');
            // Opening the panel auto-tests rows that have no result yet (read-only
            // GET /models). Wait for the single existing row to settle.
            const connStatusTexts = () => [...document.querySelectorAll('#conn-list .conn-status')].map(el => el.textContent);
            let footerDeadline = Date.now() + 8000;
            while (connStatusTexts().some(t => !t || t === 'Testing…')) {
              if (Date.now() > footerDeadline) throw new Error('Connection auto-test did not settle: ' + connStatusTexts().join(' | '));
              await new Promise(r => setTimeout(r, 50));
            }
            if (!/^Failed/.test(connStatusTexts()[0])) throw new Error('Unreachable fixture endpoint must report a failure, got: ' + connStatusTexts()[0]);
            // A second connection to switch to, added WITHOUT activating (:10
            // cannot collide with the :9 fixture the suite already uses).
            const footerAdd = await reachApi.connections.save({ action: 'add', endpoint: 'http://127.0.0.1:10/v1', name: 'Footer Switch Target', model: 'footer-model', activate: false });
            if (!footerAdd.ok) throw new Error('Footer fixture connection failed: ' + footerAdd.err);
            const footerTarget = footerAdd.connections.connections.find(c => c.endpoint.indexOf(':10') !== -1);
            if (!footerTarget) throw new Error('Footer fixture connection missing');
            await loadSettings();
            await window.ReachWorkspaceShell.refreshEndpointChip();
            // The popover lists every connection; picking the inactive row
            // activates it and closes the popover. Opening is an async IPC
            // round trip (the list is re-read on every open), so poll for it.
            sbEndpointChip.click();
            footerDeadline = Date.now() + 3000;
            while (document.querySelector('#sb-conn-popover').classList.contains('hidden')) {
              if (Date.now() > footerDeadline) throw new Error('Endpoint chip did not open the connection popover');
              await new Promise(r => setTimeout(r, 25));
            }
            const footerPop = document.querySelector('#sb-conn-popover');
            // The popover anchors to the CHIP, not the window edge (a static
            // offset once put it ~320px left of the pill — measured). Assert
            // the clamped chip-aligned position and that it clears the chip.
            const chipRect = sbEndpointChip.getBoundingClientRect();
            const popRect = footerPop.getBoundingClientRect();
            const expectedLeft = Math.max(8, Math.min(chipRect.left, window.innerWidth - popRect.width - 8));
            if (Math.abs(popRect.left - expectedLeft) > 2) throw new Error('Connection popover must open above the chip: chip left ' + Math.round(chipRect.left) + ', popover left ' + Math.round(popRect.left) + ', expected ' + Math.round(expectedLeft));
            if (popRect.bottom > chipRect.top) throw new Error('Connection popover must clear the chip: popover bottom ' + Math.round(popRect.bottom) + ' vs chip top ' + Math.round(chipRect.top));
            const footerRows = [...footerPop.querySelectorAll('.sb-pop-row')];
            if (footerRows.length !== 2) throw new Error('Connection popover must list both connections, got ' + footerRows.length);
            const footerRow = footerRows.find(r => r.dataset.connId === footerTarget.id);
            if (!footerRow) throw new Error('Popover is missing the inactive connection row');
            footerRow.click();
            footerDeadline = Date.now() + 3000;
            while ((await reachApi.getSettings()).activeConnection !== footerTarget.id) {
              if (Date.now() > footerDeadline) throw new Error('Footer popover did not activate the clicked connection');
              await new Promise(r => setTimeout(r, 25));
            }
            if (!document.querySelector('#sb-conn-popover').classList.contains('hidden')) throw new Error('Popover must close after a switch');
            await window.ReachWorkspaceShell.refreshEndpointChip();
            if (document.querySelector('#sb-endpoint-text').textContent.indexOf('127.0.0.1:10') === -1) throw new Error('Endpoint chip did not repaint after the switch: ' + document.querySelector('#sb-endpoint-text').textContent);
            // The Settings draft followed the external switch WITHOUT a reload —
            // the radio moved — so the next Save cannot revert the footer's pick.
            const footerCard = document.querySelector('#conn-list .conn-card.active');
            if (!footerCard || footerCard.dataset.connId !== footerTarget.id) throw new Error('Settings draft did not follow the footer switch');
            if (!footerCard.querySelector('.conn-radio').checked) throw new Error('Settings draft radio did not move with the footer switch');
            // Model chip: opens the shared picker, targeted at the ACTIVE row.
            sbModelChip.click();
            footerDeadline = Date.now() + 3000;
            while (document.querySelector('#model-modal').classList.contains('hidden') || document.querySelector('#model-source').textContent.indexOf('Footer Switch Target') === -1) {
              if (Date.now() > footerDeadline) throw new Error('Model chip did not open the picker for the active connection');
              await new Promise(r => setTimeout(r, 25));
            }
            // The fixture endpoint is unreachable by design, so the picker must
            // settle into its failure state — proving it queried the ACTIVE row
            // rather than some cached list.
            footerDeadline = Date.now() + 5000;
            while (document.querySelector('#model-source').textContent.indexOf('request failed') === -1) {
              if (Date.now() > footerDeadline) throw new Error('Model picker did not settle on the fixture endpoint');
              await new Promise(r => setTimeout(r, 25));
            }
            document.querySelector('#btn-model-cancel').click();
            // The pick path (what a model click runs) writes to the ACTIVE row.
            const footerPick = await window.ReachWorkspaceShell.setConnectionModel(footerTarget.id, 'footer-picked');
            if (!footerPick || footerPick.ok === false) throw new Error('Footer model pick failed: ' + (footerPick && footerPick.err));
            if ((await reachApi.getSettings()).model !== 'footer-picked') throw new Error('Footer model pick did not persist');
            await window.ReachWorkspaceShell.refreshEndpointChip();
            if (document.querySelector('#sb-model-val').textContent !== 'footer-picked') throw new Error('Model chip did not repaint: ' + document.querySelector('#sb-model-val').textContent);
            // Save Settings must not silently revert the footer's switch or model
            // pick: the draft mirrors both, so save writes the same values back.
            await document.querySelector('#btn-save-settings').onclick();
            const footerAfterSave = await reachApi.getSettings();
            if (footerAfterSave.activeConnection !== footerTarget.id) throw new Error('Settings save reverted the footer switch');
            if (footerAfterSave.model !== 'footer-picked') throw new Error('Settings save reverted the footer model pick');
            // Test all: every row pings with the values on screen, in parallel.
            document.querySelector('#btn-test-all').click();
            footerDeadline = Date.now() + 8000;
            while (connStatusTexts().some(t => !t || t === 'Testing…')) {
              if (Date.now() > footerDeadline) throw new Error('Test all did not settle: ' + connStatusTexts().join(' | '));
              await new Promise(r => setTimeout(r, 50));
            }
            for (const text of connStatusTexts()) {
              if (!/^Failed/.test(text)) throw new Error('Unreachable endpoint must report a failure, got: ' + text);
            }
            // Cleanup: drop the fixture row and restore the :9 connection as
            // active (with its model), so later stages see the pre-block state.
            const footerRemove = await reachApi.connections.save({ action: 'remove', id: footerTarget.id });
            if (!footerRemove.ok) throw new Error('Footer fixture cleanup failed: ' + footerRemove.err);
            const footerRestore = await reachApi.connections.save({ action: 'update', id: footerRemove.connections.activeConnection, model: 'fixture' });
            if (!footerRestore.ok) throw new Error('Footer fixture model restore failed: ' + footerRestore.err);
            await loadSettings();
            await window.ReachWorkspaceShell.refreshEndpointChip();
            if (document.querySelector('#sb-endpoint-text').textContent !== '127.0.0.1:9') throw new Error('Cleanup did not restore the endpoint chip: ' + document.querySelector('#sb-endpoint-text').textContent);

            await window.ReachWorkspaceShell.goView('settings');
            await openSettingsPanel('connection');
            await loadSettings();
            await openSettingsPanel('budgeting');
            document.querySelector('#budget-scope').value = 'conversation';
            document.querySelector('#budget-scope').dispatchEvent(new Event('change'));
            document.querySelector('#budget-inherit').checked = false;
            document.querySelector('#budget-inherit').dispatchEvent(new Event('change'));
            document.querySelector('[data-budget-preset="unrestricted"]').click();
            await document.querySelector('#btn-save-budgets').onclick();
            const override = await reachApi.agents.get(fixture.agent.id);
            if (override.settings.budgetOverrides.maxRounds !== 0 || override.settings.approvals !== 'prompt' || !override.settings.reviewEdits) throw new Error('Conversation override changed permissions or lost zero');
            document.querySelector('#budget-inherit').checked = true;
            document.querySelector('#budget-inherit').dispatchEvent(new Event('change'));
            await document.querySelector('#btn-save-budgets').onclick();
            if ((await reachApi.agents.get(fixture.agent.id)).settings.budgetOverrides !== null) throw new Error('Global inheritance was not restored');
            let invalidRejected = false;
            try { await reachApi.saveSettings({ budgets: { maxTokens: -1 } }); } catch { invalidRejected = true; }
            if (!invalidRejected || (await reachApi.getSettings()).budgets.maxTokens !== 32768) throw new Error('Invalid settings damaged saved budgets');
            document.querySelector('#budget-scope').value = 'global';
            await openSettingsPanel('budgeting');
            setDrawer(false);
            if (window.__errors.length) throw new Error('Renderer errors: ' + window.__errors.join('; '));
          })()
        `);
        // Printed only if every assertion above passed: executeJavaScript rejects
        // on a throw and the smoke exits with SMOKE FAIL instead. An explicit
        // marker matters because the connection assertions sit INSIDE this call,
        // so without one their success is only inferable from later sections
        // having run — and this suite aborts early on the flaky browser stage.
        console.log('SETTINGS + CONNECTIONS SMOKE OK: panels, budgets, scope inheritance, multi-connection add/activate/remove, duplicate and unknown-id refusal, legacy projection follow-through, per-page connection pickers, team-pool click-to-toggle with active-connection fallback guard, persona-pin + team-spread persistence, status-bar quick-switch (connection popover activation + footer model pick surviving a Settings save), and connection auto-test + Test all status.');
        // Exercise manual compression through the real preload/renderer and SSE path.
        let compressionReady, finishCompression;
        const compressionStarted = new Promise(resolve => { compressionReady = resolve; });
        let compressionRequests = 0;
        const compressionServer = createServer(async (req, res) => {
          let raw = ''; for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw);
          if (!body.stream || !body.messages[0].content.includes('durable conversation memory')) { res.writeHead(400); res.end('Expected streamed summary'); return; }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const content = 'Goal: inspect src/chat.py. Completed: file read. Pending: tests and final report. Preserve compatibility.';
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
          const finish = () => res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
          if (++compressionRequests === 1) { finishCompression = finish; compressionReady(); }
          else finish();
        });
        await new Promise(resolve => compressionServer.listen(0, '127.0.0.1', resolve));
        const preCompressionSettings = loadSettings();
        try {
          const compressionAgent = getAgentStore().create({ name: 'Context compression fixture', dir: smokeProject, model: 'Qwen/fixture' });
          getAgentStore().setMessages(compressionAgent.id, [{ role: 'user', content: 'Inspect src/chat.py and preserve compatibility.' },
            ...Array.from({ length: 70 }, (_, i) => ({ role: 'assistant', content: `File evidence ${i}: ` + 'x'.repeat(1500) })),
            { role: 'user', content: 'Finish the tests and final report.' }]);
          getAgentStore().setRunState(compressionAgent.id, { status: 'paused', reason: 'Pending tests' });
          const savedHistory = JSON.stringify(compressionAgent.messages);
          await win.webContents.executeJavaScript(`(async () => {
            await reachApi.saveSettings({ endpoint: 'http://127.0.0.1:${compressionServer.address().port}/v1', budgets: (await reachApi.getBudgetSchema()).presets.balanced });
            await selectAgent({ id: ${JSON.stringify(compressionAgent.id)} });
            await showTab('agents');
            window.__compressionPromise = document.querySelector('#btn-agent-compact').onclick();
          })()`);
          await compressionStarted;
          win.showInactive();
          await win.webContents.executeJavaScript(`(async () => {
            const deadline = Date.now() + 3000;
            while (!document.querySelector('#agent-activity').textContent.includes('Writing memory') && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
            if (!document.querySelector('#agent-context').textContent.includes('segment 1 of')) throw new Error('Compression segment indicator missing');
            if (!document.querySelector('#btn-agent-compact').disabled) throw new Error('Duplicate manual compression allowed');
            if (!document.querySelector('#agent-activity').textContent.includes('Writing memory')) throw new Error('Compression stream progress missing');
          })()`);
          const compressionScreenshot = path.join(smokeRoot, 'context-compression.png');
          fs.writeFileSync(compressionScreenshot, (await win.capturePage()).toPNG());
          console.log('COMPRESSION SCREENSHOT: ' + compressionScreenshot);
          finishCompression();
          await win.webContents.executeJavaScript('window.__compressionPromise');
          if (JSON.stringify(compressionAgent.messages) !== savedHistory || !compressionAgent.context) throw new Error('Compression damaged history or failed to persist memory');
          await win.webContents.executeJavaScript(`(async () => {
            await selectAgent({ id: ${JSON.stringify(compressionAgent.id)} });
            await refreshContextStatus();
            if (!document.querySelector('#agent-context').textContent.includes('Last compression')) throw new Error('Saved compression status missing');
            if (document.querySelector('#btn-agent-compact').disabled || document.querySelector('#agent-status').textContent !== 'paused') throw new Error('Compression did not restore paused controls');
            if (window.__errors.length) throw new Error('Renderer errors: ' + window.__errors.join('; '));
          })()`);
          console.log('COMPRESSION SMOKE OK: streamed segments, progress, manual control, saved memory, unchanged history and paused-state restoration.');
        } finally {
          compressionServer.closeAllConnections(); compressionServer.close(); saveSettings(preCompressionSettings);
        }
        // Saving settings during a request must preserve its owner and Stop.
        let budgetRequestReady;
        const budgetRequestStarted = new Promise(resolve => { budgetRequestReady = resolve; });
        let budgetRequestCount = 0;
        const budgetServer = createServer((_req, res) => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          if (++budgetRequestCount > 1) {
            const content = JSON.stringify({ status: 'complete', message: 'Resumed regular chat.', actions: [], options: [] });
            res.end('data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
            return;
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'fixture reasoning' } }] }) + '\n\n');
          budgetRequestReady();
        });
        await new Promise(resolve => budgetServer.listen(0, '127.0.0.1', resolve));
        const previousSettings = loadSettings();
        try {
          const runAgent = await win.webContents.executeJavaScript(`(async () => {
            await reachApi.saveSettings({ endpoint: 'http://127.0.0.1:${budgetServer.address().port}/v1', budgets: (await reachApi.getBudgetSchema()).presets.unrestricted });
            const a = await reachApi.agents.create('Active settings fixture', ${JSON.stringify(smokeProject)}, 'fixture');
            await selectAgent(a.agent);
            await showTab('agents');
            await reachApi.agents.send(a.agent.id, 'Synthetic cancellation test');
            return a.agent.id;
          })()`);
          await budgetRequestStarted;
          win.showInactive();
          await win.webContents.executeJavaScript(`(async () => {
            await showTab('agents');
            const deadline = Date.now() + 3000;
            while (document.querySelector('#agent-activity .activity-title').textContent !== 'Thinking' && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
            const panel = document.querySelector('#agent-activity');
            if (panel.classList.contains('hidden') || panel.dataset.active !== 'true' || panel.querySelector('.activity-title').textContent !== 'Thinking') throw new Error('Reasoning has no active indicator');
            if (!panel.textContent.includes('17 characters received') || document.querySelector('#activity-global').hidden) throw new Error('Reasoning counter or global activity missing');
            const elapsed = panel.querySelector('.activity-time').textContent;
            const timerDeadline = Date.now() + 3000;
            while (panel.querySelector('.activity-time').textContent === elapsed && Date.now() < timerDeadline) await new Promise(r => setTimeout(r, 100));
            if (panel.querySelector('.activity-time').textContent === elapsed) throw new Error('Elapsed timer froze');
            await selectAgent(await reachApi.agents.get(${JSON.stringify(runAgent)}));
            if (!document.querySelector('#agent-activity').textContent.includes('17 characters received')) throw new Error('Switching chats lost activity');
          })()`);
          await new Promise(resolve => setTimeout(resolve, 200));
          const activityScreenshot = path.join(smokeRoot, 'live-activity.png');
          fs.writeFileSync(activityScreenshot, (await win.capturePage()).toPNG());
          console.log('ACTIVITY SCREENSHOT: ' + activityScreenshot);
          const originalLoop = agentLoops.get(runAgent);
          await win.webContents.executeJavaScript(`(async () => {
            await reachApi.saveSettings({ budgets: (await reachApi.getBudgetSchema()).presets.heavy });
            await reachApi.agents.update(${JSON.stringify(runAgent)}, { settings: { budgetOverrides: { maxTokens: 65536 } } });
          })()`);
          if (agentLoops.get(runAgent) !== originalLoop || !originalLoop.settingsStale || !originalLoop.running) throw new Error('Settings save orphaned the active loop');
          if (originalLoop._budgets().maxTokens !== 0) throw new Error('Active run changed budgets mid-request');
          await win.webContents.executeJavaScript(`(async () => {
            if (document.querySelector('#btn-send').textContent !== 'Stop') throw new Error('Regular chat did not show Stop');
            await document.querySelector('#btn-send').onclick();
          })()`);
          const stopDeadline = Date.now() + 3000;
          while (originalLoop.running && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 10));
          if (originalLoop.running || getAgentStore().get(runAgent).runState.status !== 'stopped') throw new Error('Stop failed after settings save');
          await new Promise(resolve => setTimeout(resolve, 180));
          if (await win.webContents.executeJavaScript(`document.querySelector('#agent-activity').dataset.active`) !== 'false') throw new Error('Activity still animates after Stop');
          console.log('ACTIVITY SMOKE OK: real streamed reasoning, counters, elapsed timer, chat switching and Stop.');
          const replacementLoop = await getAgentLoop(runAgent);
          if (replacementLoop === originalLoop || replacementLoop._budgets().maxTokens !== 65536) throw new Error('Next run did not receive updated settings');
          await win.webContents.executeJavaScript(`(async () => {
            const start = document.querySelector('#btn-agent-continue');
            if (start.classList.contains('hidden') || start.textContent !== 'Start') throw new Error('Stopped chat has no Start');
            await start.onclick();
          })()`);
          const resumeDeadline = Date.now() + 3000;
          while (getAgentStore().get(runAgent).runState.status !== 'completed' && Date.now() < resumeDeadline) await new Promise(resolve => setTimeout(resolve, 10));
          if (getAgentStore().get(runAgent).runState.status !== 'completed' || budgetRequestCount !== 2) throw new Error('Regular Start did not resume exactly once');
          await win.webContents.executeJavaScript(`reachApi.agents.delete(${JSON.stringify(runAgent)})`);
        } finally { budgetServer.closeAllConnections(); budgetServer.close(); saveSettings(previousSettings); }
        // A provider that ignores its budget guidance still leaves a useful,
        // explicitly app-authored checkpoint instead of an empty/error bubble.
        let exhaustedRequests = 0;
        const exhaustedServer = createServer(async (req, res) => {
          let raw = ''; for await (const chunk of req) raw += chunk;
          const request = JSON.parse(raw);
          exhaustedRequests++;
          if (request.max_tokens !== 512 || !request.messages[0].content.includes('Hard output allowance: 512')) { res.writeHead(400); res.end('Missing budget contract'); return; }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: '', reasoning_content: 'Provider reasoning without an answer' }, finish_reason: 'length' }] }));
        });
        await new Promise(resolve => exhaustedServer.listen(0, '127.0.0.1', resolve));
        const beforeExhaustedSettings = loadSettings();
        try {
          await win.webContents.executeJavaScript(`(async () => {
            await reachApi.saveSettings({ endpoint: 'http://127.0.0.1:${exhaustedServer.address().port}/v1', budgets: { ...(await reachApi.getBudgetSchema()).presets.balanced, maxTokens: 512 } });
            const fixture = await reachApi.agents.create('Budget-aware checkpoint', ${JSON.stringify(smokeProject)}, 'Qwen/fixture');
            await selectAgent(fixture.agent);
            await showTab('agents');
            await reachApi.agents.send(fixture.agent.id, 'Inspect the project within the configured output budget.');
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline) {
              const saved = await reachApi.agents.get(fixture.agent.id);
              if (saved.runState?.status === 'paused' && document.querySelector('#chat-log').textContent.includes('REACH budget checkpoint')) break;
              await new Promise(r => setTimeout(r, 25));
            }
            const saved = await reachApi.agents.get(fixture.agent.id);
            if (saved.runState?.status !== 'paused' || !document.querySelector('#chat-log').textContent.includes('REACH budget checkpoint')) throw new Error('Output exhaustion produced no visible checkpoint');
            if (document.querySelector('#chat-log').textContent.includes('Error:') || !saved.messages.some(m => m._reachMeta?.source === 'budget-checkpoint')) throw new Error('Budget checkpoint missing or rendered as an error');
            if (document.querySelector('#btn-agent-continue').classList.contains('hidden') || document.querySelector('#btn-send').textContent !== 'Send') throw new Error('Budget checkpoint cannot resume');
            if (window.__errors.length) throw new Error('Renderer errors: ' + window.__errors.join('; '));
          })()`);
          if (exhaustedRequests !== 2) throw new Error('Budget recovery exceeded one concise retry');
          console.log('BUDGET AWARENESS SMOKE OK: model receives actual limit, exactly one capped retry, visible saved checkpoint, no error bubble and Continue available.');
        } finally {
          exhaustedServer.closeAllConnections(); exhaustedServer.close(); saveSettings(beforeExhaustedSettings);
        }
        // Completed activity must never displace the composer, even with long
        // provider summaries, an expanded plan, and every result opened.
        const layoutAgent = getAgentStore().create({ name: 'Read through the project and write a detailed summary', dir: smokeProject });
        const report = '# Project summary\n\n' + 'A detailed finding with a source path and supporting evidence. '.repeat(600);
        getAgentStore().setMessages(layoutAgent.id, [{ role: 'user', content: 'Review the project.' }, { role: 'assistant', content: report }]);
        getAgentStore().setTodos(layoutAgent.id, Array.from({ length: 30 }, (_, i) => ({ text: 'Review project component ' + i, status: 'completed' })));
        getAgentStore().setRunState(layoutAgent.id, { status: 'completed', reason: report });
        let layoutActivity = null;
        const activityReducer = require('./renderer/activity-state.js').reduce;
        for (let i = 0; i < 80; i++) {
          layoutActivity = activityReducer(layoutActivity, { type: 'tool-call', tool: 'read', arguments: { path: 'src/component-' + i + '.py' } });
          layoutActivity = activityReducer(layoutActivity, { type: 'tool-result', ok: true, result: { content: report } });
        }
        layoutActivity = activityReducer(layoutActivity, { type: 'run-state', status: 'completed', reason: report });
        getAgentStore().setActivity(layoutAgent.id, layoutActivity);
        win.showInactive();
        for (const [width, height, zoom] of [[1000, 640, 1], [1440, 860, 1], [1420, 980, 1.25]]) {
          win.setSize(width, height);
          win.webContents.setZoomFactor(zoom);
          await new Promise(resolve => setTimeout(resolve, 150));
          await win.webContents.executeJavaScript(`(async () => {
            await selectAgent({ id: ${JSON.stringify(layoutAgent.id)} });
            await showTab('agents');
            await selectDrawerPanel('files');
            setDrawer(true);
            await new Promise(r => setTimeout(r, 200));
            const activity = document.querySelector('#agent-activity');
            const activityDeadline = Date.now() + 3000;
            while (!activity.querySelector('.activity-count').textContent.includes('80 steps') && Date.now() < activityDeadline) await new Promise(r => setTimeout(r, 20));
            const details = activity.querySelector('.activity-details');
            if (details.open) throw new Error('Completed activity did not start collapsed: ' + JSON.stringify({ status: activity.dataset.status, count: activity.querySelector('.activity-count').textContent, saved: currentAgent.activity?.status }));
            if (activity.querySelector('.activity-note').textContent.length > 100) throw new Error('Activity duplicates the final report');
            const composer = document.querySelector('.composer');
            const input = document.querySelector('#composer-input');
            const scroll = document.querySelector('#chat-scroll');
            const before = composer.getBoundingClientRect();
            details.querySelector('summary').click();
            for (const result of activity.querySelectorAll('.activity-result')) result.open = true;
            await new Promise(r => requestAnimationFrame(r));
            const after = composer.getBoundingClientRect();
            if (!details.open) throw new Error('Completed activity cannot be expanded');
            if (Math.abs(before.top - after.top) > 1 || after.bottom > innerHeight || after.right > innerWidth + 1 || after.left < 0) throw new Error('Expanded activity displaced composer: ' + JSON.stringify({ before: before.toJSON(), after: after.toJSON(), width: innerWidth, height: innerHeight }));
            if (after.right > document.querySelector('#file-drawer').getBoundingClientRect().left + 1) throw new Error('Composer extends underneath the Files panel');
            if (scroll.clientHeight < 60 || input.getBoundingClientRect().width < 60) throw new Error('Conversation or input squeezed out of view: ' + JSON.stringify({ height: scroll.clientHeight, inputWidth: input.getBoundingClientRect().width, window: [innerWidth, innerHeight] }));
            if (document.body.scrollHeight > innerHeight + 1) throw new Error('Conversation overflowed the window');
            const header = document.querySelector('#agent-model-info');
            const headerBeforeScroll = header.getBoundingClientRect();
            const contextBeforeScroll = document.querySelector('.context-bar').getBoundingClientRect();
            if (!scroll.contains(activity)) throw new Error('Activity is outside the shared conversation scroller');
            scroll.scrollTop = scroll.scrollHeight;
            if (Math.abs(header.getBoundingClientRect().top - headerBeforeScroll.top) > 1 || Math.abs(document.querySelector('.context-bar').getBoundingClientRect().top - contextBeforeScroll.top) > 1) throw new Error('Conversation scrolling moved the stationary status header');
            if (scroll.scrollTop <= 0 || Math.abs(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight) > 2) throw new Error('Final answer is not reachable by scrolling');
            const lastMessage = document.querySelector('#chat-log .chat-msg:last-child').getBoundingClientRect();
            const viewport = scroll.getBoundingClientRect();
            if (lastMessage.bottom > viewport.bottom + 1 || lastMessage.bottom < viewport.top) throw new Error('The end of the actual final answer is not visible');
            input.value = 'Layout test draft'; input.focus();
            if (document.activeElement !== input) throw new Error('Composer is not usable');
            // Routine activity repaint must preserve a manually expanded completed trace.
            window.ReachActivity.select(currentAgent);
            await new Promise(r => setTimeout(r, 150));
            if (!details.open) throw new Error('Activity repaint collapsed the user-opened trace');
            if (getComputedStyle(document.querySelector('#agent-name')).fontSize !== (innerHeight <= 760 || document.querySelector('.workbench').clientWidth - 32 <= 620 ? '18px' : '24px')) throw new Error('Compact header did not respond to available space');
            await new Promise(r => setTimeout(r, 100));
          })()`);
          const layoutScreenshot = path.join(smokeRoot, `chat-layout-${width}-${zoom}.png`);
          fs.writeFileSync(layoutScreenshot, (await win.capturePage()).toPNG());
          console.log('CHAT LAYOUT SCREENSHOT: ' + layoutScreenshot);
          await win.webContents.executeJavaScript("document.querySelector('#agent-activity .activity-details').open = false");
        }
        win.webContents.setZoomFactor(1);
        console.log('CHAT LAYOUT SMOKE OK: long completed report, 80 expanded activity results, 30 plan items, file panel, minimum window and 125% zoom; stationary status header, responsive compact layout and visible composer.');
        win.setSize(1420, 980);
        await new Promise(resolve => setTimeout(resolve, 150));
        const settingsScreenshot = path.join(smokeRoot, 'budget-settings.png');
        fs.writeFileSync(settingsScreenshot, (await win.webContents.capturePage()).toPNG());
        console.log('SETTINGS SCREENSHOT: ' + settingsScreenshot);
        await require('./browser/smoke.cjs')(win, studioBrowser, smokeRoot);
        const beforeTheme = loadSettings();
        const cachedLoops = [...agentLoops.entries()];
        await win.webContents.executeJavaScript(`(async () => {
          await selectDrawerPanel('files');
          await openFile('hello.py');
          const editor = openFiles.get('hello.py').editor;
          editor.view.dispatch({ changes: { from: editor.getText().length, insert: '\\n# unsaved theme check' }, selection: { anchor: 3 } });
          const text = editor.getText();
          const selection = editor.view.state.selection.main.head;
          const button = document.querySelector('#theme-toggle');
          await button.onclick();
          if (document.documentElement.dataset.theme !== 'light' || button.getAttribute('aria-checked') !== 'true') throw new Error('Light switch failed');
          if (getComputedStyle(document.body).backgroundColor !== 'rgb(253, 246, 227)') throw new Error('Light palette missing');
          if (editor.getText() !== text || editor.view.state.selection.main.head !== selection) throw new Error('Theme reset editor state');
          if (getComputedStyle(editor.view.dom).backgroundColor !== 'rgb(253, 246, 227)') throw new Error('Editor did not follow light theme');
          await button.onclick();
          if (document.documentElement.dataset.theme !== 'dark' || getComputedStyle(document.body).backgroundColor !== 'rgb(10, 10, 10)') throw new Error('Dark palette did not restore');
          await button.onclick();
          editor.setText(editor.getText().replace('\\n# unsaved theme check', ''));
          openFiles.get('hello.py').dirty = false;
        })()`);
        if (loadSettings().theme !== 'light' || loadSettings().accessKey !== beforeTheme.accessKey || cachedLoops.some(([id, loop]) => agentLoops.get(id) !== loop)) throw new Error('Theme save changed connection or agent state');
        const credentialCheck = loadSettings();
        const settingsOnDisk = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
        if (settingsOnDisk.schemaVersion !== 1 || settingsOnDisk.accessKey !== undefined) throw new Error('Settings schema or legacy credential projection persisted incorrectly');
        if (credentialCheck.credentialStorage.encrypted && settingsOnDisk.connections.some(connection => connection.accessKey)) throw new Error('Plaintext connection key remained in settings');
        if (settingsOnDisk.credentialStorage !== undefined) throw new Error('Transient credential status persisted');
        console.log('CREDENTIAL STORAGE SMOKE OK: schema, disk projection, OS vault/fallback, and decrypted settings preservation.');
        await new Promise(resolve => setTimeout(resolve, 150));
        await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        await new Promise(resolve => setTimeout(resolve, 350));
        const themeScreenshot = path.join(smokeRoot, 'light-theme.png');
        fs.writeFileSync(themeScreenshot, (await win.capturePage()).toPNG());
        console.log('LIGHT THEME SCREENSHOT: ' + themeScreenshot);
        await win.webContents.executeJavaScript(`(async () => {
          await document.querySelector('#theme-toggle').onclick();
          appendChatMessage('user', 'Review this project and suggest the next steps.');
          appendChatMessage('assistant', 'The project is ready to explore. Start with the entry point, then check the tests and review any changes before saving.');
        })()`);
        await new Promise(resolve => setTimeout(resolve, 500));
        const darkScreenshot = path.join(smokeRoot, 'dark-theme.png');
        fs.writeFileSync(darkScreenshot, (await win.capturePage()).toPNG());
        console.log('DARK THEME SCREENSHOT: ' + darkScreenshot);
        await win.webContents.executeJavaScript(`(async () => {
          document.querySelector('[data-settings-panel="connection"]').click();
        })()`);
        await new Promise(resolve => setTimeout(resolve, 500));
        fs.writeFileSync(path.join(smokeRoot, 'dark-settings.png'), (await win.capturePage()).toPNG());
        await win.webContents.executeJavaScript(`document.querySelector('#theme-toggle').onclick()`);
        const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        win.webContents.reload();
        await reloaded;
        if (await win.webContents.executeJavaScript(`document.documentElement.dataset.theme`) !== 'light') throw new Error('Theme did not survive reload');
        console.log('THEME SMOKE OK: light/dark switch, editor state, credential preservation and persisted preference.');
        if (process.platform === 'darwin') {
          const closed = new Promise(resolve => win.once('closed', resolve));
          win.close();
          await closed;
          if (BrowserWindow.getAllWindows().length) throw new Error('Mac window did not close');
          app.emit('activate');
          if (!win || win.isDestroyed()) throw new Error('Dock activation did not reopen the window');
          await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
          const reopened = await win.webContents.executeJavaScript(`(async () => {
            const projects = await reachApi.getProjects();
            const browser = await reachApi.browser.command('state');
            return { projects: projects.length, browser: browser.ok === true };
          })()`);
          if (!reopened.projects || !reopened.browser) throw new Error('Reopened workspace lost projects or browser IPC');
          console.log('MAC LIFECYCLE SMOKE OK: close last window, Dock activation, project persistence and browser IPC.');
        }

        // ---------- PRD workspace shell: nav rail, hotkeys, status bar, new pages ----------
        {
          const shell = await win.webContents.executeJavaScript(`(async () => {
            // The nav rail must exist and expose every view, including the new ones.
            const rail = document.querySelector('#nav-rail');
            if (!rail) return { err: 'nav rail missing' };
            const items = [...rail.querySelectorAll('.rail-item')].map(b => b.dataset.view);
            const pages = ['workspace', 'playground', 'projects', 'agents', 'create', 'settings', 'refactor', 'about'];
            const missing = pages.filter(p => !document.querySelector('#page-' + p));
            if (missing.length) return { err: 'missing pages: ' + missing.join(',') };
            const railViews = rail.querySelectorAll('.rail-item').length;

            // Rail navigation drives the same showTab() path as the header tabs.
            await window.ReachWorkspaceShell.goView('workspace');
            const wsActive = document.querySelector('#page-workspace').classList.contains('active');
            const railActive = document.querySelector('#rail-workspace').classList.contains('active');
            await window.ReachWorkspaceShell.goView('about');
            const aboutActive = document.querySelector('#page-about').classList.contains('active');
            // Refactor is a rail destination with NO numeric hotkey: PRD1 pins
            // Ctrl/Cmd+1-6 to the six primary views, so it must be reachable by
            // rail click alone and must not have claimed a hotkey.
            await window.ReachWorkspaceShell.goView('refactor');
            const refactorActive = document.querySelector('#page-refactor').classList.contains('active');
            const refactorRailActive = document.querySelector('#rail-refactor').classList.contains('active');
            const refactorHasHotkey = document.querySelector('#rail-refactor').hasAttribute('data-hotkey');

            // Bottom status bar exists and reflects the configured endpoint.
            // The chip refreshes at init/workspace-sync; refresh it explicitly so
            // the assertion is not dependent on when saveSettings last ran.
            await window.ReachWorkspaceShell.refreshEndpointChip();
            const sb = document.querySelector('#statusbar-bottom');
            const endpointText = document.querySelector('#sb-endpoint-text');

            // Back to a view the existing smoke assertions may still rely on.
            await window.ReachWorkspaceShell.goView('projects');
            return { railViews, items, wsActive, railActive, aboutActive, refactorActive, refactorRailActive, refactorHasHotkey, hasSb: !!sb, endpointText: endpointText && endpointText.textContent };
          })()`);
          if (shell.err) throw new Error(shell.err);
          if (shell.railViews !== 8) throw new Error('Expected 8 rail items, got ' + shell.railViews);
          if (!shell.wsActive) throw new Error('Workspace page did not activate via the rail');
          if (!shell.railActive) throw new Error('Rail did not mark Workspace active');
          if (!shell.aboutActive) throw new Error('About page did not activate via the rail');
          if (!shell.refactorActive) throw new Error('Refactor page did not activate via the rail');
          if (!shell.refactorRailActive) throw new Error('Rail did not mark Refactor active');
          if (shell.refactorHasHotkey) throw new Error('Refactor rail item must not claim a numeric hotkey (Ctrl/Cmd+1-6 are pinned to the primary views)');
          if (!shell.hasSb) throw new Error('Bottom status bar missing');
          if (shell.endpointText === 'no endpoint') throw new Error('Status bar did not reflect the configured endpoint');

          // Ctrl/Cmd+1..6 hotkeys switch views (and never fire while typing).
          const hotkeys = await win.webContents.executeJavaScript(`(async () => {
            const dispatch = (key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }));
            dispatch('2');
            await new Promise(r => setTimeout(r, 30));
            const playground = document.querySelector('#page-playground').classList.contains('active');
            // Typing guard: a real keystroke targets the FOCUSED element, so
            // dispatch on the textarea. Ctrl+1 there is data, not a shortcut.
            const input = document.querySelector('#pg-prompt');
            input.focus();
            input.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }));
            await new Promise(r => setTimeout(r, 30));
            const stillPlayground = document.querySelector('#page-playground').classList.contains('active');
            // With no field focused the same hotkey navigates for real.
            input.blur();
            dispatch('6');
            await new Promise(r => setTimeout(r, 30));
            const settings = document.querySelector('#page-settings').classList.contains('active');
            return { playground, stillPlayground, settings };
          })()`);
          if (!hotkeys.playground) throw new Error('Ctrl+2 did not open the Playground');
          if (!hotkeys.stillPlayground) throw new Error('Ctrl+1 while typing in a textarea must not navigate');
          if (!hotkeys.settings) throw new Error('Ctrl+6 did not open Settings');

          // The About page populates real app info, not a placeholder.
          const aboutInfo = await win.webContents.executeJavaScript(`(async () => {
            await window.ReachAbout.sync();
            const dd = [...document.querySelectorAll('#ab-list dd')].map(e => e.textContent);
            return { count: dd.length, hasVersion: dd.some(t => /\\d+\\.\\d+\\.\\d+/.test(t)) };
          })()`);
          if (aboutInfo.count === 0) throw new Error('About page populated nothing');
          if (!aboutInfo.hasVersion) throw new Error('About page did not show the app version');

          // ---------- Refactor workbench: real plan -> review -> apply over IPC ----------
          // Exercises the renderer module, the preload bridge, the plan session in
          // main, chunk selection, atomic apply and single-use planId. The model
          // `generate` path is NOT driven here (it needs a live endpoint); it is
          // covered by the refactor:generate handler's own validation and by
          // proposeEditsViaModel's shared JSON extraction.
          const refactorFile = path.join(smokeProject, 'refactor-sample.js');
          // Two changes separated by a 3-line unchanged gap, so the preview at
          // context=2 genuinely shows TWO chunks. The original 4-line fixture
          // merged both hunks into a single chunk, which made "partial apply"
          // apply everything and defeated the whole point of the check.
          fs.writeFileSync(refactorFile, [
            'function computeTotal(a, b) {',
            '  return a + b;',
            '}',
            'const SCALE = 2;',
            'const OFFSET = 10;',
            "const NOTE = 'unchanged';",
            'module.exports = { computeTotal };',
            '',
          ].join('\n'));
          const rf = await win.webContents.executeJavaScript(`(async () => {
            const dir = ${JSON.stringify(smokeProject)};
            const api = window.reach.refactor;
            if (!api) return { err: 'refactor bridge missing' };

            // 1. Plan a real two-hunk change to one file. Nothing is written yet.
            const planned = await api.plan({ projectDir: dir, context: 2, edits: [
              { path: 'refactor-sample.js', hunks: [
                { search: 'function computeTotal(', replace: 'function sumTotals(' },
                { search: 'module.exports = { computeTotal }', replace: 'module.exports = { sumTotals }' },
              ] },
            ] });
            if (!planned.ok) return { err: 'plan failed: ' + planned.err };
            const file = planned.plan.files[0];
            const chunkCount = file.chunks.length;
            const rowCount = file.chunks.reduce((n, c) => n + c.rows.length, 0);
            // Rows carry PLAIN TEXT; the renderer escapes/highlights. A row whose
            // text already contained markup would mean main was building HTML.
            const rowsAreText = file.chunks.every(c => c.rows.every(r =>
              (r.left ? typeof r.left.text === 'string' : true) && (r.right ? typeof r.right.text === 'string' : true)));

            // 2. Reject every chunk: apply must refuse rather than write nothing silently.
            const noneSel = {};
            noneSel[file.path] = [];
            const rejectedAll = await api.apply({ planId: planned.planId, projectDir: dir, accepted: noneSel });
            const refusedEmpty = rejectedAll.ok === false;

            // 3. Accept one chunk only (partial selection) on a FRESH plan.
            const planned2 = await api.plan({ projectDir: dir, context: 2, edits: [
              { path: 'refactor-sample.js', hunks: [
                { search: 'function computeTotal(', replace: 'function sumTotals(' },
                { search: 'module.exports = { computeTotal }', replace: 'module.exports = { sumTotals }' },
              ] },
            ] });
            const file2 = planned2.plan.files[0];
            const partial = {};
            partial[file2.path] = [file2.chunks[0].id];
            const applied = await api.apply({ planId: planned2.planId, projectDir: dir, accepted: partial });
            if (!applied.ok) return { err: 'partial apply failed: ' + applied.err };

            // 4. The planId is single-use: replaying must be refused, not re-applied.
            const replay = await api.apply({ planId: planned2.planId, projectDir: dir });
            const replayRefused = replay.ok === false;

            // 5. Path traversal and absolute paths must be refused by the plan.
            const traversal = await api.plan({ projectDir: dir, edits: [{ path: '../escape.js', content: 'x' }] });
            const absolute = await api.plan({ projectDir: dir, edits: [{ path: ${JSON.stringify(process.platform === 'win32' ? 'C:/Windows/x.js' : '/etc/x.js')}, content: 'x' }] });

            // 6. A stale/unknown planId is refused.
            const unknown = await api.apply({ planId: 'rfp-does-not-exist', projectDir: dir });

            // 7. The renderer module is present and its page renders.
            const hasModule = typeof window.ReachRefactor === 'object';
            await window.ReachWorkspaceShell.goView('refactor');
            const pageHasTask = !!document.querySelector('#rf-task');
            const pageHasApply = !!document.querySelector('#rf-apply');

            return { chunkCount, rowCount, rowsAreText, refusedEmpty, appliedFiles: applied.applied,
              replayRefused, traversalRefused: traversal.ok === false, absoluteRefused: absolute.ok === false,
              unknownRefused: unknown.ok === false, hasModule, pageHasTask, pageHasApply };
          })()`);
          if (rf.err) throw new Error(rf.err);
          if (!(rf.chunkCount >= 2)) throw new Error('Refactor plan must split into 2 chunks at context=2, got ' + rf.chunkCount);
          if (!(rf.rowCount > 0)) throw new Error('Refactor diff produced no rows');
          if (!rf.rowsAreText) throw new Error('Diff rows must carry plain text, not markup');
          if (!rf.refusedEmpty) throw new Error('Apply with zero accepted chunks must be refused');
          if (!Array.isArray(rf.appliedFiles) || rf.appliedFiles.length !== 1) throw new Error('Partial apply did not write exactly one file: ' + JSON.stringify(rf.appliedFiles));
          if (!rf.replayRefused) throw new Error('A planId must be single-use');
          if (!rf.traversalRefused) throw new Error('Refactor plan accepted a traversal path');
          if (!rf.absoluteRefused) throw new Error('Refactor plan accepted an absolute path');
          if (!rf.unknownRefused) throw new Error('An unknown planId was not refused');
          if (!rf.hasModule) throw new Error('ReachRefactor module did not load');
          if (!rf.pageHasTask || !rf.pageHasApply) throw new Error('Refactor page is missing its task/apply controls');
          // The partial apply changed only the first hunk; confirm on disk.
          const rfAfter = fs.readFileSync(refactorFile, 'utf8');
          if (!rfAfter.includes('sumTotals(')) throw new Error('Accepted chunk was not written to disk');
          // The second hunk was NOT accepted, so the export line must be untouched.
          if (!rfAfter.includes('module.exports = { computeTotal }')) throw new Error('An unaccepted chunk was written to disk');

          console.log('WORKSPACE SHELL SMOKE OK: 8-item nav rail, rail+hotkey navigation, typing guard, persistent status bar, Workspace/Playground/About pages, About version info, refactor workbench plan/partial-apply/single-use/path-jail.');
        }

        console.log(`SMOKE OK: preload, renderer controls, projects, conversations+branching, personas+teams, editor, markdown, real parallel scans, responsive IPC, Stop team, clean saved answers, dialog cancel+confirm, keyboard text input and send after dialogs, project selection+same-name files+safe saves+unsaved cancellation+rapid switching, settings dropdowns+budget presets+scope inheritance+credential preservation+validation+save-during-run+Stop+next-run-budget, workspace shell+rail+hotkeys+status bar, refactor workbench, optional CLI -> ${v}`);
        app.exit(0);
      } catch (e) {
        console.error(`SMOKE FAIL: ${e.stack || e.message}`);
        app.exit(1);
      } finally {
        clearTimeout(timeout);
      }
    })();
    return;
  }
  createWindow();
});

app.on('window-all-closed', () => {
  reachProcess.killAllRuns();
  for (const loop of agentLoops.values()) loop.stop();
  for (const runner of teamRuns.values()) runner.stop();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow({ show: !process.argv.includes('--smoke') });
});
app.on('before-quit', () => {
  reachProcess.killAllRuns();
  for (const loop of agentLoops.values()) loop.stop();
  for (const runner of teamRuns.values()) runner.stop();
});
