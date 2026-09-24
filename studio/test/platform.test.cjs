'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commandEnv, reachCommand, runCommand } = require('../agent/platform.cjs');
const reach = require('../agent/reach-process.cjs');
const { createReachToolExecutor, safeProjectPath, buildReachArgs } = require('../agent/reach-tool-executor.cjs');

test('Finder PATH contains Apple Silicon, Intel and user executables without replacing inherited values', () => {
  const env = commandEnv({ PATH: '/custom/bin:/usr/bin', KEEP: 'yes' }, 'darwin', '/Users/test person');
  assert.equal(env.KEEP, 'yes');
  assert.equal(env.PATH, '/custom/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/test person/.local/bin:/Users/test person/bin:/bin:/usr/sbin:/sbin');
  assert.deepEqual(commandEnv({ Path: 'C:\\bin' }, 'win32'), { Path: 'C:\\bin' });
});
test('Mac/Linux commands preserve argument boundaries and Windows retains WSL', () => {
  assert.deepEqual(reachCommand(['index.rsh'], { reachCli: '/Users/test person/reachc' }, 'darwin'), { command: '/Users/test person/reachc', args: ['index.rsh'] });
  assert.equal(reachCommand([], {}, 'linux', { REACH_STUDIO_REACHC: '/bin/reachc' }).command, '/bin/reachc');
  assert.deepEqual(reachCommand(['--version'], {}, 'win32'), { command: 'wsl.exe', args: ['-d', 'Ubuntu', '--', 'reachc', '--version'] });
  assert.equal(reachCommand([], { reachCli: '/custom/reachc' }, 'win32').args[3], '/custom/reachc');
});
test('commands execute from directories with spaces and preserve literal arguments', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reach space '));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const result = await runCommand(process.execPath, ['-e', 'console.log(JSON.stringify([process.cwd(), process.argv[1]]))', 'a b;$(not-a-command)'], { cwd });
  assert.equal(result.ok, true);
  const [actualCwd, arg] = JSON.parse(result.stdout);
  assert.equal(fs.realpathSync(actualCwd), fs.realpathSync(cwd));
  assert.equal(arg, 'a b;$(not-a-command)');
});
test('missing executables and timeouts resolve as errors', async () => {
  assert.equal((await runCommand(path.join(os.tmpdir(), 'no-such-reach-executable-123'))).ok, false);
  const result = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 });
  assert.match(result.error, /timed out/);
});
test('combined stdout and stderr are bounded', async () => {
  const result = await runCommand(process.execPath, ['-e', 'process.stderr.write("x".repeat(100000));setInterval(()=>{},1000)'], { maxOutput: 1000 });
  assert.equal(result.ok, false);
  assert.ok(result.stdout.length + result.stderr.length <= 1000);
  assert.match(result.error, /output limit/);
});
test('already-cancelled requests never execute', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await runCommand(process.execPath, ['-e', 'process.exit(99)'], { signal: controller.signal });
  assert.equal(result.cancelled, true);
  assert.equal(result.exitCode, undefined);
});
test('Stop kills shell descendants, including children inheriting pipes', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'should-not-exist');
  const ready = path.join(root, 'ready');
  const childScript = `require('fs').writeFileSync(${JSON.stringify(ready)}, 'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'orphan'),1000);setInterval(()=>{},1000)`;
  const script = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'inherit'});setInterval(()=>{},1000)`;
  const controller = new AbortController();
  const promise = runCommand(process.execPath, ['-e', script], { signal: controller.signal, timeoutMs: 5000 });
  const deadline = Date.now() + 3000;
  while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  controller.abort();
  assert.ok(fs.existsSync(ready), 'child started before cancellation');
  const result = await promise;
  assert.equal(result.cancelled, true);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(fs.existsSync(marker), false, 'descendant cannot continue writing after Stop');
});
test('Reach pub/sub maps compile directly to reachc without a Docker launcher', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-reach-'));
  const executable = path.join(root, 'reachc');
  fs.writeFileSync(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'sample.rsh'), "'reach 0.1';\n");
  reach.configure(() => ({ reachCli: executable }));
  t.after(() => { reach.killAllRuns(); reach.configure(() => ({})); fs.rmSync(root, { recursive: true, force: true }); });
  const events = await new Promise(resolve => {
    const seen = [];
    const id = reach.runReach({ cwd: root, args: ['compile', 'sample.rsh'] });
    const detach = reach.onRunEvent(event => {
      if (event.runId !== id) return;
      seen.push(event);
      if (event.type === 'exit') { detach(); resolve(seen); }
    });
  });
  assert.match(events.filter(e => e.type === 'output').map(e => e.data).join(''), /--disable-reporting\nsample.rsh/);
  assert.equal(events.at(-1).code, 0);
});
test('Projects commands run directly in the selected folder and report launch errors', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reach project command '));
  t.after(() => { reach.killAllRuns(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const collect = args => new Promise(resolve => {
    const events = [];
    const id = reach.runProject({ cwd, args });
    const detach = reach.onRunEvent(event => {
      if (event.runId !== id) return;
      events.push(event);
      if (event.type === 'exit') { detach(); resolve(events); }
    });
  });
  const ok = await collect([process.execPath, '-e', 'console.log(process.cwd())']);
  assert.equal(fs.realpathSync(ok.find(event => event.type === 'output').data.trim()), fs.realpathSync(cwd));
  assert.equal(ok.at(-1).code, 0);
  const missing = await collect([path.join(cwd, 'missing-command')]);
  assert.match(missing.find(event => event.type === 'output').data, /could not start/);
  assert.equal(missing.at(-1).launchError, true);
  assert.throws(() => reach.runProject({ cwd, args: [] }), /enter a command/);
});
test('project commands can run concurrently and Stop targets one run', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'reach parallel commands '));
  const events = [];
  const detach = reach.onRunEvent(event => events.push(event));
  t.after(() => { reach.killAllRuns(); detach(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const first = reach.runProject({ cwd, args: [process.execPath, '-e', 'console.log("LONG_READY");setInterval(()=>{},1000)'] });
  const second = reach.runProject({ cwd, args: [process.execPath, '-e', 'console.log("SHORT_DONE")'] });
  assert.notEqual(first, second);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !(
    events.some(event => event.runId === first && event.type === 'output' && event.data.includes('LONG_READY')) &&
    events.some(event => event.runId === second && event.type === 'exit')
  )) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(events.some(event => event.runId === first && event.type === 'output' && event.data.includes('LONG_READY')));
  assert.ok(events.some(event => event.runId === second && event.type === 'output' && event.data.includes('SHORT_DONE')));
  assert.equal(events.find(event => event.runId === second && event.type === 'exit')?.code, 0);
  assert.equal(events.some(event => event.runId === first && event.type === 'exit'), false, 'long run survives the second command');
  assert.equal(reach.killRun(first), true);
  const stoppedDeadline = Date.now() + 5000;
  while (Date.now() < stoppedDeadline && !events.some(event => event.runId === first && event.type === 'exit'))
    await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.find(event => event.runId === first && event.type === 'exit')?.stopped, true);
});
test('optional CLI status supports executable paths with spaces', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach cli '));
  const executable = path.join(root, 'reachc');
  fs.writeFileSync(executable, '#!/bin/sh\n[ "$1" = --version ] && echo "reachc 0.1.13"\n', { mode: 0o755 });
  reach.configure(() => ({ reachCli: executable }));
  t.after(() => { reach.configure(() => ({})); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(await reach.reachVersion(), 'reachc 0.1.13');
  reach.configure(() => ({ reachCli: path.join(root, 'missing') }));
  assert.match(await reach.reachVersion(), /Native Reach compiler unavailable.*Settings/);
});
test('Reach agent tools honour Stop', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-stop-'));
  const executable = path.join(root, 'reachc');
  fs.writeFileSync(executable, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'index.rsh'), "'reach 0.1';\n");
  reach.configure(() => ({ reachCli: executable }));
  t.after(() => { reach.killAllRuns(); reach.configure(() => ({})); fs.rmSync(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const promise = createReachToolExecutor()('reach.compile', {}, { projectDir: root, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.equal((await promise).ok, false);
});

test('native compile explains a missing source in the selected project', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-missing-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => reach.runReach({ cwd: root, args: ['compile', 'index.rsh'] }),
    error => error.message.includes(root) && /file not found.*Native Reach init.*Ganache supplies a node for run, not compile/.test(error.message));
  assert.throws(() => reach.runReach({ cwd: root, args: ['compile'] }), /Cannot compile index.rsh: file not found/);
});

test('native init and clean work without Docker and preserve unrelated build files', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-native-project-'));
  const executable = path.join(root, 'reachc');
  fs.writeFileSync(executable, '#!/bin/sh\ncase "$1" in --numeric-version) echo 0.1.13;; --version) echo "reachc 0.1.13";; esac\n', { mode: 0o755 });
  reach.configure(() => ({ reachCli: executable }));
  t.after(() => { reach.killAllRuns(); reach.configure(() => ({})); fs.rmSync(root, { recursive: true, force: true }); });
  const collect = args => new Promise(resolve => {
    const events = [];
    const id = reach.runReach({ cwd: root, args });
    const detach = reach.onRunEvent(event => {
      if (event.runId !== id) return;
      events.push(event);
      if (event.type === 'exit') { detach(); resolve(events); }
    });
  });
  assert.equal((await collect(['init'])).at(-1).code, 0);
  assert.match(fs.readFileSync(path.join(root, 'index.rsh'), 'utf8'), /^'reach 0\.1';/);
  assert.ok(fs.existsSync(path.join(root, 'index.mjs')));
  assert.equal((await collect(['init'])).at(-1).code, 1, 'init refuses overwrite');
  const build = path.join(root, 'build');
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(build, 'index.main.mjs'), 'compiled');
  fs.writeFileSync(path.join(build, 'keep.txt'), 'user file');
  assert.equal((await collect(['clean'])).at(-1).code, 0);
  assert.equal(fs.existsSync(path.join(build, 'index.main.mjs')), false);
  assert.equal(fs.readFileSync(path.join(build, 'keep.txt'), 'utf8'), 'user file');
  assert.equal((await collect(['info'])).at(-1).code, 0);
});

test('native Reach mode refuses the Docker-backed reach launcher', async () => {
  reach.configure(() => ({ reachCli: '/tmp/reach' }));
  try {
    assert.match(await reach.reachVersion(), /configured `reach` launcher uses Docker/);
    assert.throws(() => reach.runReach({ cwd: os.tmpdir(), args: ['version'] }), /launcher uses Docker/);
  } finally { reach.configure(() => ({})); }
});

test('native run requires an existing frontend and backend', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-native-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => reach.runReach({ cwd: root, args: ['run'] }), /Compile index.rsh first/);
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(path.join(root, 'index.mjs'), '');
  fs.writeFileSync(path.join(root, 'build', 'index.main.mjs'), '');
  assert.throws(() => reach.runReach({ cwd: root, args: ['run'] }), /Compile index.rsh first/);
});

function collectReach(cwd, args) {
  return new Promise(resolve => {
    const events = [];
    const id = reach.runReach({ cwd, args });
    const detach = reach.onRunEvent(event => {
      if (event.runId !== id) return;
      events.push(event);
      if (event.type === 'exit') { detach(); resolve(events); }
    });
  });
}

test('native compiler probe rejects empty, foreign, symlinked and copied Docker launchers', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-compiler-check-'));
  t.after(() => { reach.configure(() => ({})); fs.rmSync(root, { recursive: true, force: true }); });
  const empty = path.join(root, 'empty');
  fs.writeFileSync(empty, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  reach.configure(() => ({ reachCli: empty }));
  assert.match(await reach.reachVersion(), /Unexpected native reachc version output/);
  const foreign = path.join(root, 'foreign');
  fs.writeFileSync(foreign, '#!/bin/sh\necho "other 1.0"\n', { mode: 0o755 });
  reach.configure(() => ({ reachCli: foreign }));
  assert.match(await reach.reachVersion(), /Unexpected native reachc version output/);
  const launcher = path.join(root, 'reach');
  fs.writeFileSync(launcher, '#!/bin/sh\necho "reachc 0.1.13"\n', { mode: 0o755 });
  const linked = path.join(root, 'reachc');
  fs.symlinkSync(launcher, linked);
  reach.configure(() => ({ reachCli: linked }));
  assert.match(await reach.reachVersion(), /resolves to the Docker-backed/);
  fs.unlinkSync(linked);
  fs.writeFileSync(linked, '#!/bin/sh\nIMG=reachsh/reach-cli:latest\necho "reachc 0.1.13"\n', { mode: 0o755 });
  assert.match(await reach.reachVersion(), /script invokes the Docker-backed/);
});

test('native clean refuses a build symlink outside the project', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-clean-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-clean-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  const target = path.join(outside, 'index.main.mjs');
  fs.writeFileSync(target, 'keep');
  fs.symlinkSync(outside, path.join(root, 'build'));
  const events = await collectReach(root, ['clean']);
  assert.equal(events.at(-1).code, 1);
  assert.match(events.filter(e => e.channel === 'err').map(e => e.data).join(''), /outside the selected project/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});

test('native run passes connector/node settings to Node without inheriting Finder environment', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-run-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'build'));
  fs.mkdirSync(path.join(root, 'node_modules', '@reach-sh', 'stdlib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', '@reach-sh', 'stdlib', 'package.json'), '{"name":"@reach-sh/stdlib","main":"index.js"}');
  fs.writeFileSync(path.join(root, 'node_modules', '@reach-sh', 'stdlib', 'index.js'), '');
  fs.writeFileSync(path.join(root, 'index.rsh'), "'reach 0.1';\n");
  fs.writeFileSync(path.join(root, 'build', 'index.main.mjs'), '');
  fs.writeFileSync(path.join(root, 'index.mjs'), 'console.log(JSON.stringify({mode:process.env.REACH_CONNECTOR_MODE,node:process.env.ETH_NODE_URI,args:process.argv.slice(2)}))');
  const priorConnector = process.env.REACH_CONNECTOR_MODE;
  const priorNode = process.env.ETH_NODE_URI;
  delete process.env.REACH_CONNECTOR_MODE;
  delete process.env.ETH_NODE_URI;
  t.after(() => {
    if (priorConnector === undefined) delete process.env.REACH_CONNECTOR_MODE;
    else process.env.REACH_CONNECTOR_MODE = priorConnector;
    if (priorNode === undefined) delete process.env.ETH_NODE_URI;
    else process.env.ETH_NODE_URI = priorNode;
  });
  const local = await collectReach(root, ['run', 'index.rsh']);
  assert.equal(local.at(-1).code, 0);
  assert.deepEqual(JSON.parse(local.filter(e => e.channel === 'out').map(e => e.data).join('')),
    { mode: 'ETH-devnet', node: 'http://127.0.0.1:8545', args: [] });
  assert.throws(() => reach.runReach({ cwd: root, args: ['run', 'index.rsh', '--connector', 'ETH-live'] }),
    /ETH-live needs --node URI or ETH_NODE_URI/);
  process.env.ETH_NODE_URI = 'http://127.0.0.1:8546';
  const inheritedNode = await collectReach(root, ['run', 'index.rsh']);
  assert.deepEqual(JSON.parse(inheritedNode.filter(e => e.channel === 'out').map(e => e.data).join('')),
    { mode: 'ETH-devnet', node: 'http://127.0.0.1:8546', args: [] });
  process.env.REACH_CONNECTOR_MODE = 'ALGO-live';
  const explicitConnector = await collectReach(root, ['run', 'index.rsh', '--connector', 'ETH-devnet']);
  assert.deepEqual(JSON.parse(explicitConnector.filter(e => e.channel === 'out').map(e => e.data).join('')),
    { mode: 'ETH-devnet', node: 'http://127.0.0.1:8546', args: [] });
  const events = await collectReach(root, ['run', 'index.rsh', '--connector', 'ETH-live', '--node', 'http://127.0.0.1:8545', '--', 'hello']);
  assert.equal(events.at(-1).code, 0);
  const output = events.filter(e => e.channel === 'out').map(e => e.data).join('');
  assert.deepEqual(JSON.parse(output), { mode: 'ETH-live', node: 'http://127.0.0.1:8545', args: ['hello'] });
  assert.throws(() => reach.runReach({ cwd: root, args: ['run', '--connector', 'ALGO-live', '--node', 'http://127.0.0.1:4001'] }), /ETH only/);
});

test('native run and agent source tools reject symlink escapes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-safe-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-safe-outside-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(path.join(root, 'index.mjs'), '');
  fs.writeFileSync(path.join(root, 'build', 'index.main.mjs'), '');
  fs.writeFileSync(path.join(outside, 'index.rsh'), "'reach 0.1';\n");
  fs.symlinkSync(path.join(outside, 'index.rsh'), path.join(root, 'index.rsh'));
  assert.equal(safeProjectPath(root, 'index.rsh'), null);
  assert.equal(buildReachArgs('reach.compile', { path: '../index.rsh' }), null);
  const agentResult = await createReachToolExecutor()('reach.compile', { path: 'index.rsh' }, { projectDir: root });
  assert.equal(agentResult.ok, false);
  assert.match(agentResult.error, /outside the project/);
  assert.throws(() => reach.runReach({ cwd: root, args: ['run', 'index.rsh', '--connector', 'ETH-devnet'] }), /source resolves outside/);
  fs.unlinkSync(path.join(root, 'index.rsh'));
  fs.writeFileSync(path.join(root, 'index.rsh'), "'reach 0.1';\n");
  fs.writeFileSync(path.join(outside, 'index.mjs'), '');
  fs.unlinkSync(path.join(root, 'index.mjs'));
  fs.symlinkSync(path.join(outside, 'index.mjs'), path.join(root, 'index.mjs'));
  assert.throws(() => reach.runReach({ cwd: root, args: ['run', 'index.rsh', '--connector', 'ETH-devnet'] }), /frontend resolves outside/);
  fs.unlinkSync(path.join(root, 'index.mjs'));
  fs.writeFileSync(path.join(root, 'index.mjs'), '');
  fs.writeFileSync(path.join(outside, 'index.main.mjs'), '');
  fs.unlinkSync(path.join(root, 'build', 'index.main.mjs'));
  fs.symlinkSync(path.join(outside, 'index.main.mjs'), path.join(root, 'build', 'index.main.mjs'));
  assert.throws(() => reach.runReach({ cwd: root, args: ['run', 'index.rsh', '--connector', 'ETH-devnet'] }), /backend resolves outside/);
});

test('native compile supplies temporary ALGORAND_DATA for goal without a node', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-goal-env-'));
  const executable = path.join(root, 'reachc');
  fs.writeFileSync(executable, '#!/bin/sh\n[ -d "$ALGORAND_DATA" ] || exit 7\nprintf "%s\\n" "$ALGORAND_DATA"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'index.rsh'), "'reach 0.1';\n");
  reach.configure(() => ({ reachCli: executable }));
  t.after(() => { reach.configure(() => ({})); fs.rmSync(root, { recursive: true, force: true }); });
  if (process.env.ALGORAND_DATA) return; // the caller's data directory is preserved
  const events = await collectReach(root, ['compile', 'index.rsh']);
  assert.equal(events.at(-1).code, 0);
  const dataDir = events.filter(e => e.channel === 'out').map(e => e.data).join('').trim();
  assert.match(dataDir, /reach-studio-goal-/);
  assert.equal(fs.existsSync(dataDir), false, 'temporary goal data is removed after compile');
});
