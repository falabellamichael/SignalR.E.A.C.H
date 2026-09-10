'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { GitContext, sanitizeRemoteUrl, remoteLocation, safeDiff } = require('../vscode/git-context');

function repository(root = 'D:\\work\\app') {
  return {
    rootUri: { fsPath: root },
    kind: 'repository',
    state: {
      HEAD: { name: 'feature/context', commit: 'abcdef1234567890', upstream: { remote: 'origin', name: 'main' }, ahead: 2, behind: 1 },
      remotes: [{ name: 'origin', fetchUrl: 'https://user:SUPERSECRET@github.com/team/app.git?token=SECRET', pushUrl: 'git@github.com:team/app.git' }],
      indexChanges: [], workingTreeChanges: [], mergeChanges: [], refs: [],
    },
    status: async () => {},
    diff: async staged => staged ? '+staged' : '+working',
    log: async () => [],
  };
}

function host(repositories, overrides = {}) {
  let activations = 0;
  const api = { repositories };
  const git = { enabled: true, getAPI: version => { assert.equal(version, 1); return api; } };
  const extension = { isActive: false, exports: git, activate: async () => { activations++; return git; } };
  const vscode = {
    workspace: { isTrusted: true },
    extensions: { getExtension: id => { assert.equal(id, 'vscode.git'); return extension; } },
    ...overrides,
  };
  return { vscode, extension, activations: () => activations };
}

test('remote URLs remove credentials and query/fragment secrets and normalize SCP transport', () => {
  assert.equal(sanitizeRemoteUrl('https://user:SECRET@github.com/team/app.git?token=SECRET#SECRET'), 'https://github.com/team/app.git');
  assert.equal(sanitizeRemoteUrl('git@github.com:team/app.git'), 'ssh://github.com/team/app.git');
  assert.equal(sanitizeRemoteUrl('ssh://user:SECRET@gitlab.com/team/app.git?auth=SECRET'), 'ssh://gitlab.com/team/app.git');
  for (const invalid of ['C:\\secret', 'C:/secret', '/local/path', 'file:///secrets', 'ext::command', 'https://github.com/team/app\n', 'https://github.com\\@example.com/team/app']) {
    assert.equal(sanitizeRemoteUrl(invalid), null, invalid);
  }
});

test('provider links use observed remotes and encoded branch names without inventing an active PR', () => {
  const head = { name: 'feature/context', commit: 'abcdef12' };
  const github = remoteLocation('git@github.com:team/app.git', head);
  assert.equal(github.links.repository, 'https://github.com/team/app');
  assert.equal(github.links.branch, 'https://github.com/team/app/tree/feature%2Fcontext');
  assert.equal(github.links.commit, 'https://github.com/team/app/commit/abcdef12');
  assert.equal(new URL(github.links.pullRequestSearch).searchParams.get('q'), 'is:pr is:open head:feature/context');
  assert.equal(github.activePullRequest, undefined);
  assert.equal(remoteLocation('https://gitlab.com/group/subgroup/project.git', head).links.pullRequests, 'https://gitlab.com/group/subgroup/project/-/merge_requests');
  assert.equal(remoteLocation('git@bitbucket.org:team/app.git', head).links.pullRequests, 'https://bitbucket.org/team/app/pull-requests/');
  assert.equal(remoteLocation('git@ssh.dev.azure.com:v3/org/project/repo', head).links.repository, 'https://dev.azure.com/org/project/_git/repo');
  assert.equal(remoteLocation('https://org@dev.azure.com/org/project/_git/repo', head).links.branch, 'https://dev.azure.com/org/project/_git/repo?version=GBfeature%2Fcontext');
  assert.equal(remoteLocation('https://private-forge.example/team/app.git', head).provider, null);
  assert.deepEqual(remoteLocation('https://private-forge.example/team/app.git', head).links, {});
});

test('untrusted workspaces do not activate Git or launch CLI processes', async () => {
  const vscode = {
    workspace: { isTrusted: false },
    extensions: { getExtension() { throw new Error('Must not activate in an untrusted workspace'); } },
  };
  const context = new GitContext(vscode, { execFile() { throw new Error('Must not execute'); } });
  assert.equal((await context.snapshot()).status, 'untrusted');
  assert.equal((await context.inspect()).status, 'untrusted');
  assert.equal((await context.pullRequests()).status, 'untrusted');
});

