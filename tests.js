import assert from "node:assert/strict";
import { describe, it } from "mocha";
import { compile } from "./compiler.js";
import { getAST } from "./helper.js";

const cases = `
# Constant expressions
let y = 3 + 3
let x = (2 * 2) + (4 * y)
let z = 2 + 2 + 1

move r10 6
mul r0 4 r10
add r11 4 r0
move r12 5

# Order of operations
let y = G.x + G.y
let x = (2 * G.y) + (G.z * y)
let z = G.x + G.y + x

add r10 G.x G.y
mul r0 2 G.y
mul r1 G.z r10
add r11 r0 r1
add r0 G.x G.y
add r12 r0 r11

# Positive and negative values
let x = +1 - -1

move r10 2

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
put db sp r10
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

beqz 1 end1
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
beqz r0 end1
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
beqz r0 scope2
yield
j end1
scope2:
sub r0 r10 r11
beqz r0 scope3
yield
j end1
scope3:
yield
end1:

# Writing to devices
device machine = d0
machine.ClearMemory = 1
d0.ClearMemory = 1

alias machine d0
s machine ClearMemory 1
s d0 ClearMemory 1

# Reading from devices
device machine = d0
let x = machine.ClearMemory
x = machine.Setting
let y = d0.Pressure

alias machine d0
l r10 machine ClearMemory
l r10 machine Setting
l r11 d0 Pressure

# Using devices in if statements
if d0.ClearMemory == 1 then
  yield
end

l r0 d0 ClearMemory
seq r0 r0 1
beqz r0 end1
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

beqz 1 end1
beqz 2 scope3
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
beqz 1 end2
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
define analyzer = "StructurePipeAnalyzer"
analyzer.pipe0.Setting = 1
let x = Average(analyzer.pipe0.Pressure)

define analyzer HASH("StructurePipeAnalyzer")
sbn analyzer HASH("pipe0") Setting 1
lbn r10 analyzer HASH("pipe0") Pressure Average

# Register and device backwards compatibility
device larre = d0
let x
ls(x, larre, 255, Quantity)

alias larre d0
ls r10 larre 255 Quantity

# Load slot function
device larre = d0
define slot = 255
let x = loadSlot(larre, slot, Quantity)

alias larre d0
define slot 255
ls r10 larre slot Quantity

# Set slot function and string definitions
define iron = "ItemIronIngot"
define type = PrefabHash
setSlot(d0, 0, type, iron)

define iron HASH("ItemIronIngot")
ss d0 0 PrefabHash iron

# Not unary operator on device attributes
if !d0.ClearMemory then
  yield
end

l r0 d0 ClearMemory
seq r0 r0 0
beqz r0 end1
yield
end1:

# Using IC10 globals
let x = DisplayMode.Seconds
sleep(x)

move r10 DisplayMode.Seconds
sleep r10

# Newline whitespace
if (
  1 + 1
) > 2 then yield end

beqz 0 end1
yield
end1:

# While loop
let x = 0
while x < 10 do
  yield
  x = x + 1
end

move r10 0
scope1:
slt r0 r10 10
beqz r0 end1
yield
add r10 r10 1
j scope1
end1:

# Repeat until loop
let x = 0
repeat
  yield
  x = x + 1
until x >= 10

move r10 0
scope1:
yield
add r10 r10 1
sge r0 r10 10
beqz r0 scope1

# Increment/decrement operators
let x = 0
x++
let y = --x

move r10 0
add r10 r10 1
sub r10 r10 1
move r11 r10

# Functions
fn foo(a, b)
  return a + b
end
let x = foo(1, 2)

j ProgramStart
foo:
add r9 r0 r1
j ra
ProgramStart:
move r0 1
move r1 2
jal stepInto
jal foo
jal stepOut
move r10 r9

# Recursion
fn fib(n)
  if n <= 1 then
    return n
  end
  return fib(n - 1) + fib(n - 2)
end
let x = fib(6)

j ProgramStart
fib:
push ra
move r10 r0
sle r0 r10 1
beqz r0 end2
move r9 r10
pop ra
j ra
end2:
sub r0 r10 1
jal stepInto
jal fib
jal stepOut
move r11 r9
sub r0 r10 2
jal stepInto
jal fib
jal stepOut
move r0 r9
add r9 r11 r0
pop ra
j ra
ProgramStart:
move r0 6
jal stepInto
jal fib
jal stepOut
move r10 r9

# Functions and a spilling stack
fn foo(a, b, c)
  return a + b + c
end
let a = 1
let b = 2
let c = 3
let d = 4
let e = 5
let f = 6
let g = 7
let h = foo(a, b, c)
let i = h + g

j ProgramStart
foo:
add r3 r0 r1
add r9 r3 r2
j ra
ProgramStart:
move r10 1
move r11 2
move r12 3
move r13 4
move r14 5
move r15 6
put db sp r10
move r10 7
get r3 db sp
move r0 r3
move r1 r11
move r2 r12
add sp sp 1
jal stepInto
jal foo
jal stepOut
sub sp sp 1
add r8 sp 1
put db r8 r13
move r13 r9
add r8 sp 2
put db r8 r14
add r14 r13 r10

# Reading and writing to channels
device pump = d0
let x = pump:0.Channel0
d0:0.Channel0 = 1

alias pump d0
l r10 pump:0 Channel0
s d0:0 Channel0 1
`;

