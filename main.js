
import {
  EditorView, keymap, lineNumbers, drawSelection, highlightActiveLineGutter,
  highlightActiveLine
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { javascript } from "@codemirror/lang-javascript";
import { acceptCompletion } from "@codemirror/autocomplete";
import { insertTab, indentLess, indentMore, history, historyKeymap, toggleComment } from "@codemirror/commands";
import { LRLanguage, HighlightStyle, syntaxHighlighting, indentUnit } from "@codemirror/language";
import { styleTags, tags as t, Tag } from "@lezer/highlight";
import { parser } from "./parser.js";
import { transpile } from "./transpiler.js";
import { runTests } from "./tests.js";
import { getAST } from "./helper.js";
import { setup, save, notSaved } from "./save-load.js";

const starterCode = "";

let ignoreSave = false;

const device = Tag.define();
const register = Tag.define();

const myCustomTheme = EditorView.theme({
  // The main editor container
  "&": {
    color: "#e0e0e0",
    backgroundColor: "#282C34",
    width: "100%",
    height: "100%",
    padding: "0px",
    fontSize: "24px",
  },
  // The main editor area
  ".cm-content, .cm-gutter": {
    minHeight: "200px",
    padding: "0px",
    paddingBottom: "var(--scroll-padding)",
  },
  // The background area containing line numbers
  ".cm-gutters": {
    backgroundColor: "#282C34",
    color: "#858585",
    border: "none",
    padding: "0px",
    borderRight: "2px solid #535964",
    userSelect: "none",
  },
  // Line number gutter
  "& .cm-gutterElement": {
    display: "flex",
    width: "60px",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box"
  },
  // Active line
  "& .cm-activeLine": {
    backgroundColor: "#ffffff11"
  },

  "& .cm-activeLineGutter": {
    color: "#b7b7b7",
    backgroundColor: "#363b45"
  },
  // Hide active line
  "&.cm-hide-active-line .cm-activeLine": {
    backgroundColor: "transparent"
  },

  "&.cm-hide-active-line .cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "inherit"
  },
  // Caret color
  "&.cm-focused .cm-cursor": {
    borderLeft: "2px solid #959fb0"
  },
  // Selection color (focused)
  "&.cm-focused .cm-scroller > .cm-selectionLayer > .cm-selectionBackground": {
    backgroundColor: "#ffffff22"
  },
  // Selection color (unfocused)
  "& .cm-scroller > .cm-selectionLayer > .cm-selectionBackground": {
    backgroundColor: "#ffffff22"
  },
  // Scrollbar
  ".cm-scroller::-webkit-scrollbar": {
    width: "16px",
    height: "16px"
  },
  ".cm-scroller::-webkit-scrollbar-thumb": {
    backgroundColor: "#ffffff22",
  },
}, { dark: true });

const myHighlightStyle = HighlightStyle.define([
  { tag: device, color: '#75e6d7' },
  { tag: register, color: '#75e6d7' },
  { tag: t.keyword, color: "#ff7b72" },
  { tag: t.comment, color: "#8b949e" },
  { tag: [t.string, t.special(t.string)], color: "#a5d6ff" },
  { tag: [t.number, t.bool], color: "#ffa657" },
  { tag: [t.variableName], color: "#79c0ff" },
  { tag: [t.function(t.variableName), t.labelName], color: "#d2a8ff" },
  { tag: t.operator, color: "#7d91a8" },
]);

const myCustomThemeExtension = [
  myCustomTheme,
  syntaxHighlighting(myHighlightStyle)
];

const lang = LRLanguage.define({
  parser: parser.configure({
    props: [
      styleTags({
        Number: t.number,
        "AddOp MulOp CompareOp LogicAnd LogicOr ParenLeft ParenRight Assign Dot Colon Comma": t.operator,
        "InstructionName FunctionName": t.function(t.variableName),
        "if then elif else end let while do loop break continue device define": t.keyword,
        String: t.string,
        Device: device,
        Register: register,
        Bool: t.bool,
        LabelName: t.labelName,
        Comment: t.comment,
        VariableName: t.variableName
      })
    ]
  }),
  languageData: {
    commentTokens: { line: "#" },
  }
});

