/* Reach Studio — CodeMirror 6 editor bundle entry.
 * Bundled by esbuild to renderer/editor.bundle.js. Exposes a tiny global API:
 *   ReachEditor.create(parent, {doc, onChange}) -> editor instance
 *   .setText(text) / .getText() / .destroy()
 */
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
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

function create(parent, { doc = '', onChange = null, filename = '' } = {}) {
  const language = new Compartment();
  const theme = new Compartment();
  const currentTheme = () => editorTheme(document.documentElement.dataset.theme !== 'light');
  const updateListener = EditorView.updateListener.of((u) => {
    if (u.docChanged && onChange) onChange(u.state.doc.toString());
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