test('snapshot exposes sanitized multi-root state and counts untracked files once on old and new APIs', async () => {
  const repo = repository();
  const change = (name, status) => ({ uri: { fsPath: `D:\\work\\app\\${name}` }, status });
  repo.state.indexChanges = [change('staged.js', 0)];
  repo.state.workingTreeChanges = [change('working.js', 5), change('new.js', 7), change('ignored.js', 8)];
  repo.state.untrackedChanges = [change('new.js', 7)];
  repo.state.mergeChanges = [change('conflict.js', 18)];
  const h = host([repo, repository('D:\\work\\other')]);
  const context = new GitContext(h.vscode, { execFile() { throw new Error('Snapshots must stay offline'); } });
  const result = await context.snapshot({ maxChanges: 2 });
  assert.equal(result.totalRepositories, 2);
  assert.equal(h.activations(), 1);
  assert.deepEqual(result.repositories[0].counts, { staged: 1, unstaged: 1, untracked: 1, conflicts: 1 });
  assert.deepEqual(result.repositories[0].changes.map(item => item.path), ['staged.js', 'working.js']);
  assert.equal(result.repositories[0].changesTruncated, true);
  assert.deepEqual(result.repositories[0].head.upstream, { remote: 'origin', name: 'main' });
  assert.equal(result.repositories[0].head.ahead, 2);
  assert.doesNotMatch(JSON.stringify(result), /SUPERSECRET|SECRET|user:/);
});

test('detailed operations require explicit selection for multi-root and duplicate names', async () => {
  const h = host([repository('D:\\one\\app'), repository('D:\\two\\app')]);
  const context = new GitContext(h.vscode);
  assert.equal((await context.inspect()).status, 'ambiguousRepository');
  assert.equal((await context.inspect({ repository: 'app' })).status, 'ambiguousRepository');
  assert.equal((await context.inspect({ repository: 'missing' })).status, 'repositoryNotFound');
  assert.equal((await context.inspect({ repository: 1 })).repository.root, 'D:\\two\\app');
  assert.equal((await context.inspect({ repository: 'd:/one/app' })).repository.index, 0);
});

test('status refresh failures retain labeled cached state without returning raw Git errors', async () => {
  const repo = repository();
  repo.status = async () => { throw new Error('SECRET https://token@example.com'); };
  const context = new GitContext(host([repo]).vscode);
  const result = await context.inspect();
  assert.equal(result.freshness, 'cachedAfterRefreshFailure');
  assert.equal(result.status, 'ok');
  assert.doesNotMatch(JSON.stringify(result), /SECRET|token@example/);
});

test('Git failures are reported without cutting the operation short', async () => {
  // Agent tool work runs without a timeout: a slow activation or status read
  // waits. Only a real rejection is reported, and it must stay labeled.
  const h = host([repository()]);
  h.extension.activate = () => Promise.reject(new Error('activating'));
  const context = new GitContext(h.vscode);
  assert.equal((await context.snapshot()).status, 'unavailable');
  h.extension.isActive = true;
  h.extension.exports.getAPI(1).repositories[0].status = () => Promise.reject(new Error('status failed'));
  assert.equal((await context.inspect()).freshness, 'cachedAfterRefreshFailure');
});

test('diff preserves staged/unstaged semantics and bounds output, log omits author emails', async () => {
  const repo = repository();
  const calls = [];
  repo.diff = async staged => { calls.push(staged); return '0123456789'; };
  repo.log = async options => {
    assert.deepEqual(options, { maxEntries: 50 });
    return [{ hash: 'abc', message: 'Commit message', authorName: 'Author', authorEmail: 'private@example.com' }];
  };
  const context = new GitContext(host([repo]).vscode);
  const staged = await context.inspect({ operation: 'diff', staged: true, maxChars: 5 });
  assert.equal(staged.diff, '01234');
  assert.equal(staged.truncated, true);
  await context.inspect({ operation: 'diff', staged: false });
  assert.deepEqual(calls, [true, false]);
  const log = await context.inspect({ operation: 'log', limit: 100000 });
  assert.equal(log.commits.length, 1);
  assert.doesNotMatch(JSON.stringify(log), /private@example/);
  assert.equal((await context.inspect({ operation: 'push' })).status, 'unsupportedOperation');
});

test('whole repository diffs omit common credential file contents', () => {
  const diff = 'diff --git a/.env.local b/.env.local\n+PASSWORD=SECRET\n'
    + 'diff --git a/src/app.js b/src/app.js\n+const works = true;\n'
    + 'diff --git a/cert/private.pem b/cert/private.pem\n+PRIVATEKEY\n';
  const result = safeDiff(diff, 32000);
  assert.equal(result.omittedSensitiveFiles, 2);
  assert.match(result.diff, /works = true/);
  assert.doesNotMatch(result.diff, /SECRET|PRIVATEKEY/);
  const unusual = '\x1b[1mdiff --git ".env.local" ".env.local"\x1b[m\n+PASSWORD=SECRET\n'
    + 'diff --git "a/private key.pem" "b/private key.pem"\nBinary files differ\n';
  assert.equal(safeDiff(unusual, 32000).omittedSensitiveFiles, 2);
  assert.equal(safeDiff(unusual, 32000).diff, '');
});