const keymapExtensions = [
  history(),
  indentUnit.of("  "),
  keymap.of([
    ...historyKeymap,
    {
      key: "Tab",
      run(view) {
        if (acceptCompletion(view))
          return true;

        let { state, dispatch } = view;

        // keep normal multi-line/selection indent behavior
        if (state.selection.ranges.some(r => !r.empty)) {
          return indentMore({ state, dispatch })
        }

        let { from, to } = state.selection.main;
        let column = from - state.doc.lineAt(from).from;

        if (column % 2 == 0) {
          dispatch(state.replaceSelection("  "));
        } else {
          dispatch(state.replaceSelection(" "));
        }

        return true;
      }
    },
    {
      key: "Shift-Tab",
      run: indentLess
    },
    {
      key: "Enter",
      run(view) {
        const { state } = view;
        const { from } = state.selection.main;

        const line = state.doc.lineAt(from);
        const beforeCursor = line.text.slice(0, from - line.from);

        // Copy the current line's indentation
        let indent = (line.text.match(/^\s*/) ?? [""])[0];

        // If the line ends with "then", "do", or "else", indent one more level
        if (/\b(?:then|do|else)\s*$/.test(beforeCursor)) {
          indent += "  ";
        }

        view.dispatch({
          changes: {
            from,
            to: from,
            insert: "\n" + indent
          },
          selection: {
            anchor: from + 1 + indent.length
          },
          scrollIntoView: true
        });

        return true;
      }
    },
    {
      key: "Backspace",
      run(view) {
        const { state } = view;
        const { from, to, empty } = state.selection.main;

        // Let the default behavior handle selections
        if (!empty) return false;

        // If on an odd column only delete one
        let column = from - state.doc.lineAt(from).from;
        if (column % 2 === 1) return false;

        if (from >= 2 && state.doc.sliceString(from - 2, from) === "  ") {
          view.dispatch({
            changes: {
              from: from - 2,
              to: from
            }
          });
          return true;
        }

        return false;
      }
    },
    {
      key: "Mod-/",
      run: toggleComment
    }
  ]),
  EditorView.updateListener.of(update => {
    // Only act when the selection actually changed in this update.
    // This also skips viewport-only updates (e.g. manual scrolling),
    // which otherwise have an empty transactions array and slip past
    // the filters below.
    if (!update.selectionSet) return;

    // Ignore cursor movements made with the mouse
    if (update.transactions.some(tr => tr.isUserEvent("select.pointer"))) {
      return;
    }

    // Ignore scroll-triggered transactions
    if (update.transactions.some(tr => tr.isUserEvent("scroll"))) {
      return;
    }

    const view = update.view;
    const margin = 3 * view.defaultLineHeight;

    const pos = update.state.selection.main.head;
    const coords = view.coordsAtPos(pos);
    if (!coords) return;

    const scroller = view.scrollDOM;
    const rect = scroller.getBoundingClientRect();

    if (coords.top < rect.top + margin) {
      scroller.scrollTop -= (rect.top + margin) - coords.top;
    }

    if (coords.bottom > rect.bottom - margin) {
      scroller.scrollTop += coords.bottom - (rect.bottom - margin);
    }
  }),
  EditorView.updateListener.of(update => {
    const view = update.view;

    const hasSelection = !view.state.selection.main.empty;
    const isFocused = view.hasFocus;

    const hideActiveLine = hasSelection || !isFocused;

    view.dom.classList.toggle("cm-hide-active-line", hideActiveLine);
  })
];

const autosaveExtensions = [
  history(),
  keymap.of([
    {
      key: "Mod-s",
      run: () => {
        const text = editor.state.doc.toString();
        save(text, false);
        return true;
      }
    }
  ]),
  EditorView.updateListener.of((update) => {
    // Only trigger if the actual text content changed
    if (update.docChanged && !ignoreSave) {
      const text = editor.state.doc.toString();
      notSaved();
      save(text);
      return false;
    }
  })
];

const myCustomExtensions = [
  myCustomThemeExtension,
  lang,
  lineNumbers(),
  drawSelection(),
  highlightActiveLineGutter(),
  highlightActiveLine(),
];

const nonEditable = [
  EditorState.readOnly.of(true),
  EditorView.contentAttributes.of({tabindex: "0"})
];

const editor = new EditorView({
  parent: document.getElementById("editor-container"),
  doc: starterCode,
  extensions: [...myCustomExtensions, ...keymapExtensions, ...autosaveExtensions]
});

const output = new EditorView({
  parent: document.getElementById("output-container"),
  doc: "",
  extensions: [...nonEditable, ...myCustomExtensions]
});

function initListeners() {
  // Editor scrolling
  const scrollerEditor = editor.scrollDOM;

  const resizeEditor = new ResizeObserver(() => {
    scrollerEditor.style.setProperty(
      "--scroll-padding",
      `${scrollerEditor.clientHeight - editor.defaultLineHeight}px`
    );
  });

  resizeEditor.observe(scrollerEditor);

  // Output scrolling
  const scrollerOutput = output.scrollDOM;

  const resizeOutput = new ResizeObserver(() => {
    scrollerOutput.style.setProperty(
      "--scroll-padding",
      `${scrollerOutput.clientHeight - output.defaultLineHeight}px`
    );
  });

  resizeOutput.observe(scrollerOutput);

  document.getElementById("run").addEventListener("mousedown", run);

  document.getElementById("copy").addEventListener("mousedown", () => {
    const text = output.state.doc.toString();
    navigator.clipboard.writeText(text);
  });
}

function getScript() {
  return editor.state.doc.toString();
}

function loadScript(text) {
  ignoreSave = true;
  editor.dispatch({
    changes: {
      from: 0,
      to: editor.state.doc.length,
      insert: text
    }
  });
  setTimeout(() => ignoreSave = false, 100);
}

function run() {
  const text = getScript();
  const ast = getAST(text);
  const ic10 = transpile(ast);
  
  output.dispatch({
    changes: {
      from: 0,
      to: output.state.doc.length,
      insert: ic10
    }
  });
}

initListeners();
setup(loadScript, getScript, run);
runTests(parser);
run();
