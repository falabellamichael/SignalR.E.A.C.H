'use strict';

/* Reach Studio — project subprocesses and Docker-free native Reach compiler.
 * Reach DApp compilation invokes `reachc` directly. The upstream `reach`
 * launcher probes Docker even with REACH_DOCKER=0 and is never used here.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { commandEnv, reachCommand, spawnCommand, killProcessTree, runCommand } = require('./platform.cjs');
let settingsProvider = () => ({});
function configure(provider) { settingsProvider = provider; }

const WSL_DISTRO = 'Ubuntu';
const REACH_BIN = 'reachc';
const DEFAULT_ETH_DEVNET_NODE_URI = 'http://127.0.0.1:8545';
const running = new Map(); // runId -> { proc?, controller?, killed }
const listeners = new Set();
let runSeq = 0;

function emit(payload) {
  for (const fn of listeners) {
    try { fn(payload); } catch { /* a bad listener must not break others */ }
  }
}
function onRunEvent(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function runProcess({ cwd, command, args = [], label, env, cleanup }) {
  const runId = ++runSeq;
  const proc = spawnCommand(command, args, { cwd: cwd || undefined, env });
  running.set(runId, { proc, killed: false });
  let launchError = false;
  proc.stdout.on('data', d => emit({ type: 'output', runId, channel: 'out', data: d.toString() }));
  proc.stderr.on('data', d => emit({ type: 'output', runId, channel: 'err', data: d.toString() }));
  proc.on('error', e => {
    launchError = true;
    const hint = label === 'Native Reach compiler' && e.code === 'ENOENT'
      ? 'Native Reach compiler (reachc) is unavailable. Build it locally or set its path in Settings → Connection.'
      : `${label} could not start: ${e.message}`;
    emit({ type: 'output', runId, channel: 'err', data: `${hint}\n` });
  });
  proc.on('close', code => {
    const stopped = running.get(runId)?.killed === true;
    running.delete(runId);
    try { cleanup?.(); } catch { /* temporary compiler data is best-effort cleanup */ }
    emit({ type: 'exit', runId, code, launchError, stopped });
  });
  return runId;
}

// Filesystem commands use the same output bus as subprocesses. Scheduling work
// lets callers attach listeners and gives Stop a chance to cancel before writes.
function runLocal(action) {
  const runId = ++runSeq;
  const controller = new AbortController();
  running.set(runId, { controller, killed: false });
  setImmediate(async () => {
    let code = 0;
    try {
      if (!controller.signal.aborted) {
        const output = await action(controller.signal);
        if (output && !controller.signal.aborted) emit({ type: 'output', runId, channel: 'out', data: `${output}\n` });
      }
    } catch (error) {
      code = 1;
      if (!controller.signal.aborted) emit({ type: 'output', runId, channel: 'err', data: `${error.message}\n` });
    }
    const stopped = running.get(runId)?.killed === true;
    running.delete(runId);
    emit({ type: 'exit', runId, code: stopped ? null : code, launchError: false, stopped });
  });
  return runId;
}

function insideProject(root, target) {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function realProjectFile(cwd, target, label) {
  const root = fs.realpathSync(cwd);
  const resolved = fs.realpathSync(target);
  if (!insideProject(root, resolved)) throw new Error(`${label} resolves outside the selected project.`);
  return resolved;
}

function findExecutable(command) {
  if (process.platform === 'win32') return null; // WSL paths cannot be inspected from Windows.
  const candidates = command.includes(path.sep) ? [command]
    : commandEnv().PATH.split(path.delimiter).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch { /* try the next PATH directory */ }
  }
  return null;
}
function compilerSpec(args) {
  const settings = settingsProvider();
  const spec = reachCommand(args, settings);
  const configured = settings.reachCli || process.env.REACH_STUDIO_REACHC || '';
  if (configured && /^reach(?:\.exe)?$/i.test(path.basename(String(configured))))
    throw new Error('The configured `reach` launcher uses Docker. Set Reach compiler executable to the native `reachc` binary.');
  const executable = findExecutable(spec.command);
  if (executable) {
    if (/^reach(?:\.exe)?$/i.test(path.basename(executable)))
      throw new Error('The configured reachc path resolves to the Docker-backed `reach` launcher. Set a native reachc binary.');
    // The official launcher is a shell script. Detect copied/renamed launchers
    // as well as symlinks, while allowing small local reachc setup wrappers.
    const fd = fs.openSync(executable, 'r');
    const header = Buffer.alloc(32768);
    let length;
    try { length = fs.readSync(fd, header, 0, header.length, 0); }
    finally { fs.closeSync(fd); }
    const source = header.subarray(0, length).toString('utf8');
    if (source.startsWith('#!') && /reachsh\/reach-cli|REACH_DOCKER|docker(?:-compose)?[ \t]+(?:image|pull|run|exec|ps)|(?:^|[ \t])(?:\.\/)?reach[ \t]/m.test(source))
      throw new Error('The configured reachc script invokes the Docker-backed Reach launcher. Set a native reachc binary.');
  }
  return spec;
}

function sourceForRun(source) {
  if (typeof source !== 'string' || !source.endsWith('.rsh'))
    throw new Error('Run expects a Reach source file ending in .rsh.');
  if (path.basename(source) !== source || source === '..' || source.includes('\\'))
    throw new Error('Run source must be a file at the selected project root.');
  return source;
}
function runOptions(args) {
  let source = 'index.rsh', connector = process.env.REACH_CONNECTOR_MODE || 'ETH-devnet', nodeUri = '';
  const frontendArgs = [];
  let i = 0;
  if (args[0] && !args[0].startsWith('--')) source = args[i++];
  for (; i < args.length; i++) {
    const option = args[i];
    if (option === '--') { frontendArgs.push(...args.slice(i + 1)); break; }
    if (option === '--connector' || option === '--node') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Native Run needs a value after ${option}.`);
      if (option === '--connector') connector = value;
      else nodeUri = value;
    } else frontendArgs.push(option);
  }
  if (!/^(?:ETH|ALGO)(?:-(?:live|devnet))?$/.test(connector))
    throw new Error('Native Run needs --connector ETH-live, ETH-devnet, ALGO-live, or ALGO-devnet. Studio does not start a devnet.');
  if (nodeUri && !connector.startsWith('ETH'))
    throw new Error('--node currently supports ETH only; Algorand also needs an indexer configuration.');
  if (!nodeUri && connector.startsWith('ETH'))
    nodeUri = process.env.ETH_NODE_URI || (connector === 'ETH-devnet' ? DEFAULT_ETH_DEVNET_NODE_URI : '');
  if (connector === 'ETH-live' && !nodeUri)
    throw new Error('ETH-live needs --node URI or ETH_NODE_URI.');
  if (nodeUri) {
    let parsed;
    try { parsed = new URL(nodeUri); } catch { throw new Error('--node must be an HTTP or HTTPS URI.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('--node must be an HTTP or HTTPS URI.');
  }
  return { source: sourceForRun(source), connector, nodeUri, frontendArgs };
}

function runReach({ cwd, args = [] }) {
  if (!cwd || !Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0')))
    throw new Error('Choose a project and enter a Reach command.');
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case 'version':
      if (rest.length) throw new Error('Usage: version');
      return runProcess({ cwd, ...compilerSpec(['--version']), label: 'Native Reach compiler' });
    case 'help':
      return runProcess({ cwd, ...compilerSpec(['--help']), label: 'Native Reach compiler' });
    case 'compile': {
      const compileArgs = rest.length ? rest : ['index.rsh'];
      const source = compileArgs.find(arg => arg.endsWith('.rsh'));
      if (source) {
        const sourceFile = path.resolve(cwd, source);
        if (!fs.existsSync(sourceFile) || !fs.statSync(sourceFile).isFile())
          throw new Error(`Cannot compile ${source}: file not found in the selected project (${cwd}). Run Native Reach init here or open a Reach DApp project containing that source. Ganache supplies a node for run, not compile.`);
        realProjectFile(cwd, sourceFile, 'Reach source');
      }
      // goal's standalone TEAL assembler still needs ALGORAND_DATA, but no
      // algod node. Use a temporary directory when the user has not set one.
      const goalData = process.env.ALGORAND_DATA ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'reach-studio-goal-'));
      const env = goalData ? { ...process.env, ALGORAND_DATA: goalData } : process.env;
      try {
        return runProcess({ cwd, ...compilerSpec(['--disable-reporting', ...compileArgs]),
          label: 'Native Reach compiler', env,
          cleanup: goalData ? () => fs.rmSync(goalData, { recursive: true, force: true }) : undefined });
      } catch (error) {
        if (goalData) fs.rmSync(goalData, { recursive: true, force: true });
        throw error;
      }
    }
    case 'init':
      if (rest.length) throw new Error('Usage: init');
      return runLocal(signal => initProject(cwd, signal));
    case 'clean':
      return runLocal(() => cleanProject(cwd, rest));
    case 'info':
      if (rest.length) throw new Error('Usage: info');
      return runLocal(signal => nativeInfo(cwd, signal));
    case 'run': {
      const { source, connector, nodeUri, frontendArgs } = runOptions(rest);
      const sourceFile = path.join(cwd, source);
      const frontend = path.join(cwd, source.replace(/\.rsh$/, '.mjs'));
      const backend = path.join(cwd, 'build', `${path.basename(source, '.rsh')}.main.mjs`);
      if (!fs.existsSync(sourceFile) || !fs.existsSync(frontend) || !fs.existsSync(backend))
        throw new Error(`Compile ${source} first and provide its matching .mjs frontend. Native Run does not create a Docker devnet.`);
      realProjectFile(cwd, sourceFile, 'Reach source');
      const safeFrontend = realProjectFile(cwd, frontend, 'Reach frontend');
      realProjectFile(cwd, backend, 'Compiled backend');
      try { require.resolve('@reach-sh/stdlib', { paths: [cwd] }); }
      catch { throw new Error('Native Run needs @reach-sh/stdlib. In the selected project run: npm install @reach-sh/stdlib. Use a version compatible with reachc.'); }
      const env = { ...process.env, REACH_CONNECTOR_MODE: connector };
      if (nodeUri) env.ETH_NODE_URI = nodeUri;
      return runProcess({ cwd, command: 'node', args: ['--unhandled-rejections=strict', safeFrontend, ...frontendArgs],
        label: 'Reach frontend', env });
    }
    default:
      throw new Error(`Unknown native Reach command: ${subcommand}. Use version, compile, init, clean, info, help, or run.`);
  }
}

async function compilerVersion(signal, numeric = false) {
  const spec = compilerSpec([numeric ? '--numeric-version' : '--version']);
  const result = await runCommand(spec.command, spec.args, { signal, timeoutMs: 10000, maxOutput: 4096 });
  if (!result.ok) throw new Error(result.error || result.stderr.trim() || `reachc exited with code ${result.exitCode}`);
  const version = result.stdout.trim();
  const valid = numeric ? /^\d+\.\d+(?:\.\d+)*(?:[-+][^\s]+)?$/.test(version)
    : /^reachc\s+\d+\.\d+(?:\.\d+)*(?:[-+][^\s]+)?(?:\s|$)/i.test(version);
  if (!valid) throw new Error(`Unexpected native reachc version output: ${version || '(empty)'}`);
  return version;
}

// Based on the default init files in reach-sh/reach-lang (Apache-2.0).
async function initProject(cwd, signal) {
  const rsh = path.join(cwd, 'index.rsh');
  const mjs = path.join(cwd, 'index.mjs');
  if (fs.existsSync(rsh) || fs.existsSync(mjs)) throw new Error('index.rsh or index.mjs already exists.');
  const version = await compilerVersion(signal, true);
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Could not read the native Reach compiler version: ${version}`);
  if (signal.aborted) return '';
  const rshText = `'reach ${match[1]}.${match[2]}';

export const main = Reach.App(() => {
  const A = Participant('Alice', {
    // Specify Alice's interact interface here
  });
  const B = Participant('Bob', {
    // Specify Bob's interact interface here
  });
  init();
  // The first one to publish deploys the contract
  A.publish();
  commit();
  // The second one to publish always attaches
  B.publish();
  commit();
  // write your program here
  exit();
});
`;
  const mjsText = `import {loadStdlib} from '@reach-sh/stdlib';
import * as backend from './build/index.main.mjs';
const stdlib = loadStdlib(process.env);

const startingBalance = stdlib.parseCurrency(100);

const [ accAlice, accBob ] =
  await stdlib.newTestAccounts(2, startingBalance);
console.log('Hello, Alice and Bob!');

console.log('Launching...');
const ctcAlice = accAlice.contract(backend);
const ctcBob = accBob.contract(backend, ctcAlice.getInfo());

console.log('Starting backends...');
await Promise.all([
  backend.Alice(ctcAlice, {
    ...stdlib.hasRandom,
    // implement Alice's interact object here
  }),
  backend.Bob(ctcBob, {
    ...stdlib.hasRandom,
    // implement Bob's interact object here
  }),
]);

console.log('Goodbye, Alice and Bob!');
`;
  let wroteRsh = false;
  try {
    fs.writeFileSync(rsh, rshText, { flag: 'wx' });
    wroteRsh = true;
    fs.writeFileSync(mjs, mjsText, { flag: 'wx' });
  } catch (error) {
    if (wroteRsh) fs.rmSync(rsh, { force: true });
    throw error;
  }
  return 'Created index.rsh and index.mjs. Compile the Reach source before running the frontend.';
}

function cleanProject(cwd, args) {
  if (args.length > 2 || args.some(arg => !/^[A-Za-z0-9_-]+$/.test(arg)))
    throw new Error('Usage: clean [module] [export] (simple names only)');
  const moduleName = args[0] || 'index';
  const exportName = args[1] || 'main';
  const build = path.join(cwd, 'build');
  const output = path.join(build, `${moduleName}.${exportName}.mjs`);
  if (fs.existsSync(build)) realProjectFile(cwd, build, 'Build directory');
  const existed = fs.existsSync(output);
  if (existed) realProjectFile(cwd, output, 'Compiled backend');
  fs.rmSync(output, { force: true });
  return existed ? `Removed ${path.relative(cwd, output)}` : `No ${path.relative(cwd, output)} file to remove.`;
}

async function nativeInfo(cwd, signal) {
  const version = await compilerVersion(signal);
  const sources = fs.readdirSync(cwd).filter(name => name.endsWith('.rsh')).sort();
  return `${version}\nProject: ${cwd}\nReach source files: ${sources.length ? sources.join(', ') : '(none)'}\nCompiler: native reachc; no Docker launcher or devnet is started.`;
}

function runProject({ cwd, args = [] }) {
  if (!cwd || !Array.isArray(args) || !args.length || args.some(arg => typeof arg !== 'string' || !arg || arg.includes('\0')))
    throw new Error('Choose a project and enter a command to run.');
  return runProcess({ cwd, command: args[0], args: args.slice(1), label: args[0] });
}
function killRun(runId) {
  const r = running.get(runId);
  if (!r) return false;
  r.killed = true;
  r.controller?.abort();
  if (r.proc) killProcessTree(r.proc);
  return true;
}
function killAllRuns() {
  for (const id of [...running.keys()]) killRun(id);
}
async function reachVersion() {
  try { return await compilerVersion(); }
  catch (error) { return `Native Reach compiler unavailable. Configure native reachc in Settings. ${error.message}`; }
}

module.exports = { configure, runReach, runProject, killRun, killAllRuns, onRunEvent, reachVersion, WSL_DISTRO, REACH_BIN };
