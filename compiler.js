
/*
Temporary registers (r0 - r8)
Return value (r9)
Saved registers (r10 - r15)
Stack pointer (sp or r16)
Return address (ra or r17)
*/

/*
Input:
let x0 = 0
let x1 = 1
let x2 = 2
let x3 = 3
let x4 = 4
let x5 = 5
let x6 = 6

Output:
move r10 0
move r11 1
move r12 2
move r13 3
move r14 4
move r15 5

# LRU replacement
put db 0 r10
move r10 6
*/

export class CompilerError extends Error {
  static from = 0;
  static to = 0;

  constructor(message) {
    super(message);
    this.from = CompilerError.from;
    this.to = CompilerError.to;
  }

  toString() {
    return `${this.message} (${this.from.line}:${this.from.column} - ${this.to.line}:${this.to.column})`;
  }
}

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
  "||": "or"
};

const DEVICE_REGISTERS = new Set(["d0", "d1", "d2", "d3", "d4", "d5"]);

class Cache {
  static TEMP = new Set(["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"]);

  constructor() {
    this.stackSize = 512;
    this.recentRegisters = ["r15", "r14", "r13", "r12", "r11", "r10"];
    this.var2reg = new Map();
    this.reg2var = new Map();
    this.var2stack = new Map();
    this.stackPointer = -1;
    this.tempRegisters = Array(9).fill(true); // r0 - r8
  }

  used(register) {
    // Update recent registers
    const index = this.recentRegisters.indexOf(register);

    if (index == -1) {
      throw "Register not found";
    }

    // Move to front
    this.recentRegisters.splice(index, 1);
    this.recentRegisters.unshift(register);
  }

  lru() {
    // Return least recently used
    return this.recentRegisters[this.recentRegisters.length - 1];
  }

  get(variableName, discardValue = false) {
    let device = "db";
    let register = this.var2reg.get(variableName);
    let cacheInstructions = [];

    // Cache hit
    if (register) {
      this.used(register);

      return { register, cacheInstructions };
    }

    // Cache miss
    register = this.lru();

    const oldVariable = this.reg2var.get(register);

    // Update the stack if needed
    if (this.var2reg.has(oldVariable)) {
      let oldStackOffset = this.var2stack.get(oldVariable);

      // Assign a stack address if not already assigned
      if (oldStackOffset === undefined) {
        this.stackPointer++;
        this.var2stack.set(oldVariable, this.stackPointer);
        oldStackOffset = this.stackPointer;
      }

      cacheInstructions.push(`put ${device} ${oldStackOffset} ${register}`);
      this.var2reg.delete(oldVariable);
    }

    this.var2reg.set(variableName, register);
    this.reg2var.set(register, variableName);

    // Variable already in cache
    if (this.var2stack.has(variableName)) {
      let stackOffset = this.var2stack.get(variableName);

      if (!discardValue) {
        cacheInstructions.push(`get ${register} ${device} ${stackOffset}`);
      }
    }

    this.used(register);

    return { register, cacheInstructions };
  }

  has(variableName) {
    return this.var2reg.has(variableName) || this.var2stack.has(variableName);
  }

  getTemp() {
    const index = this.tempRegisters.indexOf(true);
    this.tempRegisters[index] = false;
    return `r${index}`;
  }

  freeTemp(register) {
    if (!Cache.TEMP.has(register)) return;
    const prefix = register[0];
    const index = Number(register.slice(1));
    this.tempRegisters[index] = true;
  }

  clearTemp() {
    this.tempRegisters = Array(9).fill(true);
  }
}

