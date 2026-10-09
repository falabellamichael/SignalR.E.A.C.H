/* Reach Studio — CodeMirror 6 editor bundle entry.
 * Bundled by esbuild to renderer/editor.bundle.js. Exposes a tiny global API:
 *   ReachEditor.create(parent, {doc, onChange, onLive, filename}) -> editor
 *   .setText / .getText / .showChange / .clearLive / .setDeletionsVisible
 *   .jumpLive / .removedText / .liveState / .focus / .destroy
 */
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder, Decoration, WidgetType } from '@codemirror/view';
import { EditorState, Compartment, StateEffect, StateField, Transaction } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, syntaxHighlighting, bracketMatching, LanguageDescription } from '@codemirror/language';
import { tags, highlightTree } from '@lezer/highlight';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';

const editorTheme = dark => EditorView.theme({
  '&': { backgroundColor: 'var(--bg)', color: 'var(--text)', height: '100%', fontSize: '13px' },
  '.cm-content': { fontFamily: "Menlo, Consolas, 'Courier New', monospace", caretColor: 'var(--gold)', padding: '10px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--gold)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--gold)' },
  '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--muted)', border: 'none', borderRight: '1px solid var(--line)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-matchingBracket': { backgroundColor: 'var(--selection)', outline: '1px solid var(--gold-dim)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--selection)' },
}, { dark });

const goldHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--gold)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: tags.comment, color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--code-text)' },
  { tag: tags.typeName, color: 'var(--syntax-type)' },
  { tag: tags.operator, color: 'var(--dim)' },
  { tag: tags.punctuation, color: 'var(--dim)' },
  { tag: tags.propertyName, color: 'var(--syntax-property)' },
  { tag: tags.definition(tags.variableName), color: 'var(--text)' },
]);

/* Deleted lines are not part of the saved document. They render as a block
 * widget in front of the line that now follows them. The widget is not an
 * editor: no caret, no selection, no line number. */
const LIVE_DEL_LINE = 14;

class DeletedLinesWidget extends WidgetType {
  constructor(lines) {
    super();
    this.lines = lines;
  }
  eq(other) {
    return other.lines.length === this.lines.length && other.lines.every((line, i) => line === this.lines[i]);
  }
  toDOM(view) {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-del';
    wrap.contentEditable = 'false';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.style.setProperty('--live-del-rows', String(Math.max(1, this.lines.length)));
    this.lines.forEach((line, i) => {
      const row = document.createElement('div');
      row.className = 'cm-live-del-line';
      row.style.top = (i * LIVE_DEL_LINE) + 'px';
      row.textContent = line.length ? line : '\u00a0';
      wrap.appendChild(row);
    });
    /* Match the visible pane. A long removed line must not widen the file. */
    const fit = () => {
      const scroller = view.scrollDOM;
      if (!scroller || !scroller.clientWidth) return;
      const gutter = scroller.querySelector('.cm-gutters');
      const width = scroller.clientWidth - (gutter ? gutter.offsetWidth : 0);
      if (width > 0) wrap.style.width = width + 'px';
    };
    fit();
    if (typeof ResizeObserver === 'function' && view.scrollDOM) {
      const observer = new ResizeObserver(fit);
      observer.observe(view.scrollDOM);
      wrap._liveFit = observer;
    }
    return wrap;
  }
  destroy(dom) {
    if (dom && dom._liveFit) dom._liveFit.disconnect();
  }
  /* Let the editor take the click and place the caret in the real file. */
  ignoreEvent() { return false; }
  get estimatedHeight() { return Math.max(1, this.lines.length) * LIVE_DEL_LINE; }
}

function normalizeLive(value) {
  if (Array.isArray(value)) return { changes: value, showDeletions: true };
  return {
    changes: Array.isArray(value && value.changes) ? value.changes : [],
    showDeletions: !value || value.showDeletions !== false,
  };
}

const setLiveDiff = StateEffect.define();

function liveDecorations(doc, spec) {
  try {
    const { changes, showDeletions } = normalizeLive(spec);
    const ranges = [];
    const seenAdds = new Set();
    let group = null;
    const flush = () => {
      if (!group || !group.lines.length) { group = null; return; }
      if (showDeletions) {
        let from = doc.length;
        if (group.at != null && group.at >= 1 && group.at <= doc.lines) from = doc.line(group.at).from;
        else if (group.at != null) { group = null; return; }
        ranges.push(Decoration.widget({
          widget: new DeletedLinesWidget(group.lines),
          side: -1,
          block: true,
        }).range(from));
      }
      group = null;
    };
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      if (change.type === 'del') {
        const at = Number.isInteger(change.at) ? change.at : null;
        if (!group || group.at !== at) flush();
        if (!group) group = { at, lines: [] };
        group.lines.push(String(change.text ?? '').slice(0, 400));
        continue;
      }
      if (change.type !== 'add' || !Number.isInteger(change.next) || change.next < 1 || change.next > doc.lines || seenAdds.has(change.next)) continue;
      flush();
      seenAdds.add(change.next);
      ranges.push(Decoration.line({ class: 'cm-live-add' }).range(doc.line(change.next).from));
    }
    flush();
    return ranges.length ? Decoration.set(ranges, true) : Decoration.none;
  } catch {
    return Decoration.none;
  }
}

