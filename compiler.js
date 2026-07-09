
/*
Temporary registers (r0 - r8)
Return value (r9)
Saved registers (r10 - r15)
Stack pointer (sp or r16)
Return address (ra or r17)
*/

const OP_INSTRUCTIONS = {
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "==": "seq",
  "!=": "sne",
  "<=": "sle",
  ">=": "sge",
  "<": "slt",
  ">": "sgt",
  "&&": "and",
  "||": "or",
  "++": "add",
  "--": "sub",
};

const DEVICE_REGISTERS = new Set(["d0", "d1", "d2", "d3", "d4", "d5"]);
const SAVED_REGISTERS = ["r10", "r11", "r12", "r13", "r14", "r15"];
const TEMP_REGISTERS = ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7"];
const RETURN_REGISTER = "r9";
const DUMMY_REGISER = "r8";

const STEP_SUBROUTINES = `
stepInto:
move r8 10
push rr8
add r8 r8 1
brne r8 16 -2
push sp
j ra
stepOut:
pop sp
move r8 15
pop rr8
sub r8 r8 1
brne r8 9 -2
j ra`.slice(1);

function compareRegisters(a, b) {
  // Sort registers by number (descending)
  return -a.localeCompare(b, undefined, { numeric: true });
}

function round(n) {
  return Math.round(n * 1e14) / 1e14;
}

export class CompilerError extends Error {
  static from = 0;
  static to = 0;

  constructor(message) {
    super(message);
    this.from = CompilerError.from;
    this.to = CompilerError.to;
  }

  toString() {
    return `${this.message} from ${this.from} to ${this.to}`;
  }
}

class Stack {
  constructor(size) {
    this.pointer = 0; // End of stack (next free offset)
    this.size = size; // Max stack size
    this.usedOffsets = new Map(); // Variable name -> offset
    this.freeOffsets = new Set(); // Free offsets
  }

  has(varName) {
    return this.usedOffsets.has(varName);
  }

  get(varName) {
    let offset = this.usedOffsets.get(varName);
    return offset === undefined ? this.reserve(varName) : offset;
  }

  reserve(varName) {
    // Reserve space on the stack for the variable
    // Return the offset
    if (this.freeOffsets.size > 0) {
      const offset = this.freeOffsets.values().next().value;
      this.freeOffsets.delete(offset);
      this.usedOffsets.set(varName, offset);
      return offset;
    }

    const offset = this.pointer++;
    this.usedOffsets.set(varName, offset);
    return offset;
  }

  free(varName) {
    // Free space on the stack
    const offset = this.usedOffsets.get(varName);

    if (offset === undefined) {
      throw new CompilerError("Variable not found on stack");
    }

    this.usedOffsets.delete(varName);
    this.freeOffsets.add(offset);
  }
}

class LRUCache {
  constructor(stack, registers, addInstructions) {
    this.addInstructions = addInstructions;
    this.stack = stack;
    this.var2reg = new Map(); // Variable -> register
    this.reg2var = new Map(); // Register -> variable
    this.dirtyReg = new Set(); // Registers that need to be saved
    this.registers = registers;
    this.recentRegisters = registers.slice().sort(compareRegisters); // Most recent stored at the beginning
    this.definedVars = new Set();
  }

  used(register) {
    const index = this.recentRegisters.indexOf(register);
    
    if (index == -1) {
      throw new CompilerError("Register not found");
    }

    // Move to front
    this.recentRegisters.splice(index, 1);
    this.recentRegisters.unshift(register);
  }

  notUsed(register) {
    const index = this.recentRegisters.indexOf(register);

    // Move to back
    this.recentRegisters.splice(index, 1);
    this.recentRegisters.push(register);
  }

  lru(varName) {
    let register = this.recentRegisters[this.recentRegisters.length - 1];
    let instructions = [];

    this.used(register);

    // If the old register was dirty, save it
    if (this.dirtyReg.has(register)) {
      let oldVarName = this.reg2var.get(register);
      let stackOffset = this.stack.get(oldVarName);
    
      if (stackOffset == 0) {
        // No need to calculate the stack offset when the offset is 0
        instructions.push(`put db sp ${register}`);
      } else {
        instructions.push(`add ${DUMMY_REGISER} sp ${stackOffset}`);
        instructions.push(`put db ${DUMMY_REGISER} ${register}`);
      }

      this.dirtyReg.delete(register);
      this.var2reg.delete(oldVarName);
    }

    this.var2reg.set(varName, register);
    this.reg2var.set(register, varName);
    this.addInstructions(instructions);
  
    return register;
  }

  has(varName) {
    return this.var2reg.has(varName) || this.stack.has(varName);
  }

  load(varName) {
    let register = this.var2reg.get(varName);

    if (register !== undefined) {
      // Register hit
      this.used(register);
      return register;
    }

    // Check if the variable has been created
    if (!this.isDefined(varName)) {
      throw new CompilerError(`${varName} is not defined`);
    }

    register = this.lru(varName);
    
    return register;
  }

