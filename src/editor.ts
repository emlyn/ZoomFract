import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import { EditorSelection, EditorState, RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  type Command,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { indentationMarkers } from '@replit/codemirror-indentation-markers';
import { parseSceneWithDiagnostics, SceneError, type SceneDiagnostic } from './scene';

const INDENT = '  ';
// Marks text replaced by the app, as opposed to edits made by the user.
const LOAD_EVENT = 'load';
const LINT_DELAY_MS = 300;

const highlightStyle = HighlightStyle.define([
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: '#93c5fd' },
  { tag: [tags.string, tags.special(tags.string)], color: '#fcd34d' },
  { tag: [tags.number, tags.bool, tags.null], color: '#f9a8d4' },
  { tag: tags.comment, color: '#71717a', fontStyle: 'italic' },
  { tag: [tags.punctuation, tags.separator, tags.squareBracket, tags.brace], color: '#a1a1aa' },
  { tag: [tags.keyword, tags.typeName, tags.labelName], color: '#c4b5fd' },
]);

const theme = EditorView.theme({
  '&': { color: '#f4f4f5', backgroundColor: 'transparent' },
  '.cm-content': { caretColor: '#f4f4f5', padding: '0.6rem 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#f4f4f5' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(147, 197, 253, 0.25)',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.04)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: '#71717a', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#d4d4d8' },
  '.cm-tooltip': {
    backgroundColor: '#27272a',
    color: '#f4f4f5',
    border: '1px solid rgba(212, 212, 216, 0.18)',
    borderRadius: '0.4rem',
  },
}, { dark: true });

// Tab indents: at a cursor it inserts spaces up to the next indent level,
// and with a selection it indents the selected lines. YAML forbids tabs.
const insertIndent: Command = (view) => {
  if (view.state.selection.ranges.some((range) => !range.empty)) {
    return indentMore(view);
  }
  view.dispatch(view.state.changeByRange((range) => {
    const column = range.head - view.state.doc.lineAt(range.head).from;
    const spaces = INDENT.length - (column % INDENT.length);
    return {
      changes: { from: range.head, insert: ' '.repeat(spaces) },
      range: EditorSelection.cursor(range.head + spaces),
    };
  }));
  return true;
};

// Wrapped lines continue past their indentation and any list dashes, plus one
// more indent level, so continuation rows never cross the indent guides.
const hangingIndent = (text: string): number => {
  const prefix = /^[ ]*(?:-[ ]+)*/.exec(text)?.[0].length ?? 0;
  return prefix + INDENT.length;
};

const hangingIndentDecorations = (view: EditorView): DecorationSet => {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let position = from; position <= to;) {
      const line = view.state.doc.lineAt(position);
      const width = hangingIndent(line.text);
      builder.add(line.from, line.from, Decoration.line({
        attributes: { style: `padding-left: calc(6px + ${width}ch); text-indent: -${width}ch` },
      }));
      position = line.to + 1;
    }
  }
  return builder.finish();
};

const hangingIndentPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) {
    this.decorations = hangingIndentDecorations(view);
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = hangingIndentDecorations(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });

// Marks stay on the line where the mistake starts, so they remain readable.
const toLintDiagnostic = (text: string) => (diagnostic: SceneDiagnostic): Diagnostic => {
  const from = Math.min(diagnostic.from, text.length);
  const lineEnd = text.indexOf('\n', from);
  const to = Math.min(Math.max(diagnostic.to, from), lineEnd === -1 ? text.length : lineEnd);
  return { from, to, severity: diagnostic.severity, message: diagnostic.message };
};

// Checks the definition as it is edited and marks mistakes where they occur.
const sceneLinter = linter((view) => {
  const text = view.state.doc.toString();
  const toLint = toLintDiagnostic(text);
  try {
    return parseSceneWithDiagnostics(text).warnings.map(toLint);
  } catch (error) {
    if (error instanceof SceneError) {
      return error.diagnostics.map(toLint);
    }
    throw error;
  }
}, { delay: LINT_DELAY_MS });

export type SceneEditor = {
  element: HTMLElement;
  text: () => string;
  setText: (text: string) => void;
};

export function createSceneEditor(text: string, onEdit: () => void): SceneEditor {
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        EditorView.lineWrapping,
        hangingIndentPlugin,
        indentUnit.of(INDENT),
        EditorState.tabSize.of(INDENT.length),
        keymap.of([
          { key: 'Tab', run: insertIndent, shift: indentLess },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        yaml(),
        syntaxHighlighting(highlightStyle),
        indentationMarkers({
          markerType: 'codeOnly',
          colors: { light: '#3f3f46', dark: '#3f3f46', activeLight: '#71717a', activeDark: '#71717a' },
        }),
        sceneLinter,
        lintGutter(),
        theme,
        EditorView.editorAttributes.of({ class: 'scene-input' }),
        EditorView.updateListener.of((update) => {
          if (update.transactions.some((transaction) => transaction.docChanged && !transaction.isUserEvent(LOAD_EVENT))) {
            onEdit();
          }
        }),
      ],
    }),
  });

  return {
    element: view.dom,
    text: () => view.state.doc.toString(),
    setText: (next) => {
      if (next !== view.state.doc.toString()) {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, userEvent: LOAD_EVENT });
      }
    },
  };
}