function liveHunks(doc, changes, showDeletions) {
  const hunks = [];
  let group = null;
  const flush = () => {
    if (!group || !group.lines.length) { group = null; return; }
    if (showDeletions) {
      let pos = doc.length;
      if (group.at != null && group.at >= 1 && group.at <= doc.lines) pos = doc.line(group.at).from;
      if (group.at == null || (group.at >= 1 && group.at <= doc.lines)) hunks.push({ pos, kind: 'del' });
    }
    group = null;
  };
  const seenAdds = new Set();
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || typeof change !== 'object') continue;
    if (change.type === 'del') {
      const at = Number.isInteger(change.at) ? change.at : null;
      if (!group || group.at !== at) flush();
      if (!group) group = { at, lines: [] };
      group.lines.push(String(change.text ?? ''));
      continue;
    }
    if (change.type !== 'add' || !Number.isInteger(change.next) || change.next < 1 || change.next > doc.lines || seenAdds.has(change.next)) continue;
    flush();
    seenAdds.add(change.next);
    hunks.push({ pos: doc.line(change.next).from, kind: 'add' });
  }
  flush();
  hunks.sort((a, b) => a.pos - b.pos || (a.kind === 'del' ? -1 : 1));
  return hunks;
}

const liveDiffField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    let next = null;
    for (const effect of tr.effects) {
      if (effect.is(setLiveDiff)) next = liveDecorations(tr.state.doc, effect.value);
    }
    // A live replace both changes the doc and carries the effect. A later edit
    // has no effect, and that is what clears the red and green.
    if (next) return next;
    if (tr.docChanged) return Decoration.none;
    return deco.map(tr.changes);
  },
  provide: field => EditorView.decorations.from(field),
});

function firstLivePos(doc, changes) {
  let pos = null;
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || typeof change !== 'object') continue;
    let at = null;
    if (change.type === 'add' && Number.isInteger(change.next) && change.next >= 1 && change.next <= doc.lines) at = doc.line(change.next).from;
    else if (change.type === 'del') {
      if (change.at == null) at = doc.length;
      else if (Number.isInteger(change.at) && change.at >= 1 && change.at <= doc.lines) at = doc.line(change.at).from;
    }
    if (at != null && (pos == null || at < pos)) pos = at;
  }
  return pos;
}

function create(parent, { doc = '', onChange = null, onLive = null, filename = '' } = {}) {
  const language = new Compartment();
  const theme = new Compartment();
  const currentTheme = () => editorTheme(document.documentElement.dataset.scheme ? document.documentElement.dataset.scheme !== 'light' : document.documentElement.dataset.theme !== 'light');
  let applying = false;
  let liveChanges = [];
  let showDeletions = true;
  const updateListener = EditorView.updateListener.of((u) => {
    if (applying) return;
    if (!u.docChanged) return;
    if (liveChanges.length) {
      liveChanges = [];
      if (onLive) onLive(false);
    }
    if (onChange) onChange(u.state.doc.toString());
  });
  const state = EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      language.of([]),
      theme.of(currentTheme()),
      syntaxHighlighting(goldHighlight),
      liveDiffField,
      updateListener,
      keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap, ...searchKeymap, indentWithTab]),
    ],
  });
  const view = new EditorView({ state, parent });
  const refreshTheme = () => view.dispatch({ effects: theme.reconfigure(currentTheme()) });
  document.addEventListener('reach-theme-change', refreshTheme);
  let destroyed = false;
  const mode = /\.rsh$/i.test(filename) ? languages.find(l => l.name === 'JavaScript') : LanguageDescription.matchFilename(languages, filename);
  if (mode) mode.load().then(extension => {
    if (!destroyed) view.dispatch({ effects: language.reconfigure(extension) });
  }).catch(() => { /* Unknown/failed grammar leaves a functional plain-text editor. */ });
  return {
    view,
    getText: () => view.state.doc.toString(),
    setText: (text) => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    showChange: (text, changes) => {
      const next = String(text ?? '');
      const list = Array.isArray(changes) ? changes : [];
      liveChanges = list;
      showDeletions = true;
      const effects = [setLiveDiff.of({ changes: list, showDeletions: true })];
      applying = true;
      try {
        if (view.state.doc.toString() !== next) {
          // Keep this out of the undo stack so Ctrl+Z cannot put the stale
          // buffer back and let a later save overwrite the file on disk.
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: next },
            effects,
            annotations: Transaction.addToHistory.of(false),
          });
        } else {
          view.dispatch({ effects });
        }
        const pos = firstLivePos(view.state.doc, list);
        if (pos != null) view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
      } finally {
        applying = false;
      }
      if (onLive) onLive(list.length > 0);
    },
    clearLive: () => {
      if (!liveChanges.length) return;
      liveChanges = [];
      view.dispatch({ effects: setLiveDiff.of({ changes: [], showDeletions }) });
      if (onLive) onLive(false);
    },
    setDeletionsVisible: (on) => {
      showDeletions = !!on;
      if (!liveChanges.length) return;
      view.dispatch({ effects: setLiveDiff.of({ changes: liveChanges, showDeletions }) });
      if (onLive) onLive(true);
    },
    jumpLive: (direction) => {
      const hunks = liveHunks(view.state.doc, liveChanges, showDeletions);
      if (!hunks.length) return false;
      const head = view.state.selection.main.head;
      let index = direction < 0 ? hunks.length - 1 : 0;
      if (direction > 0) {
        const next = hunks.findIndex(hunk => hunk.pos > head);
        index = next < 0 ? 0 : next;
      } else {
        for (let i = hunks.length - 1; i >= 0; i--) {
          if (hunks[i].pos < head) { index = i; break; }
        }
      }
      const pos = hunks[index].pos;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'center' }),
      });
      view.focus();
      return true;
    },
    removedText: () => liveChanges.filter(change => change && change.type === 'del').map(change => String(change.text ?? '')).join('\n'),
    liveState: () => ({
      active: liveChanges.length > 0,
      hunks: liveHunks(view.state.doc, liveChanges, showDeletions).length,
      removed: liveChanges.filter(change => change && change.type === 'del').length,
      showDeletions,
    }),
    focus: () => view.focus(),
    destroy: () => { destroyed = true; document.removeEventListener('reach-theme-change', refreshTheme); view.destroy(); },
  };
}