  get(varName) {
    let register = this.var2reg.get(varName);

    if (register !== undefined) {
      // Register hit
      this.used(register);
      return register;
    }

    // Check if the variable has been created
    if (!this.isDefined(varName)) {
      throw new CompilerError(`${varName} is not defined`);
    }

    register = this.lru(varName);

    if (!this.stack.has(varName)) {
      return register;
    }

    // Load the variable into the register
    let stackOffset = this.stack.get(varName);
    let instructions = [];

    if (stackOffset == 0) {
      // No need to calculate the stack offset when the offset is 0
      instructions.push(`get ${register} db sp`);
    } else {
      instructions.push(`add ${DUMMY_REGISER} sp ${stackOffset}`);
      instructions.push(`get ${register} db ${DUMMY_REGISER}`);
    }

    this.addInstructions(instructions);

    return register;
  }

  free(varName) {
    let register = this.var2reg.get(varName);
    // console.log("freed", varName, register);
    if (this.stack.has(varName)) this.stack.free(varName);
    this.var2reg.delete(varName);
    this.reg2var.delete(register);
    this.dirtyReg.delete(register);
    this.notUsed(register);
    this.definedVars.delete(varName);
  }

  isDefined(varName) {
    // Exception for temporary variables
    if (varName.startsWith("*") || varName.startsWith("v*")) return true;

    return this.has(varName) || this.definedVars.has(varName);
  }

  define(varName) {
    if (this.isDefined(varName)) {
      throw new CompilerError(`${varName} was already defined`);
    }

    this.definedVars.add(varName);
  }

  assign(varName, register) {
    if (this.var2reg.has(varName)) {
      throw new CompilerError(`Variable ${varName} is already assigned!`);
    }

    this.var2reg.set(varName, register);
    this.reg2var.set(register, varName);
    this.used(register);
  }
}

class Cache {
  // TODO:
  // When adding variable scopes, use this to track the active scope
  // The compiler will automatically update this depending on the current scope
  static activeScope = null;

  constructor(addInstructions) {
    this.stack = new Stack(512);
    this.cacheStack = [];
    this.savedCache = new LRUCache(this.stack, SAVED_REGISTERS, addInstructions);
    this.tempCache = new LRUCache(this.stack, TEMP_REGISTERS, addInstructions);
    this.addInstructions = addInstructions;
    this.tempNameCounter = 0;
  }

  nameOf(varExpr) {
    if (varExpr.type !== "VariableName") {
      throw new CompilerError(`Expected variable name, got: ${varExpr.type}`);
    }

    return varExpr.text;
  }

  has(varExpr) {
    let varName = this.nameOf(varExpr);
    return this.tempCache.has(varName) || this.savedCache.has(varName);
  }

  load(varExpr) {
    let varName = this.nameOf(varExpr);

    if (this.tempCache.has(varName)) {
      return this.tempCache.load(varName);
    } else if (this.savedCache.has(varName)) {
      return this.savedCache.load(varName);
    } else if (this.isTemp(varName)) {
      return this.tempCache.load(varName);
    } else {
      return this.savedCache.load(varName);
    }
  }

  get(varExpr) {
    
    let varName = this.nameOf(varExpr);
    
    if (this.tempCache.has(varName)) {
      return this.tempCache.get(varName);
    } else if (this.savedCache.has(varName)) {
      return this.savedCache.get(varName);
    } else if (this.isTemp(varName)) {
      return this.tempCache.get(varName);
    } else {
      return this.savedCache.get(varName);
    }
  }

  free(varExpr) {
    let varName = this.nameOf(varExpr);

    if (this.tempCache.has(varName)) {
      this.tempCache.free(varName);
    } else if (this.savedCache.has(varName)) {
      this.savedCache.free(varName);
    } else if (this.isTemp(varName)) {
      this.tempCache.free(varName);
    } else {
      this.savedCache.free(varName);
    }
  }

  freeTemp(varExpr) {
    let varName = this.nameOf(varExpr);
    if (this.isTemp(varName)) {
      this.tempCache.free(varName);
    } else if (varName.startsWith("v*")) {
      this.savedCache.free(varName);
    } else {
      throw new CompilerError(`Expected temporary variable, got: ${varName}`);
    }
  }

  dirty(register) {
    // Variables are always modified as a register so
    // stack variables can never be dirty, only registers
    if (this.tempCache.reg2var.has(register)) {
      this.tempCache.dirtyReg.add(register);
    } else if (this.savedCache.reg2var.has(register)) {
      this.savedCache.dirtyReg.add(register);
    } else {
      throw new CompilerError("Register not found");
    }
  }

  define(varName) {
    if (this.isTemp(varName)) {
      throw new CompilerError(`Expected non-temporary variable, got: ${varName}`);
    }

    this.savedCache.define(varName);
  }

  newTemp(useSavedCache = false) {
    if (useSavedCache) {
      return { type: "VariableName", text: `v*${this.tempNameCounter++}` };
    } else {
      return { type: "VariableName", text: `*${this.tempNameCounter++}` };
    }
  }

  isTemp(varName) {
    return varName.startsWith("*");
  }

  stepInto() {
    this.cacheStack.push([
      this.savedCache,
      this.tempCache
    ]);

    this.savedCache = new LRUCache(this.stack, SAVED_REGISTERS, this.addInstructions);
    this.tempCache = new LRUCache(this.stack, TEMP_REGISTERS, this.addInstructions);
  }

  stepOut() {
    let [savedCache, tempCache] = this.cacheStack.pop();
    this.savedCache = savedCache;
    this.tempCache = tempCache;
  }
}

// Post process the output to remove all labels
// and replace them with line numbers
// With any defined functions add the stepIn
// and stepOut subroutines to the top with a jump
// to skip them

