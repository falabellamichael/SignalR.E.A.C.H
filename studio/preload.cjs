const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('reach', {
  platform: process.platform,
  initialTheme: ipcRenderer.sendSync('theme:get'),
  setTheme: theme => ipcRenderer.invoke('theme:set', theme),
  telemetry: {
    sample: () => ipcRenderer.invoke('telemetry:sample'),
    sources: () => ipcRenderer.invoke('telemetry:sources'),
    saveSources: sources => ipcRenderer.invoke('telemetry:saveSources', sources),
  },
  browser: {
    onSelection: cb => ipcRenderer.on('browser:selection', (_e, data) => cb(data)),
    onSelectionCleared: cb => ipcRenderer.on('browser:selection-cleared', (_e, tabId) => cb(tabId)),
    onReveal: cb => ipcRenderer.on('browser:reveal', () => cb()),
    onError: cb => ipcRenderer.on('browser:error', (_e, message) => cb(message)),
    command: (action, args = {}) => ipcRenderer.invoke('browser:command', action, args),
    onState: cb => ipcRenderer.on('browser:state', (_e, state) => cb(state)),
    onContext: cb => ipcRenderer.on('browser:context', (_e, context) => cb(context)),
    onShortcut: cb => ipcRenderer.on('browser:shortcut', (_e, key) => cb(key)),
  },
  // Reach CLI
  getVersion: () => ipcRenderer.invoke('reach:version'),
  run: (cwd, args) => ipcRenderer.invoke('reach:run', { cwd, args }),
  kill: (runId) => ipcRenderer.invoke('reach:kill', runId),
  onOutput: (cb) => {
    ipcRenderer.on('reach:output', (_e, d) => cb(d));
  },
  onExit: (cb) => {
    ipcRenderer.on('reach:exit', (_e, d) => cb(d));
  },

  // Projects
  getProjects: () => ipcRenderer.invoke('projects:get'),
  saveProjects: (ps) => ipcRenderer.invoke('projects:save', ps),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  createProject: (name, parent) => ipcRenderer.invoke('project:create', { name, parent }),
  listFiles: (dir) => ipcRenderer.invoke('project:list', dir),
  openDir: (dir) => ipcRenderer.invoke('shell:openDir', dir),

  // Settings
  getBudgetSchema: () => ipcRenderer.invoke('settings:budgetSchema'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),

  // Agents
  agents: {
    clear: id => ipcRenderer.invoke('agents:clear', id),
    toolSchema: () => ipcRenderer.invoke('agents:toolSchema'),
    list: () => ipcRenderer.invoke('agents:list'),
    get: (id) => ipcRenderer.invoke('agents:get', id),
    context: (id) => ipcRenderer.invoke('agents:context', id),
    compact: (id) => ipcRenderer.invoke('agents:compact', id),
    tree: (dir) => ipcRenderer.invoke('agents:tree', dir),
    create: (name, dir, model) => ipcRenderer.invoke('agents:create', { name, dir, model }),
    fork: (id, upToIndex, name) => ipcRenderer.invoke('agents:fork', { id, upToIndex, name }),
    update: (id, patch) => ipcRenderer.invoke('agents:update', { id, ...patch }),
    delete: (id) => ipcRenderer.invoke('agents:delete', id),
    send: (id, text) => ipcRenderer.invoke('agents:send', { id, text }),
    stop: (id) => ipcRenderer.invoke('agents:stop', id),
    setTodos: (id, todos) => ipcRenderer.invoke('agents:setTodos', { id, todos }),
    appendNote: (id, content) => ipcRenderer.invoke('agents:appendNote', { id, content }),
    respondApproval: (requestId, approved) => ipcRenderer.invoke('agents:respondApproval', { requestId, approved }),
    resolveEdit: (id, editId, accepted) => ipcRenderer.invoke('agents:resolveEdit', { id, editId, accepted }),
    onEvent: (cb) => {
      ipcRenderer.on('agent:event', (_e, d) => cb(d));
    },
    onApprovalRequest: (cb) => {
      ipcRenderer.on('agent:approval-request', (_e, d) => cb(d));
    },
    onEditPending: (cb) => {
      ipcRenderer.on('agent:edit-pending', (_e, d) => cb(d));
    },
  },

  // Personas (custom agents) + Teams (crews)
  personas: {
    list: () => ipcRenderer.invoke('personas:list'),
    get: (id) => ipcRenderer.invoke('personas:get', id),
    create: (p) => ipcRenderer.invoke('personas:create', p),
    update: (id, patch) => ipcRenderer.invoke('personas:update', { id, ...patch }),
    delete: (id) => ipcRenderer.invoke('personas:delete', id),
  },
  teams: {
    list: () => ipcRenderer.invoke('teams:list'),
    get: (id) => ipcRenderer.invoke('teams:get', id),
    create: (t) => ipcRenderer.invoke('teams:create', t),
    update: (id, patch) => ipcRenderer.invoke('teams:update', { id, ...patch }),
    delete: (id) => ipcRenderer.invoke('teams:delete', id),
    run: (teamId, task, dir, agentId) => ipcRenderer.invoke('teams:run', { teamId, task, dir, agentId }),
    stop: (teamRunId) => ipcRenderer.invoke('teams:stop', { teamRunId }),
    start: (teamRunId) => ipcRenderer.invoke('teams:start', { teamRunId }),
    stopAll: () => ipcRenderer.invoke('runs:stop'),
    controlMember: (teamRunId, index, agentId, start) => ipcRenderer.invoke('teams:controlMember', { teamRunId, index, agentId, start }),
    resolveEdit: (editId, accepted) => ipcRenderer.invoke('teams:resolveEdit', { editId, accepted }),
    answerQuestion: (questionId, answer) => ipcRenderer.invoke('teams:answerQuestion', { questionId, answer }),
    onEvent: (cb) => {
      ipcRenderer.on('team:event', (_e, d) => cb(d));
    },
    onEditPending: (cb) => {
      ipcRenderer.on('team:edit-pending', (_e, d) => cb(d));
    },
  },

  // Files (scoped to an agent's project directory, or a raw projectDir)
  files: {
    tree: (agentId, projectDir, directory = '', offset = 0) => ipcRenderer.invoke('files:tree', { agentId, projectDir, directory, offset }),
    read: (agentId, relPath, projectDir) => ipcRenderer.invoke('files:read', { agentId, path: relPath, projectDir }),
    write: (agentId, relPath, content, projectDir) => ipcRenderer.invoke('files:write', { agentId, path: relPath, content, projectDir }),
  },

  // Models. Pass nothing to list the ACTIVE connection's models (playground,
  // refactor, agent settings). Pass { connectionId } to list a saved row without
  // activating it, or { endpoint, accessKey } for an ad-hoc lookup while a row is
  // still being typed and has nothing saved to resolve an id against.
  listModels: (target) => {
    if (!target) return ipcRenderer.invoke('models:list', {});
    if (typeof target === 'string') return ipcRenderer.invoke('models:list', { connectionId: target });
    return ipcRenderer.invoke('models:list', target);
  },

  // Endpoint connections (multiple providers, each with its own key + model).
  connections: {
    list: () => ipcRenderer.invoke('connections:list'),
    // action: 'add' | 'update' | 'remove' | 'activate'
    save: (payload) => ipcRenderer.invoke('connections:save', payload),
    ping: (connectionId) => ipcRenderer.invoke('connections:ping', connectionId ? { connectionId } : {}),
  },

  // Workspace dashboard (PRD: Studio Workspace Dashboard). Local system
  // telemetry only — no relay admin API is contacted.
  workspace: {
    pingEndpoint: () => ipcRenderer.invoke('workspace:pingEndpoint'),
    indexCode: (projectDir) => ipcRenderer.invoke('workspace:indexCode', { projectDir }),
    searchSymbols: (args) => ipcRenderer.invoke('workspace:searchSymbols', args),
    extractContext: (args) => ipcRenderer.invoke('workspace:extractContext', args),
  },

  // Prompt console (PRD US-2: Interactive Prompt Console). The renderer never
  // holds the endpoint access key, so streaming happens in main and arrives as
  // playground:token events tagged with the runId the renderer generated.
  playground: {
    run: (payload) => ipcRenderer.invoke('playground:run', payload),
    stop: (runId) => ipcRenderer.invoke('playground:stop', runId),
    onToken: (cb) => ipcRenderer.on('playground:token', (_e, d) => cb(d)),
  },

  // About page (PRD: About REACH Studio)
  about: {
    info: () => ipcRenderer.invoke('about:info'),
  },

  // Refactor workbench (PRD: Multi-File Refactoring Workbench /refactor and
  // Interactive Diff & Patch Manager). Plans stay in main keyed by planId — they
  // hold whole file contents, and the renderer only needs the id plus its chunk
  // selections. Apply is atomic and single-use; see the handler comments.
  refactor: {
    generate: (payload) => ipcRenderer.invoke('refactor:generate', payload),
    stop: (runId) => ipcRenderer.invoke('refactor:stop', runId),
    onProgress: (cb) => ipcRenderer.on('refactor:progress', (_e, d) => cb(d)),
    plan: (payload) => ipcRenderer.invoke('refactor:plan', payload),
    apply: (payload) => ipcRenderer.invoke('refactor:apply', payload),
    defaultGates: (projectDir) => ipcRenderer.invoke('refactor:defaultGates', { projectDir }),
    gates: (payload) => ipcRenderer.invoke('refactor:gates', payload),
    selfCorrect: (payload) => ipcRenderer.invoke('refactor:selfCorrect', payload),
    revert: (payload) => ipcRenderer.invoke('refactor:revert', payload),
  },
});
