
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
  "FunctionDef", "Return", "PreprocessorDirective",
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
  | { id: number; op: "branch"; opcode: string; args: Operand[]; target: string; node: SyntaxNode }
  // Function call/return: jal jumps to the function's label and comes back;
  // ret emits `j ra`. Parameters and results travel through shared vregs.
  | { id: number; op: "jal"; target: string; node: SyntaxNode }
  | { id: number; op: "ret"; fn: string; node: SyntaxNode };

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
  | { kind: "define"; text: string; needsLine: boolean }
  // A read-only parameter of an inlined function: each use re-compiles the
  // argument expression in the caller's scope (textual inlining)
  | { kind: "alias"; argNode: SyntaxNode; callerScopes: Map<string, Sym>[]; callerBase: number };

/** A user-defined function, registered before anything is lowered. */
type FnInfo = {
  name: string;
  params: string[];
  body: SyntaxNode[];
  constexpr: boolean;
  node: SyntaxNode;
  callCount: number;
  // Filled in when the function is lowered for jal-style calls
  paramVregs: number[] | null;
  retVreg: number | null;
  lowered: Inst[] | null;
};

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
  let inlineCounter = 0;
  const scratch = new Set<number>();   // vregs created by spilling; never re-spilled
  const boolVregs = new Set<number>(); // vregs known to hold 0/1

  // Innermost scope last; declarations die when their scope is popped
  const scopes: Map<string, Sym>[] = [new Map()];
  // Variables in scopes below this index are invisible: function bodies see
  // globals' devices/defines/functions but not the caller's variables.
  let functionScopeBase = 0;
  // Targets for break/continue of the innermost enclosing loop
  const loopStack: { breakLabel: string; continueLabel: string }[] = [];
  // Where `return` should deliver its value and jump to
  const returnStack: { home: number; endLabel: string }[] = [];
  // User-defined functions and lowering state
  const fnTable = new Map<string, FnInfo>();
  const registeredFnNodes = new Set<SyntaxNode>();
  const loweringStack: string[] = [];
  const inlineStack: string[] = [];
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

  // Function bodies are emitted into their own buffers and assembled in
  // front of the main program later.
  let emitBuffer: Inst[] = instructions;

  function emit(inst: DistributiveOmit<Inst, "id">): Inst {
    const complete = { ...inst, id: nextInstId++ } as Inst;
    emitBuffer.push(complete);
    return complete;
  }

  function lookup(name: string): Sym | null {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const symbol = scopes[i].get(name);
      if (symbol) {
        // Caller variables are not visible inside a function body
        if ((symbol.kind === "var" || symbol.kind === "alias") && i < functionScopeBase) return null;
        return symbol;
      }
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
        if (op.text === "-") return constOp(-parseFloat(value.text));
        if (op.text === "!") return { kind: "const", text: parseFloat(value.text) === 0 ? "1" : "0" };
        return value;
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

    // User-defined functions take precedence over raw opcodes
    const fn = fnTable.get(name);
    if (fn) {
      if (argNodes.length !== fn.params.length) {
        throw error(`${name} expects ${fn.params.length} argument${fn.params.length === 1 ? "" : "s"}`, node);
      }

      // Constant arguments to a @constexpr function: run it now
      if (fn.constexpr) {
        const folded = argNodes.map(a => foldExpression(a));
        if (folded.every(v => v !== null)) {
          const result = evalConstexpr(fn, folded.map(v => parseFloat(v!.text)));
          if (result !== null) {
            const value = constOp(result);
            if (value) return wantValue ? value : null;
          }
        }
      }

      // A function with a single call site is inlined at that site
      if (fn.callCount === 1) return inlineCall(fn, argNodes, node, wantValue);

      // jal-style call: arguments land in the function's parameter vregs
      const args = argNodes.map(a => compileExpression(a));
      if (!fn.lowered) lowerFunction(fn, node);
      args.forEach((a, i) => emit({ op: "movev", dest: fn.paramVregs![i], src: a, node }));
      emit({ op: "jal", target: fn.name, node });
      if (!wantValue) return null;
      // Copy the result out so a later call cannot clobber it; the copy
      // vanishes when the allocator gives both sides the same register.
      const copy = vreg();
      emit({ op: "movev", dest: copy, src: { kind: "vreg", id: fn.retVreg! }, node });
      return { kind: "vreg", id: copy };
    }

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
        if (symbol?.kind === "alias") {
          // Inlined read-only parameter: compile the argument expression in
          // the caller's scope, where its names resolve.
          const savedScopes = scopes.slice();
          const savedBase = functionScopeBase;
          scopes.length = 0;
          scopes.push(...symbol.callerScopes);
          functionScopeBase = symbol.callerBase;
          const value = compileExpression(symbol.argNode);
          scopes.length = 0;
          scopes.push(...savedScopes);
          functionScopeBase = savedBase;
          return value;
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
        if (op.text === "!") {
          // Logical NOT: seqz gives an exact 0/1 for any input
          if (a.kind === "const") {
            return { kind: "const", text: parseFloat(a.text) === 0 ? "1" : "0" };
          }
          const dest = vreg();
          emit({ op: "alu", opcode: "seqz", dest, args: [a], node });
          boolVregs.add(dest);
          return { kind: "vreg", id: dest };
        }
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
      case "UnaryOp": {
        // Logical NOT in a condition is free: flip the branch polarity
        const [op, operandNode] = kids(node);
        if (op.text === "!") {
          compileCondition(operandNode, target, !jumpWhen);
          return;
        }
        break; // arithmetic negation: fall through to truthiness
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
   * Put a value into a specific vreg, retargeting the instruction that just
   * produced it instead of adding a move whenever possible.
   */
  function writeThrough(home: number, value: Operand, node: SyntaxNode) {
    const last = emitBuffer[emitBuffer.length - 1];
    if (
      value.kind === "vreg" &&
      value.id >= statementVregBase &&
      last !== undefined &&
      destOf(last) === value.id
    ) {
      setDest(last, home);
    } else {
      emit({ op: "movev", dest: home, src: value, node });
    }
  }

  /**
   * Record an assignment's value. For demoted variables (inside an if/loop
   * that assigns them) the value is also written to the home vreg.
   */
  function assignVariable(state: VarState, value: Operand, node: SyntaxNode) {
    if (state.home !== null) {
      writeThrough(state.home, value, node);
      state.value = value.kind === "const" ? value : { kind: "vreg", id: state.home };
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

  // ---------------------------- functions --------------------------------

  /** Register all top-level function definitions before lowering anything. */
  function registerFunctions() {
    let pendingConstexpr = false;
    for (const statement of kids(ast)) {
      if (statement.type === "PreprocessorDirective") {
        const directive = kids(statement).find(c => c.type === "DirectiveName");
        if (directive?.text !== "constexpr") {
          throw error(`Unknown directive @${directive?.text ?? ""}`, statement);
        }
        pendingConstexpr = true;
        continue;
      }
      if (statement.type === "FunctionDef") {
        const parts = kids(statement);
        const nameNode = parts.find(c => c.type === "FunctionName");
        const block = parts.find(c => c.type === "FunctionBlock");
        if (!nameNode || !block) throw error("Malformed function definition", statement);
        if (fnTable.has(nameNode.text)) {
          throw error(`${nameNode.text} was already defined`, nameNode);
        }
        const blockIdx = parts.indexOf(block);
        const params = parts.slice(0, blockIdx).filter(c => c.type === "VariableName").map(c => c.text);
        fnTable.set(nameNode.text, {
          name: nameNode.text,
          params,
          body: kids(block).filter(c => STATEMENT_TYPES.has(c.type)),
          constexpr: pendingConstexpr,
          node: statement,
          callCount: 0,
          paramVregs: null,
          retVreg: null,
          lowered: null,
        });
        registeredFnNodes.add(statement);
      }
      pendingConstexpr = false;
    }

    // Count call sites for the inline-single-use decision
    const countIn = (node: SyntaxNode) => {
      if (node.type === "FunctionCall") {
        const name = kids(node).find(c => c.type === "FunctionName")?.text;
        const fn = name ? fnTable.get(name) : undefined;
        if (fn) fn.callCount++;
      }
      for (const child of node.children) countIn(child);
    };
    countIn(ast);
  }

  function countReturns(block: SyntaxNode[]): number {
    let count = 0;
    const walk = (node: SyntaxNode) => {
      if (node.type === "Return") count++;
      // Nested function definitions are rejected elsewhere
      for (const child of node.children) walk(child);
    };
    for (const statement of block) walk(statement);
    return count;
  }

  /**
   * Interpret a @constexpr function at compile time. Returns null when the
   * body does something that only exists at runtime (placeholders, devices,
   * raw instructions) or when the evaluation budget runs out.
   */
  function evalConstexpr(fn: FnInfo, args: number[]): number | null {
    const BAIL = { bail: true };
    let steps = 0;
    const tick = () => {
      if (++steps > 200000) throw BAIL;
    };

    type Env = Map<string, number>[];
    const findEnv = (envs: Env, name: string): Map<string, number> | null => {
      for (let i = envs.length - 1; i >= 0; i--) {
        if (envs[i].has(name)) return envs[i];
      }
      return null;
    };

    const evalNode = (node: SyntaxNode, envs: Env): number => {
      tick();
      switch (node.type) {
        case "Number": return parseFloat(node.text);
        case "Bool": return node.text === "true" ? 1 : 0;
        case "VariableName": {
          const env = findEnv(envs, node.text);
          if (!env) throw BAIL;
          return env.get(node.text)!;
        }
        case "Parens": {
          const inner = kids(node).find(c => EXPRESSION_TYPES.has(c.type));
          if (!inner) throw BAIL;
          return evalNode(inner, envs);
        }
        case "UnaryOp": {
          const [op, operand] = kids(node);
          const value = evalNode(operand, envs);
          if (op.text === "-") return -value;
          if (op.text === "!") return value === 0 ? 1 : 0;
          return value;
        }
        case "BinaryOp": {
          const [left, opNode, right] = kids(node);
          const op = opNode.text;
          if (op === "&&") return evalNode(left, envs) !== 0 && evalNode(right, envs) !== 0 ? 1 : 0;
          if (op === "||") return evalNode(left, envs) !== 0 || evalNode(right, envs) !== 0 ? 1 : 0;
          const x = evalNode(left, envs);
          const y = evalNode(right, envs);
          if (op in COMPARE_JS) return COMPARE_JS[op](x, y) ? 1 : 0;
          switch (op) {
            case "+": return x + y;
            case "-": return x - y;
            case "*": return x * y;
            case "/": return x / y;
          }
          throw BAIL;
        }
        case "FunctionCall": {
          const parts = kids(node);
          const callee = fnTable.get(parts[0].text);
          if (!callee) throw BAIL;
          const argNodes = parts.filter(c => EXPRESSION_TYPES.has(c.type));
          if (argNodes.length !== callee.params.length) throw BAIL;
          return run(callee, argNodes.map(a => evalNode(a, envs)));
        }
        default:
          throw BAIL;
      }
    };

    const RETURN = { value: 0 };
    const BREAK = { brk: true };
    const CONTINUE = { cont: true };

    const execBlock = (block: SyntaxNode[], envs: Env) => {
      envs.push(new Map());
      try {
        for (const statement of block) execStatement(statement, envs);
      } finally {
        envs.pop();
      }
    };

    const execStatement = (statement: SyntaxNode, envs: Env) => {
      tick();
      const parts = kids(statement);
      switch (statement.type) {
        case "Declaration": {
          const nameNode = parts.find(c => c.type === "VariableName")!;
          const assignIdx = parts.findIndex(c => c.type === "Assign");
          const value = assignIdx >= 0 ? evalNode(parts[assignIdx + 1], envs) : NaN;
          envs[envs.length - 1].set(nameNode.text, value);
          return;
        }
        case "Assignment": {
          const target = parts[0];
          if (target.type !== "VariableName") throw BAIL;
          const env = findEnv(envs, target.text);
          if (!env) throw BAIL; // placeholder write = side effect
          const assignIdx = parts.findIndex(c => c.type === "Assign");
          env.set(target.text, evalNode(parts[assignIdx + 1], envs));
          return;
        }
        case "Return": {
          const expr = parts.find(c => EXPRESSION_TYPES.has(c.type));
          if (!expr) throw BAIL;
          RETURN.value = evalNode(expr, envs);
          throw RETURN;
        }
        case "IfExpr": {
          for (const part of parts) {
            if (part.type === "If" || part.type === "ElseIf") {
              const cond = conditionOf(part);
              if (cond && evalNode(cond, envs) !== 0) {
                execBlock(blockOf(part), envs);
                return;
              }
            } else if (part.type === "Else") {
              execBlock(blockOf(part), envs);
              return;
            }
          }
          return;
        }
        case "LoopExpr":
        case "WhileExpr":
        case "RepeatUntilExpr": {
          const cond = statement.type === "LoopExpr" ? null : conditionOf(statement);
          const body = blockOf(statement);
          for (;;) {
            tick();
            if (statement.type === "WhileExpr" && cond && evalNode(cond, envs) === 0) return;
            try {
              execBlock(body, envs);
            } catch (e) {
              if (e === BREAK) return;
              if (e !== CONTINUE) throw e;
            }
            if (statement.type === "RepeatUntilExpr" && cond && evalNode(cond, envs) !== 0) return;
          }
        }
        case "break": throw BREAK;
        case "continue": throw CONTINUE;
        case "Comment": return;
        default:
          throw BAIL; // yield/sleep/devices/etc. only exist at runtime
      }
    };

    const run = (callee: FnInfo, argValues: number[]): number => {
      tick();
      const envs: Env = [new Map(callee.params.map((p, i) => [p, argValues[i]]))];
      try {
        for (const statement of callee.body) execStatement(statement, envs);
      } catch (e) {
        if (e === RETURN) return RETURN.value;
        throw e;
      }
      throw BAIL; // fell off the end without returning a value
    };

    try {
      const result = run(fn, args);
      return Number.isFinite(result) ? result : null;
    } catch (e) {
      if (e === BAIL) return null;
      throw e;
    }
  }

  /** Inline a single-call-site function at its call site (textual inlining). */
  function inlineCall(fn: FnInfo, argNodes: SyntaxNode[], node: SyntaxNode, wantValue: boolean): Operand | null {
    if (inlineStack.includes(fn.name) || loweringStack.includes(fn.name)) {
      throw error(`Recursive functions are not supported: ${fn.name}`, node);
    }
    inlineStack.push(fn.name);

    const callerScopes = scopes.slice();
    const callerBase = functionScopeBase;

    // Parameters that the body reassigns must become real variables,
    // evaluated once up front; read-only parameters stay lazy aliases.
    const reassigned = new Set<string>();
    collectAssignedNames(fn.body, reassigned);
    const paramScope = new Map<string, Sym>();
    fn.params.forEach((param, i) => {
      if (reassigned.has(param)) {
        const value = compileExpression(argNodes[i]);
        paramScope.set(param, { kind: "var", state: { value, maybe: false, home: null } });
      } else {
        paramScope.set(param, { kind: "alias", argNode: argNodes[i], callerScopes, callerBase });
      }
    });

    scopes.push(paramScope);
    const savedBase = functionScopeBase;
    functionScopeBase = scopes.length - 1;

    let result: Operand | null = null;
    const last = fn.body[fn.body.length - 1];
    if (last?.type === "Return" && countReturns(fn.body) === 1) {
      // Single trailing return: the result is just an operand
      for (const statement of fn.body.slice(0, -1)) processStatement(statement);
      const expr = kids(last).find(c => EXPRESSION_TYPES.has(c.type));
      if (!expr) throw error("return needs a value", last);
      if (wantValue) result = compileExpression(expr);
    } else {
      const home = vreg();
      const endLabel = `inline${inlineCounter++}`;
      returnStack.push({ home, endLabel });
      for (const statement of fn.body) processStatement(statement);
      returnStack.pop();
      emit({ op: "label", name: endLabel, node });
      if (wantValue) result = { kind: "vreg", id: home };
    }

    functionScopeBase = savedBase;
    scopes.pop();
    inlineStack.pop();
    return result;
  }

  /** Lower a function body into its own buffer for jal-style calls. */
  function lowerFunction(fn: FnInfo, node: SyntaxNode) {
    if (loweringStack.includes(fn.name) || inlineStack.includes(fn.name)) {
      throw error(`Recursive functions are not supported: ${fn.name}`, node);
    }
    loweringStack.push(fn.name);

    const buffer: Inst[] = [];
    const savedBuffer = emitBuffer;
    const savedBase = functionScopeBase;
    const savedScopesLength = scopes.length;
    const savedLoads = statementLoads;
    const savedVregBase = statementVregBase;
    emitBuffer = buffer;
    statementLoads = new Map();

    fn.paramVregs = fn.params.map(() => vreg());
    fn.retVreg = vreg();
    const paramScope = new Map<string, Sym>();
    fn.params.forEach((param, i) => {
      paramScope.set(param, {
        kind: "var",
        state: { value: { kind: "vreg", id: fn.paramVregs![i] }, maybe: false, home: null },
      });
    });
    scopes.push(paramScope);
    functionScopeBase = scopes.length - 1;

    const endLabel = `end${fn.name}`;
    emit({ op: "label", name: fn.name, node: fn.node });
    returnStack.push({ home: fn.retVreg, endLabel });
    for (const statement of fn.body) processStatement(statement);
    returnStack.pop();
    emit({ op: "label", name: endLabel, node: fn.node });

    // Non-leaf functions must save the return address around their calls
    if (buffer.some(inst => inst.op === "jal")) {
      buffer.splice(1, 0, {
        op: "call", opcode: "push", dest: null, args: [sym("ra")], node: fn.node, id: nextInstId++,
      } as Inst);
      emit({ op: "call", opcode: "pop", dest: null, args: [sym("ra")], node: fn.node });
    }
    emit({ op: "ret", fn: fn.name, node: fn.node });

    scopes.length = savedScopesLength;
    functionScopeBase = savedBase;
    emitBuffer = savedBuffer;
    statementLoads = savedLoads;
    statementVregBase = savedVregBase;
    loweringStack.pop();
    fn.lowered = buffer;
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
      case "FunctionDef": {
        if (!registeredFnNodes.has(statement)) {
          throw error("Functions must be defined at the top level", statement);
        }
        break; // registered up front; lowered lazily when called
      }
      case "PreprocessorDirective": {
        if (scopes.length > 1) {
          throw error("Directives must appear at the top level", statement);
        }
        break; // handled during function registration
      }
      case "Return": {
        const context = returnStack[returnStack.length - 1];
        if (!context) throw error("return outside of a function", statement);
        const expression = parts.find(c => EXPRESSION_TYPES.has(c.type));
        if (!expression) throw error("return needs a value", statement);
        const value = compileExpression(expression);
        writeThrough(context.home, value, statement);
        emit({ op: "jump", target: context.endLabel, node: statement });
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
  function convergeLiveness(program: Inst[]) {
    const liveAtLabel = new Map<string, Set<number>>();
    // What is live after a function returns: the union over its call sites
    const retLive = new Map<string, Set<number>>();
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
          case "jal": {
            // Values live after the call flow through the callee's body
            let after = retLive.get(inst.target);
            if (!after) retLive.set(inst.target, after = new Set());
            for (const v of live) {
              if (!after.has(v)) {
                after.add(v);
                changed = true;
              }
            }
            live = new Set(liveAtLabel.get(inst.target) ?? []);
            break;
          }
          case "ret":
            live = new Set(retLive.get(inst.fn) ?? []);
            break;
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
    return { liveAtLabel, retLive };
  }

  /** Keep only instructions that contribute to a side effect. */
  function eliminateDeadCode(program: Inst[]): Inst[] {
    const { liveAtLabel, retLive } = convergeLiveness(program);
    let live = new Set<number>();
    // Symbol names (aliases, defines) referenced by kept instructions.
    // Function bodies sit in front of the main program, so a use can
    // appear at an earlier position than its alias line: decide the
    // alias/define lines in a second sweep once all uses are known.
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
        case "jal":
          live = new Set(liveAtLabel.get(inst.target) ?? []);
          keep(inst);
          continue;
        case "ret":
          live = new Set(retLive.get(inst.fn) ?? []);
          keep(inst);
          continue;
        case "alias":
        case "definedef":
          kept.push(inst); // decided below, once every use is known
          continue;
      }
      const dest = destOf(inst);
      if (!hasSideEffect(inst) && (dest === null || !live.has(dest))) continue;
      if (dest !== null) live.delete(dest);
      for (const used of usesOf(inst)) live.add(used);
      keep(inst);
    }
    return kept
      .reverse()
      .filter(inst => (inst.op !== "alias" && inst.op !== "definedef") || usedSyms.has(inst.name));
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

      // A then-arm that is exactly one jump (break/continue/return): jump
      // there directly when the condition holds; any else arm falls through.
      if (region.arms.length <= 2 && region.arms[0].branchIds.length === 1) {
        const thenArm = region.arms[0];
        const only = contents[0];
        if (only.length === 1 && only[0].op === "jump" &&
            (region.arms.length === 1 || thenArm.labelName?.startsWith("else"))) {
          const branch = present.get(thenArm.branchIds[0]);
          if (branch && branch.op === "branch" && INVERT_BRANCH[branch.opcode]) {
            branch.opcode = INVERT_BRANCH[branch.opcode];
            branch.target = only[0].target;
            remove.add(only[0].id);
            if (thenArm.jumpId !== null) remove.add(thenArm.jumpId);
            if (thenArm.labelId !== null) remove.add(thenArm.labelId);
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
      if (inst.op === "jump" || inst.op === "ret") reachable = false;
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
      if (inst.op === "jump" || inst.op === "branch" || inst.op === "jal") targets.add(inst.target);
    }
    const kept = program.filter(inst => inst.op !== "label" || targets.has(inst.name));
    return kept.length === program.length ? null : kept;
  }

  // ---------------------------------------------------------------------
  // 3. Linear-scan register allocation with store sinking and spilling
  // ---------------------------------------------------------------------

  /**
   * Live ranges from converged dataflow, split into one segment per code
   * region (main and each function body). A value live across a call is
   * live inside the callee's positions too, so segments capture exactly
   * where a register is needed — between its segments (other functions
   * that never run while it is in flight) the register is free.
   */
  function computeSegments(program: Inst[]) {
    const { liveAtLabel, retLive } = convergeLiveness(program);

    // Every position where each vreg needs its register
    const touched = new Map<number, Set<number>>();
    const useCount = new Map<number, number>();
    const defPositions = new Map<number, Set<number>>();
    const touch = (v: number, position: number) => {
      let positions = touched.get(v);
      if (!positions) touched.set(v, positions = new Set());
      positions.add(position);
    };

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
        case "jal":
          live = new Set(liveAtLabel.get(inst.target) ?? []);
          break;
        case "ret":
          live = new Set(retLive.get(inst.fn) ?? []);
          break;
        case "branch":
          for (const v of liveAtLabel.get(inst.target) ?? []) live.add(v);
          for (const used of usesOf(inst)) live.add(used);
          break;
        default: {
          const dest = destOf(inst);
          if (dest !== null) {
            live.delete(dest);
            touch(dest, i);
            let defs = defPositions.get(dest);
            if (!defs) defPositions.set(dest, defs = new Set());
            defs.add(i);
          }
          for (const used of usesOf(inst)) live.add(used);
        }
      }
      for (const used of usesOf(inst)) {
        useCount.set(used, (useCount.get(used) ?? 0) + 1);
        touch(used, i);
      }
      // `live` is now the live-in set of instruction i
      for (const v of live) touch(v, i);
    }

    // Compress each vreg's positions into maximal contiguous runs. In the
    // gaps the value is dead (it is redefined before its next segment, or
    // those positions cannot execute while it is in flight), so its
    // register is genuinely free there.
    const segments = new Map<number, { start: number; end: number }[]>();
    for (const [v, positions] of touched) {
      const sorted = [...positions].sort((a, b) => a - b);
      const runs: { start: number; end: number }[] = [];
      for (const position of sorted) {
        const last = runs[runs.length - 1];
        if (last && position === last.end + 1) last.end = position;
        else runs.push({ start: position, end: position });
      }
      segments.set(v, runs);
    }
    return { segments, useCount, defPositions };
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
          other.op === "jal" || other.op === "ret" ||
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
      const { segments, useCount, defPositions } = computeSegments(program);

      // One work item per (vreg, region) segment, in position order. The
      // first segment of a vreg picks its register; later segments occupy
      // the same register in other regions.
      type Seg = { v: number; start: number; end: number };
      const items: Seg[] = [];
      for (const [v, runs] of segments) {
        for (const span of runs) items.push({ v, start: span.start, end: span.end });
      }
      // At equal starts, segments that begin with a definition go last:
      // the values they read at that position must re-occupy their
      // registers first, so read-then-write sharing works out.
      const startsAtDef = (s: Seg) => defPositions.get(s.v)?.has(s.start) ?? false;
      items.sort((a, b) =>
        a.start - b.start ||
        (startsAtDef(a) ? 1 : 0) - (startsAtDef(b) ? 1 : 0) ||
        a.v - b.v);

      const lastEnd = new Map<number, number>();
      for (const item of items) {
        lastEnd.set(item.v, Math.max(lastEnd.get(item.v) ?? -1, item.end));
      }

      // Two segments conflict unless they only meet where one is being
      // read for the last time as the other is defined (read-then-write:
      // IC10 reads all operands before writing the destination).
      const conflicts = (a: Seg, b: Seg): boolean => {
        if (a.start > b.end || b.start > a.end) return false;
        if (a.start === b.end && defPositions.get(a.v)?.has(a.start)) return false;
        if (b.start === a.end && defPositions.get(b.v)?.has(b.start)) return false;
        return true;
      };

      const regOf = new Map<number, number>();
      const active: { v: number; reg: number; end: number }[] = [];
      let victim: number | null = null;
      let victimNode: SyntaxNode = ast;

      for (const item of items) {
        const itemStartsAtDef = startsAtDef(item);
        // Release registers whose values are not live past this point:
        // IC10 reads operands before writing the destination.
        for (let k = active.length - 1; k >= 0; k--) {
          const entry = active[k];
          if (entry.end < item.start || (entry.end === item.start && itemStartsAtDef && entry.v !== item.v)) {
            active.splice(k, 1);
          }
        }

        const assigned = regOf.get(item.v);
        if (assigned !== undefined) {
          // A later segment of an already-placed value re-occupies its register
          const holder = active.find(a => a.reg === assigned && a.v !== item.v);
          if (holder) {
            victim = holder.v;
            victimNode = program[item.start].node;
            break;
          }
          const existing = active.find(a => a.v === item.v);
          if (existing) existing.end = Math.max(existing.end, item.end);
          else active.push({ v: item.v, reg: assigned, end: item.end });
          continue;
        }

        // Registers claimed by future segments of already-placed values
        // that overlap this one are off limits.
        const forbidden = new Set<number>();
        for (const [w, reg] of regOf) {
          if (w === item.v) continue;
          const wRuns = segments.get(w);
          if (!wRuns) continue;
          for (const span of wRuns) {
            if (conflicts(item, { v: w, start: span.start, end: span.end })) {
              forbidden.add(reg);
              break;
            }
          }
        }

        const allowed = (r: number) => !forbidden.has(r) && !active.some(a => a.reg === r);
        // Prefer sharing a register with a copy's other side, so the move
        // can be elided at emission: the source when this value starts as
        // a copy, or the destination when it ends by being copied away.
        let preferred: number | undefined;
        const startInst = program[item.start];
        if (startInst?.op === "movev" && startInst.dest === item.v && startInst.src.kind === "vreg") {
          preferred = regOf.get(startInst.src.id);
        }
        if (preferred === undefined || !allowed(preferred)) {
          const endInst = program[item.end];
          if (endInst?.op === "movev" && endInst.src.kind === "vreg" && endInst.src.id === item.v) {
            preferred = regOf.get(endInst.dest);
          }
        }
        const pick = preferred !== undefined && allowed(preferred)
          ? preferred
          : registerOrder.find(allowed);
        if (pick === undefined) {
          // Spill the value that blocks its register the longest; break
          // ties toward the least-used one. Short-lived values are never
          // worth spilling — freeing their register relieves nothing.
          const candidates = [...active.map(a => a.v), item.v].filter(v => !scratch.has(v));
          if (candidates.length === 0) {
            throw error("Expression too complex: not enough registers", program[item.start].node);
          }
          candidates.sort((x, y) =>
            (lastEnd.get(y) ?? 0) - (lastEnd.get(x) ?? 0) ||
            (useCount.get(x) ?? 0) - (useCount.get(y) ?? 0) ||
            y - x);
          victim = candidates[0];
          victimNode = program[item.start].node;
          break;
        }

        regOf.set(item.v, pick);
        active.push({ v: item.v, reg: pick, end: item.end });
      }

      if (victim === null) {
        // Success. Copies where both sides landed in the same register are
        // no-ops; dropping them can expose branch-over-jump patterns
        // (e.g. a return inside an if), so clean up once more.
        program = program.filter(inst =>
          !(inst.op === "movev" && inst.src.kind === "vreg" &&
            regOf.get(inst.src.id) === regOf.get(inst.dest)));
        for (;;) {
          const refs = new Map<string, number>();
          for (const inst of program) {
            if (inst.op === "jump" || inst.op === "branch" || inst.op === "jal") {
              refs.set(inst.target, (refs.get(inst.target) ?? 0) + 1);
            }
          }
          let fused = false;
          for (let i = 0; i + 2 < program.length; i++) {
            const branch = program[i];
            const jump = program[i + 1];
            const label = program[i + 2];
            if (branch.op === "branch" && jump.op === "jump" && label.op === "label" &&
                branch.target === label.name && refs.get(label.name) === 1 &&
                INVERT_BRANCH[branch.opcode]) {
              branch.opcode = INVERT_BRANCH[branch.opcode];
              branch.target = jump.target;
              program.splice(i + 1, 2);
              fused = true;
              break;
            }
          }
          if (fused) continue;
          const next = removeJumpsToNext(program) ?? collectGarbageLabels(program);
          if (!next) break;
          program = next;
        }

        // Render the IR with real registers
        const fmt = (operand: Operand): string =>
          operand.kind === "vreg" ? `r${regOf.get(operand.id)}` : operand.text;
        const lines: string[] = [];
        for (const inst of program) {
          switch (inst.op) {
            case "alu": lines.push(`${inst.opcode} r${regOf.get(inst.dest)} ${inst.args.map(fmt).join(" ")}`); break;
            case "movev": {
              lines.push(`move r${regOf.get(inst.dest)} ${fmt(inst.src)}`);
              break;
            }
            case "loadname": lines.push(`move r${regOf.get(inst.dest)} ${inst.name}`); break;
            case "storename": lines.push(`move ${inst.name} ${fmt(inst.src)}`); break;
            case "get": lines.push(`get r${regOf.get(inst.dest)} db ${inst.addr}`); break;
            case "poke": lines.push(`poke ${inst.addr} ${fmt(inst.src)}`); break;
            case "call":
              lines.push(inst.dest === null
                ? [inst.opcode, ...inst.args.map(fmt)].join(" ")
                : [inst.opcode, `r${regOf.get(inst.dest)}`, ...inst.args.map(fmt)].join(" "));
              break;
            case "alias": lines.push(`alias ${inst.name} ${inst.device}`); break;
            case "definedef": lines.push(`define ${inst.name} ${inst.value}`); break;
            case "label": lines.push(`${inst.name}:`); break;
            case "jump": lines.push(`j ${inst.target}`); break;
            case "branch": lines.push(`${inst.opcode} ${inst.args.map(fmt).join(" ")} ${inst.target}`); break;
            case "jal": lines.push(`jal ${inst.target}`); break;
            case "ret": lines.push("j ra"); break;
          }
        }
        return lines.join("\n");
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
  registerFunctions();
  for (const statement of ast.children) {
    processStatement(statement);
  }

  // Assemble: functions first (jumped over), then the main program
  const loweredFns = [...fnTable.values()].filter(fn => fn.lowered);
  let program: Inst[];
  if (loweredFns.length > 0) {
    program = [
      { op: "jump", target: "ProgramStart", node: ast, id: nextInstId++ } as Inst,
      ...loweredFns.flatMap(fn => fn.lowered!),
      { op: "label", name: "ProgramStart", node: ast, id: nextInstId++ } as Inst,
      ...instructions,
    ];
  } else {
    program = instructions;
  }

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