export function compile(ast, config = {}) {
  let gen = "";
  let prependGen = "";
  let prepending = false;
  let statements = ast.children;
  let nScopes = 0;
  let cache = new Cache(addInstructions);
  let devices = new Map(); // Device name -> device register
  let unusedLoopEnds = new Set(); // End-of-loop labels that have not been used
  let defined = new Map(); // Variable name -> value
  let definedFns = new Set(); // Function definitions

  // Helpers
  function createRootScope() {
    return {
      index: nScopes++,
      loopIndex: 0,
      variables: new Set()
    };
  }

  function createScope(scope) {
    return {
      ...scope,
      index: nScopes++,
      scopeVariables: new Set(scope.variables),
      variables: new Set()
    };
  }

  function deleteScope(scope) {
    // Remove variables from scope
    for (let variable of scope.variables) {
      free(variable);
    }
  }

  function prependInstruction(instruction) {
    gen = instruction + "\n" + gen;
  }

  function addInstruction(instruction) {
    if (prepending) {
      prependGen += instruction + "\n";
    } else {
      gen += instruction + "\n";
    }
  }

  function addInstructions(instructions) {
    for (let instruction of instructions) {
      addInstruction(instruction);
    }
  }

  function prependEnabled(prepend) {
    prepending = prepend;
  }

  function reverseSign(numberString) {
    if (numberString[0] === "-") {
      return numberString.slice(1);
    } else {
      return "-" + numberString;
    }
  }

  function applyUnaryOp(number, op) {
    switch (op) {
    case "-":
      return { type: "Number", text: reverseSign(number) };
    case "+":
      return { type: "Number", text: number };
    case "!":
      if (number === "0") {
        return { type: "Number", text: "1" };
      } else {
        return { type: "Number", text: "0" };
      }
    default:
      throw new Error(`Unknown unary operator: ${op}`);
    }
  }

  function collapseProperty(expr) {
    let identifiers = [];
    let idx = 0;

    while (true) {
      let identifier = expr.children[0];

      if (idx == 0) {
        if (identifier.type !== "VariableName" && identifier.type !== "Device") {
          throw new CompilerError("Expected identifier or device for property accessor");
        }
      } else {
        if (identifier.type !== "VariableName") {
          throw new CompilerError("Expected identifier for property accessor");
        }
      }

      if (expr.children[1] && expr.children[1].type === "Channel") {
        let deviceTxt = expr.children[0].text + expr.children[1].text;
        identifiers.push({ type: "Device", text: deviceTxt });
        expr = expr.children[3];
      } else {
        identifiers.push(identifier);
        expr = expr.children[2];
      }

      idx++;

      if (!expr) break;
    }

    return identifiers;
  }

  function makeDefinition(variableName, value) {
    prependInstruction(`define ${variableName} ${value}`);
    defined.set(variableName, value);
  }

  function findInstruction(statement, filter) {
    if (filter(statement)) {
      return statement;
    }

    for (let child of statement.children) {
      let result = findInstruction(child, filter);
      if (result) {
        return result;
      }
    }

    return null;
  }

  function findInstructionParentIdx(statement, filter) {
    // Find the instruction and return the parent and the child index
    if (filter(statement)) {
      return { parent: null, index: -1 };
    }

    for (let i = 0; i < statement.children.length; i++) {
      let result = findInstructionParentIdx(statement.children[i], filter);
      if (result) {
        return { parent: statement, index: i };
      }
    }

    return null;
  }

  // Memory

  function free(expr) {
    if (expr.type !== "VariableName") {
      throw new CompilerError(`Expected variable name, got: ${expr.type}`);
    }

    cache.free(expr);
  }

  function freeTemp(expr) {
    if (expr.type === "VariableName" && cache.isTemp(expr.text)) {
      cache.free(expr);
    }
  }

  function exists(varExpr) {
    if (varExpr.type !== "VariableName") {
      return false;
    }

    return cache.has(varExpr);
  }

  function load(expr) {
    // NOTE: Before changing this to accept things other than VariableName,
    // do you need to use get(expr) to get the value instead of load(expr)?

    // Exception: return registers
    if (expr.type === "Register") {
      return expr.text;
    }

    // Get the final value of the expression (number, register, device, etc.)
    if (expr.type !== "VariableName") {
      throw new CompilerError(`Expected variable name, got: ${expr.type}`);
    }
    
    return cache.load(expr);
  }

  function get(expr) {
    // Get the final value of the expression (number, register, device, etc.)
    switch (expr.type) {
    case "Number":
    case "Register":
    case "Device":
    case "String":
    case "Global":
    case "Macro":
      return expr;
    case "VariableName":
      return { type: "Register", text: cache.get(expr) };
    default:
      throw new CompilerError(`Unexpected expression type: ${expr.type}`);
    }
  }

  function dirty(register) {
    // NOTE: Register is always a register
    // No need to dirty the return register
    if (register === RETURN_REGISTER) return;
    cache.dirty(register);
  }

  function newTemp(useSavedCache = false) {
    return cache.newTemp(useSavedCache);
  }

  function define(varName) {
    cache.define(varName);
  }

  function getReturnRegister() {
    return { type: "Register", text: RETURN_REGISTER };
  }

  // Expressions

  function binaryOp(expr, outVar) {
    let left = expr.children[0];
    let op = expr.children[1];
    let right = expr.children[2];

    // If the right expression contains a function call, we need
    // to use saved registers to store the result of the lhs expression
    const isDefinedCall = i => {
      return i.type === "FunctionCall" && definedFns.has(i.children[0].text);
    };

    let rightContainsDefinedCall = findInstruction(right, isDefinedCall) !== null;

    // Compute left and right expressions if needed
    if (left.type !== "Number" && left.type !== "Register") {
      if (rightContainsDefinedCall) {
        let savedTemp = newTemp(true); // Use saved register
        left = processExpression(left, savedTemp);
      } else {
        left = processExpression(left);
      }
    }

    if (right.type !== "Number" && right.type !== "Register") {
      right = processExpression(right);
    }
    
    let opInstruction = OP_INSTRUCTIONS[op.text];

    // Compile time expression
    if (left.type === "Number" && right.type === "Number") {
      let lhs = parseFloat(left.text);
      let rhs = parseFloat(right.text);
      let value;

      switch (op.text) {
      case "+": value = lhs + rhs; break;
      case "-": value = lhs - rhs; break;
      case "*": value = lhs * rhs; break;
      case "/": value = lhs / rhs; break;
      case ">": value = lhs > rhs; break;
      case "<": value = lhs < rhs; break;
      case ">=": value = lhs >= rhs; break;
      case "<=": value = lhs <= rhs; break;
      case "==": value = lhs == rhs; break;
      case "!=": value = lhs != rhs; break;
      case "&&": value = lhs && rhs; break;
      case "||": value = lhs || rhs; break;
      default:
        throw new CompilerError(`Unknown operator: ${op.text}`);
      }

      if (outVar) {
        let register = load(outVar);
        addInstruction(`move ${register} ${round(value)}`);
        dirty(register);
        return outVar;
      }

      return { type: "Number", text: round(value) };
    }

    // Save result directly to outVar
    if (outVar) {
      let lhs = get(left);
      let rhs = get(right);
      freeTemp(right);
      freeTemp(left);
      let register = load(outVar);
      addInstruction(`${opInstruction} ${register} ${lhs.text} ${rhs.text}`);
      dirty(register);
      return outVar;
    }

    // Return temporary variable
    // console.log(cache.tempCache.recentRegisters[cache.tempCache.recentRegisters.length - 1]);
    let lhs = get(left);
    let rhs = get(right);
    freeTemp(right);
    freeTemp(left);
    let tempVar = newTemp();
    let register = load(tempVar);
    addInstruction(`${opInstruction} ${register} ${lhs.text} ${rhs.text}`);
    dirty(register);
    return tempVar;
  }

  function unaryOpLeft(expr, outVar) {
    let op = expr.children[0];
    let operand = expr.children[1];

    // Compile time expression
    if (operand.type === "Number") {
      let value = applyUnaryOp(operand.text, op.text);

      if (outVar) {
        freeTemp(operand);
        let register = load(outVar);
        addInstruction(`move ${register} ${value.text}`);
        dirty(register);
        return outVar;
      }

      return value;
    }

    let operandExpr = processExpression(operand);
    let operandValue = get(operandExpr);
    freeTemp(operandExpr);

    if (op.text === "++" || op.text === "--") {
      if (operandValue.type !== "Register")
        throw new CompilerError("Expected operand to be a variable");

      let opInstruction = op.text === "++" ? "add" : "sub";

      addInstruction(`${opInstruction} ${operandValue.text} ${operandValue.text} 1`);

      if (outVar) {
        let register = load(outVar);
        addInstruction(`move ${register} ${operandValue.text}`);
        dirty(register);
        return outVar;
      }

      return operandValue;
    }

    if (!outVar) outVar = newTemp();
    let register = load(outVar);

    // Add instructions to compute expression
    switch (op.text) {
    case "-":
      addInstruction(`mul ${register} -1 ${operandValue.text}`);
      break;
    case "+":
      addInstruction(`move ${register} ${operandValue.text}`);
      break;
    case "!":
      addInstruction(`seq ${register} ${operandValue.text} 0`);
      break;
    default:
      throw new CompilerError(`Unknown unary operator: ${op.text}`);
    }

    dirty(register);

    return outVar;
  }

  function unaryOpRight(expr, outVar, returnValue = true) {
    let operand = expr.children[0];
    let op = expr.children[1];

    let operandExpr = processExpression(operand);
    let operandValue = get(operandExpr);
    freeTemp(operandExpr);

    if (op.text === "++" || op.text === "--") {
      if (operandValue.type !== "Register")
        throw new CompilerError("Expected operand to be a variable");
      
      let opInstruction = op.text === "++" ? "add" : "sub";

      if (returnValue) {
        if (!outVar) outVar = newTemp();
        let register = load(outVar);
        addInstruction(`move ${register} ${operandValue.text}`);
        dirty(register);
      }

      addInstruction(`${opInstruction} ${operandValue.text} ${operandValue.text} 1`);
      
      return outVar;
    }
  }

  function property(expr, outVar) {
    const varExpr = expr.children[0];
    const variableName = varExpr.text;
    
    // Check if variable is a macro
    if (defined.has(variableName)) {
      const value = defined.get(variableName);

      if (outVar) {
        if (value.type === "String") {
          let register = load(outVar);
          addInstruction(`move ${register} ${variableName}`);
          dirty(register);
          return varExpr;
        }

        if (value.type === "Property") {
          let register = load(outVar);
          addInstruction(`move ${register} ${value.text}`);
          dirty(register);
          return varExpr;
        }

        let register = load(outVar);
        addInstruction(`move ${register} ${variableName}`);
        dirty(register);
        return varExpr;
      }

      if (value.type === "Property") {
        return { type: "Macro", text: value.text };
      }

      return { type: "Macro", text: expr.text };
    }

    // Check if variable is a device
    if (devices.has(variableName) || varExpr.type === "Device") {
      let device = varExpr.text;

      if (expr.children[1] && expr.children[1].type === "Channel") {
        device += expr.children[1].text;
      }

      // Check if it is already a device
      if (expr.children.length == 1) {
        return { type: "Device", text: device };
      }

      let property = expr.children[1].type === "Channel" ? expr.children[3] : expr.children[2];

      if (property.children.length !== 1) {
        throw new CompilerError("Expected only one property accessor");
      }

      const attribute = property.children[0];
      
      if (attribute.type !== "VariableName") {
        throw new CompilerError("Expected attribute to be a variable name");
      }
      
      if (!outVar) outVar = newTemp();

      let register = load(outVar);

      addInstruction(`l ${register} ${device} ${attribute.text}`);
      dirty(register);

      return outVar;
    }
    
    // Register check
    if (varExpr.type === "Register") {
      if (outVar) {
        let register = load(outVar);
        let value = get(varExpr);
        addInstruction(`move ${register} ${value.text}`);
        dirty(register);
        return outVar;
      }

      return varExpr;
    }

    // Check if variable is not in scope
    if (!exists(varExpr)) {
      if (outVar) {
        let register = load(outVar);
        const idfs = collapseProperty(expr);
        let value = idfs.map(idf => idf.text).join(".");
        addInstruction(`move ${register} ${value}`);
        dirty(register);
        return outVar;
      }

      // Assume global variable
      const idfs = collapseProperty(expr);
      let value = idfs.map(idf => idf.text).join(".");
      return { type: "Global", text: value };
    }
    
    if (outVar) {
      let register = load(outVar);
      let value = get(varExpr);
      addInstruction(`move ${register} ${value.text}`);
      dirty(register);
      return varExpr;
    }
    
    return varExpr;
  }

  function number(expr, outVar) {
    if (outVar) {
      let register = load(outVar);
      addInstruction(`move ${register} ${expr.text}`);
      dirty(register);
    }
    
    return expr;
  }

  function string(expr, outVar) {
    if (outVar) {
      // Hash the string
      let register = load(outVar);
      addInstruction(`move ${register} HASH(${expr.text})`);
      dirty(register);
    }
    
    return expr;
  }

  function bool(expr, outVar) {
    let value = {
      type: "Number",
      text: expr.text === "true" ? "1" : "0"
    };
    
    if (outVar) {
      let register = load(outVar);
      addInstruction(`move ${register} ${value.text}`);
      dirty(register);
      return outVar;
    }
    
    return value;
  }

  function userDefinedFunctionCall(expr, outVar, returnValue = true) {
    const functionName = expr.children[0].text;
    const params = [];
    const tempVars = [];
    const tempVals = [];

    // Reserve temps for parameters first
    for (let i = 2; i < expr.children.length - 1; i += 2) {
      const param = expr.children[i];
      const tempVar = newTemp();
      const tempVal = get(tempVar);

      params.push(param);
      tempVars.push(tempVar);
      tempVals.push(tempVal);
    }

    for (let i = 0; i < params.length; i++) {
      const param = params[i];
      const tempVar = tempVars[i];
      const tempVal = tempVals[i];
      const paramExpr = processExpression(param, tempVal);
      const paramValue = get(paramExpr);
      freeTemp(paramExpr);
    }

    for (let i = tempVars.length - 1; i >= 0; i--) {
      const temp = tempVars[i];
      freeTemp(temp);
    }

    // Move stack pointer to end of free space
    // No need to add to stack pointer if offset is 0
    if (cache.stack.pointer > 0) addInstruction(`add sp sp ${cache.stack.pointer}`);
    
    addInstruction("jal stepInto");
    cache.stepInto();
    addInstruction(`jal ${functionName}`);
    cache.stepOut();
    addInstruction("jal stepOut");

    if (cache.stack.pointer > 0) addInstruction(`sub sp sp ${cache.stack.pointer}`);

    if (!returnValue) return;

    if (!outVar) outVar = newTemp();

    let register = load(outVar);

    // Only move register if it's not the return register
    if (register !== RETURN_REGISTER) {
      addInstruction(`move ${register} ${RETURN_REGISTER}`);
    }

    return outVar;
  }

  function functionCall(expr, outVar, returnValue = true) {
    let functionName = expr.children[0].text;

    if (definedFns.has(functionName)) {
      return userDefinedFunctionCall(expr, outVar, returnValue);
    }

    if (!outVar) outVar = newTemp();
    
    if (functionName === "HASH") {
      if (!returnValue) {
        throw new CompilerError("HASH return value must be used");
      }

      let register = load(outVar);  
      addInstruction(`move ${register} ${expr.text}`);
      dirty(register);
      return outVar;
    }

    if (functionName === "loadSlot") {
      if (!returnValue) {
        throw new CompilerError("loadSlot return value must be used");
      }

      let device = expr.children[2];
      let slot = processExpression(expr.children[4]);
      let attribute = expr.children[6];

      freeTemp(slot);
      let register = load(outVar);
      addInstruction(`ls ${register} ${device.text} ${slot.text} ${attribute.text}`);
      dirty(register);

      return outVar;
    }

    // Convert setSlot to ss (alias)
    if (functionName === "setSlot") functionName = "ss";

    const batchModes = new Set(["Average", "Sum", "Minimum", "Maximum"]);

    if (batchModes.has(functionName)) {
      if (!returnValue) {
        throw new CompilerError(`${functionName} return value must be used`);
      }

      // Check if this is a batch operation
      const argument = expr.children[2];
      const idfs = collapseProperty(argument);
  
      let x0 = idfs[0].text;
      let x1 = idfs[1].text;
  
      if (!defined.has(x0)) {
        x0 = `HASH("${x0}")`;
      }
  
      if (idfs.length == 2) {
        let register = load(outVar);
        addInstruction(`lb ${register} ${x0} ${x1} ${functionName}`);
        cache.dirty(register);
        return outVar;
      } else if (idfs.length == 3) {
        let x2 = idfs[2].text;
  
        if (!defined.has(x1)) {
          x1 = `HASH("${x1}")`;
        }
  
        let register = load(outVar);
        addInstruction(`lbn ${register} ${x0} ${x1} ${x2} ${functionName}`);
        dirty(register);
        return outVar;
      } else {
        throw new CompilerError("Expected 2 or 3 property accessors for batch operation");
      }
    }

    // Default to ic10 instruction
    let args = [];
    let regs = [];

    // Process arguments
    for (let i = 2; i < expr.children.length; i += 2) {
      args.push(processExpression(expr.children[i]));
    }

    // Load regs
    for (let arg of args) {
      regs.push(get(arg));
    }

    // Remove quotes from strings
    for (let arg of args) {
      if (arg.type === "String") {
        arg.text = arg.text.slice(1, arg.text.length - 1);
      }
    }

    addInstruction(`${functionName} ${regs.map(regs => regs.text).join(" ")}`);

    // Free temporary variables after processing
    for (let arg of args) {
      freeTemp(arg);
    }
  }

  function processExpression(expr, outVar) {
    if (expr.type === "Number") {
      return number(expr, outVar);
    }

    if (expr.type === "String") {
      return string(expr, outVar);
    }

    if (expr.type === "Bool") {
      return bool(expr, outVar);
    }

    if (expr.type === "Property") {
      return property(expr, outVar);
    }

    if (expr.type === "Parens") {
      return processExpression(expr.children[1], outVar);
    }

    if (expr.type === "BinaryOp") {
      return binaryOp(expr, outVar);
    }

    if (expr.type === "UnaryOp" || expr.type === "IncDecLeft") {
      return unaryOpLeft(expr, outVar);
    }

    if (expr.type === "IncDecRight") {
      return unaryOpRight(expr, outVar);
    }

    if (expr.type === "FunctionCall") {
      return functionCall(expr, outVar);
    }

    if (expr.type === "Global") {
      return expr;
    }

    if (expr.type === "Macro") {
      return expr;
    }

    if (expr.type === "⚠") {
      throw new CompilerError("Unexpected input");
    } else {
      throw new CompilerError(`Unknown expression type: ${expr.type}`);
    }
  }

  // Statements

  function functionDef(expr, scope) {
    const functionName = expr.children[1].text;
    const args = [];
    const argNames = new Set();
    const nextScope = createScope(scope);

    for (let i = 3; i < expr.children.length - 3; i += 2) {
      if (argNames.has(expr.children[i].text)) {
        throw new CompilerError(`Duplicate argument name: ${expr.children[i].text}`);
      }

      args.push(expr.children[i]);
      argNames.add(expr.children[i].text);
    }

    if (args.length > TEMP_REGISTERS.length) {
      throw new CompilerError(`Too many arguments (max ${TEMP_REGISTERS.length})`);
    }

    const body = expr.children[expr.children.length - 2];

    // Push ra and pop ra are only necessary if there is a function call within the body
    let firstFnCall = findInstructionParentIdx(body, i => i.type === "FunctionCall");
    let hasFnCall = firstFnCall !== null;
    nextScope.needsPopRa = hasFnCall;

    // Add function to defined functions
    definedFns.add(functionName);

    // Enter function
    prependEnabled(true);
    cache.stepInto();
    addInstruction(`${functionName}:`);
    if (hasFnCall) addInstruction(`push ra`);
    
    // Check if an argument is used after the function call
    // const isArgUsedAferFnCall = arg => {
    //   const statementsAfterFnCall = firstFnCall.parent.children.slice(firstFnCall.index + 1);
    //   return statementsAfterFnCall.some(statement => {
    //     return findInstruction(statement, i => {
    //       // Use property to ensure we have found "arg" and not "var.arg" etc.
    //       return i.type === "Property" && i.children[0].text === arg.text;
    //     });
    //   });
    // };

    // Load arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      // TODO: Instead of just checking for function call, see if the variables
      // are being used after the function call.
      // These arguments need to be freed just before the function call
      // The reason it was not done yet was because if the parameter replaces
      // an argument used for the next parameters, an auxiliary register is needed.
      if (!hasFnCall) {
        cache.tempCache.assign(arg.text, `r${i}`);
        continue;
      }
      
      // The argument is used so we need to store it in a saved register
      define(arg.text);
      const register = load(arg);
      addInstruction(`move ${register} r${i}`);
      dirty(register);
    }

    // Process body
    processStatements(body.children, nextScope);

    // Add jump at end if no return
    if (body.children[body.children.length - 1].type !== "Return") {
      if (hasFnCall) addInstruction("pop ra");
      addInstruction("j ra");
    }

    cache.stepOut();
    prependEnabled(false);
  }

  function returnStatement(statement, scope) {
    const returnRegister = getReturnRegister();
    const expr = processExpression(statement.children[1], returnRegister);
    if (scope.needsPopRa) addInstruction("pop ra");
    addInstruction("j ra");
  }

  function declaration(statement, scope) {
    const varExpr = statement.children[1];
    const valueExpr = statement.children[3];
    const varName = varExpr.text;

    // Add the variable to the scope
    scope.variables.add(varExpr);
    define(varName);

    // Declaring a variable only
    if (statement.children.length === 2) {
      load(varExpr);
      return;
    }

    if (scope.variables.has(varName)) {
      throw new CompilerError(`Duplicate variable name: ${varName}`);
    }
    
    processExpression(valueExpr, varExpr);
  }

  function assignment(statement) {
    const target = statement.children[0];
    const idfs = collapseProperty(target);

    // Setting lone variables
    if (idfs.length === 1) {
      if (idfs[0].type !== "VariableName") {
        throw new CompilerError("Expected assignment target to be a variable name");
      }

      return processExpression(statement.children[2], idfs[0]);
    }
    
    // Setting device attributes
    let device = idfs[0];

    if (device.type === "Device" || devices.has(device.text)) {
      if (idfs.length !== 2) {
        throw new CompilerError("Expected only one property accessor");
      }

      // Setting a device attribute
      let attributeName = idfs[1].text;
      let retExpr = processExpression(statement.children[2]);
      let value = get(retExpr);

      addInstruction(`s ${device.text} ${attributeName} ${value.text}`);
      freeTemp(value);
    } else {
      // Batch setting device attributes
      let retExpr = processExpression(statement.children[2]);
      let value = get(retExpr);
      let x0 = idfs[0].text;
      let x1 = idfs[1].text;

      if (!defined.has(x0)) {
        x0 = `HASH("${x0}")`;
      }

      if (idfs.length === 2) {
        addInstruction(`sb ${x0} ${x1} ${value.text}`);
        freeTemp(value);
      } else if (idfs.length === 3) {
        let x2 = idfs[2].text;

        if (!defined.has(x1)) {
          x1 = `HASH("${x1}")`;
        }

        addInstruction(`sbn ${x0} ${x1} ${x2} ${value.text}`);
        freeTemp(value);
      }
    }
  }

  function loopExpr(statement, scope) {
    const statements = statement.children.slice(1, statement.children.length - 1);
    const nextScope = createScope(scope);

    nextScope.loopIndex = nextScope.index;
    unusedLoopEnds.add(nextScope.index);

    addInstruction(`scope${nextScope.index}:`);
    processStatements(statements, nextScope);
    addInstruction(`j scope${nextScope.index}`);
    addInstruction(`end${nextScope.index}:`);

    deleteScope(nextScope);
  }

  function whileExpr(statement, scope) {
    const condition = statement.children[1];
    const statements = statement.children.slice(3, statement.children.length - 1);
    const nextScope = createScope(scope);

    nextScope.loopIndex = nextScope.index;

    addInstruction(`scope${nextScope.index}:`);
    
    const conditionExpr = processExpression(condition);
    const conditionReg = get(conditionExpr);
    
    freeTemp(conditionExpr);
    addInstruction(`beqz ${conditionReg.text} end${nextScope.index}`);
    processStatements(statements, nextScope);
    addInstruction(`j scope${nextScope.index}`);
    addInstruction(`end${nextScope.index}:`);

    deleteScope(nextScope);
  }

  function repeatUntilExpr(statement, scope) {
    const statements = statement.children.slice(1, statement.children.length - 2);
    const condition = statement.children[statement.children.length - 1];
    const nextScope = createScope(scope);

    nextScope.loopIndex = nextScope.index;

    addInstruction(`scope${nextScope.index}:`);
    processStatements(statements, nextScope);
    
    const conditionExpr = processExpression(condition);
    const conditionReg = get(conditionExpr);
    
    freeTemp(conditionExpr);
    addInstruction(`beqz ${conditionReg.text} scope${nextScope.index}`);

    deleteScope(nextScope);
  }

  function ifExpr(statement, scope) {
    let ifStatement = statement.children[0];
    let elseIfStatements = [];
    let elseStatement = null;

    if (statement.children[statement.children.length - 2].type === "Else") {
      elseStatement = statement.children[statement.children.length - 2];
      elseIfStatements = statement.children.slice(1, statement.children.length - 2);
    } else {
      elseIfStatements = statement.children.slice(1, statement.children.length - 1);
    }

    let currentScope = createScope(scope);
    let endif = currentScope.index;
    currentScope.endif = endif;
    let nextScope = null;

    for (let i = 0; i < statement.children.length; i++) {
      let childStatement = statement.children[i];

      if (childStatement.type === "Else") {
        processStatements(childStatement.children.slice(1), currentScope);
        addInstruction(`end${currentScope.endif}:`);
        deleteScope(nextScope);
        break;
      }

      let nextLabel = `end${currentScope.endif}`;

      if (statement.children[i + 1].type !== "end") {
        nextScope = createScope(scope);
        nextScope.endif = endif;
        nextLabel = `scope${nextScope.index}`;
      }

      // If/ElseIf clause
      let condition = processExpression(childStatement.children[1]);
      let value = get(condition);
      
      addInstruction(`beqz ${value.text} ${nextLabel}`);
      
      // Free temporary registers used for condition
      freeTemp(condition);
      
      processStatements(childStatement.children.slice(3), currentScope);
      
      if (statement.children[i + 1].type === "end") {
        // End of the if/elif/else statement
        addInstruction(`end${currentScope.endif}:`);
        deleteScope(currentScope);
        break;
      } else {
        addInstruction(`j end${currentScope.endif}`);
        deleteScope(currentScope);
        addInstruction(`scope${nextScope.index}:`);
        currentScope = nextScope;
      }
    }
  }

  function deviceDeclaration(statement) {
    const variableName = statement.children[1].text;
    const deviceRegister = statement.children[3].text;
    addInstruction(`alias ${variableName} ${deviceRegister}`);
    devices.set(variableName, deviceRegister);
  }

  function definition(statement) {
    const variableName = statement.children[1].text;
    const value = statement.children[3];

    if (value.type === "Number") {
      addInstruction(`define ${variableName} ${value.text}`);
    } else if (value.type === "Bool") {
      addInstruction(`define ${variableName} ${value.text === "true" ? "1" : "0"}`);
    } else if (value.type === "String") {
      addInstruction(`define ${variableName} HASH(${value.text})`);
    }

    defined.set(variableName, value);
  }

  function jump(statement) {
    const istructionName = statement.children[0].text;
    const labelExpr = processExpression(statement.children[1]);
    const label = get(labelExpr);

    freeTemp(labelExpr);
    addInstruction(`${istructionName} ${label.text}`);
  }

  function instruction(statement) {
    if (statement.children.length === 1) {
      addInstruction(statement.text);
      return;
    }

    const instructionName = statement.children[0].text;
    const expr = processExpression(statement.children[1]);
    const value = get(expr);

    freeTemp(expr);
    addInstruction(`${instructionName} ${value.text}`);
  }

  function processStatement(statement, scope) {
    // Update compiler error position
    CompilerError.from = statement.from;
    CompilerError.to = statement.to;

    if (statement.type === "Declaration") {
      return declaration(statement, scope);
    }

    if (statement.type === "Return") {
      return returnStatement(statement, scope);
    }

    if (statement.type === "DeviceDeclaration") {
      return deviceDeclaration(statement);
    }

    if (statement.type === "Assignment") {
      return assignment(statement);
    }

    if (statement.type === "IncDecLeft") {
      return unaryOpLeft(statement);
    }

    if (statement.type === "IncDecRight") {
      return unaryOpRight(statement, undefined, false);
    }

    if (statement.type === "LoopExpr") {
      return loopExpr(statement, scope);
    }

    if (statement.type === "WhileExpr") {
      return whileExpr(statement, scope);
    }

    if (statement.type === "RepeatUntilExpr") {
      return repeatUntilExpr(statement, scope);
    }

    if (statement.type === "IfExpr") {
      return ifExpr(statement, scope);
    }

    if (statement.type === "continue") {
      addInstruction("j scope" + scope.loopIndex);
      return;
    }

    if (statement.type === "break") {
      addInstruction("j end" + scope.loopIndex);
      unusedLoopEnds.delete(scope.loopIndex);
      return;
    }

    if (statement.type === "Definition") {
      return definition(statement);
    }

    if (statement.type === "Comment") {
      return;
    }

    if (statement.type === "Label") {
      addInstruction(statement.text);
      return;
    }

    if (statement.type === "Jump") {
      return jump(statement);
    }

    if (statement.type === "Instruction") {
      return instruction(statement);
    }

    if (statement.type === "FunctionDef") {
      return functionDef(statement, scope);
    }

    if (statement.type === "FunctionCall") {
      return functionCall(statement, undefined, false);
    }

    throw new CompilerError(`Unknown statement: ${statement.type}`);
  }

  function processStatements(statements, scope) {
    for (let statement of statements) {
      processStatement(statement, scope);
    }
  }

  processStatements(statements, createRootScope());

  // Remove unused end loops
  for (let index of unusedLoopEnds) {
    gen = gen.replace(`end${index}:\n`, "");
  }

  let finalGen = "";

  if (prependGen) {
    finalGen += "j ProgramStart\n";
    if (!config.omitPrologue) finalGen += STEP_SUBROUTINES + "\n";
    finalGen += prependGen.trim() + "\n";
    finalGen += "ProgramStart:\n";
  }

  finalGen += gen.trim();

  if (!config.keepLabels) {
    finalGen = removeLabels(finalGen);
  }

  return finalGen;
}

function removeLabels(output) {
  // Find all the line numbers for each label
  const labels = new Map();
  let lines = output.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const instruction = lines[i].trim();

    if (instruction.endsWith(":")) {
      const label = instruction.substring(0, instruction.length - 1).trim();
      labels.set(label, i); // Starts at line 0

      // Remove the instruction
      lines.splice(i--, 1);
    }
  }

  // Replace all instances of used labels with the line number
  for (let i = 0; i < lines.length; i++) {
    const instruction = lines[i].trim();
    const tokens = instruction.split(" ");
    
    for (let j = 0; j < tokens.length; j++) {
      if (labels.has(tokens[j])) {
        tokens[j] = labels.get(tokens[j]);
      }
    }

    lines[i] = tokens.join(" ");
  }

  return lines.join("\n");
}
