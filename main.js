
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { acceptCompletion } from "@codemirror/autocomplete";
import { insertTab, indentLess, indentMore, history, historyKeymap, toggleComment } from "@codemirror/commands";
import { parser } from "./parser.js";
import { LRLanguage, HighlightStyle, syntaxHighlighting, indentUnit } from "@codemirror/language";
import { styleTags, tags as t, Tag } from "@lezer/highlight";

const starterCode = `
let machine = d0
let stacker = d1

machine.ClearMemory = 1

while true do
  yield
  if machine.ExportCount == stacker.Setting then
    machine.Activate = 0
    machine.ClearMemory = 1
  elseif machine.Activate == 0 then
    machine.ClearMemory = 1
  end
end
`.substring(1);

const device = Tag.define();
const register = Tag.define();

const myCustomTheme = EditorView.theme({
  // The main editor container
  "&": {
    color: "#e0e0e0",
    backgroundColor: "#282C34",
    width: "100%",
    height: "100%"
  },
  // The background area containing line numbers
  ".cm-gutters": {
    backgroundColor: "#282C34",
    color: "#858585",
    border: "none",
    paddingRight: "14px",
    borderRight: "2px solid #535964"
  },
  // Style for the text selection
  ".cm-content, .cm-gutter": {
    minHeight: "200px"
  },
  "&.cm-focused": {
    outline: "none"
  },
  // Style for the flashing cursor
  ".cm-cursor, & .cm-dropCursor": {
    borderLeftColor: "#ffffff"
  }
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
        "AddOp MulOp CompareOp LogicAnd LogicOr ParenLeft ParenRight Assign Dot Colon": t.operator,
        "InstructionName FunctionName": t.function(t.variableName),
        "if then elseif else end let while do": t.keyword,
        String: t.string,
        Device: device,
        Register: register,
        Bool: t.bool,
        LabelName: t.labelName,
        Comment: t.comment,
      })
    ]
  }),
  languageData: {
    commentTokens: { line: "#" },
  }
});

const editor = new EditorView({
  parent: document.getElementById("editor-container"),
  doc: starterCode,
  extensions: [
    myCustomThemeExtension,
    lang,
    lineNumbers(),
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

          // If the line ends with "then" or "do", indent one more level
          if (/\b(?:then|do|else)\s*$/.test(beforeCursor)) {
            indent += "  ";
          }

          view.dispatch(state.replaceSelection("\n" + indent));
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
    ])
  ]
});

function nodeToJSON(cursor) {
  const result = {
    type: cursor.type.name,
    // from: cursor.from,
    // to: cursor.to,
    children: []
  };

  if (cursor.firstChild()) {
    do {
      result.children.push(nodeToJSON(cursor));
    } while (cursor.nextSibling());
    cursor.parent();
  }

  return result;
}

function showTree() {
  const text = editor.state.doc.toString();
  const tree = parser.parse(text);

  const getLineNum = pos => {
    const line = editor.state.doc.lineAt(pos);
    return line.number;
  };

  const getColumnNum = pos => {
    const line = editor.state.doc.lineAt(pos);
    return pos - line.from;
  };

  // tree.iterate({
  //   enter(node) {
  //     const lineNum = getLineNum(node.from);
  //     const columnNum = getColumnNum(node.from);
  //     const str = text.substring(node.from, node.to).replace(/\n/g, "\\n\n");
  //     console.log(
  //       "  ".repeat(node.node.depth) +
  //       `${node.type.name}\n${str}`
  //     );
  //   }
  // });

  const json = nodeToJSON(tree.cursor());
  console.log(json);
}

document.getElementById("run").addEventListener("click", showTree);
