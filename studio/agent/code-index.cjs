'use strict';

/* Reach Studio — codebase context & symbol indexer.
 *
 * Builds a symbol table plus dependency and call graphs for a project so the
 * agent can inject the relevant definitions into a prompt instead of the user
 * hand-assembling context.
 *
 * Deliberately ZERO dependencies: the packaged app ships only main.mjs,
 * preload.cjs, renderer/, agent/, browser/ and assets/ (see package.json
 * build.files), so node_modules is absent at runtime. A tree-sitter or lezer
 * parser would only work from source. This module is therefore a structural
 * symbol extractor — the same pragmatic approach as the hand-rolled LCS in
 * diff.cjs and the patch helpers in edits.cjs. It is indentation and
 * signature based, not a full grammar parse, so it degrades gracefully: a file
 * it cannot make sense of is skipped and reported in `warnings` rather than
 * corrupting the index.
 *
 * Pure functions over {path, content} inputs, plus one indexProject() that
 * touches the disk. No Electron, no agent loop knowledge.
 */

const fs = require('node:fs');
const path = require('node:path');

/* ------------------------------------------------------------------ languages */

const LANGUAGES = {
  js: { exts: ['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx'], blockComment: ['/*', '*/'], lineComment: '//', maskStrings: true },
  python: { exts: ['.py', '.pyi'], blockComment: null, lineComment: '#', maskStrings: true },
  reach: { exts: ['.rsh', '.reach'], blockComment: ['/*', '*/'], lineComment: '//', maskStrings: true },
  shell: { exts: ['.sh', '.bash', '.zsh'], blockComment: null, lineComment: '#', maskStrings: true },
  // Markup and styles quote attribute values and selector text; blanking quote
  // bodies there would erase exactly what the rules need to match (an
  // id="foo" selector becomes id=      ), so only comments are masked.
  html: { exts: ['.html', '.htm'], blockComment: ['<!--', '-->'], lineComment: null, maskStrings: false },
  css: { exts: ['.css', '.scss', '.less'], blockComment: ['/*', '*/'], lineComment: null, maskStrings: false },
  json: { exts: ['.json'], blockComment: null, lineComment: null, maskStrings: false },
  markdown: { exts: ['.md', '.markdown'], blockComment: null, lineComment: null, maskStrings: false },
};

const EXT_TO_LANG = (() => {
  const map = new Map();
  for (const [lang, spec] of Object.entries(LANGUAGES)) {
    for (const ext of spec.exts) map.set(ext, lang);
  }
  return map;
})();

function languageFor(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  return EXT_TO_LANG.get(ext) || null;
}

/* ------------------------------------------------------------------- scanning */

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules', '__pycache__', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  '.next', '.nuxt', 'coverage', '.venv', 'venv', 'env', '.tox', '.mypy_cache',
  '.pytest_cache', 'target', 'vendor', '.idea', '.vscode', 'electron_dist',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;   // a single source file this large is data, not code
const DEFAULT_MAX_FILES = 4000;

// tsconfig files are small and few. A bound prevents a pathological tree (or a
// generated-config farm) from reading unbounded JSON into memory.
const MAX_TSCONFIG_BYTES = 256 * 1024;
const MAX_TSCONFIG_FILES = 32;

/**
 * Strip comments, string bodies and regex bodies for signature scanning while
 * preserving the original line numbering. Returns one string per source line
 * where those regions are replaced by spaces, so offsets and line numbers
 * still match the original file.
 *
 * Blanking string contents matters for call-graph accuracy: a symbol name
 * mentioned only inside a string literal is not a call site.
 *
 * Regex literals MUST be handled too. A pattern like /id="([^"]+)"/ contains
 * quote characters; treating the first `"` as a string opener starts a phantom
 * string that never terminates and blanks the rest of the file. That bug cost
 * every symbol after the first quote-bearing regex — including this module's
 * own extractSymbols() — before the masker became regex aware.
 */
