import { transpile } from "./transpiler.js";
import { getAST } from "./helper.js";

const cases = `
# Order of operations
let y = 3 + 3
let x = (2 * 2) + (4 * y)
let z = 2 + 2 + 1

add r10 3 3
mul r0 2 2
mul r1 4 r10
add r11 r0 r1
add r0 2 2
add r12 r0 1

# Using the stack
let a = 1
let b = 2
let c = 3
let d = 4
let e = 5
let f = 6
let g = 7

move r10 1
move r11 2
move r12 3
move r13 4
move r14 5
move r15 6
put db 0 r10
move r10 7

# Loops
loop
  yield
end

scope1:
yield
j scope1

# If statements
if true then
  yield
end

beq 1 0 end1
yield
end1:

# If statements with expressions
let x = 1
let y = -1
if x + y then
  yield
end

move r10 1
move r11 -1
add r0 r10 r11
beq r0 0 end1
yield
end1:

# If elif else statements
let x = 1
let y = -1
if x + y then
  yield
elif x - y then
  yield
else
  yield
end

move r10 1
move r11 -1
add r0 r10 r11
beq r0 0 scope2
yield
j end1
scope2:
sub r0 r10 r11
beq r0 0 scope3
yield
j end1
scope3:
yield
end1:

# Writing to devices
device machine = d0
machine.ClearMemory = 1
d0.ClearMemory = 1

s d0 ClearMemory 1
s d0 ClearMemory 1

# Reading from devices
device machine = d0
x = machine.ClearMemory
let x = machine.Setting
let y = d0.Pressure

l r10 d0 ClearMemory
l r10 d0 Setting
l r11 d0 Pressure

# Using devices in if statements
if d0.ClearMemory == 1 then
  yield
end

l r0 d0 ClearMemory
seq r0 r0 1
beq r0 0 end1
yield
end1:

# Continue statements
loop
  continue
end

scope1:
j scope1
j scope1

# Break statements
loop
  break
end

scope1:
j end1
j scope1
end1:

# Nested if statements
if 1 then
  if 2 then
    yield
  else
    yield
  end
end

beq 1 0 end1
beq 2 0 scope3
yield
j end2
scope3:
yield
end2:
end1:

# Nested loops
loop
  loop
    break
  end
end

scope1:
scope2:
j end2
j scope2
end2:
j scope1

# If statments with continue statements
loop
  if 1 then
    continue
  end
end

scope1:
beq 1 0 end2
j scope1
end2:
j scope1

# Batch operations
StructurePipeAnalyzer.Setting = 1
let x = Average(StructurePipeAnalyzer.Pressure)

sb HASH("StructurePipeAnalyzer") Setting 1
lb r10 HASH("StructurePipeAnalyzer") Pressure Average

# Batch name operations
StructurePipeAnalyzer.pipe0.Setting = 1
let x = Average(StructurePipeAnalyzer.pipe0.Pressure)

sbn HASH("StructurePipeAnalyzer") HASH("pipe0") Setting 1
lbn r10 HASH("StructurePipeAnalyzer") HASH("pipe0") Pressure Average

# Definitions
define analyzer StructurePipeAnalyzer
analyzer.pipe0.Setting = 1
let x = Average(analyzer.pipe0.Pressure)

define analyzer HASH("StructurePipeAnalyzer")
sbn analyzer HASH("pipe0") Setting 1
lbn r10 analyzer HASH("pipe0") Pressure Average
`;

function format(char) {
  if (!char) return `'${char}'`;
  return `'${char.replace("\n", "\\n")}'`;
}

export function runTests() {
  let parsedCases = [];
  const matchInput = /#[^\n]*\n/g;
  const testNames = cases.match(matchInput).map(c => c.substring(1).trim());

  cases.split(matchInput).map(c => {
    if (c.trim() === "") return;
    let [input, output] = c.split("\n\n");
    input = input.trim();
    output = output.trim();
    parsedCases.push([input, output]);
  });

  for (let i = 0; i < parsedCases.length; i++) {
    let [input, output] = parsedCases[i];
    const name = testNames[i];
    const ast = getAST(input);
    const ic10 = transpile(ast);

    // Assert match
    let passed = true;
    let error = "";
    let pointer = 0;

    for (let i = 0; i < ic10.length; i++) {
      if (ic10[i] !== output[i]) {
        error = `Expected ${format(output[i])}, got ${format(ic10[i])}`;
        passed = false;
        pointer = i;
        break;
      }
    }

    if (passed && ic10.length !== output.length) {
      error = `Expected ${output.length} chars, got ${ic10.length}`;
      passed = false;
      pointer = ic10.length - 1;
    }

    if (passed) {
      console.log(`%cTest passed: ${name}`, "color: limegreen; background: black");
    } else {
      console.log(`%cTest failed: ${name}`, "color: red; background: black");
      console.log(`%cError: ${error}`, "color: red; background: black");
      console.log(`${ic10.slice(0, pointer)}%c${ic10[pointer]}%c${ic10.slice(pointer + 1)}`, "color: red; background: black", "background: transparent");
    }
  }
}
