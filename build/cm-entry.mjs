// Entry bundled by esbuild into public/vendor/codemirror.js (window.CM6 + window.YCOLLAB).
// Rebuild:  npm run build:client        (see build/build-client.mjs)
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, keymap, Decoration, WidgetType, ViewPlugin } from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSet, RangeSetBuilder, Transaction } from "@codemirror/state";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { StreamLanguage, syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching, indentOnInput } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, snippetCompletion } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { tags } from "@lezer/highlight";

// Real-time collaboration (M0 spike): Yjs + Hocuspocus provider + the CodeMirror
// binding. Bundled HERE, in the same file as CM6, on purpose: y-codemirror.next
// must share the exact same @codemirror/state instance as the editor, otherwise
// CodeMirror's facet system sees two copies and the binding breaks.
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
// Local copy of the doc in the browser's IndexedDB. The CRDT already merges work written
// while the socket is down, but until now that work lived only in the tab's memory — so
// reloading while offline (the reflex when something looks stuck) threw it away.
import { IndexeddbPersistence } from "y-indexeddb";

window.CM6 = {
  view: { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, keymap, Decoration, WidgetType, ViewPlugin },
  state: { EditorState, StateField, StateEffect, RangeSet, RangeSetBuilder, Transaction },
  commands: { history, historyKeymap, defaultKeymap, indentWithTab },
  language: { StreamLanguage, syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching, indentOnInput },
  legacy: { stex },
  autocomplete: { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, snippetCompletion },
  search: { highlightSelectionMatches, searchKeymap },
  tags,
};

window.YCOLLAB = { Y, HocuspocusProvider, yCollab, yUndoManagerKeymap, IndexeddbPersistence };