export function transpile(ast, text) {
  let gen = "";
  let statements = ast.children;
  let cache = new Cache();
  let nScopes = 0;
  let nLoops = 0;
  let nEndIfs = 0;
  let nElseIfs = 0;
  let devices = new Map(); // Device name -> device register
  let unusedLoopEnds = new Set();
  let defined = new Map();

  // Helpers
  function createRootScope() {
    return {
      index: nScopes++,
      loopIndex: 0,
    };
  }

  function createScope(scope) {
    return {
      ...scope,
      index: nScopes++,
    };
  }

  function prependInstruction(instruction) {
    gen = instruction + "\n" + gen;
  }

  function addInstruction(instruction) {
    gen += instruction + "\n";
  }

  function addInstructions(instructions) {
    for (let instruction of instructions) {
      addInstruction(instruction);
    }
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
          throw CompilerError("Expected identifier or device for property accessor");
        }
      } else {
        if (identifier.type !== "VariableName") {
          throw CompilerError("Expected identifier for property accessor");
        }
      }

      identifiers.push(identifier);
      
      if (expr.children.length === 1) break;
      
      expr = expr.children[2];

      idx++;
    }

    return identifiers;
  }

  function makeDefinition(variableName, value) {
    prependInstruction(`define ${variableName} ${value}`);
    defined.set(variableName, value);
  }

  function locationOf(index) {
    // Count number of newlines before index to get line number
    const line = text.slice(0, index).split("\n").length - 1;
    const column = index - text.lastIndexOf("\n", index) - 1;
    return [line, column];
  }

  function coords(from, to) {
    return [locationOf(from), locationOf(to)];
  }

  // Expressions

  function free(expr) {
    if (expr.type !== "Register") return;
    if (!Cache.TEMP.has(expr.text)) return;
    cache.freeTemp(expr.text);
  }

  function binaryOp(expr, outRegister) {
    let left = expr.children[0];
    let op = expr.children[1];
    let right = expr.children[2];

    // Compute left and right expressions if needed
    if (left.type !== "Number" && left.type !== "Register") {
      left = processExpression(left);
    }

    if (right.type !== "Number" && right.type !== "Register") {
      right = processExpression(right);
    }

    // If left or right were temporary registers, free them
    free(left);
    free(right);
    
    let opInstruction = OP_INSTRUCTIONS[op.text];
    
    if (outRegister === "none") outRegister = cache.getTemp();

    addInstruction(`${opInstruction} ${outRegister} ${left.text} ${right.text}`);

    return { type: "Register", text: outRegister };
  }

  function unaryOp(expr, outRegister) {
    let op = expr.children[0];
    let operand = expr.children[1];

    // Compute right expression if needed
    if (operand.type !== "Number" && operand.type !== "Register") {
      operand = processExpression(operand);
    }

    // If right was a temporary register, free it
    free(operand);

    // Compute expression
    if (operand.type === "Number") {
      let value = applyUnaryOp(operand.text, op.text);

      if (outRegister !== "none") {
        addInstruction(`move ${outRegister} ${value.text}`);
      }

      return value;
    }

    if (outRegister === "none") outRegister = cache.getTemp();

    // Add instructions to compute expression
    switch (op.text) {
    case "-":
      addInstruction(`mul ${outRegister} -1 ${operand.text}`);
      break;
    case "+":
      addInstruction(`move ${outRegister} ${operand.text}`);
      break;
    case "!":
      addInstruction(`seq ${outRegister} ${operand.text} 0`);
      break;
    default:
      throw new CompilerError(`Unknown unary operator: ${op.text}`);
    }

    return { type: "Register", text: outRegister };
  }

  function property(expr, outRegister) {
    const variableName = expr.children[0].text;
    const isDeviceRef = devices.has(variableName);
    const isDeviceVar = DEVICE_REGISTERS.has(variableName);

    if (defined.has(variableName)) {
      if (outRegister !== "none") {
        addInstruction(`move ${outRegister} ${variableName}`);
      }

      if (defined.get(variableName).type === "String") {
        return { type: "String", text: defined.get(variableName).text };
      }

      return expr;
    }

    if (isDeviceRef || isDeviceVar) {
      let device = variableName;

      if (expr.children.length === 1) {
        return expr.children[0];
      }

      if (expr.children[2].children.length !== 1) {
        throw new CompilerError("Expected only one property accessor");
      }

      const attribute = expr.children[2].children[0];
      
      if (attribute.type !== "VariableName") {
        throw new CompilerError("Expected attribute to be a variable name");
      }
      
      if (outRegister === "none") outRegister = cache.getTemp();

      addInstruction(`l ${outRegister} ${device} ${attribute.text}`);

      return { type: "Register", text: outRegister };
    }
    
    if (!cache.has(variableName)) {
      if (outRegister !== "none") {
        const idfs = collapseProperty(expr);
        addInstruction(`move ${outRegister} ${idfs.map(idf => idf.text).join(".")}`);
      }

      return expr;
    }

    const { register, cacheInstructions } = cache.get(variableName, outRegister);

    addInstructions(cacheInstructions);

    if (outRegister !== "none") {
      addInstruction(`move ${outRegister} ${register}`);
    }

    return { type: "Register", text: register };
  }

  function number(expr, outRegister) {
    if (outRegister !== "none") {
      addInstruction(`move ${outRegister} ${expr.text}`);
    }
    
    return expr;
  }

  function bool(expr, outRegister) {
    let value = {
      type: "Number",
      text: expr.text === "true" ? "1" : "0"
    };
    
    if (outRegister !== "none") {
      addInstruction(`move ${outRegister} ${value.text}`);
    }
    
    return value;
  }

  function functionCall(expr, outRegister) {
    let functionName = expr.children[0].text;

    if (outRegister === "none") outRegister = cache.getTemp();
    
    if (functionName === "HASH") {  
      addInstruction(`move ${outRegister} ${expr.text}`);
      
      return { type: "Register", text: outRegister };
    }

    if (functionName === "loadSlot") {
      let device = expr.children[2];
      let slot = processExpression(expr.children[4]);

      free(slot);

      let attribute = expr.children[6];

      if (attribute.type !== "String") {
        throw new CompilerError("Expected slot attribute to be a string");
      }

      // Remove quotes
      let attributeName = attribute.text.slice(1, attribute.text.length - 1);

      addInstruction(`ls ${outRegister} ${device.text} ${slot.text} ${attributeName}`);

      return { type: "Register", text: outRegister };
    }

    // Convert setSlot to ss (alias)
    if (functionName === "setSlot") functionName = "ss";

    const batchModes = new Set(["Average", "Sum", "Minimum", "Maximum"]);

    if (batchModes.has(functionName)) {
      // Check if this is a batch operation
      const argument = expr.children[2];
      const idfs = collapseProperty(argument);
  
      let x0 = idfs[0].text;
      let x1 = idfs[1].text;
  
      if (!defined.has(x0)) {
        x0 = `HASH("${x0}")`;
      }
  
      if (idfs.length == 2) {
        addInstruction(`lb ${outRegister} ${x0} ${x1} ${functionName}`);
      } else if (idfs.length == 3) {
        let x2 = idfs[2].text;
  
        if (!defined.has(x1)) {
          x1 = `HASH("${x1}")`;
        }
  
        addInstruction(`lbn ${outRegister} ${x0} ${x1} ${x2} ${functionName}`);
      }
  
      return { type: "Register", text: outRegister };
    }

    // Default to ic10 instruction
    let args = [];

    // Process arguments
    for (let i = 2; i < expr.children.length; i += 2) {
      args.push(processExpression(expr.children[i]));
    }

    // Free temporary arguments after processing
    for (let arg of args) {
      free(arg);
    }

    // Remove quotes from strings
    for (let arg of args) {
      if (arg.type === "String") {
        arg.text = arg.text.slice(1, arg.text.length - 1);
      }
    }

    addInstruction(`${functionName} ${args.map(arg => arg.text).join(" ")}`);
  }

  function processExpression(expr, outRegister = "none") {
    if (expr.type === "Number") {
      return number(expr, outRegister);
    }

    if (expr.type === "String") {
      return expr;
    }

    if (expr.type === "Bool") {
      return bool(expr, outRegister);
    }

    if (expr.type === "Property") {
      return property(expr, outRegister);
    }

    if (expr.type === "Parens") {
      return processExpression(expr.children[1], outRegister);
    }

    if (expr.type === "BinaryOp") {
      return binaryOp(expr, outRegister);
    }

    if (expr.type === "UnaryOp") {
      return unaryOp(expr, outRegister);
    }

    if (expr.type === "FunctionCall") {
      return functionCall(expr, outRegister);
    }

    if (expr.type === "⚠") {
      throw new CompilerError("Unexpected input");
    } else {
      throw new CompilerError(`Unknown expression type: ${expr.type}`);
    }
  }

  // Statements

  function declaration(statement) {
    const variableName = statement.children[1].text;

    // Declaring a variable only
    if (statement.children.length === 2) {
      const { register, cacheInstructions } = cache.get(variableName, true);

      addInstructions(cacheInstructions);

      return;
    }

    const { register, cacheInstructions } = cache.get(variableName);
    
    addInstructions(cacheInstructions);
    
    const value = processExpression(statement.children[3], register);

    free(value);
  }

  function assignment(statement) {
    const target = statement.children[0];
    const idfs = collapseProperty(target);

    // Setting lone variables
    if (idfs.length === 1) {
      if (idfs[0].type !== "VariableName") {
        throw new CompilerError("Expected assignment target to be a variable name");
      }

      let variableName = idfs[0].text;
      let { register, cacheInstructions } = cache.get(variableName, true);

      addInstructions(cacheInstructions);
      processExpression(statement.children[2], register);

      return { type: "Register", text: register };
    }
    
    // Setting device attributes
    let device = idfs[0];

    if (device.type === "Device" || devices.has(device.text)) {
      if (idfs.length !== 2) {
        throw new CompilerError("Expected only one property accessor");
      }

      // Setting a device attribute
      let attributeName = idfs[1].text;
      let value = processExpression(statement.children[2]);

      free(value);
      addInstruction(`s ${device.text} ${attributeName} ${value.text}`);
    } else {
      // Batch setting device attributes
      let value = processExpression(statement.children[2]);
      let x0 = idfs[0].text;
      let x1 = idfs[1].text;

      free(value);

      if (!defined.has(x0)) {
        x0 = `HASH("${x0}")`;
      }

      if (idfs.length === 2) {
        addInstruction(`sb ${x0} ${x1} ${value.text}`);
      } else if (idfs.length === 3) {
        let x2 = idfs[2].text;

        if (!defined.has(x1)) {
          x1 = `HASH("${x1}")`;
        }

        addInstruction(`sbn ${x0} ${x1} ${x2} ${value.text}`);
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

    nEndIfs += 1;

    let currentScope = createScope(scope);
    currentScope.endif = currentScope.index;
    let nextScope = null;

    for (let i = 0; i < statement.children.length; i++) {
      let childStatement = statement.children[i];

      if (childStatement.type === "Else") {
        processStatements(childStatement.children.slice(1), currentScope);
        addInstruction(`end${currentScope.endif}:`);
        break;
      }

      let nextLabel = `end${currentScope.endif}`;

      if (statement.children[i + 1].type !== "end") {
        nextScope = createScope(currentScope);
        nextLabel = `scope${nextScope.index}`;
      }

      // If/ElseIf clause
      let condition = processExpression(childStatement.children[1]);
      
      // Free temporary registers used for condition
      free(condition);

      addInstruction(`beq ${condition.text} 0 ${nextLabel}`);
      processStatements(childStatement.children.slice(3), currentScope);
      
      if (statement.children[i + 1].type === "end") {
        // End of the if/elif/else statement
        addInstruction(`end${currentScope.endif}:`);
        break;
      } else {
        addInstruction(`j end${currentScope.endif}`);
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
    } else if (value.type !== "String") {
      addInstruction(`define ${variableName} HASH("${value.text}")`);
    }

    defined.set(variableName, value);
  }

  function jump(statement) {
    const istructionName = statement.children[0].text;
    const label = statement.children[1].text;
    addInstruction(`${istructionName} ${label}`);
  }

  function instruction(statement) {
    addInstruction(statement.text);
  }

  function processStatement(statement, scope) {
    // Update compiler error position
    CompilerError.from = statement.from;
    CompilerError.to = statement.to;

    if (statement.type === "Declaration") {
      return declaration(statement);
    }

    if (statement.type === "DeviceDeclaration") {
      return deviceDeclaration(statement);
    }

    if (statement.type === "Assignment") {
      return assignment(statement);
    }

    if (statement.type === "LoopExpr") {
      return loopExpr(statement, scope);
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

    if (statement.type === "FunctionCall") {
      return functionCall(statement);
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

  return gen.trim();
}