/* One-shot syntax highlighting for read-only rendered code (the refactor
 * workbench's diff view). Reuses the same grammar set and the same colour
 * mapping as the live editor, so a diff and the file open in the editor agree on
 * colours instead of shipping a second highlighter.
 *
 * `tag -> css class` rather than inline styles: colours stay in CSS and follow
 * the active theme, which an inline style could not.
 *
 * Async because CodeMirror loads grammars lazily. Bounded: the caller passes one
 * diff side at a time, never a whole file, and anything over the cap is returned
 * escaped-but-unhighlighted rather than freezing the renderer.
 */
const HIGHLIGHT_MAX_CHARS = 200000;
const TAG_CLASS = [
  [tags.keyword, 'tok-keyword'],
  [tags.string, 'tok-string'],
  [tags.special(tags.string), 'tok-string'],
  [tags.number, 'tok-number'],
  [tags.bool, 'tok-number'],
  [tags.null, 'tok-number'],
  [tags.comment, 'tok-comment'],
  [tags.typeName, 'tok-type'],
  [tags.propertyName, 'tok-property'],
  [tags.function(tags.variableName), 'tok-fn'],
  [tags.operator, 'tok-op'],
  [tags.punctuation, 'tok-punct'],
  [tags.definition(tags.variableName), 'tok-def'],
];

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Escape text for HTML without highlighting. Always safe to call.
 */
function escape(text) { return escapeHtml(text); }

/**
 * Highlight `text` as `filename`'s language and return HTML.
 *
 * Returns escaped plain text when the language is unknown, the grammar has not
 * loaded yet, the text is too large, or parsing throws. Callers get a correct,
 * readable result in every case — highlighting is a nicety, never a
 * correctness dependency.
 *
 * Grammar loading is asynchronous in CodeMirror, so this is async too; the
 * resolved value is the final HTML.
 */
async function highlight(text, filename = '') {
  const src = String(text == null ? '' : text);
  if (!src) return '';
  if (src.length > HIGHLIGHT_MAX_CHARS) return escapeHtml(src);
  let mode = null;
  try {
    mode = /\.rsh$/i.test(filename)
      ? languages.find(l => l.name === 'JavaScript')
      : LanguageDescription.matchFilename(languages, filename || 'x.js');
    if (!mode) return escapeHtml(src);
    const support = await mode.load();
    const language = support && support.language;
    if (!language) return escapeHtml(src);

    // Walk the syntax tree once and collect non-overlapping spans. Nesting is
    // resolved by preferring the innermost tag, matching what the live editor
    // shows.
    const tree = language.parser.parse(src);
    const spans = [];
    highlightTree(tree, TAG_CLASS, (tag, from, to) => {
      if (to > from) spans.push({ from, to, tag });
    });
    if (!spans.length) return escapeHtml(src);
    spans.sort((a, b) => a.from - b.from || b.to - a.to);

    let html = '', cursor = 0;
    for (const s of spans) {
      if (s.from < cursor) continue;          // already inside a rendered span
      if (s.from > cursor) html += escapeHtml(src.slice(cursor, s.from));
      html += `<span class="${s.tag}">${escapeHtml(src.slice(s.from, s.to))}</span>`;
      cursor = s.to;
    }
    if (cursor < src.length) html += escapeHtml(src.slice(cursor));
    return html;
  } catch {
    // Any grammar or parse failure degrades to escaped text.
    return escapeHtml(src);
  }
}

window.ReachEditor = { create, highlight, escape };
