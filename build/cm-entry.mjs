// Entry bundled by esbuild into public/vendor/codemirror.js (window.CM6).
// Rebuild:  npx esbuild build/cm-entry.mjs --bundle --format=iife \
//             --outfile=public/vendor/codemirror.js --minify
import { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { history, historyKeymap, defaultKeymap, indentWithTab } from "@codemirror/commands";
import { StreamLanguage, syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching, indentOnInput } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, snippetCompletion } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { tags } from "@lezer/highlight";

window.CM6 = {
  view: { EditorView, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, keymap },
  state: { EditorState },
  commands: { history, historyKeymap, defaultKeymap, indentWithTab },
  language: { StreamLanguage, syntaxHighlighting, defaultHighlightStyle, HighlightStyle, bracketMatching, indentOnInput },
  legacy: { stex },
  autocomplete: { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, snippetCompletion },
  search: { highlightSelectionMatches, searchKeymap },
  tags,
};
