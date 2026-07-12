// Compiler regression tests: node test.mjs
import { getAST } from "./ast.js";
import { compile, CompileError } from "./compiler.ts";

// The default register pool is whatever VAR_REGISTER_ORDER is set to in
// compiler.ts (currently r0-r2). Cases that exercise the full register file
// pass FULL_ORDER explicitly.
const FULL_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const REDUCED_ORDER = [0, 1, 2]; // For testing register pressure

const cases = {
  // Miscellaneous
  "fully dead programs produce no code": {
    source: "let x = a + 1",
    expected: "",
  },
  "constants propagate through reassignment": {
    source: "let x = 5\nx = x + 1\nc = x",
    expected: "move c 6",
  },
  "comments are dropped": {
    source: "# header\nc = 1 # trailing",
    expected: "move c 1",
  },
  "redeclaration is an error": {
    source: "let x = 1\nlet x = 2",
    error: "Line 1: x was already defined",
  },
  "reading an unassigned variable is an error": {
    source: "let x\nc = x",
    error: "Line 1: x is used before being assigned",
  },
  "syntax errors are reported": {
    source: "let = 3",
    error: "Line 0: Syntax error",
  },
  // Register allocation
  "registers are reused after a value's last use": {
    source: "let x = a - b\nlet y = x * 2\nc = y",
    expected: "move r0 a\nmove r1 b\nsub r0 r0 r1\nmul r0 r0 2\nmove c r0",
  },
  "register pressure spills the least useful values":{
    // Four values are live at once but only three registers exist, so the
    // two longest-blocking values (u and w) spill to fixed stack addresses.
    source: [
      "let b1 = p",
      "let b2 = q",
      "let b3 = u",
      "let b4 = w",
      "c = b1 + b2",
      "c = b3 + b4",
    ],
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
    ],
  },
  "full register file starts at r0": {
    order: FULL_ORDER,
    source: "let x = a + b\nlet y = x * 2\nc = y - x",
    expected: [
      "move r0 a",
      "move r1 b",
      "add r0 r0 r1",
      "mul r1 r0 2",
      "sub r0 r1 r0",
      "move c r0",
    ],
  },
  // Folding
  "constants fold through variables": {
    source: "let x = 5\nlet y = x * 2\nc = y",
    expected: "move c 10",
  },
  "copies are free and identities fold away": {
    source: "let x = a\nlet y = x\nc = y * 1",
    expected: "move r0 a\nmove c r0",
  },
  "non-finite folds are left to the game": {
    source: "c = 1 / 0",
    expected: "div r0 1 0\nmove c r0",
  },
  // Placeholders
  "dead code is pruned, placeholders accessed via move": {
    source: "let x = a + 1\nlet y = b * 2\nc = y - 4",
    expected: "move r0 b\nmul r0 r0 2\nsub r0 r0 4\nmove c r0",
  },
  "placeholders never appear as ALU operands": {
    source: "c = a + b",
    expected: "move r0 a\nmove r1 b\nadd r0 r0 r1\nmove c r0",
  },
  "placeholder loads are shared within a statement": {
    source: "c = a * a",
    expected: "move r0 a\nmul r0 r0 r0\nmove c r0",
  },
  "placeholder loads are not shared across statements": {
    source: "c = a\nd = a",
    expected: "move r0 a\nmove c r0\nmove r0 a\nmove d r0",
  },
  "unary minus of placeholder": {
    source: "c = -a",
    expected: "move r0 a\nsub r0 0 r0\nmove c r0",
  },
  "can't reuse loaded placeholders": {
    // Most recent read value for a placeholder must be used.
    source: [
      "let x = b",
      "a = b",
      "c = x",
    ],
    expected: [
      "move r0 b",
      "move r1 b", // b cannot reuse the value of r0
      "move a r1",
      "move c r0", // x can be used since the value was already loaded
    ],
  },
  // If statements
  "if elif else statements": {
    source: [
      "let x = a",
      "if x > 1 then",
      "  b = 1",
      "elif x < -1 then",
      "  b = 2",
      "else",
      "  b = 3",
      "end",
    ],
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
    ],
  },
  "using placeholders in if statements": {
    source: [
      "if a > 0 then",
      "  b = 1",
      "end",
    ],
    expected: [
      "move r0 a",
      "blez r0 endif0", // blez: branch if less than or equal to zero
      "move b 1",
      "endif0:",
    ],
  },
  "total dead code elimination for if statements": {
    source: [
      "let x = a + b",
      "let y",
      "if x > 2 then",
      "  y = 2",
      "end",
    ],
    expected: "", // No side effects
  },
  "partial dead code elimination for if statements": {
    source: [
      "let x = a + b",
      "let y",
      "if x > 2 then",
      "  y = 2",
      "else",
      "  x = -x",
      "end",
      "c = x",
    ],
    expected: [
      "move r0 a",
      "move r1 b",
      "add r0 r0 r1",
      "bgt r0 2 endif0", // Only the else branch is kept
      "sub r0 0 r0", // Canonical unary minus
      "endif0:",
      "move c r0", // x is used to update c
    ],
  },
  "always true if statements": {
    source: [
      "if true then",
      "  a = 2", // Always executed
      "end",
    ],
    expected: "move a 2",
  },
  "always false if statements": {
    source: [
      "let x",
      "if 1 - 1 then",
      "  x = 2", // Never executed
      "else",
      "  x = 1", // Always executed
      "end",
      "a = x" // x is used to update a
    ],
    expected: "move a 1",
  },
  "potential undefined behavior with if statements": {
    source: [
      "let x",
      "if a then",
      "  x = 1",
      "else",
      "  b = 2",
      "end",
      "a = x",
    ],
    error: "Line 6: x may be undefined",
  },
  "potential undefined behavior with if statements cleared by dead code elimination": {
    source: [
      "let x",
      "if a then",
      "  x = 1",
      "else",
      "  b = 2",
      "end",
      "x = 3", // if statement is no longer a dependency
      "a = x",
    ],
    expected: [
      "move r0 a",
      "bnez r0 endif0",
      "move b 2", // else branch is kept to update b
      "endif0:",
      "move a 3",
    ],
  },
  "if statement variables going out of scope": {
    source: [
      "if true then",
      "  let x = 1",
      "end",
      "a = x",
    ],
    expected: [
      "move r0 x", // x is treated as a placeholder
      "move a r0",
    ],
  },
  "changing variables in if statement scope": {
    source: [
      "let x = 1",
      "if a < 0 then",
      "  x = 2",
      "end",
      "b = x", // Order of when a/b are read/assigned is important and must be preserved
    ],
    expected: [
      "move r0 1",
      "move r1 a",
      "bgez r1 endif0",
      "move r0 2",
      "endif0:",
      "move b r0",
    ],
  },
  "nested if statements": {
    source: [
      "if a == 1 then",
      "  if b > 2 then",
      "    c = -1",
      "  else",
      "    c = d",
      "  end",
      "end",
    ],
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
    ],
  },
  // Loops
  "basic loops and yields": {
    source: [
      "loop", // Start of loop
      "  yield", // Instruction used in ic10 to pause for one tick
      "  a = b",
      "end", // End of loop
    ],
    expected: [
      "loop0:",
      "yield",
      "move r0 b",
      "move a r0",
      "j loop0"
    ]
  },
  "basic loops and sleeps": {
    source: [
      "loop", // Start of loop
      "  sleep 1", // Instruction used in ic10 to sleep for one second
      "  a = b",
      "end", // End of loop
    ],
    expected: [
      "loop0:",
      "sleep 1",
      "move r0 b",
      "move a r0",
      "j loop0"
    ]
  },
  "loops incrementing a single variable": {
    source: [
      "let x = 0",
      "loop",
      "  a = x",
      "  x = x + 1",
      "end",
    ],
    expected: [
      "move r0 0",
      "loop0:",
      "move a r0",
      "add r0 r0 1",
      "j loop0"
    ]
  },
  "if statements in loops": {
    source: [
      "loop",
      "  yield",
      "  if a > 0 then",
      "    a = 1",
      "  else",
      "    b = 0",
      "  end",
      "end",
    ],
    expected: [
      "loop0:", // Start of loop
      "yield",
      "move r0 a", // Start of if
      "blez r0 else0",
      "move a 1",
      "j endif0",
      "else0:",
      "move b 0",
      "endif0:", // End of if
      "j loop0" // End of loop
    ]
  },
  "compacting if statements in loops with continue (if statement is just continue)": {
    source: [
      "loop",
      "  yield",
      "  if a <= 0 then",
      "    continue",
      "  end",
      "  b = a",
      "end",
    ],
    expected: [
      "loop0",
      "yield",
      "blez r0 loop0", // Back to start of loop
      "move r0 a",
      "move b r0",
      "j loop0"    
    ]
  },
  "compacting if statements in loops with continue (if statement is not just continue)": {
    source: [
      "loop",
      "  yield",
      "  if a <= 0 then",
      "    b = 0",
      "    continue",
      "  end",
      "  b = a",
      "end",
    ],
    expected: [
      "loop0",
      "yield",
      "bgtz r0 endif0",
      "move b 0", // Update b before continuing
      "j endif0",
      "endif0:",
      "move r0 a",
      "move b r0",
      "j loop0"    
    ]
  },
  "compacting if statements in loops with break (if statement is just break)": {
    source: [
      "loop",
      "  yield",
      "  if a <= 0 then",
      "    break",
      "  end",
      "  b = a",
      "end",
    ],
    expected: [
      "loop0",
      "yield",
      "blez r0 endloop0",
      "move r0 a",
      "move b r0",
      "j loop0",
      "endloop0:",
    ]
  },
  "compacting if statements in loops with break (if statement is not just break)": {
    source: [
      "loop",
      "  yield",
      "  if a <= 0 then",
      "    b = 0",
      "    break",
      "  end",
      "  b = a",
      "end",
    ],
    expected: [
      "loop0",
      "yield",
      "bgtz r0 endif0",
      "move b 0", // Update b before breaking
      "j endloop0",
      "endif0:",
      "move r0 a",
      "move b r0",
      "j loop0",
      "endloop0:",
    ]
  },
  "pruning loops with guarenteed break on first iteration": {
    source: [
      "loop",
      "  yield",
      "  a = b",
      "  break", // Break out of loop after the first iteration
      "end",
    ],
    expected: [
      "yield",
      "move r0 b",
      "move a r0",
    ]
  },
  "pruning loops with break in pruned if": {
    source: [
      "loop",
      "  yield",
      "  a = b",
      "  if true then", // Always executed
      "    break", // Break out of loop after the first iteration
      "  end",
      "end",
    ],
    expected: [
      "yield",
      "move r0 b",
      "move a r0",
    ]
  },
  "pruning unnecessary continue": {
    source: [
      "loop",
      "  yield",
      "  a = b",
      "  continue",
      "end",
    ],
    expected: [
      "loop0:",
      "yield",
      "move r0 b",
      "move a r0",
      "j loop0"
    ]
  },
  "freeing registers in loops (register used on next iteration)": {
    source: [
      "let x = c",
      "loop",
      "  a = x",
      "  let y = x + 1",
      "  b = y",
      "end",
    ],
    expected: [
      "move r0 c",
      "loop0:",
      "move a r0",
      "add r1 r0 1", // r0 will be used on the next iteration
      "move b r1",
      "j loop0"
    ]
  },
  "freeing registers in loops (register not used on next iteration due to pruning)": {
    source: [
      "let x = c",
      "loop",
      "  a = x",
      "  let y = x + 1",
      "  b = y",
      "  break",
      "end",
    ],
    expected: [
      "move r0 c",
      "move a r0",
      "add r0 r0 1", // r0 will NOT be used on the next iteration (loop pruned)
      "move b r0",
    ]
  },
  "freeing registers in loops (register used after loop ends)": {
    source: [
      "let x = c",
      "loop",
      "  a = x",
      "  let y = x + 1",
      "  b = y",
      "  break",
      "end",
      "d = x",
    ],
    expected: [
      "move r0 c",
      "move a r0",
      "add r1 r0 1", // r0 will be used in the future
      "move b r0",
      "move d r0",
    ]
  },
  "stack allocation in loops (not enough registers + optimizing order)": {
    // Assigning placeholders early to free registers.
    // This is only possible because order doesn't matter for the calculation of x4
    // What does matter is that y3 is saved before y4.
    // The rule: The order of read and writes to placeholders MUST be preserved.
    // Any other instructions are free to reorder as long as logic is preserved.
    source: [
      "let x0 = y0",
      "let x1 = y1",
      "let x2 = y2",
      "loop",
      "  let x3 = x0 + x1",
      "  let x4 = x1 + x2",
      "  y3 = x3",
      "  y4 = x4",
      "end",
    ],
    // The pressure of the program is 5 and the minimum number of temp registers is 1.
    // It's a tie between x0 and x2 for use as temporaries (use last one).
    expected: [
      "move r0 y0",
      "move r1 y1",
      "move r2 y2",
      "poke 511 r2", // Save x2 and free r2 before the loop (this is our temp register)
      "loop0:", // (r0, r1, r2) = (x0, x1, temp)
      "add r2 r0 r1", // r2 = x0 + x1
      "move y3 r2", // r2 is now free
      "get r2 db 511", // r2 = x2
      "add r2 r1 r2", // r2 = x1 + x2
      "move y4 r2", // r2 is now free
      "j loop0"
    ]
  },
  "stack allocation in loops (not enough registers + can't optimize order)": {
    // Here, a read of y5 disrupts the ability to set y3 before calculating y4.
    source: [
      "let x0 = y0",
      "let x1 = y1",
      "let x2 = y2",
      "loop",
      "  let x3 = x0 + x1",
      "  let x4 = x2 + y5",
      "  y3 = x3",
      "  y4 = x4",
      "end",
    ],
    // The pressure of the program is 5 and the minimum number of temp registers is 2.
    // It is a tie between x0, x1, and x2 for use as temporaries (use last two).
    expected: [
      "move r0 y0",
      "move r1 y1",
      "move r2 y2",
      "poke 511 r1", // Save x1 but don't free r1
      "poke 510 r2", // Save x2 and free r2
      "loop0:", // (r0, r1, r2) = (x0, temp, temp)
      "add r1 r0 r1", // r1 = x0 + x1
      "poke 509 r1", // Save x3 and free r1
      "get r1 db 510", // r1 = x2
      "move r2 y5", // r2 = y5
      "add r1 r0 r2", // r1 = x2 + y5
      "get r2 db 509", // r2 = x3
      "move y3 r2", // r2 is now free
      "move y4 r1", // r1 is now free
      "get r1 db 511", // r1 = x1
      "j loop0"
    ]
  },
  "stack allocation in loops (enough registers)": {
    // The program is in its simplest form when all the registers are available.
    order: FULL_ORDER,
    source: [
      "let x0 = y0",
      "let x1 = y1",
      "let x2 = y2",
      "loop",
      "  let x3 = x0 + x1",
      "  let x4 = x2 + y5",
      "  y3 = x3",
      "  y4 = x4",
      "end",
    ],
    expected: [
      "move r0 y0",
      "move r1 y1",
      "move r2 y2",
      "loop0:",
      "add r3 r0 r1",
      "move r4 y5", // r4 is temporary
      "add r4 r2 r4",
      "move y3 r3",
      "move y4 r4",
      "j loop0"
    ]
  },
  "nested loops": {
    source: [
      "let x",
      "loop",
      "  x = 0",
      "  loop",
      "    x = x + 1",
      "    a = x",
      "    if x == 10 then",
      "      break",
      "    end",
      "  end",
      "end",
    ],
    expected: [
      "loop0:",
      "move r0 0",
      "loop1:",
      "add r0 r0 1",
      "move a r0",
      "beq r0 10 endloop1",
      "j loop1",
      "endloop1:",
      "j loop0",
    ]
  },
  "defining variables in loops": {
    source: [
      "loop",
      "  let x = a",
      "  b = x",
      "  c = x",
      "end",
    ],
    expected: [
      "loop0:",
      "move r0 a",
      "move b r0",
      "move c r0",
      "j loop0",
    ]
  },
  "using variables defined in loops outside the loop": {
    source: [
      "loop",
      "  let x = 0",
      "end",
      "a = x",
    ],
    expected: [ // Loop has no side effects and is pruned
      "move r0 x", // x is treated as a placeholder
      "move a r0",
    ]
  },
  // Loop variants
  "while loop": {
    source: [
      "while a < b do",
      "  c = 0",
      "end",
    ],
    expected: [
      "while0:",
      "move r0 a",
      "move r1 b",
      "bge r0 r1 endwhile0",
      "move c 0",
      "j while0",
      "endwhile0:",
    ]
  },
  "repeat until loop": {
    source: [
      "repeat",
      "  sleep c",
      "  d = a",
      "until a >= b",
    ],
    expected: [
      "repeat0:",
      "move r0 c", // r0 is temporary
      "sleep r0",
      "move r0 a",
      "move d r0",
      "move r0 a",
      "move r1 b",
      "blt r0 r1 repeat0",
    ]
  },
  "compacting while loops (true condition)": {
    source: [
      "while 1 > 0 do",
      "  yield",
      "  a = b",
      "end",
    ],
    expected: [
      "while0:",
      "yield",
      "move r0 b",
      "move a r0",
      "j while0",
    ]
  },
  "compacting while loops (false condition)": {
    source: [
      "while a && false do",
      "  yield",
      "  a = b",
      "end",
    ],
    expected: "",
  },
  "compacting repeat until loops (true condition)": {
    source: [
      "repeat",
      "  yield",
      "  a = b",
      "until 1 > 0",
    ],
    expected: [
      "yield",
      "move r0 b",
      "move a r0",
    ]
  },
  "compacting repeat until loops (false condition)": {
    source: [
      "repeat",
      "  yield",
      "  a = b",
      "until a && false",
    ],
    expected: [
      "repeat0:",
      "yield",
      "move r0 b",
      "move a r0",
      "j repeat0",
    ],
  }
};

let failures = 0;
let nCases = Object.keys(cases).length;

for (const [name, { source, expected, error, order }] of Object.entries(cases)) {
  let actual;
  let sourceText = typeof source === "string" || !source ? source : source.join("\n");
  let expectedText = typeof expected === "string" || !expected ? expected : expected.join("\n");
  try {
    actual = compile(getAST(sourceText), order ?? REDUCED_ORDER);
  } catch (e) {
    if (!(e instanceof CompileError)) throw e;
    actual = e;
  }

  const ok = actual instanceof CompileError
    ? actual.message === error
    : actual === expectedText;

  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}`);
    console.log(`  expected: ${JSON.stringify(error ?? expectedText)}`);
    console.log(`  actual:   ${JSON.stringify(actual instanceof CompileError ? actual.message : actual)}`);
  }
}

console.log(`\n${nCases - failures}/${nCases} passed`);
process.exit(failures > 0 ? 1 : 0);
