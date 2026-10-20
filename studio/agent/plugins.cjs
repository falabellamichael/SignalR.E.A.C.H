'use strict';

/* Reach Studio — Plugins & Integrations Runtime (GitHub, Gmail, Outlook).
 *
 * Provides built-in connectivity and agent tools for external developer & communication
 * services. Integrates securely with Studio's credential storage and settings.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { gmailFetch, gmailRead, gmailSend, outlookFetch } = require('./mail-connections.cjs');
const { readWeather, DEFAULT_WEATHER_URL } = require('./weather-connection.cjs');

function pluginSettings(ctx) {
  const settings = ctx.getSettings?.() || ctx.agentStore?.get(ctx.agentId)?.settings || {};
  return { ...settings, plugins: ctx.getPlugins?.() || settings.plugins || {} };
}

const GITHUB_API = 'https://api.github.com';

function sanitizePlugins(input, current = {}) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const cur = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const out = {};

  // 1. GitHub
  const ghIn = src.github || {};
  const ghCur = cur.github || {};
  out.github = {
    enabled: ghIn.enabled !== undefined ? ghIn.enabled === true : ghCur.enabled !== false,
    token: typeof ghIn.token === 'string' ? ghIn.token.trim().slice(0, 512) : (ghCur.token || ''),
    username: typeof ghIn.username === 'string' ? ghIn.username.trim().slice(0, 64) : (ghCur.username || ''),
  };

  // 2. Gmail
  const gmIn = src.gmail || {};
  const gmCur = cur.gmail || {};
  out.gmail = {
    enabled: gmIn.enabled !== undefined ? gmIn.enabled === true : gmCur.enabled !== false,
    email: typeof gmIn.email === 'string' ? gmIn.email.trim().slice(0, 128) : (gmCur.email || ''),
    password: typeof gmIn.password === 'string' ? gmIn.password.trim().slice(0, 512) : (gmCur.password || ''),
    clientId: gmCur.clientId || '', clientSecret: gmCur.clientSecret || '',
    accessToken: gmCur.accessToken || '', refreshToken: gmCur.refreshToken || '',
    expiresAt: gmCur.expiresAt || 0, scope: gmCur.scope || '',
  };

  // 3. Outlook
  const olIn = src.outlook || {};
  const olCur = cur.outlook || {};
  out.outlook = {
    enabled: olIn.enabled !== undefined ? olIn.enabled === true : olCur.enabled !== false,
    email: typeof olIn.email === 'string' ? olIn.email.trim().slice(0, 128) : (olCur.email || ''),
    password: typeof olIn.password === 'string' ? olIn.password.trim().slice(0, 512) : (olCur.password || ''),
  };

  for(const id of require('./extra-apps.cjs').ids){const value=src[id]||{},previous=cur[id]||{};out[id]={...previous,enabled:value.enabled===undefined?previous.enabled===true:value.enabled===true};}
  out.weather = { enabled: cur.weather?.enabled !== false, url: cur.weather?.url || DEFAULT_WEATHER_URL };
  return out;
}

function getGithubToken(settings) {
  const pluginToken = settings?.plugins?.github?.token;
  if (pluginToken) return pluginToken;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    const res = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', shell: false, timeout: 3000 });
    if (res.status === 0 && res.stdout) {
      const token = res.stdout.trim();
      if (token && token.length > 8) return token;
    }
  } catch {}
  return '';
}

async function githubFetch(endpoint, token, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${GITHUB_API}${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  const headers = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'SignalREACH-Studio/26.10',
    ...(options.headers || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (new URL(url).origin !== GITHUB_API) throw new Error('Invalid GitHub API endpoint.');
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  const res = await fetch(url, { ...options, headers, signal, redirect: 'error' });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

async function testPlugin(id, config = {}) {
  if (id === 'github') {
    const token = config.token || getGithubToken({ plugins: { github: config } });
    if (!token) return { ok: false, err: 'Enter a Personal Access Token or sign in with the GitHub CLI (gh auth login).' };
    try {
      const res = await githubFetch('/user', token);
      if (!res.ok) return { ok: false, err: res.data?.message || `GitHub API error (HTTP ${res.status})` };
      return {
        ok: true,
        user: {
          login: res.data.login,
          name: res.data.name || res.data.login,
          avatar_url: res.data.avatar_url,
          public_repos: res.data.public_repos,
        },
      };
    } catch (e) {
      return { ok: false, err: e.message || 'Could not connect to GitHub API.' };
    }
  }

  if (id === 'gmail') {
    try { const profile = await gmailFetch(config, 'profile'); return { ok: true, email: profile.emailAddress, note: 'Gmail API connected.' }; }
    catch (error) { return { ok: false, err: error.message }; }
  }

  if (id === 'outlook') {
    try { const profile = await outlookFetch(config, '?$select=mail,userPrincipalName'); return { ok: true, email: profile.mail || profile.userPrincipalName }; }
    catch (error) { return { ok: false, err: error.message }; }
  }

  return { ok: false, err: `Unknown plugin ${id}` };
}

function parseGitRepoSlug(remoteUrl) {
  if (!remoteUrl || typeof remoteUrl !== 'string') return null;
  const cleaned = remoteUrl.trim();
  const match = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git|\/)?$/.exec(cleaned);
  if (match) return `${match[1]}/${match[2]}`;
  return null;
}

function getGitInfo(projectDir, settings = {}) {
  const targetDir = projectDir ? String(projectDir) : '';
  if (!targetDir || !fs.existsSync(targetDir)) return { isGit: false, error: 'Directory not found' };

  try {
    const gitCheck = spawnSync('git', ['-C', targetDir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', timeout: 3000, shell: false });
    if (gitCheck.status !== 0 || !gitCheck.stdout?.trim()) {
      return { isGit: false };
    }

    const branchRes = spawnSync('git', ['-C', targetDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', timeout: 3000, shell: false });
    const branch = branchRes.stdout?.trim() || 'unknown';

    const remoteRes = spawnSync('git', ['-C', targetDir, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8', timeout: 3000, shell: false });
    const remoteUrl = remoteRes.stdout?.trim() || '';
    const repoSlug = parseGitRepoSlug(remoteUrl);

    const statusRes = spawnSync('git', ['-C', targetDir, 'status', '--porcelain'], { encoding: 'utf8', timeout: 4000, shell: false });
    const modifiedCount = (statusRes.stdout || '').split('\n').filter(Boolean).length;

    const logRes = spawnSync('git', ['-C', targetDir, 'log', '-1', '--format=%h · %s (%cr)'], { encoding: 'utf8', timeout: 3000, shell: false });
    const lastCommit = logRes.stdout?.trim() || '';

    const token = getGithubToken(settings);
    const githubUser = settings?.plugins?.github?.username || '';

    return {
      isGit: true,
      branch,
      remoteUrl,
      repoSlug,
      modifiedCount,
      lastCommit,
      githubConnected: !!token,
      githubUser,
    };
  } catch (error) {
    return { isGit: false, error: error.message };
  }
}

/* ------------------------------------------------------------------- Plugin Tools */

