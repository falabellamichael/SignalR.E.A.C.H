'use strict';

// Read-only context from the built-in Git extension's documented API v1:
// https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts
const path = require('node:path');
const { execFile } = require('node:child_process');

const STATUS = ['INDEX_MODIFIED', 'INDEX_ADDED', 'INDEX_DELETED', 'INDEX_RENAMED',
  'INDEX_COPIED', 'MODIFIED', 'DELETED', 'UNTRACKED', 'IGNORED', 'INTENT_TO_ADD',
  'INTENT_TO_RENAME', 'TYPE_CHANGED', 'ADDED_BY_US', 'ADDED_BY_THEM',
  'DELETED_BY_US', 'DELETED_BY_THEM', 'BOTH_ADDED', 'BOTH_DELETED', 'BOTH_MODIFIED'];
const text = (value, max = 500) => String(value == null ? '' : value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max);
const limit = (value, fallback, max) => Number.isFinite(Number(value)) && Number(value) > 0
  ? Math.min(max, Math.floor(Number(value))) : fallback;
const basename = value => path.basename(String(value).replace(/\\/g, '/'));
const comparablePath = value => {
  const normalized = String(value).replace(/\\/g, '/').replace(/\/$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
};

function sanitizeRemoteUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\s\\\x00-\x1f\x7f]/.test(raw)) return null;
  let value = raw;
  // SCP syntax is a Git transport location, not a URL with a password field.
  if (!value.includes('://')) {
    if (value.includes('::')) return null; // Git external transport helpers
    const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(value);
    if (!scp || scp[1].length === 1) return null; // local drive/path
    value = `ssh://${scp[1]}/${scp[2]}`;
  }
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return null;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.toString();
  } catch { return null; }
}

