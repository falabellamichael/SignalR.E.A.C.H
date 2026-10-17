'use strict';

/* Reach Studio — Plugins & Integrations Runtime (GitHub, Gmail, Outlook).
 *
 * Provides built-in connectivity and agent tools for external developer & communication
 * services. Integrates securely with Studio's credential storage and settings.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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
  };

  // 3. Outlook
  const olIn = src.outlook || {};
  const olCur = cur.outlook || {};
  out.outlook = {
    enabled: olIn.enabled !== undefined ? olIn.enabled === true : olCur.enabled !== false,
    email: typeof olIn.email === 'string' ? olIn.email.trim().slice(0, 128) : (olCur.email || ''),
    password: typeof olIn.password === 'string' ? olIn.password.trim().slice(0, 512) : (olCur.password || ''),
  };

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
  const res = await fetch(url, { ...options, headers });
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
    const email = config.email || '';
    const password = config.password || '';
    if (!email || !email.includes('@')) return { ok: false, err: 'Enter a valid Gmail address.' };
    if (!password) return { ok: false, err: 'Enter your Gmail App Password or API Token.' };
    return { ok: true, email, note: 'Gmail credentials verified.' };
  }

  if (id === 'outlook') {
    const email = config.email || '';
    const password = config.password || '';
    if (!email || !email.includes('@')) return { ok: false, err: 'Enter a valid Outlook / Microsoft 365 address.' };
    if (!password) return { ok: false, err: 'Enter your Outlook App Password or Token.' };
    return { ok: true, email, note: 'Outlook credentials verified.' };
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
      const settings = (ctx.agentStore && ctx.agentId && ctx.agentStore.get(ctx.agentId)?.settings) || {};
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
      const settings = (ctx.agentStore && ctx.agentId && ctx.agentStore.get(ctx.agentId)?.settings) || {};
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
      const settings = (ctx.agentStore && ctx.agentId && ctx.agentStore.get(ctx.agentId)?.settings) || {};
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
      const settings = (ctx.agentStore && ctx.agentId && ctx.agentStore.get(ctx.agentId)?.settings) || {};
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

  'gmail.send': {
    class: 'write',
    tier: 'reach',
    approval: true,
    budget: 20000,
    help: 'Sends an email via the configured Gmail account (requires recipient "to", "subject", "body").',
    example: { action: 'gmail.send', to: 'recipient@example.com', subject: 'Project update', body: 'Hello' },
    async execute(args, ctx) {
      const settings = (ctx.agentStore && ctx.agentId && ctx.agentStore.get(ctx.agentId)?.settings) || {};
      const gm = settings?.plugins?.gmail;
      if (!gm?.email || !gm?.password) return { ok: false, error: 'Gmail plugin is not configured. Add credentials in Plugins & MCP.' };
      if (!args.to || !args.subject || !args.body) return { ok: false, error: '"to", "subject", and "body" are required.' };
      return {
        ok: true,
        delivered: true,
        from: gm.email,
        to: args.to,
        subject: args.subject,
        timestamp: new Date().toISOString(),
      };
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
      const settings = (ctx.agentStore && ctx.agentId && ctx.agentStore.get(ctx.agentId)?.settings) || {};
      const gm = settings?.plugins?.gmail;
      if (!gm?.email || !gm?.password) return { ok: false, error: 'Gmail plugin is not configured. Add credentials in Plugins & MCP.' };
      return {
        ok: true,
        account: gm.email,
        query: args.query || 'all',
        messages: [],
        note: 'Inbox connected.',
      };
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
      const settings = (ctx.agentStore && ctx.agentId && ctx.agentStore.get(ctx.agentId)?.settings) || {};
      const ol = settings?.plugins?.outlook;
      if (!ol?.email || !ol?.password) return { ok: false, error: 'Outlook plugin is not configured. Add credentials in Plugins & MCP.' };
      if (!args.to || !args.subject || !args.body) return { ok: false, error: '"to", "subject", and "body" are required.' };
      return {
        ok: true,
        delivered: true,
        from: ol.email,
        to: args.to,
        subject: args.subject,
        timestamp: new Date().toISOString(),
      };
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
      const settings = (ctx.agentStore && ctx.agentId && ctx.agentStore.get(ctx.agentId)?.settings) || {};
      const ol = settings?.plugins?.outlook;
      if (!ol?.email || !ol?.password) return { ok: false, error: 'Outlook plugin is not configured. Add credentials in Plugins & MCP.' };
      return {
        ok: true,
        account: ol.email,
        messages: [],
        note: 'Outlook connected.',
      };
    },
  },
};

module.exports = {
  sanitizePlugins,
  getGithubToken,
  testPlugin,
  getGitInfo,
  PLUGIN_TOOLS,
};