const PLUGIN_TOOLS = {
  'github.repo': {
    class: 'browse',
    tier: 'reach',
    approval: false,
    budget: 30000,
    help: 'Inspects a GitHub repository (stars, description, default branch, topics). If owner/repo are omitted, inspects the current workspace repository.',
    example: { action: 'github.repo', owner: 'owner', repo: 'name' },
    async execute(args, ctx) {
      const settings = pluginSettings(ctx);
      const token = getGithubToken(settings);
      let owner = args.owner, repo = args.repo;
      if (!owner || !repo) {
        const info = getGitInfo(ctx.projectDir, settings);
        if (info.repoSlug) [owner, repo] = info.repoSlug.split('/');
      }
      if (!owner || !repo) return { ok: false, error: 'Provide owner and repo, or run inside a GitHub-tracked workspace.' };
      const res = await githubFetch(`/repos/${owner}/${repo}`, token);
      if (!res.ok) return { ok: false, error: res.data?.message || `GitHub error ${res.status}` };
      const d = res.data;
      return {
        ok: true,
        full_name: d.full_name,
        description: d.description,
        default_branch: d.default_branch,
        stars: d.stargazers_count,
        forks: d.forks_count,
        open_issues: d.open_issues_count,
        visibility: d.visibility || (d.private ? 'private' : 'public'),
      };
    },
  },

  'github.issues': {
    class: 'browse',
    tier: 'reach',
    approval: false,
    budget: 40000,
    help: 'Lists or searches issues in a GitHub repository. Options: state ("open"|"closed"|"all"), query (keyword), limit (default 10).',
    example: { action: 'github.issues', owner: 'owner', repo: 'name', state: 'open', limit: 10 },
    async execute(args, ctx) {
      const settings = pluginSettings(ctx);
      const token = getGithubToken(settings);
      let owner = args.owner, repo = args.repo;
      if (!owner || !repo) {
        const info = getGitInfo(ctx.projectDir, settings);
        if (info.repoSlug) [owner, repo] = info.repoSlug.split('/');
      }
      if (!owner || !repo) return { ok: false, error: 'Provide owner and repo.' };
      const state = args.state || 'open';
      const perPage = Math.min(30, Math.max(1, Number(args.limit) || 10));
      const res = await githubFetch(`/repos/${owner}/${repo}/issues?state=${encodeURIComponent(state)}&per_page=${perPage}`, token);
      if (!res.ok) return { ok: false, error: res.data?.message || `GitHub error ${res.status}` };
      const items = (res.data || []).filter(item => !item.pull_request).map(issue => ({
        number: issue.number,
        title: issue.title,
        state: issue.state,
        author: issue.user?.login,
        comments: issue.comments,
        created_at: issue.created_at,
        url: issue.html_url,
      }));
      return { ok: true, count: items.length, issues: items };
    },
  },

  'github.prs': {
    class: 'browse',
    tier: 'reach',
    approval: false,
    budget: 40000,
    help: 'Lists or inspects pull requests in a GitHub repository. Options: state ("open"|"closed"|"all"), pr_number (optional to inspect one PR in detail).',
    example: { action: 'github.prs', owner: 'owner', repo: 'name', state: 'open' },
    async execute(args, ctx) {
      const settings = pluginSettings(ctx);
      const token = getGithubToken(settings);
      let owner = args.owner, repo = args.repo;
      if (!owner || !repo) {
        const info = getGitInfo(ctx.projectDir, settings);
        if (info.repoSlug) [owner, repo] = info.repoSlug.split('/');
      }
      if (!owner || !repo) return { ok: false, error: 'Provide owner and repo.' };
      if (args.pr_number) {
        const res = await githubFetch(`/repos/${owner}/${repo}/pulls/${encodeURIComponent(args.pr_number)}`, token);
        if (!res.ok) return { ok: false, error: res.data?.message || `GitHub error ${res.status}` };
        const pr = res.data;
        return {
          ok: true,
          number: pr.number,
          title: pr.title,
          state: pr.state,
          author: pr.user?.login,
          head: pr.head?.ref,
          base: pr.base?.ref,
          diff_url: pr.diff_url,
          body: (pr.body || '').slice(0, 4000),
          url: pr.html_url,
        };
      }
      const state = args.state || 'open';
      const perPage = Math.min(30, Math.max(1, Number(args.limit) || 10));
      const res = await githubFetch(`/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}&per_page=${perPage}`, token);
      if (!res.ok) return { ok: false, error: res.data?.message || `GitHub error ${res.status}` };
      const items = (res.data || []).map(pr => ({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        author: pr.user?.login,
        head: pr.head?.ref,
        base: pr.base?.ref,
        url: pr.html_url,
      }));
      return { ok: true, count: items.length, pull_requests: items };
    },
  },

  'github.create_pr': {
    class: 'write',
    tier: 'reach',
    approval: true,
    budget: 30000,
    help: 'Opens a new pull request on GitHub (requires title, head branch, base branch).',
    example: { action: 'github.create_pr', title: 'Feature update', head: 'feature-branch', base: 'main', body: 'Summary of changes' },
    async execute(args, ctx) {
      const settings = pluginSettings(ctx);
      const token = getGithubToken(settings);
      if (!token) return { ok: false, error: 'GitHub connection / token required to create pull requests.' };
      let owner = args.owner, repo = args.repo;
      if (!owner || !repo) {
        const info = getGitInfo(ctx.projectDir, settings);
        if (info.repoSlug) [owner, repo] = info.repoSlug.split('/');
      }
      if (!owner || !repo || !args.title || !args.head || !args.base) {
        return { ok: false, error: 'title, head branch, and base branch are required.' };
      }
      const res = await githubFetch(`/repos/${owner}/${repo}/pulls`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: String(args.title).slice(0, 200),
          head: String(args.head).trim(),
          base: String(args.base).trim(),
          body: String(args.body || '').slice(0, 10000),
        }),
      });
      if (!res.ok) return { ok: false, error: res.data?.message || `GitHub error ${res.status}` };
      return {
        ok: true,
        number: res.data.number,
        url: res.data.html_url,
        title: res.data.title,
      };
    },
  },

  'weather.current': {
    class: 'browse', tier: 'reach', approval: false, budget: 15000,
    help: 'Reads current conditions from The Weather Network city page. Uses the saved city when url is omitted. For another city, provide its exact current-weather page URL; do not guess a city or use data for the saved city as another location.',
    example: { action: 'weather.current', url: DEFAULT_WEATHER_URL },
    async execute(args, ctx) { return readWeather(pluginSettings(ctx).plugins.weather || {}, args, ctx.signal); },
  },

  'gmail.send': {
    class: 'write',
    tier: 'reach',
    approval: true,
    budget: 20000,
    help: 'Sends an email via the configured Gmail account (requires recipient "to", "subject", "body").',
    example: { action: 'gmail.send', to: 'recipient@example.com', subject: 'Project update', body: 'Hello' },
    async execute(args, ctx) {
      const settings = pluginSettings(ctx);
      return gmailSend(settings.plugins.gmail || {}, args, ctx.signal);
    },
  },

  'gmail.read': {
    class: 'browse',
    tier: 'reach',
    approval: false,
    budget: 30000,
    help: 'Searches or lists recent emails in the configured Gmail account.',
    example: { action: 'gmail.read', query: 'is:unread', limit: 5 },
    async execute(args, ctx) {
      const settings = pluginSettings(ctx);
      return gmailRead(settings.plugins.gmail || {}, args, ctx.signal);
    },
  },

  'outlook.send': {
    class: 'write',
    tier: 'reach',
    approval: true,
    budget: 20000,
    help: 'Sends an email via the configured Outlook account (requires recipient "to", "subject", "body").',
    example: { action: 'outlook.send', to: 'recipient@example.com', subject: 'Project update', body: 'Hello' },
    async execute(args, ctx) {
      const settings = pluginSettings(ctx);
      if (!args.to || !args.subject || !args.body || /[\r\n]/.test(args.to)) throw new Error('Recipient, subject and body are required.');
      // Microsoft returns 202 with no JSON body when the send is accepted.
      const config = settings.plugins.outlook;
      if (config?.enabled === false || !config?.password) throw new Error('Connect Outlook with a Microsoft Graph OAuth token first.');
      const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
        method: 'POST', redirect: 'error', signal: ctx.signal || AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.password },
        body: JSON.stringify({ message: { subject: args.subject, body: { contentType: 'Text', content: args.body }, toRecipients: [{ emailAddress: { address: args.to } }] } }),
      });
      if (response.status !== 202) throw new Error(`Outlook returned HTTP ${response.status}. Check Mail.Send permissions and reconnect if needed.`);
      return { ok: true, accepted: true, to: args.to, subject: args.subject };
    },
  },

  'outlook.read': {
    class: 'browse',
    tier: 'reach',
    approval: false,
    budget: 30000,
    help: 'Searches or lists recent emails in the configured Outlook account.',
    example: { action: 'outlook.read', query: '', limit: 5 },
    async execute(args, ctx) {
      const settings = pluginSettings(ctx);
      const params = new URLSearchParams({ '$top': String(Math.min(20, Math.max(1, Number(args.limit) || 5))), '$select': 'id,subject,from,receivedDateTime,bodyPreview,webLink' });
      if (args.query) params.set('$search', '"' + String(args.query).replaceAll('"', '').slice(0, 400) + '"');
      const result = await outlookFetch(settings.plugins.outlook, '/messages?' + params, { signal: ctx.signal });
      return { ok: true, messages: result.value || [] };
    },
  },
};

Object.assign(PLUGIN_TOOLS,require('./extra-apps.cjs').TOOLS);
for (const [name, tool] of Object.entries(PLUGIN_TOOLS)) {
  const execute = tool.execute;
  tool.execute = async (args, ctx) => {
    if (pluginSettings(ctx).plugins[name.split('.')[0]]?.enabled === false) return { ok: false, error: 'This app connection is disabled.' };
    return execute(args, ctx);
  };
}

module.exports = {
  sanitizePlugins,
  getGithubToken,
  testPlugin,
  getGitInfo,
  PLUGIN_TOOLS,
};