function maskLiterals(source, language) {
  const spec = LANGUAGES[language] || {};
  // Python, HTML, CSS, markdown and shell have no regex-literal syntax we need
  // to distinguish, so the regex branch is JS-family only.
  const regexAware = language === 'js' || language === 'reach';
  const out = source.split('');
  const n = source.length;
  let i = 0;
  let lastSignificant = '';   // last non-space char outside comments/strings

  // A `/` only starts a regex where a value could begin. After an identifier,
  // number, closing bracket, `)` or `++`/`--` it is division instead.
  const regexCanStart = () => {
    if (!lastSignificant) return true;
    if ('(,=:[!&|?{};+-*%~^<>'.includes(lastSignificant)) return true;
    return false;
  };

  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (source[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const ch = source[i];
    // Line comment
    if (spec.lineComment && source.startsWith(spec.lineComment, i)) {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    // Block comment
    if (spec.blockComment && source.startsWith(spec.blockComment[0], i)) {
      const end = source.indexOf(spec.blockComment[1], i + spec.blockComment[0].length);
      const stop = end === -1 ? n : end + spec.blockComment[1].length;
      blank(i, stop);
      i = stop;
      continue;
    }
    // Regex literal: blank the body so its quotes and braces cannot confuse
    // the string scanner or the brace-depth counter.
    if (regexAware && ch === '/' && regexCanStart()) {
      let j = i + 1, inClass = false, ok = false;
      while (j < n) {
        const c = source[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '\n') break;              // unterminated: it was division
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) { ok = true; j++; break; }
        j++;
      }
      if (ok) {
        while (j < n && /[a-z]/i.test(source[j])) j++;   // flags
        blank(i, j);
        lastSignificant = '/';
        i = j;
        continue;
      }
    }
    // Strings / templates: blank the interior, keep the quotes and newlines.
    if (spec.maskStrings && (ch === '"' || ch === "'" || ch === '`')) {
      const quote = ch;
      out[i] = ' '; i++;
      while (i < n) {
        if (source[i] === '\\') { if (source[i + 1] !== '\n') out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (source[i] === quote) { out[i] = ' '; i++; break; }
        if (source[i] !== '\n') out[i] = ' ';
        i++;
      }
      lastSignificant = quote;
      continue;
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
    i++;
  }
  return out.join('');
}

/* --------------------------------------------------------------- symbol rules */

// Each rule matches one masked source line. `name` is the capture-group index
// holding the symbol name — always explicit, because a rule that captures
// indentation first (the Python class/def rules) silently produced empty
// names and dropped every class it found. Ordered by specificity so a
// decorated method does not also match as a bare function.
const SYMBOL_RULES = [
  // ---- JavaScript / TypeScript ----
  { lang: 'js', kind: 'class', name: 1, re: /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/ },
  { lang: 'js', kind: 'interface', name: 1, re: /^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/ },
  { lang: 'js', kind: 'function', name: 1, re: /^\s*(?:export\s+)?(?:default\s+)?async\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { lang: 'js', kind: 'function', name: 1, re: /^\s*(?:export\s+)?(?:default\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/ },
  { lang: 'js', kind: 'function', name: 1, re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\*?\s*\(|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/ },
  // Module-scope constants only. A `const` inside a function body is a local,
  // not part of the codebase's referenceable surface — indexing those buried
  // the real symbols (an early run produced 1795 variable hits on 68 files).
  // Scope comes from brace depth, not indentation: every renderer file here is
  // IIFE-wrapped, so its module constants sit at indent 2 and a `topLevelOnly`
  // indent test would have discarded all of them.
  { lang: 'js', kind: 'variable', name: 1, moduleScopeOnly: true,
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/ },
  { lang: 'js', kind: 'method', name: 1, re: /^\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/ },
  // ---- Python ----
  { lang: 'python', kind: 'class', name: 2, re: /^(\s*)class\s+([A-Za-z_]\w*)/ },
  { lang: 'python', kind: 'method', name: 2, re: /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
  { lang: 'python', kind: 'variable', name: 1, moduleScopeOnly: true, re: /^([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=/ },
  // ---- Reach / shell ----
  { lang: 'reach', kind: 'contract', name: 1, re: /^\s*(?:export\s+)?contract\s+([A-Za-z_$][\w$]*)/ },
  { lang: 'reach', kind: 'function', name: 1, re: /^\s*(?:export\s+)?(?:function|fun)\s+([A-Za-z_$][\w$]*)/ },
  { lang: 'shell', kind: 'function', name: 1, re: /^\s*(?:function\s+)?([A-Za-z_][\w-]*)\s*\(\s*\)\s*\{/ },
  // ---- Markup / styles ----
  { lang: 'html', kind: 'section', name: 1, re: /^\s*<(?:h[1-6]|section|nav|header|footer|main)\b[^>]*id="([^"]+)"/ },
  { lang: 'css', kind: 'rule', name: 2, re: /^(\s*)([.#][\w-]+[^{]*)\{/ },
  { lang: 'markdown', kind: 'heading', name: 2, re: /^(#{1,6})\s+(.+?)\s*#*\s*$/ },
];

const RESERVED = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'class', 'new',
  'typeof', 'delete', 'await', 'yield', 'do', 'else', 'try', 'throw', 'super',
  'this', 'self', 'cls', 'with', 'elif', 'except', 'finally', 'lambda', 'pass',
  'break', 'continue', 'def', 'async', 'import', 'from', 'export', 'default',
  'const', 'let', 'var', 'public', 'private', 'protected', 'static',
]);

function isIdentifierName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 120
    && /^[A-Za-z_$@#\w][\w$.:@#-]*$/.test(name) && !RESERVED.has(name);
}

/**
 * Extract symbols from one file. Returns {symbols, warnings}; warnings carry
 * enough detail for the log inspector to show why a file was skipped or
 * partially indexed.
 */
function extractSymbols(file, content) {
  const rel = String(file || '');
  const language = languageFor(rel);
  const warnings = [];
  if (!language) return { symbols: [], warnings, language: null };

  const text = String(content == null ? '' : content);
  if (!text.trim()) return { symbols: [], warnings, language };

  let masked;
  try {
    masked = maskLiterals(text, language);
  } catch (error) {
    // A file we cannot even scan is malformed for our purposes: skip it and
    // say exactly why, rather than dropping it silently.
    warnings.push({ path: rel, level: 'error', message: `Skipped: could not scan file (${error.message})` });
    return { symbols: [], warnings, language };
  }

  const lines = masked.split('\n');
  const rules = SYMBOL_RULES.filter(r => r.lang === language);
  const symbols = [];
  const seen = new Set();
  // Python uses indentation to decide whether a `def` is a method or a
  // module-level function; remember the last class indent to attribute it.
  let lastClassIndent = -1;
  let lastClassName = null;

  // Brace languages track scope with a stack instead of indentation, because
  // indentation says nothing about scope: every renderer file in this repo is
  // IIFE-wrapped, so its module constants sit at indent 2 while still being
  // module scope. Each entry records whether that brace opened a FUNCTION body
  // (declarations inside it are locals) or module-ish scope (an IIFE wrapper,
  // an object literal). A declaration is module scope when no enclosing brace
  // is a function body — so nesting inside an `if` block within a function is
  // still correctly treated as function scope.
  const braceStack = [];
  const inFunctionBody = () => braceStack.some(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    const moduleScope = language === 'python' ? indent === 0 : !inFunctionBody();

    let produced = null;
    for (const rule of rules) {
      // Module constants only: skip locals declared inside a function body.
      if (rule.moduleScopeOnly && !moduleScope) continue;
      const m = rule.re.exec(line);
      if (!m) continue;
      const rawName = (m[rule.name] || '').trim();
      if (!rawName) continue;
      const name = rule.kind === 'heading' || rule.kind === 'rule'
        ? rawName.replace(/\s+/g, ' ')
        : rawName.split('(')[0].trim();
      if (rule.kind !== 'heading' && rule.kind !== 'rule' && !isIdentifierName(name)) continue;

      let kind = rule.kind;
      let scope = null;
      if (language === 'python') {
        if (kind === 'class') { lastClassIndent = indent; lastClassName = name; }
        else if (kind === 'method') {
          // Indented under a class => method; column 0 => module-level function.
          if (indent === 0) kind = 'function';
          else if (lastClassName !== null && indent > lastClassIndent) scope = lastClassName;
        }
      }
      const endLine = guessEndLine(lines, i, indent, language);
      const key = `${kind}:${scope || ''}:${name}:${i + 1}`;
      if (seen.has(key)) break;
      seen.add(key);

      const rawLine = (text.split('\n')[i] || '').trim();
      const symbol = {
        name,
        qualified: scope ? `${scope}.${name}` : name,
        kind,
        scope,
        language,
        path: rel,
        line: i + 1,
        endLine,
        signature: rawLine.length > 200 ? rawLine.slice(0, 200) + '…' : rawLine,
        exported: /\bexport\b/.test(rawLine) || (language === 'python' && !name.startsWith('_'))
          || (language === 'js' && /module\.exports/.test(text)),
      };
      symbols.push(symbol);
      produced = symbol;
      break; // one symbol per line
    }

    // Update brace scope for the NEXT line. Masked input means comments,
    // strings and regex bodies cannot contribute stray braces.
    if (language !== 'python' && language !== 'markdown') {
      const opensFn = !!(produced && ['function', 'method'].includes(produced.kind))
        || /\bfunction\b/.test(trimmed) || /=>/.test(trimmed);
      // An IIFE wrapper's body is module scope, not a function body.
      const isIife = /^[(;]?\(?\s*(?:async\s+)?(?:function\s*\(|\(\s*\)\s*=>)/.test(trimmed);
      for (const ch of line) {
        if (ch === '{') braceStack.push(opensFn && !isIife);
        else if (ch === '}') braceStack.pop();
      }
    }
  }

  if (!symbols.length && text.length > 64) {
    warnings.push({ path: rel, level: 'warn', message: 'No symbols recognised; indexed as text only.' });
  }
  return { symbols, warnings, language };
}

/**
 * Approximate the last line of a symbol body so context snippets stay whole.
 * For brace languages, walk to the matching close; for indentation languages,
 * stop when dedent returns to or above the declaration's own indent.
 */
function guessEndLine(lines, startIndex, indent, language) {
  const cap = Math.min(lines.length - 1, startIndex + 400);
  if (language === 'python' || language === 'markdown') {
    for (let i = startIndex + 1; i <= cap; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      const ind = raw.length - raw.trimStart().length;
      if (ind <= indent) return i; // exclusive: the dedent line is not ours
    }
    return cap + 1;
  }
  let depth = 0, opened = false;
  for (let i = startIndex; i <= cap; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true; }
      else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) return i + 1;
  }
  return Math.min(cap + 1, startIndex + 1);
}

/* --------------------------------------------------------- dependency parsing */

const IMPORT_PATTERNS = [
  // JS/TS: import … from 'x', import 'x', export … from 'x', require('x')
  /(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]/g,
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*import\s+['"]([^'"]+)['"]/gm,
  // Python: import a.b / from a.b import c
  /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm,
];

/** Module specifiers a file refers to. Package imports keep their bare name. */
function extractImports(content) {
  const text = String(content || '');
  const found = new Set();
  for (const re of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const spec = (m[1] || m[2] || '').trim();
      if (!spec) continue;
      // Ignore a stray identifier captured by the python branch.
      if (/^[A-Za-z_$][\w$]*$/.test(spec) && !text.includes('import ' + spec) && !text.includes('from ' + spec)) continue;
      found.add(spec);
    }
  }
  return [...found];
}

/** Resolve a relative specifier to a project-relative path, or null if external. */
function resolveSpecifier(fromFile, spec, knownFiles, tsConfig) {
  const s = String(spec || '');

  // tsconfig `paths` aliases. Only consulted when a tsconfig was found, because
  // without one a bare specifier is always an external package.
  if (tsConfig && tsConfig.aliasRules.length && !s.startsWith('.') && !s.startsWith('/')) {
    const aliased = resolveAlias(s, tsConfig);
    if (aliased) return aliased;
  }

  if (!s.startsWith('.') && !s.startsWith('/')) return null;  // bare package import
  const base = path.posix.dirname(String(fromFile).split(path.sep).join('/'));
  const joined = path.posix.normalize(path.posix.join(base, s));
  if (joined.startsWith('..')) return null;
  const candidates = [joined, joined + '.js', joined + '.cjs', joined + '.mjs', joined + '.ts',
    joined + '.tsx', joined + '.jsx', joined + '.py', joined + '.rsh',
    path.posix.join(joined, 'index.js'), path.posix.join(joined, 'index.cjs'),
    path.posix.join(joined, 'index.mjs'), path.posix.join(joined, '__init__.py')];
  for (const c of candidates) if (knownFiles.has(c)) return c;
  return null;
}

/** Extensions tried when an alias target omits them, in TypeScript's order. */
const ALIAS_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const ALIAS_INDEX = ['index.ts', 'index.tsx', 'index.js', 'index.jsx', 'index.mjs', 'index.cjs'];

/**
 * Expand the candidate paths for one alias substitution.
 *
 * TypeScript tries, in order: the literal target, target + each extension, and
 * target as a directory with an index file. Mirroring that order matters — the
 * wrong pick silently resolves an import to an unrelated file.
 */
function aliasCandidates(target, knownFiles) {
  const out = [];
  if (knownFiles.has(target)) out.push(target);
  for (const ext of ALIAS_EXTENSIONS) {
    if (knownFiles.has(target + ext)) out.push(target + ext);
  }
  for (const idx of ALIAS_INDEX) {
    const p = path.posix.join(target, idx);
    if (knownFiles.has(p)) out.push(p);
  }
  return out;
}

/**
 * Resolve a bare specifier against tsconfig `paths`, or return null.
 *
 * Supports both forms TypeScript allows:
 *   "@utils/*": ["src/utils/*"]   — wildcard substitution
 *   "@config":  ["src/config.ts"] — exact match
 * A `*` pattern matches the longest prefix, and every remaining `*` in the
 * target is substituted (TypeScript requires exactly one, but tolerating more
 * avoids a hard failure on odd configs).
 */
function resolveAlias(spec, tsConfig) {
  const { aliasRules, knownFiles, baseUrl } = tsConfig;
  // Exact matches win over wildcards, so try them first.
  for (const rule of aliasRules) {
    if (!rule.exact || rule.prefix !== spec) continue;
    for (const target of rule.targets) {
      const resolved = baseUrl ? path.posix.join(baseUrl, target) : target;
      const hit = aliasCandidates(resolved, knownFiles)[0];
      if (hit) return hit;
    }
  }
  let best = null;
  for (const rule of aliasRules) {
    if (rule.exact || !spec.startsWith(rule.prefix) || !spec.endsWith(rule.suffix)) continue;
    // The captured text between prefix and suffix. Must not use
    // `suffix.length || undefined`: when suffix is '' that evaluates to
    // undefined, `spec.length - undefined` is NaN, and slice(prefix, NaN)
    // yields '' — which silently resolved every wildcard alias to its bare
    // directory (index file) instead of the requested module.
    if (spec.length < rule.prefix.length + rule.suffix.length) continue;
    // `*` may capture the empty string, exactly as TypeScript allows: `@utils/`
    // against `@utils/*` yields `src/utils/`, which then resolves to
    // src/utils/index.ts via aliasCandidates. Guarding against an empty star
    // here would diverge from tsc and silently drop a valid resolution.
    const star = spec.slice(rule.prefix.length, spec.length - rule.suffix.length);
    if (!best || rule.prefix.length > best.rule.prefix.length) best = { rule, star };
  }
  if (!best) return null;
  for (const target of best.rule.targets) {
    const substituted = target.split('*').join(best.star);
    const resolved = baseUrl ? path.posix.join(baseUrl, substituted) : substituted;
    const hit = aliasCandidates(resolved, knownFiles)[0];
    if (hit) return hit;
  }
  return null;
}

/**
 * Parse tsconfig.json, which is JSONC: line comments, block comments and
 * trailing commas are legal and appear in real projects. A bare JSON.parse
 * therefore throws on valid configs, and swallowing that throw would silently
 * disable alias resolution — so comments and trailing commas are stripped first.
 *
 * Returns null when there is no config or it cannot be understood; the caller
 * treats null as "no aliases", which is correct rather than fatal.
 */
function parseTsConfig(text, { onError } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    return JSON.parse(stripJsonComments(text));
  } catch (error) {
    if (onError) onError('tsconfig.json could not be parsed: ' + error.message);
    return null;
  }
}

/** Remove line and block comments plus trailing commas, preserving string literals. */
function stripJsonComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    // String literal: copy verbatim so a "//" inside a string survives.
    if (ch === '"') {
      out += ch; i++;
      while (i < n) {
        const c = text[i];
        out += c;
        if (c === '\\') { if (i + 1 < n) { out += text[i + 1]; i += 2; continue; } }
        i++;
        if (c === '"') break;
      }
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    out += ch; i++;
  }
  // Trailing commas before } or ] are legal in JSONC but not JSON.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Build the alias lookup table from a parsed tsconfig.
 *
 * `baseUrl` is resolved relative to the tsconfig's own directory and returned
 * project-relative; `paths` are compiled into prefix/suffix rules with wildcard
 * `*` handled. `extends` chains are followed (bounded) because a paths map
 * commonly lives in a shared base config rather than the leaf one.
 */
function buildAliasRules(parsed, configDir, readFile, knownFiles, onError, depth = 0) {
  if (!parsed || typeof parsed !== 'object' || depth > 4) {
    return { aliasRules: [], baseUrl: '', knownFiles };
  }
  let inherited = { aliasRules: [], baseUrl: '' };
  if (typeof parsed.extends === 'string' && parsed.extends) {
    const parentRel = resolveTsConfigExtends(parsed.extends, configDir, readFile, onError);
    if (parentRel) {
      const parentDir = path.posix.dirname(parentRel.path);
      const parentParsed = parseTsConfig(parentRel.text, { onError });
      inherited = buildAliasRules(parentParsed, parentDir, readFile, knownFiles, onError, depth + 1);
    }
  }
  const compilerOptions = parsed.compilerOptions && typeof parsed.compilerOptions === 'object'
    ? parsed.compilerOptions : {};
  const baseUrl = typeof compilerOptions.baseUrl === 'string'
    ? path.posix.normalize(path.posix.join(configDir, compilerOptions.baseUrl.split(path.sep).join('/')))
    : inherited.baseUrl;
  const paths = compilerOptions.paths && typeof compilerOptions.paths === 'object'
    ? compilerOptions.paths : null;

  let aliasRules = inherited.aliasRules;
  if (paths) {
    const rules = [];
    for (const [pattern, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets)) continue;
      const clean = targets.filter(t => typeof t === 'string' && t);
      if (!clean.length) continue;
      const star = pattern.indexOf('*');
      if (star === -1) rules.push({ exact: true, prefix: pattern, suffix: '', targets: clean });
      else rules.push({ exact: false, prefix: pattern.slice(0, star), suffix: pattern.slice(star + 1), targets: clean });
    }
    if (rules.length) aliasRules = rules;
  }
  return { aliasRules, baseUrl, knownFiles };
}

/** Resolve an `extends` entry to a project-relative path + text, or null. */
function resolveTsConfigExtends(spec, configDir, readFile, onError) {
  const candidates = [];
  const s = String(spec);
  if (s.startsWith('.')) {
    const joined = path.posix.normalize(path.posix.join(configDir, s));
    candidates.push(joined, joined + '.json');
  } else {
    // A package-style extends (e.g. "@tsconfig/node20") resolves under
    // node_modules, which the indexer skips; treat it as unavailable rather
    // than walking outside the project.
    candidates.push(path.posix.join('node_modules', s), path.posix.join('node_modules', s + '.json'));
    candidates.push(path.posix.join('node_modules', s, 'tsconfig.json'));
  }
  for (const c of candidates) {
    const text = readFile(c);
    if (typeof text === 'string') return { path: c, text };
  }
  if (onError && !s.startsWith('.')) onError(`tsconfig "extends" target not indexed: ${s}`);
  return null;
}

/**
 * Compile supplied tsconfig entries into alias tables keyed by the directory
 * they govern.
 *
 * options.tsConfigs is a flat list of {path, content} exactly like source files,
 * because tsconfig.json is not a source language and the directory walk does not
 * collect it otherwise. Entries without alias rules are dropped: a tsconfig with
 * no `paths` cannot help resolution, and keeping it would only add lookup work.
 *
 * A reader is needed for `extends` chains. Configs may extend another config
 * that is present in the file list, so lookups are served from `knownFiles`
 * content supplied by the caller via options.configFiles when available, and
 * otherwise extend resolution reports a warning and continues.
 */
function buildTsConfigTables(configs, knownFiles, warnings) {
  const tables = [];
  const list = Array.isArray(configs) ? configs : [];
  if (!list.length) return tables;

  const contentByPath = new Map();
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const p = String(c.path || '').split(path.sep).join('/').replace(/^\.\//, '');
    if (!p) continue;
    contentByPath.set(p, String(c.content == null ? '' : c.content));
  }

  const readFile = (rel) => (contentByPath.has(rel) ? contentByPath.get(rel) : null);
  const onError = (message) => warnings.push({ path: '.', level: 'warn', message });

  for (const [configPath, content] of contentByPath) {
    const parsed = parseTsConfig(content, { onError });
    if (!parsed) continue;
    const configDir = path.posix.dirname(configPath);
    const table = buildAliasRules(parsed, configDir === '.' ? '' : configDir, readFile, knownFiles, onError);
    if (!table.aliasRules.length) continue;
    tables.push({ dir: configDir === '.' ? '' : configDir, path: configPath, ...table });
  }
  // Longest directory prefix first so nearestTsConfig can return on first match.
  tables.sort((a, b) => b.dir.length - a.dir.length);
  return tables;
}

/**
 * The tsconfig that governs `file`: the table whose directory is the longest
 * prefix of the file's directory. Returns null when no config has aliases.
 */
function nearestTsConfig(file, tables) {
  if (!tables || !tables.length) return null;
  const dir = path.posix.dirname(String(file).split(path.sep).join('/'));
  for (const table of tables) {   // already sorted longest-prefix-first
    if (!table.dir) return table;  // a root tsconfig governs everything
    if (dir === table.dir || dir.startsWith(table.dir + '/')) return table;
  }
  return null;
}

/* ------------------------------------------------------------------ call graph */

/**
 * Which known symbols each symbol's body mentions. This is name resolution,
 * not a semantic call graph: an identifier collision shows up as an edge. It
 * is precise enough for "what would a rename touch?" and for dependency-cycle
 * detection, and it is honest about being lexical (see the header note).
 */
function buildCallGraph(files, symbolsByFile) {
  const names = new Set();
  for (const list of symbolsByFile.values()) for (const s of list) {
    if (isIdentifierName(s.name)) names.add(s.name);
  }
  const edges = new Map();  // qualified name -> Set of referenced qualified names
  const qualByName = new Map();
  for (const list of symbolsByFile.values()) {
    for (const s of list) {
      if (!qualByName.has(s.name)) qualByName.set(s.name, []);
      qualByName.get(s.name).push(s.qualified);
    }
  }
  for (const file of files) {
    const list = symbolsByFile.get(file.path) || [];
    // Scan the MASKED text, not the raw source. An identifier inside a string
    // literal or a comment is not a reference: with raw text, a file containing
    // `const msg = 'indexProject only in a string'` produced a bogus
    // msg -> indexProject edge. False edges are not cosmetic — they can
    // manufacture a dependency cycle that halts an otherwise valid refactor.
    // maskLiterals() preserves line numbering, so slicing by line still works.
    const raw = String(file.content == null ? '' : file.content);
    const lines = maskLiterals(raw, languageFor(file.path) || 'js').split('\n');
    for (const sym of list) {
      const body = lines.slice(sym.line - 1, Math.min(lines.length, sym.endLine)).join('\n');
      const refs = new Set();
      for (const m of body.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const id = m[0];
        if (id === sym.name || !names.has(id)) continue;
        for (const q of qualByName.get(id) || []) refs.add(q);
      }
      if (refs.size) edges.set(sym.qualified, refs);
    }
  }
  return edges;
}

/** Tarjan-style cycle detection over any directed graph of string nodes.
 *  adjacency values may be arrays or Sets.
 *
 *  Iterative rather than recursive on purpose: a repository-scale call graph
 *  can nest thousands of frames deep, which overflows the JS stack long before
 *  the analysis is interesting. The explicit work stack keeps depth bounded by
 *  heap instead. */
function findCycles(nodes, adjacency) {
  const index = new Map(), low = new Map(), onStack = new Set(), stack = [];
  const cycles = [];
  let counter = 0;
  const outgoing = (node) => {
    const raw = adjacency.get(node);
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [...raw];
    return list.filter(n => nodes.has(n));
  };

  for (const root of nodes) {
    if (index.has(root)) continue;
    // Each frame: the node and how far through its outgoing edges we are.
    const frames = [{ node: root, i: 0, edges: outgoing(root) }];
    index.set(root, counter); low.set(root, counter); counter++;
    stack.push(root); onStack.add(root);

    while (frames.length) {
      const frame = frames[frames.length - 1];
      if (frame.i < frame.edges.length) {
        const next = frame.edges[frame.i++];
        if (!index.has(next)) {
          index.set(next, counter); low.set(next, counter); counter++;
          stack.push(next); onStack.add(next);
          frames.push({ node: next, i: 0, edges: outgoing(next) });
        } else if (onStack.has(next)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(next)));
        }
        continue;
      }
      frames.pop();
      const node = frame.node;
      if (frames.length) {
        const parent = frames[frames.length - 1].node;
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === index.get(node)) {
        const component = [];
        for (;;) {
          const w = stack.pop(); onStack.delete(w); component.push(w);
          if (w === node) break;
        }
        if (component.length > 1) cycles.push(component.reverse());
        else if (outgoing(node).includes(node)) cycles.push([node]);
      }
    }
  }
  return cycles;
}

/* -------------------------------------------------------------------- ranking */

/**
 * Lexical relevance score for a query against a symbol. Deterministic and
 * explainable — no embeddings, because the packaged app has no runtime
 * dependencies to provide a vector model.
 */
function scoreSymbol(query, symbol) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 0;
  const name = String(symbol.name).toLowerCase();
  const qual = String(symbol.qualified).toLowerCase();
  const terms = q.split(/[\s.,;:]+/).filter(Boolean);
  if (!terms.length) return 0;

  let score = 0;
  for (const term of terms) {
    if (name === term) score += 100;
    else if (name.startsWith(term)) score += 60;
    else if (name.includes(term)) score += 34;
    else if (qual.includes(term)) score += 18;
    else if (String(symbol.signature).toLowerCase().includes(term)) score += 8;
    else if (String(symbol.path).toLowerCase().includes(term)) score += 5;
    else score -= 12;   // a term that matches nothing penalises the candidate
  }
  // Public surface outranks private; definitions outrank incidental hits.
  if (symbol.exported) score += 6;
  if (['class', 'contract', 'interface'].includes(symbol.kind)) score += 5;
  if (['function', 'method'].includes(symbol.kind)) score += 3;
  if (name.startsWith('_')) score -= 8;
  // Shorter names are usually the primary definition of that concept.
  score += Math.max(0, 10 - Math.abs(name.length - q.length));
  return score;
}

/**
 * Top relevant symbols for a prompt, each with its source snippet. Pulls in
 * the matched symbol's own file imports so the model sees the dependency edge,
 * staying inside `maxChars`.
 */
function contextForQuery(index, query, options = {}) {
  const { maxChars = 6000, maxSymbols = 12, includeSnippets = true } = options;
  const scored = index.symbols
    .map(s => ({ symbol: s, score: scoreSymbol(query, s) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || a.symbol.path.localeCompare(b.symbol.path) || a.symbol.line - b.symbol.line)
    .slice(0, maxSymbols);

  const chosen = [];
  let used = 0;
  for (const { symbol, score } of scored) {
    const snippet = includeSnippets ? symbol.snippet || '' : '';
    const cost = snippet.length + 120;
    if (used + cost > maxChars && chosen.length) break;
    used += cost;
    chosen.push({ ...symbol, score, snippet: includeSnippets ? snippet : undefined });
  }

  // Dependency hints for the files that matched.
  const paths = [...new Set(chosen.map(c => c.path))];
  const dependencies = [];
  for (const p of paths) {
    const deps = (index.fileImports.get(p) || []).filter(d => index.resolvedImports.has(d) || d.startsWith('.'));
    if (deps.length) dependencies.push({ path: p, imports: deps.slice(0, 12) });
  }

  return { query: String(query || ''), symbols: chosen, dependencies, chars: used, total: index.symbols.length };
}

/** Render an injection block for the prompt context buffer. */
function formatContext(context) {
  if (!context || !context.symbols.length) return '';
  const head = `Codebase context for "${context.query}" (${context.symbols.length} of ${context.total} indexed symbols):`;
  const body = context.symbols.map(s => {
    const where = `${s.path}:${s.line}${s.endLine > s.line ? `-${s.endLine}` : ''}`;
    const scope = s.scope ? ` in ${s.scope}` : '';
    const snippet = s.snippet ? `\n${s.snippet}` : '';
    return `- ${s.kind} ${s.qualified}${scope} — ${where}${snippet}`;
  }).join('\n');
  const deps = context.dependencies.length
    ? '\nDependencies:\n' + context.dependencies.map(d => `- ${d.path} imports ${d.imports.join(', ')}`).join('\n')
    : '';
  return head + '\n' + body + deps;
}

/* ------------------------------------------------------------------- indexing */

/**
 * Build an index from in-memory files. Pure: no disk, no Electron.
 * files: [{path, content}] with project-relative posix or win paths.
 */
function buildIndex(files, options = {}) {
  const warnings = [];
  const symbolsByFile = new Map();
  const allSymbols = [];
  const fileImports = new Map();
  const knownFiles = new Set();
  const normalized = [];

  for (const raw of Array.isArray(files) ? files : []) {
    if (!raw || typeof raw !== 'object') continue;
    const rel = String(raw.path || '').split(path.sep).join('/').replace(/^\.\//, '');
    if (!rel) continue;
    knownFiles.add(rel);
    normalized.push({ path: rel, content: String(raw.content == null ? '' : raw.content) });
  }

  // tsconfig alias tables, keyed by the directory they govern. Nearest config
  // wins: TypeScript resolves paths relative to the tsconfig that declares
  // them, and monorepos legitimately have several.
  const tsConfigs = buildTsConfigTables(options.tsConfigs, knownFiles, warnings);

  for (const file of normalized) {
    const language = languageFor(file.path);
    if (!language) continue;   // not a source file we model; not an error
    const { symbols, warnings: w } = extractSymbols(file.path, file.content);
    warnings.push(...w);
    symbolsByFile.set(file.path, symbols);
    const lines = file.content.split('\n');
    for (const s of symbols) {
      const start = Math.max(0, s.line - 1);
      const end = Math.min(lines.length, s.endLine);
      const snippet = lines.slice(start, end).join('\n');
      const capped = snippet.length > 1200 ? snippet.slice(0, 1200) + '\n…' : snippet;
      const withSnippet = { ...s, snippet: capped };
      s.snippet = capped;
      allSymbols.push(withSnippet);
    }
    fileImports.set(file.path, extractImports(file.content));
  }

  const resolvedImports = new Set();
  const fileGraph = new Map();
  for (const [file, specs] of fileImports) {
    const targets = [];
    // Pick the tsconfig nearest to this file, not the first one in the project.
    const tsConfig = nearestTsConfig(file, tsConfigs);
    for (const spec of specs) {
      const target = resolveSpecifier(file, spec, knownFiles, tsConfig);
      if (target && target !== file) { resolvedImports.add(target); targets.push(target); }
    }
    if (targets.length) fileGraph.set(file, [...new Set(targets)]);
  }

  const callGraph = buildCallGraph(normalized, symbolsByFile);
  const symbolNodes = new Set(allSymbols.map(s => s.qualified));
  const symbolCycles = findCycles(symbolNodes, callGraph);
  const fileCycles = findCycles(new Set(fileGraph.keys()), fileGraph);

  const byLanguage = {};
  for (const s of allSymbols) byLanguage[s.language] = (byLanguage[s.language] || 0) + 1;

  return {
    version: 1,
    builtAt: Date.now(),
    files: normalized.length,
    indexedFiles: symbolsByFile.size,
    symbols: allSymbols,
    symbolsByFile,
    byLanguage,
    fileImports,
    fileGraph,
    resolvedImports,
    callGraph,
    symbolCycles,
    fileCycles,
    warnings,
    limits: { maxFiles: options.maxFiles || DEFAULT_MAX_FILES, maxFileBytes: MAX_FILE_BYTES },
  };
}

/**
 * Walk a project directory and build its index. Skips ignored directories,
 * symlinks, oversize and undecodable files — each skip is reported in
 * `warnings` so the UI can surface "N files skipped, here is why" instead of
 * silently indexing less than the user expects.
 */
function indexProject(projectDir, options = {}) {
  const root = path.resolve(String(projectDir || ''));
  const maxFiles = options.maxFiles || DEFAULT_MAX_FILES;
  const ignoredDirs = options.ignoredDirs instanceof Set ? options.ignoredDirs : new Set(options.ignoredDirs || DEFAULT_IGNORED_DIRS);
  const extensions = options.extensions ? new Set(options.extensions) : EXT_TO_LANG;
  const warnings = [];
  const files = [];
  // tsconfig files are collected separately: they are JSON, not a source
  // language, so they are not symbol-bearing files, but their `paths`/`baseUrl`
  // are required to resolve aliased imports across the tree.
  const tsConfigs = [];
  const maxConfigs = options.maxTsConfigs || MAX_TSCONFIG_FILES;
  let visited = 0;
  let truncated = false;

  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (error) { warnings.push({ path: rel || '.', level: 'warn', message: `Unreadable directory: ${error.message}` }); return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      if (entry.isSymbolicLink()) continue;
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        visited++;
        if (ignoredDirs.has(entry.name) || entry.name.startsWith('.')) continue;
        walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile()) {
        visited++;
        const ext = path.extname(entry.name).toLowerCase();
        const lower = entry.name.toLowerCase();
        // tsconfig*.json files govern path aliases. They are collected (not
        // indexed as source) so aliased imports across the tree resolve; a
        // monorepo can legitimately have several, hence the bounded count.
        if (lower.endsWith('.json') && lower.startsWith('tsconfig') && tsConfigs.length < maxConfigs) {
          const abs = path.join(dir, entry.name);
          try {
            const stat = fs.statSync(abs);
            if (stat.size <= MAX_TSCONFIG_BYTES) {
              const content = fs.readFileSync(abs, 'utf8');
              if (!content.includes('\u0000')) tsConfigs.push({ path: childRel, content });
            }
          } catch (error) {
            warnings.push({ path: childRel, level: 'warn', message: `tsconfig unreadable: ${error.message}` });
          }
          continue;
        }
        if (!extensions.has(ext)) continue;
        const abs = path.join(dir, entry.name);
        let stat;
        try { stat = fs.statSync(abs); }
        catch (error) { warnings.push({ path: childRel, level: 'warn', message: `Unreadable file: ${error.message}` }); continue; }
        if (stat.size > MAX_FILE_BYTES) {
          warnings.push({ path: childRel, level: 'warn', message: `Skipped: ${(stat.size / 1024 / 1024).toFixed(1)} MB exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB source limit.` });
          continue;
        }
        let content;
        try { content = fs.readFileSync(abs, 'utf8'); }
        catch (error) { warnings.push({ path: childRel, level: 'error', message: `Skipped: ${error.message}` }); continue; }
        if (content.includes('\u0000')) {
          warnings.push({ path: childRel, level: 'warn', message: 'Skipped: binary file.' });
          continue;
        }
        files.push({ path: childRel, content });
      }
    }
  };

  if (!root || !fs.existsSync(root)) {
    return { ...buildIndex([], options), root, visited: 0, truncated: false,
      warnings: [{ path: '.', level: 'error', message: 'Project directory does not exist.' }] };
  }
  walk(root, '');
  const index = buildIndex(files, { ...options, tsConfigs });
  if (truncated) {
    index.warnings.unshift({ path: '.', level: 'warn', message: `Index truncated at ${maxFiles} files; raise maxFiles to cover the rest.` });
  }
  index.root = root;
  index.visited = visited;
  index.truncated = truncated;
  return index;
}

/** Compact, JSON-safe summary for the UI and for tool results. */
function summarize(index) {
  return {
    version: index.version,
    files: index.files,
    indexedFiles: index.indexedFiles,
    symbols: index.symbols.length,
    byLanguage: index.byLanguage,
    byKind: index.symbols.reduce((acc, s) => { acc[s.kind] = (acc[s.kind] || 0) + 1; return acc; }, {}),
    dependencies: index.fileGraph.size,
    symbolCycles: index.symbolCycles.length,
    fileCycles: index.fileCycles.length,
    warnings: index.warnings.length,
    truncated: !!index.truncated,
  };
}

module.exports = {
  LANGUAGES,
  DEFAULT_IGNORED_DIRS,
  MAX_FILE_BYTES,
  MAX_TSCONFIG_BYTES,
  MAX_TSCONFIG_FILES,
  languageFor,
  maskLiterals,
  extractSymbols,
  guessEndLine,
  extractImports,
  resolveSpecifier,
  stripJsonComments,
  parseTsConfig,
  buildAliasRules,
  buildTsConfigTables,
  nearestTsConfig,
  resolveAlias,
  buildCallGraph,
  findCycles,
  scoreSymbol,
  contextForQuery,
  formatContext,
  buildIndex,
  indexProject,
  summarize,
  isIdentifierName,
};
