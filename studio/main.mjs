import { app, nativeTheme, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { AgentStore } = require('./agent/agent-store.cjs');
const { AgentLoop } = require('./agent/agent-loop.cjs');
const { parseAgentResponse } = require('./agent/agent-response.cjs');
const { createReachToolExecutor } = require('./agent/reach-tool-executor.cjs');
const { PersonaStore } = require('./agent/persona-store.cjs');
const { TeamRunner } = require('./agent/team-runner.cjs');
const reachProcess = require('./agent/reach-process.cjs');
const { resolveInProject } = require('./agent/tool-registry.cjs');
const { readTextFile, writeTextFile } = require('./agent/text-files.cjs');
const { fields: budgetFields, defaults: budgetDefaults, presets: budgetPresets, validateBudgets, resolveBudgets } = require('./agent/budgets.cjs');
const { listDirectory } = require('./agent/file-browser.cjs');
const { StudioBrowser } = require('./browser/host.cjs');
let studioBrowser = null;

const isDev = !app.isPackaged;
// ESM has no __dirname; import.meta.dirname is supported by the bundled Node runtime.
const rootDir = import.meta.dirname;
// Smoke checks create conversations; keep them out of the user's real store.
const smokeRoot = process.argv.includes('--smoke') ? fs.mkdtempSync(path.join(os.tmpdir(), 'reach-studio-smoke-')) : null;
const smokeProject = smokeRoot ? path.join(smokeRoot, 'project') : null;
if (smokeRoot) app.setPath('userData', path.join(smokeRoot, 'profile'));

let win = null;
let agentStore = null;
let personaStore = null;
let agentLoops = new Map(); // agentId -> AgentLoop
let teamRuns = new Map();   // teamRunId -> TeamRunner

// ---------- stores ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); }
  catch { return {}; }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

const projectsFile = () => path.join(app.getPath('userData'), 'projects.json');
function loadProjects() {
  try { return JSON.parse(fs.readFileSync(projectsFile(), 'utf8')); }
  catch { return []; }
}
function saveProjects(ps) {
  fs.mkdirSync(path.dirname(projectsFile()), { recursive: true });
  fs.writeFileSync(projectsFile(), JSON.stringify(ps, null, 2));
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
const pendingMemberAnswers = new Map(); // questionId -> fn(answer) that unblocks a waiting_input member

/* Approval bus: the main process owns the map of pending approval requests.
 * Renderer responses arrive over ipcMain.handle('agents:respondApproval')
 * (invoke — which actually reaches main; webContents.send does not). */
const pendingApprovals = new Map(); // requestId -> resolve

function requestApprovalFromRenderer(payload, timeoutMs = 300000) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(false);
    const requestId = 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    pendingApprovals.set(requestId, resolve);
    win.webContents.send('agent:approval-request', { requestId, ...payload });
    // Zero removes the app's approval deadline; Stop still cancels the run.
    if (timeoutMs > 0) setTimeout(() => {
      if (pendingApprovals.delete(requestId)) resolve(false);
    }, timeoutMs);
  });
}

