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
import { tags } from '@lezer/highlight';
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

window.ReachEditor = { create };
