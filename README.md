# High-Level Language for Stationeers IC10
This is a `high-level language` for `IC10` that is meant to be fully `backwards compatible` with the standard IC10 programming language. Any IC10 you write will be in the compiled output. This means that if there is a function missing you will be able to use it regardless.
## Documentation
The top example is written in the high level code.
The bottom example is the compiled output in `IC10`.
### Table of Contents
- [Declaring Variables](#declaring-variables)
- [Using Variables](#using-variables)
- [Arithmetic](#arithmetic)
- [Booleans](#booleans)
- [Loops](#loops)
- [If Statements](#if-statements)
- [Using Devices](#using-devices)
- [Using Definitions](#using-definitions)
- [Functions](#functions)
- [Writing IC10 in the High-Level Language](#writing-ic10-in-the-high-level-language)
- [Supported Operators](#supported-operators)

### Declaring Variables
`let` is currently just syntax sugar and only used to define variables without giving a value. There are no variable scopes at the moment. `numbers` are the only thing that can be assigned to variables.
```js
let pi
let y = -2
pi = 3.14
```
```mips
move r11 -2
move r10 3.14
```
You can still technically use all the registers, but this may interfere with how variables are used by the compiler *(not recommended)*.
### Using Variables
Registers 10-15 are used for variables.
```js
let x = 1
let y = x
```
```mips
move r10 1
move r11 r10
```
### Arithmetic
Click [here](#supported-operators) to see the list of all supported operators.
```js
let x = 2 * 2
```
```mips
mul r10 2 2
```
### Booleans
```lua
x = true
y = false
```
```mips
move r10 1
move r11 0
```
### Loops
```js
loop
  yield # Pause for one game tick
end
```
```mips
scope1:
yield
j scope1
```
Break statements:
```js
loop
  break
end
```
```mips
scope1:
j end1
j scope1
end1:
```
Continue statements:
```js
loop
  continue
end
```
```mips
scope2:
j scope2
j scope2
```
### If Statements
A single if statement:
```lua
if true then
  yield
end
```
```mips
beq 1 0 end1
yield
end1:
```
If else statement:
```lua
if false then
  yield
else
  yield
end
```
```mips
beq 0 0 scope2
yield
j end1
scope2:
yield
end1:
```
If elif else statement:
```lua
if false then
  yield
elif true then
  yield
else
  yield
end
```
```mips
beq 0 0 scope2
yield
j end1
scope2:
beq 1 0 scope3
yield
j end1
scope3:
yield
end1:
```
### Using Devices
You can get/set device logic types using dot notation.
```
device pump = d0
pump.Setting = 1
x = pump.On
```
```mips
alias pump d0
s pump Setting 1
l r10 pump On
```
### Using Definitions
A list of all aggregator functions (like Sum) can be found [here](#functions).
```py
define light = StructureWallLight
define active = true
define y = 100

# Count how many lights are on
x = Sum(light.On)

# Turn on all of your wall lights 
light.On = active

# Do something with y
s db Setting y
```
```mips
define light HASH("StructureWallLight")
define active 1
define y 100
lb r10 light On Sum
sb light On active
s db Setting y
```
Reading from and writing to devices with specific names
```py
define light = StructureWallLight

# Count how many lights are on inside
x = Sum(light.Inside.On)

# Turn on all the lights inside
light.Inside.On = true
```
```mips
define light HASH("StructureWallLight")
lbn r10 light HASH("Inside") On Sum
sbn light HASH("Inside") On 1
```
### Functions
Supported functions:
- Average, Sum, Minimum, Maximum, LoadSlot
```py
# Take the average of a logic type for a device group
x = Average(deviceHash.LogicType) # (deviceHash.logicType)

# Load the quantity at slot 0 for device d0
y = loadSlot(d0, 0, "Quantity") # (device, slot index, logic type)
```
```mips
lb r10 HASH("deviceHash") LogicType Average
ls r11 d0 0 Quantity
```
### Writing IC10 in the High-Level Language
Since this high level language is fully backwards compatible with IC10, this means you can use functions and variables from the standard IC10 language directly inside your code! You may be wondering how to write IC10 without using the registers. The solution is to just use the variable names and the compiler will substitute it with the register that it has been assigned.
```mips
x = 1
top:
sleep x
j top
```
```mips
move r10 1
top:
sleep r10
j top
```
### Supported Operators
- Addition/Positive: `+`
- Subtraction/Negative: `-`
- Multiplication: `*`
- Division: `/`
- Or: `||`
- And: `&&`
- Greater than: `>`
- Less than: `<`
- Greater than or equal to: `>=`
- Less than or equal to: `<=`
- Equal to: `==`
- Not equal to: `!=`
- Not: `!`
- Parenthesis: `()`