test('focused diffs contain paths to the selected repository and preserve staged semantics', async () => {
  const repo = repository();
  const calls = [];
  repo.diffWithHEAD = async file => { calls.push(['unstaged', file]); return 'diff --git a/src/app.js b/src/app.js\n+working\n'; };
  repo.diffIndexWithHEAD = async file => { calls.push(['staged', file]); return 'diff --git a/src/app.js b/src/app.js\n+staged\n'; };
  const context = new GitContext(host([repo]).vscode);
  const working = await context.inspect({ operation: 'diff', path: 'src/app.js' });
  assert.equal(working.path, 'src/app.js');
  assert.match(working.diff, /working/);
  await context.inspect({ operation: 'diff', path: 'D:/work/app/src/app.js', staged: true });
  assert.deepEqual(calls, [['unstaged', 'D:\\work\\app\\src\\app.js'], ['staged', 'D:\\work\\app\\src\\app.js']]);
  for (const unsafe of ['../outside.txt', 'D:/work/application/secret', 'E:/other/file', '.env', '.env.local',
    '.git/config', 'folder/key.pem', '.aws/config', ':(glob)*', '**/*.js', 'src/app.js:secret', '\u0000']) {
    assert.equal((await context.inspect({ operation: 'diff', path: unsafe })).status, 'invalidPath', unsafe);
  }
  assert.equal(calls.length, 2, 'invalid paths must not reach Git');
});

test('PR lookup uses read-only CLI arguments and current branch metadata', async () => {
  const repo = repository();
  const calls = [];
  const context = new GitContext(host([repo]).vscode, {
    execFile(file, args, options, callback) {
      calls.push({ file, args, options });
      callback(null, JSON.stringify([{
        number: 21, title: 'Connect VS Code', url: 'https://TOKEN@bad.example/redirect', state: 'OPEN',
        isDraft: true, headRefName: 'feature/context', baseRefName: 'main',
        headRepositoryOwner: { login: 'team' }, updatedAt: '2026-09-09T12:00:00Z',
      }, { number: 22, headRefName: 'another-branch' }]), '');
    },
  });
  const result = await context.pullRequests();
  assert.equal(result.status, 'ok');
  assert.equal(result.pullRequests.length, 1);
  assert.equal(result.pullRequests[0].url, 'https://github.com/team/app/pull/21');
  assert.equal(result.pullRequests[0].headOwner, 'team');
  assert.equal(result.pullRequests[0].draft, true);
  assert.equal(calls[0].file, 'gh');
  assert.ok(calls[0].args.includes('--head=feature/context'));
  assert.ok(calls[0].args.includes('--repo=github.com/team/app'));
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].options.windowsHide, true);
  // No imposed timeout: a slow gh invocation waits rather than reporting a
  // timeout the agent never asked for.
  assert.equal(calls[0].options.timeout, undefined);
  assert.equal(calls[0].options.maxBuffer, 256 * 1024);
  assert.doesNotMatch(JSON.stringify(result), /TOKEN|bad\.example|SECRET/);
});

test('PR CLI missing/authentication/timeouts report explicit statuses without leaking errors', async () => {
  for (const [error, stderr, expected] of [
    [{ code: 'ENOENT' }, 'SECRET', 'cliUnavailable'],
    [{ code: 4 }, 'Token SECRET and gh auth login', 'authenticationRequired'],
    [{ code: 1 }, 'HTTP 401 token=SECRET', 'authenticationRequired'],
    [{ killed: true }, 'SECRET', 'timeout'],
    [{ code: 1 }, 'private path SECRET', 'lookupFailed'],
  ]) {
    const context = new GitContext(host([repository()]).vscode, { execFile: (_file, _args, _options, callback) => callback(error, '', stderr) });
    const result = await context.pullRequests();
    assert.equal(result.status, expected);
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
    assert.equal(result.links.pullRequests, 'https://github.com/team/app/pulls');
  }
});

test('offline PR locations and non-GitHub providers never start CLI lookup; no PR is explicit', async () => {
  const repo = repository();
  const context = new GitContext(host([repo]).vscode, { execFile() { throw new Error('No CLI expected'); } });
  assert.equal((await context.pullRequests({ lookup: false })).status, 'locationsOnly');
  repo.state.remotes[0].fetchUrl = 'https://gitlab.com/team/app.git';
  assert.equal((await context.pullRequests()).status, 'locationsOnly');
  repo.state.remotes[0].fetchUrl = 'https://github.com/team/app.git';
  const empty = new GitContext(host([repo]).vscode, { execFile: (_file, _args, _opts, callback) => callback(null, '[]', '') });
  assert.equal((await empty.pullRequests()).status, 'noPullRequests');
  repo.state.HEAD = { commit: 'abcdef12' };
  assert.equal((await empty.pullRequests()).status, 'noBranch');
});
