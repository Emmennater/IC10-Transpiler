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
      "loop0:",
      "yield",
      "move r0 a", // The condition must load the placeholder first
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
      "loop0:",
      "yield",
      "move r0 a", // The condition must load the placeholder first
      "bgtz r0 endif0",
      "move b 0", // Update b before continuing
      "j loop0", // The continue goes back to the loop start
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
      "loop0:",
      "yield",
      "move r0 a", // The condition must load the placeholder first
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
      "loop0:",
      "yield",
      "move r0 a", // The condition must load the placeholder first
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
      "move b r1", // y lives in r1
      "move d r0",
    ]
  },
  "stack allocation in loops (not enough registers + equal uses)": {
    source: [
      "let x0 = y0",
      "let x1 = y1",
      "let x2 = y2",
      "loop",
      "  z01 = x0 + x1",
      "  z02 = x0 + x2",
      "  z12 = x1 + x2",
      "end",
    ],
    // The minimum number of virtual registers is 4.
    // At least one temporary register is needed.
    expected: [
      "move r0 y0",
      "move r1 y1",
      "move r2 y2",
      "poke 511 r2", // r2 is the chosen temporary
      "loop0:",
      "add r2 r0 r1",
      // "poke 510 r2", // Redundant instructions
      // "get r2 db 510",
      "move z01 r2",
      "get r2 db 511",
      "add r2 r0 r2",
      "move z02 r2",
      "get r2 db 511",
      "add r2 r1 r2",
      "move z12 r2",
      "j loop0"
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
  "stack allocation in loops (not enough registers + saving placeholder to optimize order)": {
    // Here, a read of y5 disrupts the ability to set y3 before calculating y5.
    // You don't need to calculate x4, just save y5 before setting y3.
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
    // The store of y3 can still sink below the y5 read (source order of
    // placeholder accesses is read y5, write y3, write y4), which frees x3's
    // register before x4 is computed. x1 and x2 spill; x0 keeps r0.
    expected: [
      "move r0 y0",
      "move r1 y1",
      "poke 510 r1", // Save x1 and free r1
      "move r1 y2",
      "poke 511 r1", // Save x2 and free r1
      "loop0:", // (r0, r1, r2) = (x0, temp, temp)
      "get r1 db 510", // r1 = x1
      "add r1 r0 r1", // r1 = x3 = x0 + x1
      "move r2 y5", // r2 = y5
      "move y3 r1", // r1 is now free
      "get r1 db 511", // r1 = x2
      "add r1 r1 r2", // r1 = x4 = x2 + y5
      "move y4 r1",
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
      "bne r0 10 loop1", // The break fuses: loop while x != 10
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
  },
  // Devices, defines and function calls
  "device declarations and dot access": {
    source: [
      "device pump = d0",
      "pump.Setting = 1",
      "let x = pump.On",
      "d1.Setting = x", // Raw device pins work directly
    ],
    expected: [
      "alias pump d0",
      "s pump Setting 1",
      "l r0 pump On",
      "s d1 Setting r0",
    ],
  },
  "slot access with brackets": {
    source: [
      "device larre = d0",
      "device sorter = d1",
      "let count = larre[255].Quantity",
      "sorter[0].PrefabHash = \"Iron\"",
      "b = count",
    ],
    expected: [
      "alias larre d0",
      "alias sorter d1",
      "ls r0 larre 255 Quantity",
      "ss sorter 0 PrefabHash HASH(\"Iron\")",
      "move b r0",
    ],
  },
  "unused devices and dead reads are dropped": {
    source: [
      "device pump = d0",
      "device spare = d1",
      "let x = pump.On",
      "b = 1",
    ],
    expected: "move b 1", // No alias lines survive
  },
  "defines emit only when used": {
    source: [
      "define light = \"StructureWallLight\"",
      "define unused = 5",
      "define y = 100",
      "light.On = y",
    ],
    expected: [
      "define light HASH(\"StructureWallLight\")",
      "define y 100",
      "sb light On y",
    ],
  },
  "bare identifier defines substitute without a define line": {
    source: [
      "define str = HelloWorld",
      "let s = str",
      "c = s",
    ],
    expected: "move c HelloWorld",
  },
  "aggregators read device groups": {
    source: [
      "define light = \"StructureWallLight\"",
      "let x = Sum(light.On)",
      "let y = Average(deviceHash.Temperature)", // Unknown names hash directly
      "b = x + y",
    ],
    expected: [
      "define light HASH(\"StructureWallLight\")",
      "lb r0 light On Sum",
      "lb r1 HASH(\"deviceHash\") Temperature Average",
      "add r0 r0 r1",
      "move b r0",
    ],
  },
  "named device groups use lbn and sbn": {
    source: [
      "define light = \"StructureWallLight\"",
      "let x = Sum(light[\"Inside\"].On)",
      "light[\"Inside\"].On = true",
      "b = x",
    ],
    expected: [
      "define light HASH(\"StructureWallLight\")",
      "lbn r0 light HASH(\"Inside\") On Sum",
      "sbn light HASH(\"Inside\") On 1",
      "move b r0",
    ],
  },
  "function calls become instructions": {
    source: [
      "device larre = d0",
      "let itemCount = ls(larre, 0, Quantity)", // Assigned: first operand is the output
      "b = itemCount",
      "s(db, Setting, 5)", // Statement: translated as-is
    ],
    expected: [
      "alias larre d0",
      "ls r0 larre 0 Quantity",
      "move b r0",
      "s db Setting 5",
    ],
  },
  "loadSlot and setSlot are aliases": {
    source: [
      "let y = loadSlot(d0, 0, Quantity)",
      "setSlot(d1, 0, PrefabHash, y)",
    ],
    expected: [
      "ls r0 d0 0 Quantity",
      "ss d1 0 PrefabHash r0",
    ],
  },
  "strings hash and propagate like constants": {
    source: "let s = \"Hello World!\"\nc = s",
    expected: "move c HASH(\"Hello World!\")",
  },
  "game constants stay inline": {
    source: "let x = DisplayMode.Seconds\nsleep x",
    expected: "sleep DisplayMode.Seconds",
  },
  "device group reads need an aggregator": {
    source: "define light = \"X\"\nb = light.On",
    error: "Line 1: Reading from a device group needs an aggregator (Sum, Average, Minimum, Maximum)",
  },
  "writing to unknown devices is an error": {
    source: "foo.On = 1",
    error: "Line 0: Unknown device or define foo",
  },
  // User-defined functions
  "defining and calling functions": {
    source: [
      "fn hypot(a, b)",
      "  return sqrt(a * a + b * b)", // sqrt <reg> <reg|number> aligns with our compiler
      "end",
      "x = hypot(1, 2)",
      "y = hypot(x, 3)",
    ],
    expected: [
      "j ProgramStart",
      "hypot:", // Parameters live in r0/r1; the result is computed into r0
      "mul r0 r0 r0",
      "mul r1 r1 r1",
      "add r0 r0 r1",
      "sqrt r0 r0",
      "j ra", // Leaf function: no ra bookkeeping
      "ProgramStart:",
      "move r0 1",
      "move r1 2",
      "jal hypot",
      "move x r0",
      "move r0 x",
      "move r1 3",
      "jal hypot",
      "move y r0",
    ],
  },
  "functions calling functions (reduced order)": {
    source: [
      "fn min(a, b)",
      "  if a < b then",
      "    return a",
      "  else",
      "    return b",
      "  end", // Closes the if; the fn needs its own end
      "end",
      "fn max(a, b)",
      "  return -min(-a, -b)",
      "end",
      "fn constrain(value, min, max)",
      "  return min(max(value, min), max)",
      "end",
      "x = constrain(a, 2, 3) + constrain(b, 5, 6)",
    ],
    // min is jal-called (two sites); max inlines into constrain, whose
    // negations retarget straight into min's parameter registers. With
    // only three registers the first result must survive the second call
    // on the stack (constrain clobbers r0-r2).
    expected: [
      "j ProgramStart",
      "min:", // a=r1, b=r2, result=r1
      "blt r1 r2 endmin",
      "move r1 r2",
      "endmin:",
      "j ra",
      "constrain:", // value=r1, min=r2, max=r0, result=r1
      "push ra",
      "sub r1 0 r1", // -value, straight into min's first parameter
      "sub r2 0 r2", // -min
      "jal min",
      "sub r1 0 r1", // max(value, min) = -min(-value, -min)
      "move r2 r0",
      "jal min",
      "pop ra",
      "j ra",
      "ProgramStart:",
      "move r1 a", // Placeholder loads directly into the parameter register
      "move r2 2",
      "move r0 3",
      "jal constrain",
      "poke 511 r1", // First result survives the second call on the stack
      "move r1 b",
      "move r2 5",
      "move r0 6",
      "jal constrain",
      "get r0 db 511",
      "add r0 r0 r1",
      "move x r0",
    ],
  },
  "functions calling functions (full order)": {
    order: FULL_ORDER,
    source: [
      "fn min(a, b)",
      "  if a < b then",
      "    return a",
      "  else",
      "    return b",
      "  end", // Closes the if; the fn needs its own end
      "end",
      "fn max(a, b)",
      "  return -min(-a, -b)",
      "end",
      "fn constrain(value, min, max)",
      "  return min(max(value, min), max)",
      "end",
      "x = constrain(a, 2, 3) + constrain(b, 5, 6)",
    ],
    // With a full register file the first result rides out the second
    // call in r0 instead of on the stack.
    expected: [
      "j ProgramStart",
      "min:", // a=r2, b=r3, result=r2
      "blt r2 r3 endmin",
      "move r2 r3",
      "endmin:",
      "j ra",
      "constrain:", // value=r2, min=r3, max=r1, result=r2
      "push ra",
      "sub r2 0 r2",
      "sub r3 0 r3",
      "jal min",
      "sub r2 0 r2",
      "move r3 r1",
      "jal min",
      "pop ra",
      "j ra",
      "ProgramStart:",
      "move r2 a",
      "move r3 2",
      "move r1 3",
      "jal constrain",
      "move r0 r2", // First result moves clear of the second call
      "move r2 b",
      "move r3 5",
      "move r1 6",
      "jal constrain",
      "add r0 r0 r2",
      "move x r0",
    ],
  },
  "parameterless functions": {
    source: [
      "fn update()",
      "  x = x + 1",
      "end",
      "update()",
      "sleep 10",
      "update()",
    ],
    expected: [
      "j ProgramStart",
      "update:",
      "move r0 x",
      "add r0 r0 1",
      "move x r0",
      "j ra",
      "ProgramStart:",
      "jal update",
      "sleep 10",
      "jal update",
    ]
  },
  "recursive functions": {
    // These types of functions need to be treated differently than other functions
    // since they are register hungry.
    // If supporting these types of functions comprimises efficient stack management
    // elsewhere, then it may not be worth it.
    source: [
      "fn fib(n)",
      "  if n < 2 then",
      "    return n",
      "  else",
      "    return fib(n - 1) + fib(n - 2)",
      "  end",
      "end",
      "x = fib(10)",
    ],
    // Runtime recursion would force dynamic stack frames and break the
    // fixed spill addresses; @constexpr covers compile-time recursion.
    error: "Line 4: Recursive functions are not supported: fib",
  },
  "mutually recursive functions": {
    source: [
      "fn even(n)",
      "  if n == 0 then",
      "    return true",
      "  else",
      "    return odd(n - 1)",
      "  end",
      "end",
      "fn odd(n)",
      "  if n == 0 then",
      "    return false",
      "  else",
      "    return even(n - 1)",
      "  end",
      "end",
      "x = even(10)",
    ],
    error: "Line 11: Recursive functions are not supported: even",
  },
  "inlining functions that are only used once": {
    source: [
      "fn manhattan(a, b)",
      "  return abs(a) + abs(b)",
      "end",
      "x = manhattan(a, b)",
    ],
    expected: [
      "move r0 a",
      "abs r0 r0",
      "move r1 b",
      "abs r1 r1",
      "add r0 r0 r1",
      "move x r0",
    ],
  },
  "constant expression functions": {
    // A special preprocessor directive (@constexpr) should be used to mark functions
    // that should be evaluated at compile time if possible.
    source: [
      "@constexpr",
      "fn fib(n)",
      "  if n < 2 then",
      "    return n",
      "  else",
      "    return fib(n - 1) + fib(n - 2)",
      "  end",
      "end",
      "x = fib(10)",
    ],
    expected: "move x 55",
  },
  "functions calling multiple functions (full order)": {
    order: FULL_ORDER,
    source: [
      "fn baz(a, b)",
      "  return a > b",
      "end",
      "fn bar(a, b)",
      "  return !baz(b, a)",
      "end",
      "fn foo(a, b, c)",
      "  return bar(a, b) && baz(b, c)",
      "end",
      "x = foo(-2, 0, 4)",
      "y = foo(3, -2, 1)",
    ],
    // baz is jal-called twice; bar inlines into foo; foo is jal-called.
    // baz's comparison lands directly in its result register.
    expected: [
      "j ProgramStart",
      "baz:", // a=r3, b=r4, result=r3
      "sgt r3 r3 r4",
      "j ra",
      "foo:", // a=r4, b=r1, c=r2, result=r1
      "push ra",
      "move r3 r1", // baz(b, a): a is already in baz's second parameter
      "jal baz",
      "seqz r0 r3", // !baz(...)
      "move r3 r1",
      "move r4 r2",
      "jal baz",
      "snez r1 r3",
      "and r1 r0 r1",
      "pop ra",
      "j ra",
      "ProgramStart:",
      "move r4 -2",
      "move r1 0",
      "move r2 4",
      "jal foo",
      "move x r1",
      "move r4 3",
      "move r1 -2",
      "move r2 1",
      "jal foo",
      "move y r1",
    ],
  },
  "functions with many variables": {
    source: [
      "fn foo(a, b, c)",
      "  let x = a * 2 + 1",
      "  let y = x + c",
      "  let z = a * y + b",
      "  let w = b * z - 4",
      "  return w",
      "end",
      "x = foo(1, 2, 3)",
      "y = foo(4, 5, 6)",
    ],
    // Three registers cannot hold a, b, c and the chain at once: the two
    // least-pressing parameters pass through fixed stack slots instead.
    expected: [
      "j ProgramStart",
      "foo:", // a=r0, b=stack 510, c=stack 511, result=r0
      "mul r1 r0 2",
      "add r1 r1 1",
      "get r2 db 511",
      "add r1 r1 r2",
      "mul r0 r0 r1",
      "get r1 db 510",
      "add r0 r0 r1",
      "get r1 db 510",
      "mul r0 r1 r0",
      "sub r0 r0 4",
      "j ra",
      "ProgramStart:",
      "move r0 1",
      "move r1 2",
      "poke 510 r1",
      "move r1 3",
      "poke 511 r1",
      "jal foo",
      "move x r0",
      "move r0 4",
      "move r1 5",
      "poke 510 r1",
      "move r1 6",
      "poke 511 r1",
      "jal foo",
      "move y r0",
    ],
  },
  "functions with loops": {
    source: [
      "fn triangle(n)",
      "  let x = 0",
      "  let sum = 0",
      "  while x < n do",
      "    x = x + 1",
      "    sum = sum + x",
      "  end",
      "  return sum",
      "end",
      "x = triangle(6)",
      "y = triangle(8)",
    ],
    expected: [
      "j ProgramStart",
      "triangle:", // n=r0, result=r2 (sum's register, no final move needed)
      "move r1 0",
      "move r2 0",
      "while0:",
      "bge r1 r0 endwhile0",
      "add r1 r1 1",
      "add r2 r2 r1",
      "j while0",
      "endwhile0:",
      "j ra",
      "ProgramStart:",
      "move r0 6",
      "jal triangle",
      "move x r2",
      "move r0 8",
      "jal triangle",
      "move y r2",
    ],
  },
  "functions write global variables": {
    source: [
      "let count = 0",
      "fn bump()",
      "  count = count + 1",
      "end",
      "bump()",
      "bump()",
      "c = count",
    ],
    // count gets a permanent home register; every write goes through it
    expected: [
      "j ProgramStart",
      "bump:",
      "add r0 r0 1",
      "j ra",
      "ProgramStart:",
      "move r0 0",
      "jal bump",
      "jal bump",
      "move c r0",
    ],
  },
  "functions read global variables": {
    source: [
      "let target = 50",
      "fn alarmIf(v)",
      "  if v > target then",
      "    alarm = 1",
      "  end",
      "end",
      "alarmIf(a)",
      "alarmIf(b)",
      "d = target * 2",
    ],
    // target lives in a register for the function, but stays a known
    // constant in the main program (the function never writes it).
    expected: [
      "j ProgramStart",
      "alarmIf:",
      "ble r1 r0 endif0",
      "move alarm 1",
      "endif0:",
      "j ra",
      "ProgramStart:",
      "move r0 50",
      "move r1 a",
      "jal alarmIf",
      "move r1 b",
      "jal alarmIf",
      "move d 100",
    ],
  },
  "globals initialize before loops that call functions": {
    source: [
      "device housing = db",
      "let count = 0",
      "fn bump()",
      "  count = count + 1",
      "end",
      "loop",
      "  yield",
      "  bump()",
      "  bump()",
      "  housing.Setting = count",
      "end",
    ],
    // count's home register is set up where the declaration is, not at
    // the first call site — otherwise the loop would reset it every pass.
    expected: [
      "alias housing db",
      "j ProgramStart",
      "bump:",
      "add r0 r0 1",
      "j ra",
      "ProgramStart:",
      "move r0 0",
      "loop0:",
      "yield",
      "jal bump",
      "jal bump",
      "s housing Setting r0",
      "j loop0",
    ],
  },
  "alias and define lines start the script": {
    source: [
      "let x = 1",
      "device pump = d0",
      "define speed = 3",
      "pump.Setting = x + speed",
    ],
    expected: [
      "alias pump d0",
      "define speed 3",
      "add r0 1 speed",
      "s pump Setting r0",
    ],
  },
  "function names cannot be reused": {
    source: [
      "fn foo(a)",
      "  return a",
      "end",
      "let foo = 1",
    ],
    error: "Line 3: foo was already defined",
  }
};

let failures = 0;
let nCases = Object.keys(cases).length;

for (const [name, { source, expected, error, order }] of Object.entries(cases)) {
  let actual;
  let sourceText = typeof source === "string" || !source ? source : source.join("\n");
  let expectedText = typeof expected === "string" || !expected ? expected : expected.join("\n");
  let config = {
    removeLabels: false,
    registerOrder: order ?? REDUCED_ORDER,
  }
  try {
    actual = compile(getAST(sourceText), config);
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
