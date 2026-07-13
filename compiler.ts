
/**
 * Compiler for translating high-level code to IC10.
 *
 * Custom language reference: ./README.md
 * IC10 Reference: https://stationeers-wiki.com/IC10 (local copy: ./ic10-docs.txt)
 *
 * Pipeline:
 *   1. The AST is lowered to a linear IR over infinite virtual registers.
 *      Constants are folded and propagated through variables, and copies
 *      never generate code (each assignment just remaps the variable name).
 *      Placeholder identifiers (anything not declared with `let`) are read
 *      and written only through `move` — they stand in for the l/s/lb/sb/...
 *      device instructions to come, which cannot appear as ALU operands.
 *      If/loop conditions compile to fused branches (ble/bgez/bnez/...);
 *      && and || short-circuit. A variable assigned inside a branch or loop
 *      body is demoted to a "home" vreg: every path writes the same vreg,
 *      so merge points and back edges need no phis. Inside a loop body the
 *      variable's compile-time constant is forgotten (the back edge may
 *      change it); constant conditions skip branches entirely.
 *   2. Dead code elimination uses iterative backward liveness (loops have
 *      backward branches, so label live-sets must reach a fixed point),
 *      keeping only instructions that contribute to a side effect (a
 *      placeholder write, yield, or sleep). Control-flow cleanup passes
 *      alternate with it: ifs with all-empty arms disappear, a then-arm
 *      that is exactly `break`/`continue` fuses into the conditional
 *      branch, code after an unconditional jump is unreachable, jumps to
 *      the next label vanish, and loops with empty bodies are pruned.
 *   3. Linear-scan register allocation maps virtual registers onto
 *      VAR_REGISTER_ORDER using live ranges from the same dataflow (a value
 *      used before the back edge stays live to the end of the loop). Under
 *      pressure, placeholder stores are first sunk earlier (their order
 *      among placeholder accesses is preserved) to shorten live ranges;
 *      remaining pressure spills the least-used value to a fixed stack
 *      address (511 downward: `get r? db addr` / `poke addr value`). Low
 *      stack addresses are left free for the future function call stack.
 *
 *   r16 (sp) and r17 (ra) are reserved for stack and function support.
 */

export type SyntaxNode = {
  type: string;
  text: string;
  from: number;
  to: number;
  children: SyntaxNode[];
};

export class CompileError extends Error {
  from: number;
  to: number;

  constructor(message: string, node: SyntaxNode) {
    super(message);
    this.from = node.from;
    this.to = node.to;
  }
}


// Preferred assignment order for variable registers
const VAR_REGISTER_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
// const VAR_REGISTER_ORDER = [0, 1, 2];

// Spilled values live at fixed stack addresses growing down from here
const STACK_TOP = 511;

const ALU_OPCODES: Record<string, string> = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
};

// Comparison results as data (0/1 values)
const SET_OPCODES: Record<string, string> = {
  "==": "seq", "!=": "sne", ">": "sgt", "<": "slt", ">=": "sge", "<=": "sle",
};

// Branch when the comparison is TRUE / FALSE
const BRANCH_TRUE: Record<string, string> = {
  "==": "beq", "!=": "bne", ">": "bgt", "<": "blt", ">=": "bge", "<=": "ble",
};
const BRANCH_FALSE: Record<string, string> = {
  "==": "bne", "!=": "beq", ">": "ble", "<": "bge", ">=": "blt", "<=": "bgt",
};

// Mirror `0 OP x` into `x OP' 0` so the zero-compare forms apply
const MIRROR: Record<string, string> = {
  "==": "==", "!=": "!=", ">": "<", "<": ">", ">=": "<=", "<=": ">=",
};

// Flip a branch to jump on the opposite outcome
const INVERT_BRANCH: Record<string, string> = {
  beq: "bne", bne: "beq", bgt: "ble", ble: "bgt", blt: "bge", bge: "blt",
  beqz: "bnez", bnez: "beqz", bgtz: "blez", blez: "bgtz", bltz: "bgez", bgez: "bltz",
};

const COMPARE_JS: Record<string, (a: number, b: number) => boolean> = {
  "==": (a, b) => a === b, "!=": (a, b) => a !== b,
  ">": (a, b) => a > b, "<": (a, b) => a < b,
  ">=": (a, b) => a >= b, "<=": (a, b) => a <= b,
};

// Instructions that read a value and return it through their first operand
const AGGREGATORS = new Set(["Average", "Sum", "Minimum", "Maximum"]);

// Friendlier spellings for IC10 opcodes
const OPCODE_ALIASES: Record<string, string> = {
  loadSlot: "ls",
  setSlot: "ss",
};

const EXPRESSION_TYPES = new Set([
  "Number", "Bool", "VariableName", "Device", "DeviceProperty", "DeviceChannelProperty",
  "DeviceNameProperty", "Parens", "UnaryOp", "BinaryOp", "FunctionCall", "String",
]);
const STATEMENT_TYPES = new Set([
  "Declaration", "Assignment", "IfExpr", "LoopExpr", "WhileExpr", "RepeatUntilExpr",
  "break", "continue", "Instruction", "FunctionCall", "DeviceDeclaration", "Definition",
]);

type VRegOperand = { kind: "vreg"; id: number };
type ConstOperand = { kind: "const"; text: string };
type NameOperand = { kind: "name"; text: string };
// Symbolic text emitted verbatim: device aliases, define names, HASH("..."),
// game constants like DisplayMode.Seconds. Valid inline anywhere a number is.
type SymOperand = { kind: "sym"; text: string };
type Operand = VRegOperand | ConstOperand | NameOperand | SymOperand;

type Inst =
  | { id: number; op: "alu"; opcode: string; dest: number; args: Operand[]; node: SyntaxNode }
  | { id: number; op: "movev"; dest: number; src: Operand; node: SyntaxNode }
  | { id: number; op: "loadname"; dest: number; name: string; node: SyntaxNode }
  | { id: number; op: "storename"; name: string; src: Operand; node: SyntaxNode }
  | { id: number; op: "get"; dest: number; addr: number; node: SyntaxNode }
  | { id: number; op: "poke"; addr: number; src: Operand; node: SyntaxNode }
  // A raw IC10 instruction (yield, sleep, l, s, ls, lb, user calls, ...).
  // With a dest it is a pure value producer (dest is the first operand);
  // without one it is a side effect and always survives.
  | { id: number; op: "call"; opcode: string; dest: number | null; args: Operand[]; node: SyntaxNode }
  // alias/define lines survive only if their name is used by kept code
  | { id: number; op: "alias"; name: string; device: string; node: SyntaxNode }
  | { id: number; op: "definedef"; name: string; value: string; node: SyntaxNode }
  | { id: number; op: "label"; name: string; node: SyntaxNode }
  | { id: number; op: "jump"; target: string; node: SyntaxNode }
  | { id: number; op: "branch"; opcode: string; args: Operand[]; target: string; node: SyntaxNode };

// Omit that distributes over a union instead of collapsing it
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** One variable's compile-time state. */
type VarState = {
  value: Operand | null; // null = unassigned so far
  maybe: boolean;        // assigned on some control-flow paths but not all
  home: number | null;   // while inside an if/loop that assigns this variable,
                         // every write also lands in this vreg
};

/** Anything a name can refer to. */
type Sym =
  | { kind: "var"; state: VarState }
  | { kind: "device"; pin: string }
  // `text` is what uses emit: the define's own name when a `define` line is
  // generated, or the substituted value for bare-identifier definitions
  | { kind: "define"; text: string; needsLine: boolean };

/** Metadata for one lowered if/elif/else, used by branch simplification. */
type IfRegion = {
  arms: {
    condIds: number[];        // everything emitted for the condition
    branchIds: number[];      // just the conditional branches
    bodyFrom: number;         // inclusive inst-id range of the arm body
    bodyTo: number;
    jumpId: number | null;    // the `j endif` after the body
    labelName: string | null; // label that starts the NEXT arm
    labelId: number | null;
  }[];
  endLabelName: string;
  endLabelId: number;
  simplified?: boolean;       // structural transforms are one-shot
};

/** Metadata for one lowered loop, used to prune empty loops. */
type LoopRegion = {
  headLabelId: number;
  backJumpId: number;
  bodyFrom: number; // inclusive inst-id range between head label and back jump
  bodyTo: number;
};