const codeExamples = {
  "bulk plant harvester": [
    `
device larre = d0
device vending = d1
device importBin = d2
define plantSeeds = "SeedBag_Potato"
define plantName = "ItemPotato"
define stackSize 20
define plants = 13
define dropPos = 14
define pickupPos = 15
define homePos = 16

let ra2
let target
let seeds
let planted = false

loop
  jal plant
  seeds = 1
  jal pick
  seeds = 0
  jal pick
end

wait:
loop
  yield
  if larre.Idle == 1 then
    break
  end
end
j ra

pick:
ra2 = ra
target = plants
loop
  larre.Setting = target
  jal wait
  loop
    if (
      loadSlot(larre, 255, Seeding) != seeds ||
      loadSlot(larre, 255, Mature) == 0 ||
      loadSlot(larre, 0, Quantity) == stackSize
    ) then
      break
    end
    larre.Activate = 1
    jal wait
  end
  target = target - 1
  if target == -1 then
    break
  end
end
if loadSlot(larre, 0, Quantity) > 0 then
  larre.Setting = dropPos
  jal wait
  larre.Activate = 1
  jal wait
  importBin.Open = 0
  if seeds == 0 then
    planted = false
  end
end
j ra2

plant:
if planted then
  j ra
end
ra2 = ra
vending.RequestHash = plantSeeds
larre.Setting = pickupPos
jal wait
larre.Activate = 1
jal wait
if loadSlot(larre, 0, Quantity) == 0 then
  vending.RequestHash = plantName
  sleep 1
  larre.Activate = 1
  jal wait
end
target = plants
loop
  larre.Setting = target
  jal wait
  if loadSlot(larre, 255, Occupied) == 0 then
    larre.Activate = 1
    jal wait
  end
  target = target - 1
  if target == -1 then
    break
  end
end
if loadSlot(larre, 0, Quantity) > 0 then
  larre.Setting = dropPos
  jal wait
  larre.Activate = 1
  jal wait
  importBin.Open = 0
  planted = true
end
j ra2`,
    `
alias larre d0
alias vending d1
alias importBin d2
define plantSeeds HASH("SeedBag_Potato")
define plantName HASH("ItemPotato")
define stackSize 20
define plants 13
define dropPos 14
define pickupPos 15
define homePos 16
move r13 0
scope1:
jal plant
move r12 1
jal pick
move r12 0
jal pick
j scope1
wait:
scope2:
yield
l r0 larre Idle
seq r0 r0 1
beqz r0 end3
j end2
end3:
j scope2
end2:
j ra
pick:
move r10 ra
move r11 plants
scope4:
s larre Setting r11
jal wait
scope5:
ls r0 larre 255 Seeding
sne r0 r0 r12
ls r1 larre 255 Mature
seq r1 r1 0
or r0 r0 r1
ls r1 larre 0 Quantity
seq r1 r1 stackSize
or r0 r0 r1
beqz r0 end6
j end5
end6:
s larre Activate 1
jal wait
j scope5
end5:
sub r11 r11 1
seq r0 r11 -1
beqz r0 end7
j end4
end7:
j scope4
end4:
ls r0 larre 0 Quantity
sgt r0 r0 0
beqz r0 end8
s larre Setting dropPos
jal wait
s larre Activate 1
jal wait
s importBin Open 0
seq r0 r12 0
beqz r0 end9
move r13 0
end9:
end8:
j r10
plant:
beqz r13 end10
j ra
end10:
move r10 ra
s vending RequestHash plantSeeds
s larre Setting pickupPos
jal wait
s larre Activate 1
jal wait
ls r0 larre 0 Quantity
seq r0 r0 0
beqz r0 end11
s vending RequestHash plantName
sleep 1
s larre Activate 1
jal wait
end11:
move r11 plants
scope12:
s larre Setting r11
jal wait
ls r0 larre 255 Occupied
seq r0 r0 0
beqz r0 end13
s larre Activate 1
jal wait
end13:
sub r11 r11 1
seq r0 r11 -1
beqz r0 end14
j end12
end14:
j scope12
end12:
ls r0 larre 0 Quantity
sgt r0 r0 0
beqz r0 end15
s larre Setting dropPos
jal wait
s larre Activate 1
jal wait
s importBin Open 0
move r13 1
end15:
j r10`
  ]
};

function format(char) {
  if (!char) return `'${char}'`;
  return `'${char.replace("\n", "\\n")}'`;
}

function getTestCases() {
  const parsedCases = [];

  const matchInput = /#[^\n]*\n/g;
  const testNames = cases.match(matchInput).map(c => c.substring(1).trim());

  cases.split(matchInput).forEach(c => {
    if (c.trim() === "") return;

    let [input, output] = c.split("\n\n");

    parsedCases.push({
      name: testNames[parsedCases.length],
      input: input.trim(),
      output: output.trim()
    });
  });

  for (const example in codeExamples) {
    parsedCases.push({
      name: `Code example ${example}`,
      input: codeExamples[example][0].trim(),
      output: codeExamples[example][1].trim()
    });
  }

  return parsedCases;
}

function runTests() {
  const parsedCases = getTestCases();
  const config = {
    omitPrologue: true,
    keepLabels: true
  };

  for (let i = 0; i < parsedCases.length; i++) {
    let { input, output, name } = parsedCases[i];
    const ast = getAST(input);
    const ic10 = compile(ast, config);

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

describe("Compiler", () => {
  const config = {
    omitPrologue: true,
    keepLabels: true
  };

  for (const test of getTestCases()) {
    it(test.name, () => {
      const ast = getAST(test.input);
      const actual = compile(ast, config);
      assert.strictEqual(actual, test.output);
    });
  }
});