function remoteLocation(raw, head = {}) {
  head = head || {};
  const sanitized = sanitizeRemoteUrl(raw);
  if (!sanitized) return { url: null, provider: null, links: {} };
  const url = new URL(sanitized);
  const host = url.hostname.toLowerCase();
  let segments;
  try { segments = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean).map(decodeURIComponent); }
  catch { return { url: sanitized, provider: null, links: {} }; }
  if (segments.some(part => !part || /[\/?#\\\x00-\x1f]/.test(part))) return { url: sanitized, provider: null, links: {} };
  let provider = null;
  let website;
  const encode = encodeURIComponent;
  const branch = typeof head.name === 'string' ? head.name : head.branch;
  const ref = branch ? encode(branch) : null;
  const commit = /^[a-f0-9]{7,64}$/i.test(head.commit || '') ? head.commit : null;
  if (host === 'github.com' && segments.length === 2) provider = 'github';
  else if (host === 'gitlab.com' && segments.length >= 2) provider = 'gitlab';
  else if (host === 'bitbucket.org' && segments.length === 2) provider = 'bitbucket';
  else if (host === 'ssh.dev.azure.com' && segments.length === 4 && segments[0] === 'v3') {
    provider = 'azure';
    website = `https://dev.azure.com/${encode(segments[1])}/${encode(segments[2])}/_git/${encode(segments[3])}`;
  } else if (host === 'dev.azure.com' && segments.length === 4 && segments[2] === '_git') provider = 'azure';
  else if (/^[a-z0-9-]+\.visualstudio\.com$/.test(host) && segments.length >= 2 && segments.at(-2) === '_git') provider = 'azure';
  // Unknown/self-hosted providers retain their sanitized transport URL. Do not
  // guess that their host implements a particular forge's PR routes.
  if (!provider) return { url: sanitized, provider, links: {} };
  website = website || `https://${host}/${segments.map(encode).join('/')}`;
  const links = { repository: website };
  if (provider === 'github') {
    links.pullRequests = `${website}/pulls`;
    links.compare = `${website}/compare${ref ? `/${ref}` : ''}`;
    if (ref) {
      links.branch = `${website}/tree/${ref}`;
      links.pullRequestSearch = `${website}/pulls?q=${encode(`is:pr is:open head:${branch}`)}`;
    }
    if (commit) links.commit = `${website}/commit/${commit}`;
  } else if (provider === 'gitlab') {
    links.pullRequests = `${website}/-/merge_requests`;
    links.compare = `${website}/-/compare`;
    if (ref) {
      links.branch = `${website}/-/tree/${ref}`;
      links.pullRequestSearch = `${links.pullRequests}?scope=all&state=opened&source_branch=${ref}`;
    }
    if (commit) links.commit = `${website}/-/commit/${commit}`;
  } else if (provider === 'bitbucket') {
    links.pullRequests = `${website}/pull-requests/`;
    links.compare = `${website}/branches/compare`;
    if (ref) links.branch = `${website}/src/${ref}/`;
    if (commit) links.commit = `${website}/commits/${commit}`;
  } else {
    links.pullRequests = `${website}/pullrequests`;
    if (ref) links.branch = `${website}?version=GB${ref}`;
    if (commit) links.commit = `${website}/commit/${commit}`;
  }
  return { url: sanitized, provider, links };
}

function changeSummary(repo, maxChanges) {
  const state = repo.state || {};
  const root = repo.rootUri.fsPath;
  const relative = uri => {
    if (!uri || !uri.fsPath) return '';
    const paths = /^[a-z]:[\\/]/i.test(root) ? path.win32 : path;
    return text(paths.relative(root, uri.fsPath).replace(/\\/g, '/'), 1000);
  };
  const working = state.workingTreeChanges || [];
  // Older Git APIs include untracked resources in workingTreeChanges; newer
  // versions may expose a separate collection. Count them once in either case.
  const untracked = new Map();
  for (const change of [...(state.untrackedChanges || []), ...working.filter(c => c.status === 7)]) {
    untracked.set(change.uri && change.uri.fsPath, change);
  }
  const groups = {
    staged: state.indexChanges || [],
    unstaged: working.filter(c => c.status !== 7 && c.status !== 8),
    untracked: [...untracked.values()],
    conflicts: state.mergeChanges || [],
  };
  const counts = Object.fromEntries(Object.entries(groups).map(([group, changes]) => [group, changes.length]));
  const changes = [];
  for (const [group, resources] of Object.entries(groups)) {
    for (const item of resources) {
      if (changes.length >= maxChanges) break;
      const entry = { group, path: relative(item.uri), status: STATUS[item.status] || 'UNKNOWN' };
      const original = relative(item.originalUri);
      if (original && original !== entry.path) entry.originalPath = original;
      changes.push(entry);
    }
  }
  return { counts, changes, changesTruncated: Object.values(counts).reduce((a, b) => a + b, 0) > changes.length };
}

function repositorySummary(repo, index, maxChanges) {
  const state = repo.state || {};
  const head = state.HEAD;
  return {
    index, root: text(repo.rootUri.fsPath, 2000), name: basename(repo.rootUri.fsPath),
    kind: text(repo.kind || 'repository', 40),
    head: head ? {
      branch: head.name ? text(head.name) : null,
      commit: head.commit ? text(head.commit, 64) : null,
      detached: !head.name,
      upstream: head.upstream ? { remote: text(head.upstream.remote), name: text(head.upstream.name) } : null,
      ahead: typeof head.ahead === 'number' ? head.ahead : null,
      behind: typeof head.behind === 'number' ? head.behind : null,
    } : null,
    remotes: (state.remotes || []).slice(0, 12).map(remote => ({
      name: text(remote.name),
      fetch: remoteLocation(remote.fetchUrl, head),
      push: remoteLocation(remote.pushUrl, head),
    })),
    ...changeSummary(repo, maxChanges),
  };
}

function sensitivePath(value) {
  return /(?:^|[\/\\\s"])(?:\.env(?:\.[^\s"/]*)?|\.npmrc|\.pypirc|credentials(?:\.[^\s"/]*)?|id_rsa|id_ed25519|[^\s"/]+\.(?:pem|key|p12|pfx))(?:["\s]|$)/i.test(value)
    || /(?:^|[\/\\\s"])(?:\.git|\.ssh|\.aws|\.azure)(?:[\/\\]|$)/i.test(value);
}

function resolveDiffPath(root, requested) {
  if (typeof requested !== 'string' || requested.length > 2000 || /[\x00-\x1f*?\[\]]/.test(requested)) throw new Error('Use an exact file path without wildcards or control characters.');
  const paths = /^[a-z]:[\\/]/i.test(root) || root.startsWith('\\\\') ? path.win32 : path;
  const absolute = paths.resolve(root, requested);
  const relative = paths.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative) || relative.includes(':')) {
    throw new Error('Git diff path must identify a file inside the selected repository.');
  }
  if (sensitivePath(relative)) throw new Error('Credential files and Git metadata are excluded from agent diffs.');
  return { absolute, relative: relative.replace(/\\/g, '/') };
}

function safeDiff(raw, maxChars) {
  // Do not send common secret-file contents along with a whole-repository diff.
  const chunks = String(raw || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/(?=^diff --git )/m);
  let omittedSensitiveFiles = 0;
  const filtered = chunks.filter(chunk => {
    const header = chunk.split('\n', 1)[0];
    const sensitive = sensitivePath(header);
    if (sensitive) omittedSensitiveFiles++;
    return !sensitive;
  }).join('');
  return { diff: filtered.slice(0, maxChars), truncated: filtered.length > maxChars, omittedSensitiveFiles };
}

class GitContext {
  constructor(vscode, options = {}) {
    this.vscode = vscode;
    this.execFile = options.execFile || execFile;
  }

  async _repositories() {
    if (!this.vscode.workspace.isTrusted) return { status: 'untrusted', message: 'Git context requires a trusted workspace.', repositories: [] };
    const extension = this.vscode.extensions.getExtension('vscode.git');
    if (!extension) return { status: 'unavailable', message: 'The built-in VS Code Git extension is unavailable.', repositories: [] };
    try {
      // No timeout: VS Code's Git extension may still be initializing, and a
      // slow start is not a failure. Pressing Stop is the only cancellation.
      const git = extension.isActive ? extension.exports : await extension.activate();
      if (!git || git.enabled === false || typeof git.getAPI !== 'function') return { status: 'disabled', message: 'VS Code Git is disabled.', repositories: [] };
      const api = git.getAPI(1);
      return { status: api.repositories.length ? 'ok' : 'noRepositories', repositories: api.repositories };
    } catch {
      return { status: 'unavailable', message: 'VS Code Git could not be activated or is still initializing.', repositories: [] };
    }
  }

  async _select(selector) {
    const result = await this._repositories();
    if (result.status !== 'ok') return result;
    const repositories = result.repositories;
    let matches;
    if (selector === undefined || selector === null || selector === '') matches = repositories.length === 1 ? repositories : [];
    else if (typeof selector === 'number' && Number.isInteger(selector)) matches = repositories[selector] ? [repositories[selector]] : [];
    else matches = repositories.filter(repo => comparablePath(repo.rootUri.fsPath) === comparablePath(selector) || basename(repo.rootUri.fsPath) === String(selector));
    if (matches.length !== 1) {
      return {
        status: matches.length > 1 || ((selector == null || selector === '') && repositories.length > 1) ? 'ambiguousRepository' : 'repositoryNotFound',
        message: 'Choose a repository by its absolute root, unique name, or zero-based numeric index.',
        repositories: repositories.slice(0, 50).map((repo, index) => ({ index, root: text(repo.rootUri.fsPath, 2000), name: basename(repo.rootUri.fsPath) })),
      };
    }
    return { status: 'ok', repository: matches[0], index: repositories.indexOf(matches[0]) };
  }

  async _refresh(repo) {
    if (typeof repo.status !== 'function') return 'cached';
    try { await repo.status(); return 'refreshed'; }
    catch { return 'cachedAfterRefreshFailure'; }
  }

  async snapshot(options = {}) {
    const result = await this._repositories();
    if (result.status !== 'ok') return result;
    const repositories = result.repositories.slice(0, limit(options.maxRepositories, 8, 50));
    const summaries = await Promise.all(repositories.map(async (repo, index) => {
      const freshness = options.refresh ? await this._refresh(repo) : 'cached';
      return { ...repositorySummary(repo, index, limit(options.maxChanges, 10, 200)), freshness };
    }));
    return { status: 'ok', repositories: summaries, totalRepositories: result.repositories.length, truncated: summaries.length < result.repositories.length };
  }

  async inspect(request = {}) {
    const operation = request.operation || 'status';
    if (!['status', 'diff', 'log', 'branches'].includes(operation)) return { status: 'unsupportedOperation', message: 'Git supports read-only status, diff, log, and branches.' };
    const selected = await this._select(request.repository);
    if (selected.status !== 'ok') return selected;
    const repo = selected.repository;
    const freshness = await this._refresh(repo);
    const summary = repositorySummary(repo, selected.index, limit(request.maxChanges, 100, 200));
    try {
      if (operation === 'status') return { status: 'ok', repository: summary, freshness };
      if (operation === 'diff') {
        let file;
        if (request.path) {
          try { file = resolveDiffPath(repo.rootUri.fsPath, request.path); }
          catch (error) { return { status: 'invalidPath', message: error.message }; }
        }
        // The Git API's diffWithHEAD(path) maps to `git diff -- path` (index
        // versus worktree), while diffIndexWithHEAD(path) uses --cached.
        // https://github.com/microsoft/vscode/blob/main/extensions/git/src/git.ts
        const method = file ? (request.staged === true ? 'diffIndexWithHEAD' : 'diffWithHEAD') : 'diff';
        if (typeof repo[method] !== 'function') return { status: 'unsupportedOperation', message: 'This version of VS Code Git does not expose the requested diff operation.' };
        const result = await repo[method](file ? file.absolute : request.staged === true);
        return { status: 'ok', repository: summary.root, path: file ? file.relative : undefined, staged: request.staged === true, freshness, ...safeDiff(result, limit(request.maxChars, 16000, 32000)) };
      }
      if (operation === 'log') {
        if (typeof repo.log !== 'function') return { status: 'unsupportedOperation', message: 'This version of VS Code Git does not expose log.' };
        const commits = await repo.log({ maxEntries: limit(request.limit, 10, 50) });
        return { status: 'ok', repository: summary.root, commits: commits.slice(0, limit(request.limit, 10, 50)).map(commit => ({
          hash: text(commit.hash, 64), message: text(commit.message, 1500),
          author: text(commit.authorName, 200), date: commit.commitDate || commit.authorDate || null,
          parents: (commit.parents || []).slice(0, 8).map(parent => text(parent, 64)),
        })) };
      }
      const refs = repo.state.refs || [];
      return { status: 'ok', repository: summary.root, branches: refs.filter(ref => ref.type === 0 || ref.type === 1).slice(0, 100).map(ref => ({
        name: text(ref.name), commit: text(ref.commit, 64), remote: ref.type === 1,
      })), truncated: refs.filter(ref => ref.type === 0 || ref.type === 1).length > 100 };
    } catch (error) {
      return { status: error.code === 'ETIMEDOUT' ? 'timeout' : 'failed', message: `Git ${operation} could not be read. Check VS Code's Git output for details.` };
    }
  }

  async pullRequests(request = {}) {
    const selected = await this._select(request.repository);
    if (selected.status !== 'ok') return selected;
    const repo = selected.repository;
    await this._refresh(repo);
    const summary = repositorySummary(repo, selected.index, 10);
    const remotes = summary.remotes;
    const preferredName = request.remote || (summary.head && summary.head.upstream && summary.head.upstream.remote) || 'origin';
    const remote = remotes.find(r => r.name === preferredName) || (!request.remote && remotes[0]);
    if (!remote) return { status: 'noRemote', repository: summary.root, message: 'The selected repository has no matching remote.' };
    const location = remote.fetch.provider ? remote.fetch : remote.push;
    const base = { repository: summary.root, remote: remote.name, provider: location.provider, links: location.links, pullRequests: [] };
    if (request.lookup === false) return { ...base, status: 'locationsOnly' };
    if (location.provider !== 'github') return { ...base, status: 'locationsOnly', message: 'Live PR lookup currently supports github.com through the GitHub CLI. Provider locations are available above.' };
    const branch = summary.head && summary.head.branch;
    if (!branch) return { ...base, status: 'noBranch', message: 'The repository is detached or has no branch yet.' };
    const state = ['open', 'closed', 'merged', 'all'].includes(request.state) ? request.state : 'open';
    const maxEntries = limit(request.limit, 10, 30);
    const fields = 'number,title,url,state,isDraft,headRefName,baseRefName,updatedAt,headRepositoryOwner';
    const githubRepo = new URL(location.links.repository);
    const args = ['pr', 'list', `--repo=${githubRepo.hostname}${githubRepo.pathname}`, `--head=${branch}`, `--state=${state}`, `--limit=${maxEntries}`, `--json=${fields}`];
    try {
      const output = await new Promise((resolve, reject) => {
        this.execFile('gh', args, {
          cwd: repo.rootUri.fsPath, encoding: 'utf8',
          maxBuffer: 256 * 1024, windowsHide: true,
          env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', GH_NO_UPDATE_NOTIFIER: '1' },
        }, (error, stdout, stderr) => {
          if (error) {
            // Classify locally; never return CLI stderr, which can include auth
            // details, config paths, or credential-bearing request URLs.
            const authentication = error.code === 4 || /(?:gh auth login|not logged|authentication|HTTP 401|bad credentials)/i.test(String(stderr || ''));
            reject({ code: error.code, killed: error.killed, authentication });
          } else resolve(stdout);
        });
      });
      const data = JSON.parse(output);
      if (!Array.isArray(data)) throw new Error('Unexpected GitHub CLI response');
      const results = data.slice(0, maxEntries).filter(pr => pr && Number.isSafeInteger(pr.number) && pr.number > 0 && pr.headRefName === branch).map(pr => ({
        number: pr.number, title: text(pr.title, 1000), url: `${location.links.repository}/pull/${pr.number}`,
        state: text(pr.state, 20), draft: pr.isDraft === true, head: text(pr.headRefName),
        headOwner: text(pr.headRepositoryOwner && pr.headRepositoryOwner.login, 200),
        base: text(pr.baseRefName), updatedAt: text(pr.updatedAt, 40),
      }));
      return { ...base, status: results.length ? 'ok' : 'noPullRequests', branch, state, pullRequests: results,
        match: 'headBranchName', message: 'Results match the branch name in the selected remote; headOwner identifies forks. No active PR is inferred.', truncated: data.length >= maxEntries };
    } catch (error) {
      let status = 'lookupFailed';
      let message = 'GitHub CLI could not read pull requests. Check its authentication and connection outside chat.';
      if (error.code === 'ENOENT') { status = 'cliUnavailable'; message = 'GitHub CLI (gh) is unavailable in the extension host. PR locations are still available.'; }
      else if (error.authentication) { status = 'authenticationRequired'; message = 'GitHub CLI requires authentication. Run gh auth login yourself; credentials are never returned to chat.'; }
      else if (error.killed || error.code === 'ETIMEDOUT') { status = 'timeout'; message = 'GitHub PR lookup timed out.'; }
      return { ...base, status, message };
    }
  }
}

module.exports = { GitContext, sanitizeRemoteUrl, remoteLocation, safeDiff };
