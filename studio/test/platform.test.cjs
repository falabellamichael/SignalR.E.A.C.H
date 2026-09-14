'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commandEnv, reachCommand, runCommand } = require('../agent/platform.cjs');
const reach = require('../agent/reach-process.cjs');
const { createReachToolExecutor } = require('../agent/reach-tool-executor.cjs');

test('Finder PATH contains Apple Silicon, Intel and user executables without replacing inherited values', () => {
  const env = commandEnv({ PATH: '/custom/bin:/usr/bin', KEEP: 'yes' }, 'darwin', '/Users/test person');
  assert.equal(env.KEEP, 'yes');
  assert.equal(env.PATH, '/custom/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/test person/.local/bin:/Users/test person/bin:/bin:/usr/sbin:/sbin');
  assert.deepEqual(commandEnv({ Path: 'C:\\bin' }, 'win32'), { Path: 'C:\\bin' });
});
test('Mac/Linux commands preserve argument boundaries and Windows retains WSL', () => {
  assert.deepEqual(reachCommand(['run', 'a b.rsh'], { reachCli: '/Users/test person/reach' }, 'darwin'), { command: '/Users/test person/reach', args: ['run', 'a b.rsh'] });
  assert.equal(reachCommand([], {}, 'linux', { REACH_STUDIO_CLI: '/bin/my-reach' }).command, '/bin/my-reach');
  assert.deepEqual(reachCommand(['version'], {}, 'win32'), { command: 'wsl.exe', args: ['-d', 'Ubuntu', '--', '/usr/local/bin/reach', 'version'] });
  assert.equal(reachCommand([], { reachCli: '/custom/reach' }, 'win32').args[3], '/custom/reach');
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
test('Reach pub/sub uses configured native executable and reports exit', { skip: process.platform === 'win32' }, async t => {
  reach.configure(() => ({ reachCli: process.execPath }));
  t.after(() => { reach.killAllRuns(); reach.configure(() => ({})); });
  const events = [];
  await new Promise(resolve => {
    const id = reach.runReach({ cwd: os.tmpdir(), args: ['-e', 'console.log("reach fixture")'] });
    const detach = reach.onRunEvent(event => {
      if (event.runId !== id) return;
      events.push(event);
      if (event.type === 'exit') { detach(); resolve(); }
    });
  });
  assert.match(events.find(e => e.type === 'output').data, /reach fixture/);
  assert.equal(events.at(-1).code, 0);
});
test('optional CLI status supports executable paths with spaces', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach cli '));
  const executable = path.join(root, 'reach fixture');
  fs.writeFileSync(executable, '#!/bin/sh\n[ "$1" = version ] && echo "reach 0.1.fixture"\n', { mode: 0o755 });
  reach.configure(() => ({ reachCli: executable }));
  t.after(() => { reach.configure(() => ({})); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(await reach.reachVersion(), 'reach 0.1.fixture');
  reach.configure(() => ({ reachCli: path.join(root, 'missing') }));
  assert.match(await reach.reachVersion(), /Optional Reach CLI unavailable.*Settings/);
});
test('Reach agent tools honour Stop', { skip: process.platform === 'win32' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-stop-'));
  const executable = path.join(root, 'reach');
  fs.writeFileSync(executable, '#!/bin/sh\nsleep 60\n', { mode: 0o755 });
  reach.configure(() => ({ reachCli: executable }));
  t.after(() => { reach.killAllRuns(); reach.configure(() => ({})); fs.rmSync(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const promise = createReachToolExecutor()('reach.compile', {}, { projectDir: root, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  assert.equal((await promise).ok, false);
});
