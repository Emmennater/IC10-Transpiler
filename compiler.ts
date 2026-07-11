
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
 *      If conditions compile to fused branches (ble/bgez/bnez/...) that jump
 *      when the condition is FALSE; && and || short-circuit. A variable
 *      assigned inside a branch is demoted to a "home" vreg for the duration
 *      of the if: every path writes the same vreg, so the merge needs no phi.
 *      Constant conditions skip the branch entirely and lower one arm inline.
 *   2. Dead code elimination walks the IR backwards (merging liveness at
 *      labels), keeping only instructions that contribute to a side effect
 *      (a placeholder write). A branch-simplification pass then deletes ifs
 *      whose arms are all empty and inverts branches over empty then-arms;
 *      the two passes repeat until nothing changes.
 *   3. Linear-scan register allocation maps virtual registers onto
 *      VAR_REGISTER_ORDER, reusing a register as soon as its value dies.
 *      When pressure exceeds the pool, the least-used value is spilled to a
 *      fixed stack address (511 downward: `get r? db addr` to read,
 *      `poke addr value` to write) and allocation is retried. Low stack
 *      addresses are left free for the future function call stack.
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

// Flip a branch to jump on the opposite outcome (for empty-then inversion)
const INVERT_BRANCH: Record<string, string> = {
  beq: "bne", bne: "beq", bgt: "ble", ble: "bgt", blt: "bge", bge: "blt",
  beqz: "bnez", bnez: "beqz", bgtz: "blez", blez: "bgtz", bltz: "bgez", bgez: "bltz",
};

const COMPARE_JS: Record<string, (a: number, b: number) => boolean> = {
  "==": (a, b) => a === b, "!=": (a, b) => a !== b,
  ">": (a, b) => a > b, "<": (a, b) => a < b,
  ">=": (a, b) => a >= b, "<=": (a, b) => a <= b,
};

const EXPRESSION_TYPES = new Set(["Number", "Bool", "VariableName", "Parens", "UnaryOp", "BinaryOp"]);
const STATEMENT_TYPES = new Set(["Declaration", "Assignment", "IfExpr"]);

type Operand =
  | { kind: "vreg"; id: number }
  | { kind: "const"; text: string }
  | { kind: "name"; text: string };

type Inst =
  | { id: number; op: "alu"; opcode: string; dest: number; args: Operand[]; node: SyntaxNode }
  | { id: number; op: "movev"; dest: number; src: Operand; node: SyntaxNode }
  | { id: number; op: "loadname"; dest: number; name: string; node: SyntaxNode }
  | { id: number; op: "storename"; name: string; src: Operand; node: SyntaxNode }
  | { id: number; op: "get"; dest: number; addr: number; node: SyntaxNode }
  | { id: number; op: "poke"; addr: number; src: Operand; node: SyntaxNode }
  | { id: number; op: "label"; name: string; node: SyntaxNode }
  | { id: number; op: "jump"; target: string; node: SyntaxNode }
  | { id: number; op: "branch"; opcode: string; args: Operand[]; target: string; node: SyntaxNode };

/** One variable's compile-time state. */
type VarState = {
  value: Operand | null; // null = unassigned so far
  maybe: boolean;        // assigned on some control-flow paths but not all
  home: number | null;   // while inside an if that assigns this variable,
                         // every write also lands in this vreg
};

