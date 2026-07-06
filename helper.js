import { parser } from "./parser.js";

function nodeToJSON(cursor, text) {
  const result = {
    type: cursor.type.name,
    text: text.substring(cursor.from, cursor.to),
    from: cursor.from,
    to: cursor.to,
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
