// Compiler regression tests: node test.mjs
import { getAST } from "./ast.js";
import { compile, CompileError } from "./compiler.ts";

// The default register pool is whatever VAR_REGISTER_ORDER is set to in
// compiler.ts (currently r0-r2). Cases that exercise the full register file
// pass FULL_ORDER explicitly.
const FULL_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const REDUCED_ORDER = [0, 1, 2]; // For testing register pressure

const cases = [
  {
    name: "dead code is pruned, placeholders accessed via move",
    source: "let x = a + 1\nlet y = b * 2\nc = y - 4",
    expected: "move r0 b\nmul r0 r0 2\nsub r0 r0 4\nmove c r0",
  },
  {
    name: "registers are reused after a value's last use",
    source: "let x = a - b\nlet y = x * 2\nc = y",
    expected: "move r0 a\nmove r1 b\nsub r0 r0 r1\nmul r0 r0 2\nmove c r0",
  },
  {
    name: "constants fold through variables",
    source: "let x = 5\nlet y = x * 2\nc = y",
    expected: "move c 10",
  },
  {
    name: "fully dead programs produce no code",
    source: "let x = a + 1",
    expected: "",
  },
  {
    name: "placeholders never appear as ALU operands",
    source: "c = a + b",
    expected: "move r0 a\nmove r1 b\nadd r0 r0 r1\nmove c r0",
  },
  {
    name: "constants propagate through reassignment",
    source: "let x = 5\nx = x + 1\nc = x",
    expected: "move c 6",
  },
  {
    name: "copies are free and identities fold away",
    source: "let x = a\nlet y = x\nc = y * 1",
    expected: "move r0 a\nmove c r0",
  },
  {
    name: "placeholder loads are shared within a statement",
    source: "c = a * a",
    expected: "move r0 a\nmul r0 r0 r0\nmove c r0",
  },
  {
    name: "placeholder loads are not shared across statements",
    source: "c = a\nd = a",
    expected: "move r0 a\nmove c r0\nmove r0 a\nmove d r0",
  },
  {
    name: "unary minus of a placeholder",
    source: "c = -a",
    expected: "move r0 a\nsub r0 0 r0\nmove c r0",
  },
  {
    name: "non-finite folds are left to the game",
    source: "c = 1 / 0",
    expected: "div r0 1 0\nmove c r0",
  },
  {
    name: "comments are dropped",
    source: "# header\nc = 1 # trailing",
    expected: "move c 1",
  },
  {
    // Four values are live at once but only three registers exist, so the
    // two longest-blocking values (u and w) spill to fixed stack addresses.
    name: "register pressure spills the least useful values",
    source: [
      "let b1 = p",
      "let b2 = q",
      "let b3 = u",
      "let b4 = w",
      "c = b1 + b2",
      "c = b3 + b4",
    ].join("\n"),
    expected: [
      "move r0 p",
      "move r1 q",
      "move r2 u",
      "poke 510 r2",
      "move r2 w",
      "poke 511 r2",
      "add r0 r0 r1",
      "move c r0",
      "get r0 db 511",
      "get r1 db 510",
      "add r0 r1 r0",
      "move c r0",
    ].join("\n"),
  },
  {
    name: "full register file starts at r0",
    order: FULL_ORDER,
    source: "let x = a + b\nlet y = x * 2\nc = y - x",
    expected: [
      "move r0 a",
      "move r1 b",
      "add r0 r0 r1",
      "mul r1 r0 2",
      "sub r0 r1 r0",
      "move c r0",
    ].join("\n"),
  },
  {
    name: "redeclaration is an error",
    source: "let x = 1\nlet x = 2",
    error: "Line 1: x was already defined",
  },
  {
    name: "reading an unassigned variable is an error",
    source: "let x\nc = x",
    error: "Line 1: x is used before being assigned",
  },
  {
    name: "syntax errors are reported",
    source: "let = 3",
    error: "Line 0: Syntax error",
  },
  {
    name: "if elif else statements",
    source: [
      "let x = a",
      "if x > 1 then",
      "  b = 1",
      "elif x < -1 then",
      "  b = 2",
      "else",
      "  b = 3",
      "end",
    ].join("\n"),
    expected: [ // Labels like endif0 can be optionally removed in a final pass
      "move r0 a",
      "ble r0 1 if0elif0", // ble: branch if less than
      "move b 1",
      "j endif0",
      "if0elif0:",
      "bge r0 -1 else0", // bge: branch if greater than or equal (negation of x < -1)
      "move b 2",
      "j endif0",
      "else0:",
      "move b 3",
      "endif0:",
    ].join("\n"),
  },
  {
    name: "using placeholders in if conditions",
    source: [
      "if a > 0 then",
      "  b = 1",
      "end",
    ].join("\n"),
    expected: [
      "move r0 a",
      "blez r0 endif0", // blez: branch if less than or equal to zero
      "move b 1",
      "endif0:",
    ].join("\n"),
  },
  {
    name: "total dead code elimination for if statements",
    source: [
      "let x = a + b",
      "let y",
      "if x > 2 then",
      "  y = 2",
      "end",
    ].join("\n"),
    expected: "", // No side effects
  },
  {
    name: "partial dead code elimination for if statements",
    source: [
      "let x = a + b",
      "let y",
      "if x > 2 then",
      "  y = 2",
      "else",
      "  x = -x",
      "end",
      "c = x",
    ].join("\n"),
    expected: [
      "move r0 a",
      "move r1 b",
      "add r0 r0 r1",
      "bgt r0 2 endif0", // Only the else branch is kept
      "sub r0 0 r0", // Canonical unary minus
      "endif0:",
      "move c r0", // x is used to update c
    ].join("\n"),
  },
  {
    name: "always true if statements",
    source: [
      "if true then",
      "  a = 2", // Always executed
      "end",
    ].join("\n"),
    expected: "move a 2",
  },
  {
    name: "always false if statements",
    source: [
      "let x",
      "if 1 - 1 then",
      "  x = 2", // Never executed
      "else",
      "  x = 1", // Always executed
      "end",
      "a = x" // x is used to update a
    ].join("\n"),
    expected: "move a 1",
  },
  {
    name: "potential undefined behavior with if statements",
    source: [
      "let x",
      "if a then",
      "  x = 1",
      "else",
      "  b = 2",
      "end",
      "a = x",
    ].join("\n"),
    error: "Line 6: x may be undefined",
  },
  {
    name: "potential undefined behavior with if statements cleared by dead code elimination",
    source: [
      "let x",
      "if a then",
      "  x = 1",
      "else",
      "  b = 2",
      "end",
      "x = 3", // if statement is no longer a dependency
      "a = x",
    ].join("\n"),
    expected: [
      "move r0 a",
      "bnez r0 endif0",
      "move b 2", // else branch is kept to update b
      "endif0:",
      "move a 3",
    ].join("\n"),
  },
  {
    "name": "if statement variables going out of scope",
    source: [
      "if true then",
      "  let x = 1",
      "end",
      "a = x",
    ].join("\n"),
    expected: [
      "move r0 x", // x is treated as a placeholder
      "move a r0",
    ].join("\n"),
  },
  {
    "name": "changing variables in if statement scope",
    source: [
      "let x = 1",
      "if a < 0 then",
      "  x = 2",
      "end",
      "b = x", // Order of when a/b are read/assigned is important and must be preserved
    ].join("\n"),
    expected: [
      "move r0 1",
      "move r1 a",
      "bgez r1 endif0",
      "move r0 2",
      "endif0:",
      "move b r0",
    ].join("\n"),
  },
  {
    "name": "nested if statements",
    source: [
      "if a == 1 then",
      "  if b > 2 then",
      "    c = -1",
      "  else",
      "    c = d",
      "  end",
      "end",
    ].join("\n"),
    expected: [
      "move r0 a",
      "bne r0 1 endif0",
      "move r0 b", // a is no longer used so r0 is free
      "ble r0 2 else1",
      "move c -1",
      "j endif1",
      "else1:",
      "move r0 d", // b is no longer used so r0 is free
      "move c r0",
      "endif1:",
      "endif0:",
    ].join("\n"),
  },
  {
    // Most recent read value for a placeholder must be used.
    name: "can't reuse loaded placeholders",
    source: [
      "let x = b",
      "a = b",
      "c = x",
    ].join("\n"),
    expected: [
      "move r0 b",
      "move r1 b", // b cannot reuse the value of r0
      "move a r1",
      "move c r0", // x can be used since the value was already loaded
    ].join("\n"),
  }
];

let failures = 0;

for (const { name, source, expected, error, order } of cases) {
  let actual;
  try {
    actual = compile(getAST(source), order ?? REDUCED_ORDER);
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    actual = e;
  }

  const ok = actual instanceof CompileError
    ? actual.message === error
    : actual === expected;

  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}`);
    console.log(`  expected: ${JSON.stringify(error ?? expected)}`);
    console.log(`  actual:   ${JSON.stringify(actual instanceof CompileError ? actual.message : actual)}`);
  }
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures > 0 ? 1 : 0);
