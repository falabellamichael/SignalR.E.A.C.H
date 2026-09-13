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

const goldTheme = EditorView.theme({
  '&': { backgroundColor: '#0a0a0a', color: '#e6e0cc', height: '100%', fontSize: '13px' },
  '.cm-content': { fontFamily: "Consolas, 'Courier New', monospace", caretColor: '#d4af37', padding: '10px 0' },
  '.cm-cursor': { borderLeftColor: '#d4af37' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: '#2a2416 !important' },
  '.cm-activeLine': { backgroundColor: '#111008' },
  '.cm-activeLineGutter': { backgroundColor: '#111008', color: '#d4af37' },
  '.cm-gutters': { backgroundColor: '#0a0a0a', color: '#4a4536', border: 'none', borderRight: '1px solid #262626' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-matchingBracket': { backgroundColor: '#2a2416', outline: '1px solid #8a7430' },
  '.cm-selectionMatch': { backgroundColor: '#241f10' },
}, { dark: true });

const goldHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#d4af37' },
  { tag: [tags.string, tags.special(tags.string)], color: '#a8c187' },
  { tag: [tags.number, tags.bool, tags.null], color: '#d19a66' },
  { tag: tags.comment, color: '#5c5646', fontStyle: 'italic' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#e6c07b' },
  { tag: tags.typeName, color: '#c678dd' },
  { tag: tags.operator, color: '#8a8578' },
  { tag: tags.punctuation, color: '#6b6555' },
  { tag: tags.propertyName, color: '#e06c75' },
  { tag: tags.definition(tags.variableName), color: '#e6e0cc' },
]);

function create(parent, { doc = '', onChange = null, filename = '' } = {}) {
  const language = new Compartment();
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
      goldTheme,
      syntaxHighlighting(goldHighlight),
      updateListener,
      keymap.of([...defaultKeymap, ...historyKeymap, ...closeBracketsKeymap, ...searchKeymap, indentWithTab]),
    ],
  });
  const view = new EditorView({ state, parent });
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
    destroy: () => { destroyed = true; view.destroy(); },
  };
}

window.ReachEditor = { create };