/** Metadata for one lowered if/elif/else, used by branch simplification. */
type Region = {
  arms: {
    condIds: number[];        // everything emitted for the condition
    branchIds: number[];      // just the conditional branches
    bodyFrom: number;         // inclusive inst-id range of the arm body
    bodyTo: number;
    jumpId: number | null;    // the `j endif` after the body
    labelName: string | null; // label that starts this arm (null for the first)
    labelId: number | null;
  }[];
  endLabelName: string;
  endLabelId: number;
  simplified?: boolean; // two-arm transforms are one-shot
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
  function constOp(value: number): Operand | null {
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
  const regions: Region[] = [];
  let nextInstId = 0;
  let nextVreg = 0;
  let ifCounter = 0;
  let shortCircuitCounter = 0;
  const scratch = new Set<number>();   // vregs created by spilling; never re-spilled
  const boolVregs = new Set<number>(); // vregs known to hold 0/1

  // Innermost scope last; declarations die when their scope is popped
  const scopes: Map<string, VarState>[] = [new Map()];
  // Placeholder name -> vreg already holding it in the current statement,
  // so `a * a` loads `a` once. Not shared across statements: a placeholder
  // may be written in between, and device reads should stay explicit.
  let statementLoads = new Map<string, number>();
  // vregs created after this point belong to the current statement and are
  // safe to retarget into a home register (see writeThrough)
  let statementVregBase = 0;

  function vreg(): number {
    return nextVreg++;
  }

  function emit(inst: Omit<Inst, "id">): Inst {
    const complete = { ...inst, id: nextInstId++ } as Inst;
    instructions.push(complete);
    return complete;
  }

  function lookup(name: string): VarState | null {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const state = scopes[i].get(name);
      if (state) return state;
    }
    return null;
  }

  /** Count how many variables currently share this vreg as their value. */
  function valueRefCount(id: number): number {
    let count = 0;
    for (const scope of scopes) {
      for (const state of scope.values()) {
        if (state.value?.kind === "vreg" && state.value.id === id) count++;
      }
    }
    return count;
  }

  /**
   * Try to evaluate an expression to a compile-time constant without
   * emitting any code. Returns the folded operand or null.
   */
  function foldExpression(node: SyntaxNode): Operand | null {
    switch (node.type) {
      case "Number":
        return constOp(parseFloat(node.text));
      case "Bool":
        return { kind: "const", text: node.text === "true" ? "1" : "0" };
      case "VariableName": {
        const state = lookup(node.text);
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
        const a = foldExpression(left);
        const b = foldExpression(right);
        if (!a || !b) return null;
        const x = parseFloat(a.text);
        const y = parseFloat(b.text);
        const op = opNode.text;
        if (op in ALU_OPCODES) {
          const value = op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : x / y;
          return constOp(value);
        }
        if (op in COMPARE_JS) return { kind: "const", text: COMPARE_JS[op](x, y) ? "1" : "0" };
        if (op === "&&") return { kind: "const", text: x !== 0 && y !== 0 ? "1" : "0" };
        if (op === "||") return { kind: "const", text: x !== 0 || y !== 0 ? "1" : "0" };
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
        return 0;
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

  function compileExpression(node: SyntaxNode): Operand {
    switch (node.type) {
      case "Number":
        return constOp(parseFloat(node.text)) ?? { kind: "const", text: node.text };
      case "Bool":
        return { kind: "const", text: node.text === "true" ? "1" : "0" };
      case "VariableName": {
        const name = node.text;
        const state = lookup(name);
        if (state) {
          if (state.maybe) throw error(`${name} may be undefined`, node);
          if (!state.value) throw error(`${name} is used before being assigned`, node);
          return state.value;
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
   * short-circuit. Returns nothing — code is emitted directly.
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

  /**
   * Record an assignment's value. For demoted variables (inside an if that
   * assigns them) the value is also written to the home vreg, retargeting
   * the instruction that just produced it when possible.
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
        (last as { dest: number }).dest = state.home;
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

  /** Collect assignment target names inside a block (including nested ifs). */
  function collectAssignedNames(block: SyntaxNode[], out: Set<string>) {
    for (const statement of block) {
      if (statement.type === "Assignment") {
        const nameNode = kids(statement).find(c => c.type === "VariableName");
        if (nameNode) out.add(nameNode.text);
      } else if (statement.type === "IfExpr") {
        for (const part of kids(statement)) {
          if (part.type === "If" || part.type === "ElseIf" || part.type === "Else") {
            collectAssignedNames(armBlock(part), out);
          }
        }
      }
    }
  }

  /** The statements of an If/ElseIf/Else arm (keyword and condition nodes filtered out). */
  function armBlock(arm: SyntaxNode): SyntaxNode[] {
    return kids(arm).filter(c => STATEMENT_TYPES.has(c.type));
  }

  function armCondition(arm: SyntaxNode): SyntaxNode | null {
    if (arm.type === "Else") return null;
    // The condition is the first expression child (before `then`)
    for (const part of kids(arm)) {
      if (part.type === "then") break;
      if (EXPRESSION_TYPES.has(part.type)) return part;
    }
    return null;
  }

  function processBlockScoped(statements: SyntaxNode[]) {
    scopes.push(new Map());
    for (const statement of statements) processStatement(statement);
    scopes.pop();
  }

  function processIf(node: SyntaxNode) {
    // Gather the arms: If, ElseIf*, Else?
    type Arm = { cond: SyntaxNode | null; block: SyntaxNode[]; node: SyntaxNode };
    let arms: Arm[] = [];
    for (const part of kids(node)) {
      if (part.type === "If" || part.type === "ElseIf" || part.type === "Else") {
        arms.push({ cond: armCondition(part), block: armBlock(part), node: part });
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
        resolved.push({ cond: null, block: arm.block, node: arm.node });
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

    // Demote every outer variable assigned in any arm to a home vreg, so all
    // paths agree on where the variable lives at the merge point.
    const assignedNames = new Set<string>();
    for (const arm of arms) collectAssignedNames(arm.block, assignedNames);

    type Demoted = {
      state: VarState;
      savedHome: number | null;
      savedValue: Operand | null;
      savedMaybe: boolean;
      assignedEverywhere: boolean;
    };
    const demoted: Demoted[] = [];
    for (const name of assignedNames) {
      const state = lookup(name);
      if (!state) continue; // placeholder writes need no merge handling
      const saved: Demoted = {
        state,
        savedHome: state.home,
        savedValue: state.value,
        savedMaybe: state.maybe,
        assignedEverywhere: true,
      };
      if (state.home === null) {
        if (state.value?.kind === "vreg" && valueRefCount(state.value.id) === 1 && !boolVregs.has(state.value.id)) {
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
      demoted.push(saved);
    }

    // Emit the skeleton
    const k = ifCounter++;
    const endLabel = `endif${k}`;
    let elifIndex = 0;
    const armLabels: (string | null)[] = arms.map((arm, i) => {
      if (i === 0) return null;
      return arm.cond ? `if${k}elif${elifIndex++}` : `else${k}`;
    });

    const region: Region = { arms: [], endLabelName: endLabel, endLabelId: -1 };
    const entryValues = demoted.map(d => ({ value: d.state.value, maybe: d.state.maybe }));

    for (let i = 0; i < arms.length; i++) {
      const arm = arms[i];
      // Each arm starts from the pre-if variable state
      demoted.forEach((d, j) => {
        d.state.value = entryValues[j].value;
        d.state.maybe = entryValues[j].maybe;
      });

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

      // Track which demoted variables this arm assigned
      demoted.forEach((d, j) => {
        const assigned = d.state.value !== entryValues[j].value || (!d.state.maybe && entryValues[j].maybe);
        const assignedHere = !d.state.maybe && d.state.value !== null &&
          (d.state.value !== entryValues[j].value || entryValues[j].value !== null);
        // A variable is definitely assigned after the if only if every arm
        // assigns it or it was already assigned before the if.
        if (!(assignedHere || (entryValues[j].value !== null && !entryValues[j].maybe))) {
          d.assignedEverywhere = false;
        }
        void assigned;
      });

      let jumpId: number | null = null;
      if (i < arms.length - 1) {
        jumpId = emit({ op: "jump", target: endLabel, node: arm.node }).id;
        const labelName = armLabels[i + 1]!;
        const labelId = emit({ op: "label", name: labelName, node: arm.node }).id;
        region.arms.push({ condIds, branchIds, bodyFrom, bodyTo, jumpId, labelName, labelId });
      } else {
        region.arms.push({ condIds, branchIds, bodyFrom, bodyTo, jumpId: null, labelName: null, labelId: null });
      }
    }

    // A chain without an else has an implicit empty arm: variables are only
    // definitely assigned if they were before the if.
    const hasElse = arms[arms.length - 1].cond === null;

    region.endLabelId = emit({ op: "label", name: endLabel, node }).id;
    regions.push(region);

    // Merge: the variable now lives in its home register
    demoted.forEach((d, j) => {
      const wasAssigned = entryValues[j].value !== null && !entryValues[j].maybe;
      const definite = wasAssigned || (hasElse && d.assignedEverywhere);
      d.state.value = { kind: "vreg", id: d.state.home! };
      d.state.maybe = !definite;
      d.state.home = d.savedHome;
      void d.savedValue;
      void d.savedMaybe;
    });
  }

  function idRange(from: number, to: number): number[] {
    const ids: number[] = [];
    for (let i = from; i < to; i++) ids.push(i);
    return ids;
  }

  function processStatement(statement: SyntaxNode) {
    const parts = kids(statement);
    switch (statement.type) {
      case "Declaration": {
        const nameNode = parts.find(c => c.type === "VariableName");
        if (!nameNode) throw error("Malformed declaration", statement);
        if (lookup(nameNode.text)) {
          throw error(`${nameNode.text} was already defined`, nameNode);
        }
        const initializer = parts.find(c => EXPRESSION_TYPES.has(c.type) && c !== nameNode);
        // The initializer is evaluated before the name is bound, so a
        // same-named reference is still an IC10 passthrough.
        const value = initializer ? compileExpression(initializer) : null;
        scopes[scopes.length - 1].set(nameNode.text, { value, maybe: false, home: null });
        break;
      }
      case "Assignment": {
        const nameNode = parts.find(c => c.type === "VariableName");
        const expression = parts.find(c => EXPRESSION_TYPES.has(c.type) && c !== nameNode);
        if (!nameNode || !expression) throw error("Malformed assignment", statement);
        const value = compileExpression(expression);
        const state = lookup(nameNode.text);
        if (state) {
          assignVariable(state, value, statement);
        } else {
          // Placeholder write: must leave the registers through a move
          emit({ op: "storename", name: nameNode.text, src: value, node: statement });
        }
        break;
      }
      case "IfExpr":
        processIf(statement);
        break;
      case "Comment":
        break;
      default:
        throw error(`Unexpected statement: ${statement.type}`, statement);
    }
    statementLoads = new Map();
    statementVregBase = nextVreg;
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
      default:
        return null;
    }
  }

  function operandsOf(inst: Inst): Operand[] {
    switch (inst.op) {
      case "alu":
      case "branch":
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
      .filter(o => o.kind === "vreg")
      .map(o => (o as { kind: "vreg"; id: number }).id);
  }

  // ---------------------------------------------------------------------
  // 2. Dead code elimination + branch simplification, to a fixed point
  // ---------------------------------------------------------------------

  /**
   * Backward liveness over the linear IR. All branches are forward, so a
   * single backward pass is exact: every label's live set is known before
   * any branch to it is reached.
   */
  function eliminateDeadCode(program: Inst[]): Inst[] {
    const liveAtLabel = new Map<string, Set<number>>();
    let live = new Set<number>();
    const kept: Inst[] = [];
    for (let i = program.length - 1; i >= 0; i--) {
      const inst = program[i];
      switch (inst.op) {
        case "label":
          liveAtLabel.set(inst.name, new Set(live));
          kept.push(inst);
          continue;
        case "jump":
          live = new Set(liveAtLabel.get(inst.target) ?? []);
          kept.push(inst);
          continue;
        case "branch": {
          const atTarget = liveAtLabel.get(inst.target);
          if (atTarget) for (const v of atTarget) live.add(v);
          for (const used of usesOf(inst)) live.add(used);
          kept.push(inst);
          continue;
        }
      }
      const sideEffect = inst.op === "storename" || inst.op === "poke";
      const dest = destOf(inst);
      if (!sideEffect && (dest === null || !live.has(dest))) continue;
      if (dest !== null) live.delete(dest);
      for (const used of usesOf(inst)) live.add(used);
      kept.push(inst);
    }
    return kept.reverse();
  }

  /**
   * Simplify if-regions whose arms became empty: remove the whole skeleton
   * when nothing is left, or invert the branch over an empty then/else arm.
   * Returns null if nothing changed.
   */
  function simplifyBranches(program: Inst[]): Inst[] | null {
    const present = new Map<number, Inst>();
    for (const inst of program) present.set(inst.id, inst);
    const remove = new Set<number>();
    let changed = false;

    function armHasContent(arm: Region["arms"][number]): boolean {
      for (const inst of program) {
        if (inst.id < arm.bodyFrom || inst.id > arm.bodyTo || remove.has(inst.id)) continue;
        if (inst.op !== "label") return true;
      }
      return false;
    }

    // Regions were recorded innermost-first, so inner ifs collapse before
    // their parents are examined.
    for (const region of regions) {
      const alive = region.arms.some(arm =>
        arm.condIds.some(id => present.has(id) && !remove.has(id)) ||
        arm.branchIds.some(id => present.has(id) && !remove.has(id)));
      if (!alive) continue;

      const contents = region.arms.map(armHasContent);

      if (contents.every(c => !c)) {
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

      // A simple if/else: the then-arm's record carries the `else` label
      // that separates the two arms.
      if (region.arms.length === 2 && region.arms[0].labelName?.startsWith("else") && !region.simplified) {
        const thenArm = region.arms[0];
        if (!contents[0] && contents[1] && thenArm.branchIds.length === 1) {
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
        if (contents[0] && !contents[1]) {
          // Empty else: fall straight through to the end label
          for (const id of thenArm.branchIds) {
            const branch = present.get(id);
            if (branch && branch.op === "branch" && branch.target === thenArm.labelName) {
              branch.target = region.endLabelName;
            }
          }
          const jump = thenArm.jumpId !== null ? present.get(thenArm.jumpId) : undefined;
          if (jump) remove.add(jump.id);
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

  /** Drop labels that nothing jumps to anymore. */
  function collectGarbageLabels(program: Inst[]): Inst[] {
    const targets = new Set<string>();
    for (const inst of program) {
      if (inst.op === "jump" || inst.op === "branch") targets.add(inst.target);
    }
    return program.filter(inst => inst.op !== "label" || targets.has(inst.name));
  }

  // ---------------------------------------------------------------------
  // 3. Linear-scan register allocation with spilling
  // ---------------------------------------------------------------------

  function allocateAndEmit(program: Inst[]): string {
    let nextSpillAddr = STACK_TOP;

    for (;;) {
      // Liveness by position: all branches are forward, so [first def,
      // last use] is a sound interval even across arms.
      const lastUse = new Map<number, number>();
      const useCount = new Map<number, number>();
      program.forEach((inst, i) => {
        for (const used of usesOf(inst)) {
          lastUse.set(used, i);
          useCount.set(used, (useCount.get(used) ?? 0) + 1);
        }
      });

      const regOf = new Map<number, number>();
      const active: number[] = [];
      const free = [...registerOrder];
      let victim: number | null = null;

      for (let i = 0; i < program.length && victim === null; i++) {
        const dest = destOf(program[i]);
        if (dest === null) continue;
        if (regOf.has(dest)) continue; // later write to a home vreg

        // Values whose last use is behind us (or in this very instruction)
        // release their register: IC10 reads operands before writing.
        for (let k = active.length - 1; k >= 0; k--) {
          const v = active[k];
          if ((lastUse.get(v) ?? i) <= i) {
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
            (lastUse.get(y) ?? 0) - (lastUse.get(x) ?? 0) ||
            y - x);
          victim = candidates[0];
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
              case "label": return `${inst.name}:`;
              case "jump": return `j ${inst.target}`;
              case "branch": return `${inst.opcode} ${inst.args.map(fmt).join(" ")} ${inst.target}`;
            }
          })
          .join("\n");
      }

      // Rewrite the program with the victim living on the stack
      const addr = nextSpillAddr--;
      if (addr < 0) throw error("Too many variables: out of stack memory", program[0].node);

      const rewritten: Inst[] = [];
      for (const inst of program) {
        if (destOf(inst) === victim) {
          // Define into a short-lived scratch register, then store
          const s = vreg();
          scratch.add(s);
          rewritten.push({ ...inst, dest: s } as Inst);
          rewritten.push({ op: "poke", addr, src: { kind: "vreg", id: s }, node: inst.node, id: nextInstId++ });
        } else if (usesOf(inst).includes(victim)) {
          // Reload before use; both operands of one instruction share it
          const s = vreg();
          scratch.add(s);
          rewritten.push({ op: "get", dest: s, addr, node: inst.node, id: nextInstId++ });
          const replace = (o: Operand): Operand =>
            o.kind === "vreg" && o.id === victim ? { kind: "vreg", id: s } : o;
          switch (inst.op) {
            case "alu":
            case "branch":
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

  let program = eliminateDeadCode(instructions);
  for (;;) {
    const simplified = simplifyBranches(program);
    if (!simplified) break;
    program = eliminateDeadCode(simplified);
  }
  program = collectGarbageLabels(program);

  return allocateAndEmit(program);
}
