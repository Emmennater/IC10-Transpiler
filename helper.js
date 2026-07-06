import { parser } from "./parser.js";

export function showTree(text) {
  const tree = parser.parse(text);
  
  const getLineNum = pos => {
    const line = editor.state.doc.lineAt(pos);
    return line.number;
  };

  const getColumnNum = pos => {
    const line = editor.state.doc.lineAt(pos);
    return pos - line.from;
  };

  tree.iterate({
    enter(node) {
      const lineNum = getLineNum(node.from);
      const columnNum = getColumnNum(node.from);
      const str = text.substring(node.from, node.to).replace(/\n/g, "\\n\n");
      console.log(
        "  ".repeat(node.node.depth) +
        `${node.type.name}\n${str}`
      );
    }
  });
}

function nodeToJSON(cursor, text) {
  const result = {
    type: cursor.type.name,
    text: text.substring(cursor.from, cursor.to),
    children: []
  };

  if (cursor.firstChild()) {
    do {
      result.children.push(nodeToJSON(cursor, text));
    } while (cursor.nextSibling());
    cursor.parent();
  }

  return result;
}

export function getAST(text) {
  const tree = parser.parse(text);
  const ast = nodeToJSON(tree.cursor(), text);
  return ast;
}