export function compile(ast: SyntaxNode, registerOrder: number[] = VAR_REGISTER_ORDER): string {
  const source = ast.text;

  // The editor gutter is 0-based, so error lines are too.
  function lineOf(node: SyntaxNode): number {
    let line = 0;
    for (let i = 0; i < node.from && i < source.length; i++) {
      if (source[i] === "\n") line++;
    }
    return line;
  }

  function error(message: string, node: SyntaxNode): CompileError {
    return new CompileError(`Line ${lineOf(node)}: ${message}`, node);
  }

  // Comments are skipped tokens and can be attached anywhere in the tree.
  function kids(node: SyntaxNode): SyntaxNode[] {
    return node.children.filter(c => c.type !== "Comment");
  }

  function checkSyntax(node: SyntaxNode) {
    if (node.type === "⚠") {
      throw error("Syntax error", node);
    }
    for (const child of node.children) checkSyntax(child);
  }

  /** Make a constant operand, or null if the value has no plain IC10 literal. */
  function constOp(value: number): ConstOperand | null {
    if (!Number.isFinite(value)) return null;
    const text = String(value);
    if (text.includes("e") || text.includes("E")) return null;
    return { kind: "const", text };
  }

  function isConst(operand: Operand, text: string): boolean {
    return operand.kind === "const" && operand.text === text;
  }

  function isZero(operand: Operand): boolean {
    return operand.kind === "const" && parseFloat(operand.text) === 0;
  }

  // ---------------------------------------------------------------------
  // 1. Lower the AST to IR
  // ---------------------------------------------------------------------

  const instructions: Inst[] = [];
  const ifRegions: IfRegion[] = [];
  const loopRegions: LoopRegion[] = [];
  let nextInstId = 0;
  let nextVreg = 0;
  let ifCounter = 0;
  let loopCounter = 0;
  let whileCounter = 0;
  let repeatCounter = 0;
  let shortCircuitCounter = 0;
  const scratch = new Set<number>();   // vregs created by spilling; never re-spilled
  const boolVregs = new Set<number>(); // vregs known to hold 0/1

  // Innermost scope last; declarations die when their scope is popped
  const scopes: Map<string, Sym>[] = [new Map()];
  // Targets for break/continue of the innermost enclosing loop
  const loopStack: { breakLabel: string; continueLabel: string }[] = [];
  // Placeholder name -> vreg already holding it in the current statement,
  // so `a * a` loads `a` once. Not shared across statements: a placeholder
  // may be written in between, and device reads should stay explicit.
  let statementLoads = new Map<string, number>();
  // vregs created after this point belong to the current statement and are
  // safe to retarget into a home register (see assignVariable)
  let statementVregBase = 0;

  function vreg(): number {
    return nextVreg++;
  }

  function emit(inst: DistributiveOmit<Inst, "id">): Inst {
    const complete = { ...inst, id: nextInstId++ } as Inst;
    instructions.push(complete);
    return complete;
  }

  function lookup(name: string): Sym | null {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const symbol = scopes[i].get(name);
      if (symbol) return symbol;
    }
    return null;
  }

  function lookupVar(name: string): VarState | null {
    const symbol = lookup(name);
    return symbol?.kind === "var" ? symbol.state : null;
  }

  /** Count how many variables currently share this vreg as their value. */
  function valueRefCount(id: number): number {
    let count = 0;
    for (const scope of scopes) {
      for (const symbol of scope.values()) {
        if (symbol.kind !== "var") continue;
        const state = symbol.state;
        if (state.value?.kind === "vreg" && state.value.id === id) count++;
      }
    }
    return count;
  }

  function foldTruthy(operand: ConstOperand | null): boolean | null {
    if (!operand) return null;
    return parseFloat(operand.text) !== 0;
  }

  /**
   * Try to evaluate an expression to a compile-time constant without
   * emitting any code. && and || fold when one side settles the outcome
   * (the other side is pure, so skipping it is safe).
   */
  function foldExpression(node: SyntaxNode): ConstOperand | null {
    switch (node.type) {
      case "Number":
        return constOp(parseFloat(node.text));
      case "Bool":
        return { kind: "const", text: node.text === "true" ? "1" : "0" };
      case "VariableName": {
        const state = lookupVar(node.text);
        if (state && !state.maybe && state.value?.kind === "const") return state.value;
        return null;
      }
      case "Parens": {
        const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
        return inner ? foldExpression(inner) : null;
      }
      case "UnaryOp": {
        const [op, operand] = kids(node);
        const value = foldExpression(operand);
        if (!value) return null;
        return op.text === "-" ? constOp(-parseFloat(value.text)) : value;
      }
      case "BinaryOp": {
        const [left, opNode, right] = kids(node);
        const op = opNode.text;
        const a = foldExpression(left);
        const b = foldExpression(right);
        if (op === "&&") {
          const ta = foldTruthy(a);
          const tb = foldTruthy(b);
          if (ta === false || tb === false) return { kind: "const", text: "0" };
          if (ta === true && tb === true) return { kind: "const", text: "1" };
          return null;
        }
        if (op === "||") {
          const ta = foldTruthy(a);
          const tb = foldTruthy(b);
          if (ta === true || tb === true) return { kind: "const", text: "1" };
          if (ta === false && tb === false) return { kind: "const", text: "0" };
          return null;
        }
        if (!a || !b) return null;
        const x = parseFloat(a.text);
        const y = parseFloat(b.text);
        if (op in ALU_OPCODES) {
          const value = op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : x / y;
          return constOp(value);
        }
        if (op in COMPARE_JS) return { kind: "const", text: COMPARE_JS[op](x, y) ? "1" : "0" };
        return null;
      }
      default:
        return null;
    }
  }

  /**
   * How many registers evaluating this subtree keeps busy at once. Only used
   * to pick evaluation order (register-hungrier side first); the real
   * allocation happens later over the whole program.
   */
  function pressure(node: SyntaxNode): number {
    switch (node.type) {
      case "Number":
      case "Bool":
      case "String":
      case "Device":
        return 0;
      case "DeviceProperty": {
        const base = kids(node)[0];
        // Game constants are inline; device reads occupy a register
        if (base.type !== "Device" && !lookup(base.text)) return 0;
        return 1;
      }
      case "DeviceChannelProperty":
      case "DeviceNameProperty":
      case "FunctionCall":
        return 1;
      case "VariableName":
        // Placeholders must be loaded into a register; variables are free
        return lookup(node.text) ? 0 : 1;
      case "Parens": {
        const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
        return inner ? pressure(inner) : 0;
      }
      case "UnaryOp": {
        const [op, operand] = kids(node);
        const inner = pressure(operand);
        return op.text === "+" ? inner : Math.max(inner, 1);
      }
      case "BinaryOp": {
        const [left, , right] = kids(node);
        const a = pressure(left);
        const b = pressure(right);
        return Math.max(a === b ? a + 1 : Math.max(a, b), 1);
      }
      default:
        return 0;
    }
  }

  function isBoolOperand(operand: Operand): boolean {
    if (operand.kind === "const") return operand.text === "0" || operand.text === "1";
    return operand.kind === "vreg" && boolVregs.has(operand.id);
  }

  /** Coerce an operand to an exact 0/1 value (IC10 and/or are bitwise). */
  function toBool(operand: Operand, node: SyntaxNode): Operand {
    if (isBoolOperand(operand)) return operand;
    if (operand.kind === "const") {
      return { kind: "const", text: parseFloat(operand.text) !== 0 ? "1" : "0" };
    }
    const dest = vreg();
    emit({ op: "alu", opcode: "snez", dest, args: [operand], node });
    boolVregs.add(dest);
    return { kind: "vreg", id: dest };
  }

  /** Emit a comparison as a 0/1 value, using the zero-compare forms when possible. */
  function emitComparison(op: string, a: Operand, b: Operand, node: SyntaxNode): Operand {
    if (a.kind === "const" && b.kind === "const") {
      return { kind: "const", text: COMPARE_JS[op](parseFloat(a.text), parseFloat(b.text)) ? "1" : "0" };
    }
    if (isZero(a)) {
      [op, a, b] = [MIRROR[op], b, a];
    }
    const dest = vreg();
    if (isZero(b)) {
      emit({ op: "alu", opcode: `${SET_OPCODES[op]}z`, dest, args: [a], node });
    } else {
      emit({ op: "alu", opcode: SET_OPCODES[op], dest, args: [a, b], node });
    }
    boolVregs.add(dest);
    return { kind: "vreg", id: dest };
  }

  const sym = (text: string): Operand => ({ kind: "sym", text });

  /** Pieces of a Device*Property node: base, property name, bracket index. */
  function propertyParts(node: SyntaxNode) {
    const parts = kids(node);
    return {
      base: parts[0],
      prop: parts[parts.length - 1],
      index: node.type === "DeviceProperty" ? null : parts[2],
    };
  }

  type ResolvedBase =
    | { kind: "device"; text: string }
    | { kind: "define"; text: string }
    | { kind: "unknown"; name: string };

  /** What the base of a property access refers to. */
  function resolveBase(base: SyntaxNode): ResolvedBase {
    if (base.type === "Device") return { kind: "device", text: base.text };
    const symbol = lookup(base.text);
    if (symbol?.kind === "device") return { kind: "device", text: base.text };
    if (symbol?.kind === "define") return { kind: "define", text: symbol.text };
    if (symbol?.kind === "var") {
      throw error(`${base.text} is a variable, not a device or define`, base);
    }
    return { kind: "unknown", name: base.text };
  }

  /**
   * Function-call arguments: identifiers pass through verbatim (logic types,
   * devices, defines — they are instruction operands, not values to load);
   * strings name IC10 symbols directly; everything else compiles normally.
   */
  function compileCallArg(node: SyntaxNode): Operand {
    if (node.type === "Device") return sym(node.text);
    if (node.type === "String") return sym(node.text.slice(1, -1));
    if (node.type === "VariableName") {
      const symbol = lookup(node.text);
      if (!symbol) return sym(node.text);
      if (symbol.kind === "device") return sym(node.text);
    }
    return compileExpression(node);
  }

  /** The slot index of a device[...] access. */
  function slotIndexOperand(index: SyntaxNode): Operand {
    if (index.type === "Integer") return { kind: "const", text: index.text };
    if (index.type === "String") throw error("Slot indexes must be numbers", index);
    return compileCallArg(index);
  }

  /** The name filter of a deviceGroup[...] access, hashed when a string. */
  function nameHashOperand(index: SyntaxNode): Operand {
    if (index.type === "String") return sym(`HASH(${index.text})`);
    return compileCallArg(index);
  }

  /**
   * A function call maps directly onto an IC10 instruction: the name is the
   * opcode and, when the result is used, the destination register is the
   * first operand. Aggregators (Sum/Average/...) become batch reads.
   */
  function compileCall(node: SyntaxNode, wantValue: boolean): Operand | null {
    const parts = kids(node);
    const name = parts[0].text;
    const argNodes = parts.filter(c => EXPRESSION_TYPES.has(c.type));

    if (AGGREGATORS.has(name)) {
      if (!wantValue) throw error(`${name}(...) must be assigned to something`, node);
      const arg = argNodes.length === 1 ? argNodes[0] : null;
      if (!arg || (arg.type !== "DeviceProperty" && arg.type !== "DeviceNameProperty")) {
        throw error(`${name} expects one deviceHash.LogicType argument`, arg ?? node);
      }
      const { base, prop, index } = propertyParts(arg);
      const resolved = resolveBase(base);
      if (resolved.kind === "device") {
        throw error(`${name} works on device groups, not single devices`, base);
      }
      const hash = resolved.kind === "define" ? sym(resolved.text) : sym(`HASH("${resolved.name}")`);
      const dest = vreg();
      if (arg.type === "DeviceProperty") {
        emit({ op: "call", opcode: "lb", dest, args: [hash, sym(prop.text), sym(name)], node });
      } else {
        emit({ op: "call", opcode: "lbn", dest, args: [hash, nameHashOperand(index!), sym(prop.text), sym(name)], node });
      }
      return { kind: "vreg", id: dest };
    }

    const opcode = OPCODE_ALIASES[name] ?? name;
    const args = argNodes.map(compileCallArg);
    if (!wantValue) {
      emit({ op: "call", opcode, dest: null, args, node });
      return null;
    }
    const dest = vreg();
    emit({ op: "call", opcode, dest, args, node });
    return { kind: "vreg", id: dest };
  }

  function compileExpression(node: SyntaxNode): Operand {
    switch (node.type) {
      case "Number":
        return constOp(parseFloat(node.text)) ?? { kind: "const", text: node.text };
      case "Bool":
        return { kind: "const", text: node.text === "true" ? "1" : "0" };
      case "String":
        // Strings are hashed; HASH("...") is resolved by the game
        return sym(`HASH(${node.text})`);
      case "Device":
        throw error(`${node.text} is a device, not a value`, node);
      case "DeviceProperty": {
        const { base, prop } = propertyParts(node);
        const resolved = resolveBase(base);
        if (resolved.kind === "device") {
          const dest = vreg();
          emit({ op: "call", opcode: "l", dest, args: [sym(resolved.text), sym(prop.text)], node });
          return { kind: "vreg", id: dest };
        }
        if (resolved.kind === "define") {
          throw error("Reading from a device group needs an aggregator (Sum, Average, Minimum, Maximum)", node);
        }
        // Unknown identifiers: a game constant like DisplayMode.Seconds
        return sym(`${resolved.name}.${prop.text}`);
      }
      case "DeviceChannelProperty":
      case "DeviceNameProperty": {
        const { base, prop, index } = propertyParts(node);
        const resolved = resolveBase(base);
        if (resolved.kind !== "device") {
          throw error("Reading from a device group needs an aggregator (Sum, Average, Minimum, Maximum)", node);
        }
        const dest = vreg();
        emit({ op: "call", opcode: "ls", dest, args: [sym(resolved.text), slotIndexOperand(index!), sym(prop.text)], node });
        return { kind: "vreg", id: dest };
      }
      case "FunctionCall":
        return compileCall(node, true)!;
      case "VariableName": {
        const name = node.text;
        const symbol = lookup(name);
        if (symbol?.kind === "var") {
          const state = symbol.state;
          if (state.maybe) throw error(`${name} may be undefined`, node);
          if (!state.value) throw error(`${name} is used before being assigned`, node);
          return state.value;
        }
        if (symbol?.kind === "define") return { kind: "sym", text: symbol.text };
        if (symbol?.kind === "device") {
          throw error(`${name} is a device, not a value`, node);
        }
        // Placeholder read: must come into a register through a move
        const cached = statementLoads.get(name);
        if (cached !== undefined) return { kind: "vreg", id: cached };
        const dest = vreg();
        emit({ op: "loadname", dest, name, node });
        statementLoads.set(name, dest);
        return { kind: "vreg", id: dest };
      }
      case "Parens": {
        const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
        if (!inner) throw error("Empty parentheses", node);
        return compileExpression(inner);
      }
      case "UnaryOp": {
        const [op, operandNode] = kids(node);
        if (op.text === "+") return compileExpression(operandNode);
        const a = compileExpression(operandNode);
        if (a.kind === "const") {
          const folded = constOp(-parseFloat(a.text));
          if (folded) return folded;
        }
        const dest = vreg();
        emit({ op: "alu", opcode: "sub", dest, args: [{ kind: "const", text: "0" }, a], node });
        return { kind: "vreg", id: dest };
      }
      case "BinaryOp": {
        const [leftNode, opNode, rightNode] = kids(node);
        const op = opNode.text;

        // Evaluate the register-hungrier side first to minimize live values
        let a: Operand;
        let b: Operand;
        if (pressure(rightNode) > pressure(leftNode)) {
          b = compileExpression(rightNode);
          a = compileExpression(leftNode);
        } else {
          a = compileExpression(leftNode);
          b = compileExpression(rightNode);
        }

        if (op in COMPARE_JS) return emitComparison(op, a, b, node);

        if (op === "&&" || op === "||") {
          // As data, outside a condition. Dropped operands were pure; any
          // loads they emitted are cleaned up by dead code elimination.
          if (a.kind === "const") {
            const truthy = parseFloat(a.text) !== 0;
            if (op === "&&") return truthy ? toBool(b, node) : { kind: "const", text: "0" };
            return truthy ? { kind: "const", text: "1" } : toBool(b, node);
          }
          if (b.kind === "const") {
            const truthy = parseFloat(b.text) !== 0;
            if (op === "&&") return truthy ? toBool(a, node) : { kind: "const", text: "0" };
            return truthy ? { kind: "const", text: "1" } : toBool(a, node);
          }
          const dest = vreg();
          emit({ op: "alu", opcode: op === "&&" ? "and" : "or", dest, args: [toBool(a, node), toBool(b, node)], node });
          boolVregs.add(dest);
          return { kind: "vreg", id: dest };
        }

        // Arithmetic: constant folding first
        // (constants propagated through variables included)
        if (a.kind === "const" && b.kind === "const") {
          const x = parseFloat(a.text);
          const y = parseFloat(b.text);
          const value = op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : x / y;
          const folded = constOp(value);
          if (folded) return folded;
        }

        // Algebraic identities that make the whole operation free
        if (op === "+" && isConst(a, "0")) return b;
        if ((op === "+" || op === "-") && isConst(b, "0")) return a;
        if (op === "*" && isConst(a, "1")) return b;
        if ((op === "*" || op === "/") && isConst(b, "1")) return a;

        const dest = vreg();
        emit({ op: "alu", opcode: ALU_OPCODES[op], dest, args: [a, b], node });
        return { kind: "vreg", id: dest };
      }
      default:
        throw error(`Unexpected expression: ${node.type}`, node);
    }
  }

  /**
   * Compile a condition as control flow: branch to `target` when the
   * condition's truth equals `jumpWhen`, fall through otherwise.
   * Comparisons fuse into a single branch instruction; && and ||
   * short-circuit (so a placeholder load on the right is skipped when the
   * left side already decided).
   */
  function compileCondition(node: SyntaxNode, target: string, jumpWhen: boolean) {
    switch (node.type) {
      case "Parens": {
        const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
        if (!inner) throw error("Empty parentheses", node);
        compileCondition(inner, target, jumpWhen);
        return;
      }
      case "BinaryOp": {
        const [leftNode, opNode, rightNode] = kids(node);
        const op = opNode.text;
        if (op in COMPARE_JS) {
          let a = compileExpression(leftNode);
          let b = compileExpression(rightNode);
          let cmp = op;
          if (a.kind === "const" && b.kind === "const") {
            const outcome = COMPARE_JS[cmp](parseFloat(a.text), parseFloat(b.text));
            if (outcome === jumpWhen) emit({ op: "jump", target, node });
            return;
          }
          if (isZero(a)) {
            [cmp, a, b] = [MIRROR[cmp], b, a];
          }
          const table = jumpWhen ? BRANCH_TRUE : BRANCH_FALSE;
          if (isZero(b)) {
            emit({ op: "branch", opcode: `${table[cmp]}z`, args: [a], target, node });
          } else {
            emit({ op: "branch", opcode: table[cmp], args: [a, b], target, node });
          }
          return;
        }
        if (op === "&&" || op === "||") {
          // Short-circuit: chain branches instead of materializing a boolean
          const both = (op === "&&") === !jumpWhen;
          if (both) {
            // (&& jumping on false) or (|| jumping on true): either side decides alone
            compileCondition(leftNode, target, jumpWhen);
            compileCondition(rightNode, target, jumpWhen);
          } else {
            // The left side alone can settle the outcome the other way
            const skip = `sc${shortCircuitCounter++}`;
            compileCondition(leftNode, skip, !jumpWhen);
            compileCondition(rightNode, target, jumpWhen);
            emit({ op: "label", name: skip, node });
          }
          return;
        }
        break; // arithmetic: fall through to truthiness
      }
    }
    // Truthiness of an arbitrary value: compare against zero
    const value = compileExpression(node);
    if (value.kind === "const") {
      const truthy = parseFloat(value.text) !== 0;
      if (truthy === jumpWhen) emit({ op: "jump", target, node });
      return;
    }
    emit({ op: "branch", opcode: jumpWhen ? "bnez" : "beqz", args: [value], target, node });
  }

  function setDest(inst: Inst, dest: number) {
    if (inst.op === "alu" || inst.op === "movev" || inst.op === "loadname" || inst.op === "get") {
      inst.dest = dest;
    } else if (inst.op === "call" && inst.dest !== null) {
      inst.dest = dest;
    }
  }

  /**
   * Record an assignment's value. For demoted variables (inside an if/loop
   * that assigns them) the value is also written to the home vreg,
   * retargeting the instruction that just produced it when possible.
   */
  function assignVariable(state: VarState, value: Operand, node: SyntaxNode) {
    if (state.home !== null) {
      const last = instructions[instructions.length - 1];
      if (
        value.kind === "vreg" &&
        value.id >= statementVregBase &&
        last !== undefined &&
        destOf(last) === value.id
      ) {
        // The value was just computed by this statement; write it straight
        // into the home register instead of adding a move.
        setDest(last, state.home);
        state.value = { kind: "vreg", id: state.home };
      } else {
        emit({ op: "movev", dest: state.home, src: value, node });
        state.value = value.kind === "const" ? value : { kind: "vreg", id: state.home };
      }
    } else {
      state.value = value;
    }
    state.maybe = false;
  }

  /** Collect assignment target names inside a block (including nested constructs). */
  function collectAssignedNames(block: SyntaxNode[], out: Set<string>) {
    for (const statement of block) {
      if (statement.type === "Assignment") {
        // Only plain variable targets; device writes need no merge handling
        const target = kids(statement)[0];
        if (target?.type === "VariableName") out.add(target.text);
      } else if (statement.type === "IfExpr") {
        for (const part of kids(statement)) {
          if (part.type === "If" || part.type === "ElseIf" || part.type === "Else") {
            collectAssignedNames(blockOf(part), out);
          }
        }
      } else if (statement.type === "LoopExpr" || statement.type === "WhileExpr" || statement.type === "RepeatUntilExpr") {
        collectAssignedNames(blockOf(statement), out);
      }
    }
  }

  /** Statement children between two keyword tokens (either side optional). */
  function statementsIn(node: SyntaxNode, afterKw: string | null, beforeKw: string | null): SyntaxNode[] {
    const parts = kids(node);
    let start = 0;
    let end = parts.length;
    if (afterKw) {
      const i = parts.findIndex(c => c.type === afterKw);
      if (i >= 0) start = i + 1;
    }
    if (beforeKw) {
      const i = parts.findIndex(c => c.type === beforeKw);
      if (i >= 0) end = i;
    }
    return parts.slice(start, end).filter(c => STATEMENT_TYPES.has(c.type));
  }

  /**
   * The statement body of a construct. Function calls are both statements
   * and expressions, so bodies are delimited by keywords, not by node type.
   */
  function blockOf(node: SyntaxNode): SyntaxNode[] {
    switch (node.type) {
      case "If":
      case "ElseIf":
        return statementsIn(node, "then", null);
      case "WhileExpr":
        return statementsIn(node, "do", null);
      case "RepeatUntilExpr":
        return statementsIn(node, "repeat", "until");
      default: // Else, LoopExpr
        return statementsIn(node, null, null);
    }
  }

  /** The condition expression of an if/elif/while/repeat construct. */
  function conditionOf(node: SyntaxNode): SyntaxNode | null {
    const parts = kids(node);
    if (node.type === "RepeatUntilExpr") {
      const i = parts.findIndex(c => c.type === "until");
      return parts.slice(i + 1).find(c => EXPRESSION_TYPES.has(c.type)) ?? null;
    }
    const boundary = node.type === "WhileExpr" ? "do" : "then";
    const i = parts.findIndex(c => c.type === boundary);
    return parts.slice(0, i < 0 ? parts.length : i).find(c => EXPRESSION_TYPES.has(c.type)) ?? null;
  }

  function processBlockScoped(statements: SyntaxNode[]) {
    scopes.push(new Map());
    for (const statement of statements) processStatement(statement);
    scopes.pop();
  }

  // -------------------- variable demotion at merges ----------------------

  type Demoted = {
    state: VarState;
    savedHome: number | null;
    entryValue: Operand | null;
    entryMaybe: boolean;
  };

  /**
   * Demote every visible variable in `names` to a home vreg: reuse the
   * variable's own vreg when it owns one outright, otherwise materialize
   * the current value into a fresh register before the control flow forks.
   */
  function demoteVariables(names: Set<string>, node: SyntaxNode): Demoted[] {
    const demoted: Demoted[] = [];
    for (const name of names) {
      const symbol = lookup(name);
      if (symbol?.kind !== "var") continue; // placeholder writes need no merge handling
      const state = symbol.state;
      const record: Demoted = {
        state,
        savedHome: state.home,
        entryValue: state.value,
        entryMaybe: state.maybe,
      };
      if (state.home === null) {
        if (state.value?.kind === "vreg" && valueRefCount(state.value.id) === 1 && !scratch.has(state.value.id)) {
          // The variable owns this vreg outright: adopt it as the home
          state.home = state.value.id;
        } else {
          state.home = vreg();
          if (state.value) {
            emit({ op: "movev", dest: state.home, src: state.value, node });
            state.value = { kind: "vreg", id: state.home };
          }
        }
      }
      demoted.push(record);
    }
    return demoted;
  }

  /** After the construct: the variable lives in its home register. */
  function finalizeDemoted(demoted: Demoted[], definitelyAssigned: (d: Demoted) => boolean) {
    for (const d of demoted) {
      d.state.value = { kind: "vreg", id: d.state.home! };
      d.state.maybe = !definitelyAssigned(d);
      d.state.home = d.savedHome;
    }
  }

  // ------------------------------ if ------------------------------------

  function processIf(node: SyntaxNode) {
    type Arm = { cond: SyntaxNode | null; block: SyntaxNode[]; node: SyntaxNode; assigned: boolean };
    let arms: Arm[] = [];
    for (const part of kids(node)) {
      if (part.type === "If" || part.type === "ElseIf" || part.type === "Else") {
        const cond = part.type === "Else" ? null : conditionOf(part);
        arms.push({ cond, block: blockOf(part), node: part, assigned: false });
      }
    }

    // Resolve compile-time constant conditions: a false arm disappears, a
    // true arm becomes the unconditional tail of the chain.
    const resolved: Arm[] = [];
    for (const arm of arms) {
      if (!arm.cond) {
        resolved.push(arm);
        break;
      }
      const folded = foldExpression(arm.cond);
      if (!folded) {
        resolved.push(arm);
        continue;
      }
      if (parseFloat(folded.text) !== 0) {
        resolved.push({ ...arm, cond: null });
        break;
      }
      // Constant false: drop the arm entirely
    }
    arms = resolved;

    if (arms.length === 0) return;
    if (arms[0].cond === null) {
      // The whole if reduced to one unconditional arm
      processBlockScoped(arms[0].block);
      return;
    }

    // Demote every outer variable assigned in any arm, so all paths agree
    // on where the variable lives at the merge point.
    const assignedNames = new Set<string>();
    for (const arm of arms) collectAssignedNames(arm.block, assignedNames);
    const demoted = demoteVariables(assignedNames, node);

    const k = ifCounter++;
    const endLabel = `endif${k}`;
    let elifIndex = 0;
    const armLabels: (string | null)[] = arms.map((arm, i) => {
      if (i === 0) return null;
      return arm.cond ? `if${k}elif${elifIndex++}` : `else${k}`;
    });

    const region: IfRegion = { arms: [], endLabelName: endLabel, endLabelId: -1 };
    let assignedInAllArms = true;

    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      // Each arm starts from the pre-if variable state
      for (const d of demoted) {
        d.state.value = d.entryValue;
        d.state.maybe = d.entryMaybe;
      }

      const condFrom = nextInstId;
      if (arm.cond) {
        const next = armLabels[i + 1] ?? endLabel;
        compileCondition(arm.cond, next, false);
        statementLoads = new Map();
      }
      const condIds = idRange(condFrom, nextInstId);
      const branchIds = instructions
        .filter(inst => inst.id >= condFrom && inst.id < nextInstId && inst.op === "branch")
        .map(inst => inst.id);

      const bodyFrom = nextInstId;
      processBlockScoped(arm.block);
      const bodyTo = nextInstId - 1;

      // Did this arm leave every demoted variable definitely assigned?
      for (const d of demoted) {
        if (d.state.maybe || d.state.value === null) assignedInAllArms = false;
      }

      if (i < arms.length - 1) {
        const jumpId = emit({ op: "jump", target: endLabel, node: arm.node }).id;
        const labelName = armLabels[i + 1]!;
        const labelId = emit({ op: "label", name: labelName, node: arm.node }).id;
        region.arms.push({ condIds, branchIds, bodyFrom, bodyTo, jumpId, labelName, labelId });
      } else {
        region.arms.push({ condIds, branchIds, bodyFrom, bodyTo, jumpId: null, labelName: null, labelId: null });
      }
    }

    // A chain without an else has an implicit empty arm
    const hasElse = arms[arms.length - 1].cond === null;

    region.endLabelId = emit({ op: "label", name: endLabel, node }).id;
    ifRegions.push(region);

    finalizeDemoted(demoted, d =>
      (d.entryValue !== null && !d.entryMaybe) || (hasElse && assignedInAllArms));
  }

  // ----------------------------- loops -----------------------------------

  /** Shared lowering for all loop kinds once labels and demotion are set up. */
  function lowerLoopBody(
    body: SyntaxNode[],
    demoted: Demoted[],
    headLabel: string,
    breakLabel: string,
    continueLabel: string,
    node: SyntaxNode,
  ) {
    // Inside the body, a demoted variable's value may come from a previous
    // iteration: forget constants, and treat unassigned entries as maybes.
    for (const d of demoted) {
      d.state.value = { kind: "vreg", id: d.state.home! };
      d.state.maybe = d.entryMaybe || d.entryValue === null;
    }
    const headLabelId = emit({ op: "label", name: headLabel, node }).id;
    loopStack.push({ breakLabel, continueLabel });
    const bodyFrom = nextInstId;
    processBlockScoped(body);
    const bodyTo = nextInstId - 1;
    loopStack.pop();
    return { headLabelId, bodyFrom, bodyTo };
  }

  function processLoop(node: SyntaxNode) {
    const body = blockOf(node);
    const assigned = new Set<string>();
    collectAssignedNames(body, assigned);
    const demoted = demoteVariables(assigned, node);

    const k = loopCounter++;
    const head = `loop${k}`;
    const end = `endloop${k}`;
    const { headLabelId, bodyFrom, bodyTo } = lowerLoopBody(body, demoted, head, end, head, node);
    const backJumpId = emit({ op: "jump", target: head, node }).id;
    emit({ op: "label", name: end, node });
    loopRegions.push({ headLabelId, backJumpId, bodyFrom, bodyTo });

    // `loop` only exits through break: whether a variable was assigned by
    // the time of the break is path-dependent, so stay conservative.
    finalizeDemoted(demoted, d => d.entryValue !== null && !d.entryMaybe);
  }

  function processWhile(node: SyntaxNode) {
    const cond = conditionOf(node);
    if (!cond) throw error("Malformed while loop", node);

    const folded = foldExpression(cond);
    if (folded && parseFloat(folded.text) === 0) return; // never runs

    const body = blockOf(node);
    const assigned = new Set<string>();
    collectAssignedNames(body, assigned);
    const demoted = demoteVariables(assigned, node);

    const k = whileCounter++;
    const head = `while${k}`;
    const end = `endwhile${k}`;

    for (const d of demoted) {
      d.state.value = { kind: "vreg", id: d.state.home! };
      d.state.maybe = d.entryMaybe || d.entryValue === null;
    }
    const headLabelId = emit({ op: "label", name: head, node }).id;
    if (!folded) {
      compileCondition(cond, end, false);
      statementLoads = new Map();
    }
    loopStack.push({ breakLabel: end, continueLabel: head });
    const bodyFrom = nextInstId;
    processBlockScoped(body);
    const bodyTo = nextInstId - 1;
    loopStack.pop();
    const backJumpId = emit({ op: "jump", target: head, node }).id;
    emit({ op: "label", name: end, node });
    loopRegions.push({ headLabelId, backJumpId, bodyFrom, bodyTo });

    // The body may run zero times
    finalizeDemoted(demoted, d => d.entryValue !== null && !d.entryMaybe);
  }

  function processRepeat(node: SyntaxNode) {
    const cond = conditionOf(node);
    if (!cond) throw error("Malformed repeat loop", node);

    const body = blockOf(node);
    const assigned = new Set<string>();
    collectAssignedNames(body, assigned);
    const demoted = demoteVariables(assigned, node);

    const k = repeatCounter++;
    const head = `repeat${k}`;
    const untilLabel = `until${k}`;
    const end = `endrepeat${k}`;

    const { headLabelId, bodyFrom } = lowerLoopBody(body, demoted, head, end, untilLabel, node);
    emit({ op: "label", name: untilLabel, node });
    // Loop back while the until-condition is FALSE
    const folded = foldExpression(cond);
    const condFrom = nextInstId;
    if (folded) {
      // Constant condition: always-false loops forever, always-true falls out
      if (parseFloat(folded.text) === 0) emit({ op: "jump", target: head, node });
    } else {
      compileCondition(cond, head, false);
    }
    statementLoads = new Map();
    const bodyTo = nextInstId - 1;
    // The back jump may not exist (constant-true condition); use the last
    // emitted branch/jump if there is one.
    const last = instructions[instructions.length - 1];
    const backJumpId = last && last.id >= condFrom ? last.id : -1;
    emit({ op: "label", name: end, node });
    if (backJumpId >= 0) {
      loopRegions.push({ headLabelId, backJumpId, bodyFrom, bodyTo });
    }

    // The body always runs at least once
    finalizeDemoted(demoted, d =>
      (d.entryValue !== null && !d.entryMaybe) || (!d.state.maybe && d.state.value !== null));
  }

  // --------------------------- statements --------------------------------

  function processStatement(statement: SyntaxNode) {
    const parts = kids(statement);
    switch (statement.type) {
      case "Declaration": {
        const nameNode = parts.find(c => c.type === "VariableName");
        if (!nameNode) throw error("Malformed declaration", statement);
        if (lookup(nameNode.text)) {
          throw error(`${nameNode.text} was already defined`, nameNode);
        }
        const assignIdx = parts.findIndex(c => c.type === "Assign");
        const initializer = assignIdx >= 0 ? parts[assignIdx + 1] : undefined;
        // The initializer is evaluated before the name is bound, so a
        // same-named reference is still an IC10 passthrough.
        const value = initializer ? compileExpression(initializer) : null;
        scopes[scopes.length - 1].set(nameNode.text, { kind: "var", state: { value, maybe: false, home: null } });
        break;
      }
      case "Assignment": {
        const target = parts[0];
        const assignIdx = parts.findIndex(c => c.type === "Assign");
        const expression = assignIdx >= 0 ? parts[assignIdx + 1] : undefined;
        if (!target || !expression) throw error("Malformed assignment", statement);
        const value = compileExpression(expression);

        if (target.type === "VariableName") {
          const symbol = lookup(target.text);
          if (symbol && symbol.kind !== "var") {
            throw error(`Cannot assign to ${target.text}`, target);
          }
          if (symbol) {
            assignVariable(symbol.state, value, statement);
          } else {
            // Placeholder write: must leave the registers through a move
            emit({ op: "storename", name: target.text, src: value, node: statement });
          }
          break;
        }

        // Device and device-group writes
        const { base, prop, index } = propertyParts(target);
        const resolved = resolveBase(base);
        if (resolved.kind === "unknown") {
          throw error(`Unknown device or define ${resolved.name}`, base);
        }
        if (target.type === "DeviceProperty") {
          const opcode = resolved.kind === "device" ? "s" : "sb";
          emit({ op: "call", opcode, dest: null, args: [sym(resolved.text), sym(prop.text), value], node: statement });
        } else if (resolved.kind === "device") {
          emit({
            op: "call", opcode: "ss", dest: null,
            args: [sym(resolved.text), slotIndexOperand(index!), sym(prop.text), value],
            node: statement,
          });
        } else {
          if (target.type === "DeviceChannelProperty") {
            throw error("Device groups are selected by name, not slot", target);
          }
          emit({
            op: "call", opcode: "sbn", dest: null,
            args: [sym(resolved.text), nameHashOperand(index!), sym(prop.text), value],
            node: statement,
          });
        }
        break;
      }
      case "DeviceDeclaration": {
        const nameNode = parts.find(c => c.type === "VariableName");
        const deviceNode = parts.find(c => c.type === "Device");
        if (!nameNode || !deviceNode) throw error("Malformed device declaration", statement);
        if (lookup(nameNode.text)) {
          throw error(`${nameNode.text} was already defined`, nameNode);
        }
        scopes[scopes.length - 1].set(nameNode.text, { kind: "device", pin: deviceNode.text });
        emit({ op: "alias", name: nameNode.text, device: deviceNode.text, node: statement });
        break;
      }
      case "Definition": {
        const nameNode = parts.find(c => c.type === "VariableName");
        const assignIdx = parts.findIndex(c => c.type === "Assign");
        const valueNode = assignIdx >= 0 ? parts[assignIdx + 1] : undefined;
        if (!nameNode || !valueNode) throw error("Malformed definition", statement);
        if (lookup(nameNode.text)) {
          throw error(`${nameNode.text} was already defined`, nameNode);
        }
        const name = nameNode.text;
        let symbol: Sym;
        const folded = foldExpression(valueNode);
        if (folded) {
          // Numbers keep their name in the output via an IC10 define line
          symbol = { kind: "define", text: name, needsLine: true };
          emit({ op: "definedef", name, value: folded.text, node: statement });
        } else if (valueNode.type === "String") {
          symbol = { kind: "define", text: name, needsLine: true };
          emit({ op: "definedef", name, value: `HASH(${valueNode.text})`, node: statement });
        } else if (valueNode.type === "VariableName") {
          const referenced = lookup(valueNode.text);
          if (referenced?.kind === "define") {
            symbol = { kind: "define", text: referenced.text, needsLine: false };
          } else if (!referenced) {
            // Bare identifier: substituted verbatim, no define line
            symbol = { kind: "define", text: valueNode.text, needsLine: false };
          } else {
            throw error("define values must be constant", valueNode);
          }
        } else if (valueNode.type === "DeviceProperty") {
          // Game constants like LogicType.Temperature substitute verbatim
          const { base: constBase, prop: constProp } = propertyParts(valueNode);
          if (constBase.type === "Device" || lookup(constBase.text)) {
            throw error("define values must be constant", valueNode);
          }
          symbol = { kind: "define", text: `${constBase.text}.${constProp.text}`, needsLine: false };
        } else {
          throw error("define values must be constant", valueNode);
        }
        scopes[scopes.length - 1].set(name, symbol);
        break;
      }
      case "FunctionCall":
        compileCall(statement, false);
        break;
      case "IfExpr":
        processIf(statement);
        break;
      case "LoopExpr":
        processLoop(statement);
        break;
      case "WhileExpr":
        processWhile(statement);
        break;
      case "RepeatUntilExpr":
        processRepeat(statement);
        break;
      case "break": {
        const loop = loopStack[loopStack.length - 1];
        if (!loop) throw error("break outside of a loop", statement);
        emit({ op: "jump", target: loop.breakLabel, node: statement });
        break;
      }
      case "continue": {
        const loop = loopStack[loopStack.length - 1];
        if (!loop) throw error("continue outside of a loop", statement);
        emit({ op: "jump", target: loop.continueLabel, node: statement });
        break;
      }
      case "Instruction": {
        // yield, or sleep with one operand
        const expression = parts.find(c => EXPRESSION_TYPES.has(c.type));
        if (statement.text.startsWith("sleep")) {
          if (!expression) throw error("sleep needs a duration", statement);
          const value = compileExpression(expression);
          emit({ op: "call", opcode: "sleep", dest: null, args: [value], node: statement });
        } else {
          emit({ op: "call", opcode: "yield", dest: null, args: [], node: statement });
        }
        break;
      }
      case "Comment":
        break;
      default:
        throw error(`Unexpected statement: ${statement.type}`, statement);
    }
    statementLoads = new Map();
    statementVregBase = nextVreg;
  }

  function idRange(from: number, to: number): number[] {
    const ids: number[] = [];
    for (let i = from; i < to; i++) ids.push(i);
    return ids;
  }

  // ---------------------------------------------------------------------
  // IR helpers
  // ---------------------------------------------------------------------

  function destOf(inst: Inst): number | null {
    switch (inst.op) {
      case "alu":
      case "movev":
      case "loadname":
      case "get":
        return inst.dest;
      case "call":
        return inst.dest;
      default:
        return null;
    }
  }

  function operandsOf(inst: Inst): Operand[] {
    switch (inst.op) {
      case "alu":
      case "branch":
      case "call":
        return inst.args;
      case "movev":
      case "storename":
      case "poke":
        return [inst.src];
      default:
        return [];
    }
  }

  function usesOf(inst: Inst): number[] {
    return operandsOf(inst)
      .filter((o): o is VRegOperand => o.kind === "vreg")
      .map(o => o.id);
  }

  function symsOf(inst: Inst): string[] {
    return operandsOf(inst)
      .filter((o): o is SymOperand => o.kind === "sym")
      .map(o => o.text);
  }

  function hasSideEffect(inst: Inst): boolean {
    // Calls without a destination write devices, sleep, yield, ...
    return inst.op === "storename" || inst.op === "poke" ||
      (inst.op === "call" && inst.dest === null);
  }

  function setsEqual(a: Set<number>, b: Set<number>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }

  // ---------------------------------------------------------------------
  // 2. Dead code elimination + control-flow cleanup, to a fixed point
  // ---------------------------------------------------------------------

  /**
   * Converge the live set at every label. Loops branch backwards, so a
   * single pass is not enough: iterate until label live-sets stabilize.
   * Definitions that are dead (and side-effect free) contribute no uses.
   */
  function convergeLiveness(program: Inst[]): Map<string, Set<number>> {
    const liveAtLabel = new Map<string, Set<number>>();
    for (let pass = 0; pass < program.length + 2; pass++) {
      let changed = false;
      let live = new Set<number>();
      for (let i = program.length - 1; i >= 0; i--) {
        const inst = program[i];
        switch (inst.op) {
          case "label": {
            const previous = liveAtLabel.get(inst.name);
            if (!previous || !setsEqual(previous, live)) {
              liveAtLabel.set(inst.name, new Set(live));
              changed = true;
            }
            break;
          }
          case "jump":
            live = new Set(liveAtLabel.get(inst.target) ?? []);
            break;
          case "branch": {
            for (const v of liveAtLabel.get(inst.target) ?? []) live.add(v);
            for (const used of usesOf(inst)) live.add(used);
            break;
          }
          default: {
            const dest = destOf(inst);
            if (!hasSideEffect(inst) && dest !== null && !live.has(dest)) break; // dead
            if (dest !== null) live.delete(dest);
            for (const used of usesOf(inst)) live.add(used);
          }
        }
      }
      if (!changed) break;
    }
    return liveAtLabel;
  }

  /** Keep only instructions that contribute to a side effect. */
  function eliminateDeadCode(program: Inst[]): Inst[] {
    const liveAtLabel = convergeLiveness(program);
    let live = new Set<number>();
    // Symbol names (aliases, defines) referenced by kept instructions;
    // walking backward sees every use before its alias/define line.
    const usedSyms = new Set<string>();
    const kept: Inst[] = [];
    const keep = (inst: Inst) => {
      for (const s of symsOf(inst)) usedSyms.add(s);
      kept.push(inst);
    };
    for (let i = program.length - 1; i >= 0; i--) {
      const inst = program[i];
      switch (inst.op) {
        case "label":
          live = new Set(liveAtLabel.get(inst.name) ?? []);
          keep(inst);
          continue;
        case "jump":
          live = new Set(liveAtLabel.get(inst.target) ?? []);
          keep(inst);
          continue;
        case "branch": {
          for (const v of liveAtLabel.get(inst.target) ?? []) live.add(v);
          for (const used of usesOf(inst)) live.add(used);
          keep(inst);
          continue;
        }
        case "alias":
        case "definedef":
          if (usedSyms.has(inst.name)) keep(inst);
          continue;
      }
      const dest = destOf(inst);
      if (!hasSideEffect(inst) && (dest === null || !live.has(dest))) continue;
      if (dest !== null) live.delete(dest);
      for (const used of usesOf(inst)) live.add(used);
      keep(inst);
    }
    return kept.reverse();
  }

  /**
   * Simplify if-regions whose arms changed shape after DCE:
   *  - all arms empty: delete the whole skeleton
   *  - then-arm is exactly one jump (break/continue): fuse it into the branch
   *  - empty then over a non-empty else: invert the branch
   *  - empty else: branch straight to the end label
   * Returns null if nothing changed.
   */
  function simplifyBranches(program: Inst[]): Inst[] | null {
    const present = new Map<number, Inst>();
    for (const inst of program) present.set(inst.id, inst);
    const remove = new Set<number>();
    let changed = false;

    function armContents(arm: IfRegion["arms"][number]): Inst[] {
      return program.filter(inst =>
        inst.id >= arm.bodyFrom && inst.id <= arm.bodyTo &&
        !remove.has(inst.id) && inst.op !== "label");
    }

    // Regions were recorded innermost-first, so inner constructs collapse
    // before their parents are examined.
    for (const region of ifRegions) {
      const alive = region.arms.some(arm =>
        arm.condIds.some(id => present.has(id) && !remove.has(id)) ||
        arm.branchIds.some(id => present.has(id) && !remove.has(id)));
      if (!alive) continue;

      // A region that already fused or inverted its branch keeps its
      // meaning inside the branch instruction: never touch it again.
      if (region.simplified) continue;

      const contents = region.arms.map(armContents);

      if (contents.every(c => c.length === 0)) {
        // Nothing in any arm: delete the entire skeleton; the condition's
        // loads die in the next liveness pass.
        for (const arm of region.arms) {
          for (const id of arm.condIds) remove.add(id);
          if (arm.jumpId !== null) remove.add(arm.jumpId);
          if (arm.labelId !== null) remove.add(arm.labelId);
        }
        remove.add(region.endLabelId);
        changed = true;
        continue;
      }

      // A lone then-arm that is exactly `break`/`continue`: jump there
      // directly when the condition holds.
      if (region.arms.length === 1 && region.arms[0].branchIds.length === 1) {
        const thenArm = region.arms[0];
        const only = contents[0];
        if (only.length === 1 && only[0].op === "jump") {
          const branch = present.get(thenArm.branchIds[0]);
          if (branch && branch.op === "branch" && INVERT_BRANCH[branch.opcode]) {
            branch.opcode = INVERT_BRANCH[branch.opcode];
            branch.target = only[0].target;
            remove.add(only[0].id);
            region.simplified = true;
            changed = true;
            continue;
          }
        }
      }

      // A simple if/else: the then-arm's record carries the `else` label
      // that separates the two arms.
      if (region.arms.length === 2 && region.arms[0].labelName?.startsWith("else")) {
        const thenArm = region.arms[0];
        if (contents[0].length === 0 && contents[1].length > 0 && thenArm.branchIds.length === 1) {
          // Empty then: invert the single branch to jump over the else arm
          const branch = present.get(thenArm.branchIds[0]);
          if (branch && branch.op === "branch" && INVERT_BRANCH[branch.opcode]) {
            branch.opcode = INVERT_BRANCH[branch.opcode];
            branch.target = region.endLabelName;
            if (thenArm.jumpId !== null) remove.add(thenArm.jumpId);
            if (thenArm.labelId !== null) remove.add(thenArm.labelId);
            region.simplified = true;
            changed = true;
            continue;
          }
        }
        if (contents[0].length > 0 && contents[1].length === 0) {
          // Empty else: fall straight through to the end label
          for (const id of thenArm.branchIds) {
            const branch = present.get(id);
            if (branch && branch.op === "branch" && branch.target === thenArm.labelName) {
              branch.target = region.endLabelName;
            }
          }
          if (thenArm.jumpId !== null) remove.add(thenArm.jumpId);
          if (thenArm.labelId !== null) remove.add(thenArm.labelId);
          region.simplified = true;
          changed = true;
          continue;
        }
      }
    }

    if (!changed) return null;
    return program.filter(inst => !remove.has(inst.id));
  }

  /** Loops whose bodies emptied out are spin cycles with no effects: prune. */
  function pruneEmptyLoops(program: Inst[]): Inst[] | null {
    const present = new Map<number, Inst>();
    for (const inst of program) present.set(inst.id, inst);
    const remove = new Set<number>();

    for (const region of loopRegions) {
      if (!present.has(region.backJumpId)) continue;
      const content = program.some(inst =>
        inst.id >= region.bodyFrom && inst.id <= region.bodyTo && inst.op !== "label");
      if (!content) remove.add(region.backJumpId);
    }

    if (remove.size === 0) return null;
    return program.filter(inst => !remove.has(inst.id));
  }

  /** Instructions after an unconditional jump are unreachable until a label. */
  function removeUnreachable(program: Inst[]): Inst[] | null {
    const kept: Inst[] = [];
    let reachable = true;
    let changed = false;
    for (const inst of program) {
      if (inst.op === "label") reachable = true;
      if (!reachable) {
        changed = true;
        continue;
      }
      kept.push(inst);
      if (inst.op === "jump") reachable = false;
    }
    return changed ? kept : null;
  }

  /** A jump whose target label follows immediately (labels between) is a no-op. */
  function removeJumpsToNext(program: Inst[]): Inst[] | null {
    const remove = new Set<number>();
    for (let i = 0; i < program.length; i++) {
      const inst = program[i];
      if (inst.op !== "jump") continue;
      for (let j = i + 1; j < program.length; j++) {
        const next = program[j];
        if (next.op !== "label") break;
        if (next.name === inst.target) {
          remove.add(inst.id);
          break;
        }
      }
    }
    if (remove.size === 0) return null;
    return program.filter(inst => !remove.has(inst.id));
  }

  /** Drop labels that nothing jumps to anymore. */
  function collectGarbageLabels(program: Inst[]): Inst[] | null {
    const targets = new Set<string>();
    for (const inst of program) {
      if (inst.op === "jump" || inst.op === "branch") targets.add(inst.target);
    }
    const kept = program.filter(inst => inst.op !== "label" || targets.has(inst.name));
    return kept.length === program.length ? null : kept;
  }

  // ---------------------------------------------------------------------
  // 3. Linear-scan register allocation with store sinking and spilling
  // ---------------------------------------------------------------------

  /**
   * Live ranges from converged dataflow: a value's range ends at the last
   * position where it is still live-in, which extends across loop back
   * edges (a value used early in a loop body is busy until the back jump).
   */
  function computeRanges(program: Inst[]) {
    const liveAtLabel = convergeLiveness(program);
    const end = new Map<number, number>();
    const useCount = new Map<number, number>();
    let live = new Set<number>();
    for (let i = program.length - 1; i >= 0; i--) {
      const inst = program[i];
      switch (inst.op) {
        case "label":
          live = new Set(liveAtLabel.get(inst.name) ?? []);
          break;
        case "jump":
          live = new Set(liveAtLabel.get(inst.target) ?? []);
          break;
        case "branch":
          for (const v of liveAtLabel.get(inst.target) ?? []) live.add(v);
          for (const used of usesOf(inst)) live.add(used);
          break;
        default: {
          const dest = destOf(inst);
          if (dest !== null) live.delete(dest);
          for (const used of usesOf(inst)) live.add(used);
        }
      }
      for (const used of usesOf(inst)) {
        useCount.set(used, (useCount.get(used) ?? 0) + 1);
      }
      // `live` is now the live-in set of instruction i
      for (const v of live) {
        if (!end.has(v)) end.set(v, i);
      }
    }
    return { end, useCount };
  }

  /**
   * Move placeholder stores earlier — right after the value they store is
   * computed — to shorten live ranges under register pressure. A store may
   * not cross another placeholder access, a yield/sleep, control flow, or
   * its own value's definition, so the observable order is unchanged.
   */
  function sinkStores(program: Inst[]): Inst[] {
    const defCount = new Map<number, number>();
    for (const inst of program) {
      const dest = destOf(inst);
      if (dest !== null) defCount.set(dest, (defCount.get(dest) ?? 0) + 1);
    }

    const result = [...program];
    for (let i = 0; i < result.length; i++) {
      const inst = result[i];
      if (inst.op !== "storename" || inst.src.kind !== "vreg") continue;
      if (defCount.get(inst.src.id) !== 1) continue;
      const value = inst.src.id;

      let target = i;
      for (let j = i - 1; j >= 0; j--) {
        const other = result[j];
        const barrier =
          other.op === "storename" || other.op === "loadname" || other.op === "call" ||
          other.op === "alias" || other.op === "definedef" ||
          other.op === "poke" || other.op === "get" ||
          other.op === "label" || other.op === "jump" || other.op === "branch" ||
          destOf(other) === value;
        if (barrier) break;
        target = j;
      }
      if (target < i) {
        result.splice(i, 1);
        result.splice(target, 0, inst);
      }
    }
    return result;
  }

  function allocateAndEmit(program: Inst[]): string {
    let nextSpillAddr = STACK_TOP;
    let storesSunk = false;

    // Repeatedly spill registers based on number of uses, breaking ties
    // by choosing the variable that blocks its register the longest.
    // Once all registers can be assigned, emit the program.
    while (true) {
      const { end, useCount } = computeRanges(program);

      const regOf = new Map<number, number>();
      const active: number[] = [];
      const free = [...registerOrder];
      let victim: number | null = null;
      let victimNode: SyntaxNode = ast;

      for (let i = 0; i < program.length && victim === null; i++) {
        const dest = destOf(program[i]);
        if (dest === null) continue;
        if (regOf.has(dest)) continue; // later write to a home vreg

        // Values not live past this point release their register:
        // IC10 reads operands before writing the destination.
        for (let k = active.length - 1; k >= 0; k--) {
          const v = active[k];
          if ((end.get(v) ?? i) <= i) {
            active.splice(k, 1);
            free.push(regOf.get(v)!);
          }
        }

        if (free.length === 0) {
          // Spill the least-used value; break ties toward the one that
          // blocks its register the longest.
          const candidates = [...active, dest].filter(v => !scratch.has(v));
          if (candidates.length === 0) {
            throw error("Expression too complex: not enough registers", program[i].node);
          }
          candidates.sort((x, y) =>
            (useCount.get(x) ?? 0) - (useCount.get(y) ?? 0) ||
            (end.get(y) ?? 0) - (end.get(x) ?? 0) ||
            y - x);
          victim = candidates[0];
          victimNode = program[i].node;
          break;
        }

        free.sort((a, b) => registerOrder.indexOf(a) - registerOrder.indexOf(b));
        regOf.set(dest, free.shift()!);
        active.push(dest);
      }

      if (victim === null) {
        // Success: render the IR with real registers
        const fmt = (operand: Operand): string =>
          operand.kind === "vreg" ? `r${regOf.get(operand.id)}` : operand.text;
        return program
          .map(inst => {
            switch (inst.op) {
              case "alu": return `${inst.opcode} r${regOf.get(inst.dest)} ${inst.args.map(fmt).join(" ")}`;
              case "movev": return `move r${regOf.get(inst.dest)} ${fmt(inst.src)}`;
              case "loadname": return `move r${regOf.get(inst.dest)} ${inst.name}`;
              case "storename": return `move ${inst.name} ${fmt(inst.src)}`;
              case "get": return `get r${regOf.get(inst.dest)} db ${inst.addr}`;
              case "poke": return `poke ${inst.addr} ${fmt(inst.src)}`;
              case "call":
                return inst.dest === null
                  ? [inst.opcode, ...inst.args.map(fmt)].join(" ")
                  : [inst.opcode, `r${regOf.get(inst.dest)}`, ...inst.args.map(fmt)].join(" ");
              case "alias": return `alias ${inst.name} ${inst.device}`;
              case "definedef": return `define ${inst.name} ${inst.value}`;
              case "label": return `${inst.name}:`;
              case "jump": return `j ${inst.target}`;
              case "branch": return `${inst.opcode} ${inst.args.map(fmt).join(" ")} ${inst.target}`;
            }
          })
          .join("\n");
      }

      // First response to pressure: shorten live ranges by storing
      // placeholder results as soon as they are ready.
      if (!storesSunk) {
        storesSunk = true;
        program = sinkStores(program);
        continue;
      }

      // Rewrite the program with the victim living on the stack
      const addr = nextSpillAddr--;
      if (addr < 0) throw error("Too many variables: out of stack memory", victimNode);

      const rewritten: Inst[] = [];
      for (const inst of program) {
        if (destOf(inst) === victim) {
          // Define into a short-lived scratch register, then store
          const s = vreg();
          scratch.add(s);
          const copy = { ...inst };
          setDest(copy, s);
          rewritten.push(copy);
          rewritten.push({ op: "poke", addr, src: { kind: "vreg", id: s }, node: inst.node, id: nextInstId++ });
        } else if (usesOf(inst).includes(victim)) {
          // Reload before use; all operands of one instruction share it
          const s = vreg();
          scratch.add(s);
          rewritten.push({ op: "get", dest: s, addr, node: inst.node, id: nextInstId++ });
          const replace = (o: Operand): Operand =>
            o.kind === "vreg" && o.id === victim ? { kind: "vreg", id: s } : o;
          switch (inst.op) {
            case "alu":
            case "branch":
            case "call":
              rewritten.push({ ...inst, args: inst.args.map(replace) });
              break;
            case "movev":
            case "storename":
            case "poke":
              rewritten.push({ ...inst, src: replace(inst.src) });
              break;
          }
        } else {
          rewritten.push(inst);
        }
      }
      program = rewritten;
    }
  }

  // ---------------------------------------------------------------------

  checkSyntax(ast);
  for (const statement of ast.children) {
    processStatement(statement);
  }

  let program: Inst[] = instructions;
  while (true) {
    program = eliminateDeadCode(program);
    const next =
      simplifyBranches(program) ??
      pruneEmptyLoops(program) ??
      removeUnreachable(program) ??
      removeJumpsToNext(program) ??
      collectGarbageLabels(program);
    if (!next) break;
    program = next;
  }

  return allocateAndEmit(program);
}