async function getAgentLoop(agentId) {
  const cached = agentLoops.get(agentId);
  if (cached && (cached.running || !cached.settingsStale)) return cached;
  const store = getAgentStore();
  const agent = store.get(agentId);
  if (!agent) throw new Error('Agent not found.');

  const settings = loadSettings();
  // Follow gist/.txt endpoint pointers (same rule as models:list) so the
  // agent runs against the same endpoint the user sees in Settings.
  let endpoint = settings.endpoint || '';
  try { endpoint = await resolveEndpoint(endpoint); }
  catch (e) { console.warn('endpoint resolve failed, using raw:', e.message); }
  const accessKey = settings.accessKey || '';

  const budgets = resolveBudgets(settings, agent.settings);
  const loop = new AgentLoop({
    agentId,
    store,
    endpoint,
    accessKey,
    model: agent.model || settings.model || 'gpt-4o-mini',
    budgets,
    projectDir: agent.dir,
    reachExecutor: createReachToolExecutor(),
    browserExecutor: (op, args, ctx) => studioBrowser.agentCommand(op, args, { ...ctx, owner: 'chat:' + ctx.agentId }),
    sendEvent: (channel, payload) => {
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
    requestApproval: payload => requestApprovalFromRenderer(payload, budgets.approvalTimeoutMs),
    requestEditReview: (edit) => {
      store.addPendingEdit(agentId, edit);
      if (win && !win.isDestroyed()) {
        win.webContents.send('agent:edit-pending', { agentId, edit });
      }
    },
  });
  agentLoops.set(agentId, loop);
  return loop;
}

/* Endpoint resolution: follow gist/.txt pointers like the VS Code extension. */
async function resolveEndpoint(raw, depth = 0) {
  if (depth > 3) throw new Error('Endpoint pointer redirects in a loop.');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS endpoint without embedded credentials.');
  }
  if (url.hostname === 'gist.githubusercontent.com' || /\.txt(?:\/v1)?\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/v1\/?$/, '');
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Endpoint pointer returned HTTP ${response.status}`);
    const target = (await response.text()).trim();
    return resolveEndpoint(target, depth + 1);
  }
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
  url.search = ''; url.hash = '';
  return url.toString().replace(/\/$/, '');
}

// ---------- ipc ----------
function registerIpc() {
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
  ipcMain.handle('projects:save', (_e, ps) => saveProjects(ps));

  ipcMain.handle('settings:get', () => loadSettings());
  ipcMain.handle('settings:budgetSchema', () => ({ fields: budgetFields, defaults: budgetDefaults, presets: budgetPresets }));
  ipcMain.handle('settings:save', (_e, s) => {
    const next = { ...loadSettings(), ...s };
    if (s.budgets !== undefined) next.budgets = { ...budgetDefaults, ...validateBudgets(s.budgets) };
    saveSettings(next);
    // Settings drive every agent loop's endpoint + default model — drop the
    // cache so the next message builds a fresh loop with the new values.
    for (const [id, loop] of agentLoops) {
      if (loop.running) loop.settingsStale = true;
      else agentLoops.delete(id);
    }
    return { ok: true };
  });

  ipcMain.handle('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
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
  ipcMain.handle('agents:create', (_e, { name, dir, model }) => {
    try {
      const agent = getAgentStore().create({ name, dir, model });
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
    if (patch.settings?.budgetOverrides != null) patch.settings.budgetOverrides = validateBudgets(patch.settings.budgetOverrides);
    const agent = getAgentStore().update(id, patch);
    // A settings save must not orphan an active loop or break Stop.
    const loop = agentLoops.get(id);
    if (loop?.running) loop.settingsStale = true;
    else agentLoops.delete(id);
    return agent ? { ok: true, agent } : { ok: false, err: 'Agent not found' };
  });
  ipcMain.handle('agents:delete', (_e, id) => {
    const loop = agentLoops.get(id);
    if (loop) loop.stop();
    agentLoops.delete(id);
    return { ok: getAgentStore().remove(id) };
  });
  ipcMain.handle('agents:send', async (_e, { id, text }) => {
    try {
      const loop = await getAgentLoop(id);
      // Auto-title: the first user message names an untitled chat.
      const store = getAgentStore();
      const agent = store.get(id);
      if (agent && (!agent.name || agent.name === 'Chat' || agent.name.startsWith('Chat '))) {
        const title = String(text).trim().replace(/\s+/g, ' ').slice(0, 42) || 'Chat';
        store.update(id, { name: title });
        if (win && !win.isDestroyed()) win.webContents.send('agent:event', { agentId: id, type: 'renamed', name: title });
      }
      loop.sendUserMessage(text).catch((err) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('agent:event', { agentId: id, type: 'error', message: err.message });
        }
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, err: e.message };
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
    const loop = agentLoops.get(id);
    if (loop) loop.stop();
    return { ok: true };
  });
  ipcMain.handle('runs:stop', () => {
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
      resolve(!!approved);
    }
    return { ok: true };
  });
  ipcMain.handle('agents:resolveEdit', (_e, { id, editId, accepted }) => {
    const edit = getAgentStore().getPendingEdit(id, editId);
    if (!edit) return { ok: false, err: 'Edit not found (already resolved?)' };
    if (accepted) {
      try {
        fs.mkdirSync(path.dirname(edit.absPath), { recursive: true });
        writeTextFile(edit.absPath, edit.proposed);
      } catch (e) {
        return { ok: false, err: e.message };
      }
    }
    getAgentStore().resolvePendingEdit(id, editId, accepted);
    getAgentStore().appendMessage(id, { role: 'user', content: `TOOL RESULTS\nEdit ${edit.path}: ${accepted ? 'accepted and written to disk' : 'rejected by the user'}.`, _reachMeta: { source: 'tool-summary' } });
    return { ok: true, accepted: !!accepted };
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

  ipcMain.handle('teams:run', async (_e, { teamId, task, dir, agentId }) => {
    try {
      const ps = getPersonaStore();
      const team = ps.getTeam(teamId);
      if (!team) return { ok: false, err: 'Team not found.' };
      if (!team.members || !team.members.length) return { ok: false, err: 'The team has no members.' };
      if (!String(task || '').trim()) return { ok: false, err: 'A task is required.' };

      const settings = loadSettings();
      let endpoint = settings.endpoint || '';
      try { endpoint = await resolveEndpoint(endpoint); } catch (e) { return { ok: false, err: 'Endpoint: ' + e.message }; }
      if ([...teamRuns.values()].some(runner => !runner.paused)) return { ok: false, err: 'A team is already running. Stop it or wait for it to finish first.' };
      for (const [id, runner] of teamRuns) { runner.stop(); teamRuns.delete(id); }
      const accessKey = settings.accessKey || '';
      const defaultModel = settings.model || 'gpt-4o-mini';

      // Resolve the roster (personas in member order; skip deleted ones).
      // Keep persona+role PAIRED while filtering — filtering personas alone
      // would misalign roles against indexes after a deletion.
      const roster = team.members
        .map(m => ({ persona: ps.getPersona(m.personaId), role: String(m.role || '') }))
        .filter(r => r.persona);
      if (!roster.length) return { ok: false, err: 'All team personas were deleted.' };
      const personas = roster.map(r => r.persona);
      const roles = roster.map(r => r.role);

      // Project dir: explicit → the bound conversation's dir.
      let projectDir = dir || '';
      if (!projectDir && agentId) {
        const agent = getAgentStore().get(agentId);
        if (agent && agent.dir) projectDir = agent.dir;
      }

      const teamRunId = 'teamrun-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
      const sendEvent = (channel, payload) => {
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
      };
      const budgets = resolveBudgets(settings, agentId ? getAgentStore().get(agentId)?.settings : {});
      const runner = new TeamRunner({
        team: { ...team, members: team.members },
        personas,
        roles,
        task,
        projectDir,
        endpoint,
        accessKey,
        defaultModel,
        budgets,
        reachExecutor: createReachToolExecutor(),
        browserExecutor: (op, args, ctx) => studioBrowser.agentCommand(op, args, { ...ctx, owner: teamRunId + ':' + ctx.agentId }),
        sendEvent,
        requestApproval: payload => requestApprovalFromRenderer(payload, budgets.approvalTimeoutMs),
        requestEditReview: (edit) => {
          pendingTeamEdits.set(edit.editId, { edit, teamRunId });
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
        requestMemberAnswer: ({ questionId, index, name, question }) => new Promise((resolve) => {
          pendingMemberAnswers.set(questionId, resolve);
          if (budgets.questionTimeoutMs > 0) setTimeout(() => { if (pendingMemberAnswers.delete(questionId)) resolve(null); }, budgets.questionTimeoutMs);
        }),
      });
      teamRuns.set(teamRunId, runner);
      runner.run(teamRunId).catch((err) => {
        sendEvent('team:event', { teamRunId, type: 'error', message: err.message });
      }).finally(() => {
        teamRuns.delete(teamRunId);
      });
      return { ok: true, teamRunId };
    } catch (e) {
      return { ok: false, err: e.message };
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

  ipcMain.handle('teams:resolveEdit', (_e, { editId, accepted }) => {
    const entry = pendingTeamEdits.get(editId);
    if (!entry) return { ok: false, err: 'Edit not found (already resolved?)' };
    pendingTeamEdits.delete(editId);
    if (accepted) {
      try {
        fs.mkdirSync(path.dirname(entry.edit.absPath), { recursive: true });
        writeTextFile(entry.edit.absPath, entry.edit.proposed);
      } catch (e) {
        // The write failed — tell the member it was rejected, not accepted.
        const resolver = pendingEditResolvers.get(editId);
        if (resolver) { pendingEditResolvers.delete(editId); resolver(false); }
        return { ok: false, err: e.message };
      }
    }
    // Unblock the paused team member (if this edit belongs to one).
    const resolver = pendingEditResolvers.get(editId);
    if (resolver) { pendingEditResolvers.delete(editId); resolver(!!accepted); }
    return { ok: true, accepted: !!accepted };
  });

  ipcMain.handle('teams:answerQuestion', (_e, { questionId, answer }) => {
    const resolver = pendingMemberAnswers.get(questionId);
    if (!resolver) return { ok: false, err: 'No member is waiting for this question (expired or already answered).' };
    pendingMemberAnswers.delete(questionId);
    resolver(String(answer === undefined ? '' : answer));
    return { ok: true };
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
  ipcMain.handle('models:list', async () => {
    const settings = loadSettings();
    if (!settings.endpoint) return { ok: false, err: 'No endpoint configured in Settings.' };
    try {
      const base = await resolveEndpoint(settings.endpoint);
      const headers = {};
      if (settings.accessKey) headers.Authorization = 'Bearer ' + settings.accessKey;
      const res = await fetch(base + '/models', { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return { ok: false, err: `HTTP ${res.status}` };
      const data = await res.json();
      const ids = (data.data || []).map(m => m.id).filter(Boolean).sort();
      return { ok: true, models: ids };
    } catch (e) {
      return { ok: false, err: e.message };
    }
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
            const treeNodes = [...document.querySelectorAll('#agent-tree .tree-node .tree-name')];
            if (!treeNodes.length) throw new Error('new chat did not appear in the conversation tree');
            const target = treeNodes[treeNodes.length - 1].closest('.tree-node').querySelector('.tree-label');
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
        const { createServer } = require('node:http');
        const teamServer = createServer((req, res) => {
          let body = '';
          req.on('data', chunk => { body += chunk; });
          req.on('end', () => {
            const request = JSON.parse(body);
            const hasResults = request.messages.some(m => m.content.startsWith('TOOL RESULTS'));
            // startsWith, not ===: the runner now appends CREW CONTEXT to the
            // task, so the raw task text is a prefix of the member prompt.
            const cancel = request.messages.some(m => m.content.startsWith('Cancel the slow search'));
            const all = request.messages.map(m => String(m.content || '')).join('\n');
            if (all.includes('Universal stop regular fixture') || (request.model === 'fixture-sub' && !all.includes('Continue the original task'))) {
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
              await until(() => slow.cards.get(0).classList.contains('done'), 'restart individual member');
              if (document.querySelector('#btn-send').textContent !== 'Stop') throw new Error('Send did not become universal Stop');
              await reachApi.agents.send(currentAgent.id, 'Universal stop regular fixture');
              await until(() => agentRunning, 'regular chat alongside team');
              composerInput.value = 'Keep this unsent draft';
              await document.querySelector('#btn-send').onclick();
              await until(() => activeTeamRun?.paused, 'stop team from Send');
              await until(() => currentAgent.runState?.status === 'stopped', 'stop regular chat alongside team');
              if (composerInput.value !== 'Keep this unsent draft') throw new Error('Stop consumed the draft');
              if (document.querySelector('#btn-stop-team').textContent !== 'Start team') throw new Error('Stopped team has no Start');
              if (slow.cards.get(1).querySelector('.member-control').textContent !== 'Start') throw new Error('Stopped member has no Start');
              document.querySelector('#btn-stop-team').click();
              await until(() => !activeTeamRun, 'resume unfinished team');
              if (![...slow.cards.values()].every(c => c.classList.contains('done'))) throw new Error('Restarted team failed');
              composerInput.value = '';
              const good = await dispatch(t.team, 'Find hello in the fixture');
              await until(() => !activeTeamRun, 'successful parallel team');
              if (![...good.cards.values()].every(c => c.classList.contains('done'))) throw new Error('Parallel scans did not complete');
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
              await until(() => !activeTeamRun, 'delegation run');
              if (![...del.cards.values()].every(c => c.classList.contains('done'))) throw new Error('Delegator did not complete');
              const sub = del.subCards && [...del.subCards.values()][0];
              if (!sub) throw new Error('Spawned worker got no card');
              if (!sub.classList.contains('done')) throw new Error('Spawned worker did not complete');
              if (!sub.querySelector('.member-state').textContent.includes('done')) throw new Error('Spawned worker state wrong: ' + sub.querySelector('.member-state').textContent);
              if (!sub.classList.contains('subagent')) throw new Error('Spawned worker card not styled as subagent');
              const saved2 = await reachApi.agents.get(agent.agent.id);
              if (!saved2.messages.some(m => m.content.includes('Crew delegation finished.'))) throw new Error('Delegation answer not saved');
              await reachApi.teams.delete(td.team.id);
              await reachApi.personas.delete(d.persona.id);

              await reachApi.agents.delete(agent.agent.id);
              await reachApi.teams.delete(t.team.id);
              await reachApi.personas.delete(a.persona.id);
              await reachApi.personas.delete(b.persona.id);
            })()
          `);
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
            if (drawerContext.textContent !== first || projectPath.textContent !== first || currentAgent || openFiles.size || !agentView.classList.contains('hidden')) throw new Error('Dropdown left another project chat or files visible');
            await showTab('projects');
            if (drawerContext.textContent !== first || projectPath.textContent !== first || document.querySelector('#project-list li.active')?.title !== first) throw new Error('Dropdown did not synchronize Projects');
            await selectAgent(a.agent);
            if (currentProject.dir !== second || dropdown.value !== second || drawerContext.textContent !== second) throw new Error('Opening chat did not synchronize all project controls');
            const emptyDir = first + '/build';
            await selectProject({ name: 'No chats', dir: emptyDir });
            await showTab('agents');
            if (currentAgent || !document.querySelector('#agent-tree').textContent.includes('No conversations yet') || drawerContext.textContent !== emptyDir || dropdown.value !== emptyDir || !fileTreeEl.querySelector('[data-path="artifact-000.txt"]')) throw new Error('Project without chats did not synchronize');
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
            const details = activity.querySelector('.activity-details');
            if (details.open) throw new Error('Completed activity did not start collapsed');
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
            if (scroll.clientHeight < 60 || input.getBoundingClientRect().width < 60) throw new Error('Conversation or input squeezed out of view');
            if (document.body.scrollHeight > innerHeight + 1) throw new Error('Conversation overflowed the window');
            const headerBeforeScroll = activity.getBoundingClientRect();
            const contextBeforeScroll = document.querySelector('.context-bar').getBoundingClientRect();
            scroll.scrollTop = scroll.scrollHeight;
            if (Math.abs(activity.getBoundingClientRect().top - headerBeforeScroll.top) > 1 || Math.abs(document.querySelector('.context-bar').getBoundingClientRect().top - contextBeforeScroll.top) > 1) throw new Error('Conversation scrolling moved the stationary status header');
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
        console.log(`SMOKE OK: preload, renderer controls, projects, conversations+branching, personas+teams, editor, markdown, real parallel scans, responsive IPC, Stop team, clean saved answers, dialog cancel+confirm, keyboard text input and send after dialogs, project selection+same-name files+safe saves+unsaved cancellation+rapid switching, settings dropdowns+budget presets+scope inheritance+credential preservation+validation+save-during-run+Stop+next-run-budget, optional CLI -> ${v}`);
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
