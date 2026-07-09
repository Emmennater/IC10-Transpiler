# High-Level Language for Stationeers IC10
### [>>> Visit Website <<<](https://emmennater.github.io/IC10-Compiler/)
This is a `high-level language` for `IC10` that is meant to be fully `backwards compatible` with the standard IC10 programming language. Any function written that is not recognized by the compiler will be converted into an IC10 instruction.
![example2](image/README/example2.png)
## Using the Compiler
When you first load the webpage a default script will be loaded. The `✖` next to the name `default-script` means the script is not saved.
A checkmark `✔` indicates the script has been saved and you can safely retrieve it later.

### Saving
Saving takes place in `local storage` which is unqiue to the computer and browser.
Save by pressing `Ctrl + S`. To `rename` a script, change the text in the text input then press `Ctrl + S`.

### Loading Scripts
The drop down `V` will show any other scripts you have saved. The plus `+` will add
a new script with a default name.

### Deleting Scripts
The trash `🗑` will delete the currently loaded script.

## Documentation
The top example is written in the high level code.
The bottom example is the compiled output in `IC10`.
### Table of Contents
- [Declaring Variables](#declaring-variables)
- [Using Variables](#using-variables)
- [Comments](#comments)
- [Arithmetic](#arithmetic)
- [Booleans](#booleans)
- [Labels and Jumps](#labels-and-jumps)
- [Loops](#loops)
- [If Statements](#if-statements)
- [Using Devices](#using-devices)
- [Using Definitions](#using-definitions)
- [Calling Functions](#calling-functions)
- [Defining Functions](#defining-functions)
- [Using IC10 Functions/Variables in the High-Level Language](#using-ic10-functionsvariables-in-the-high-level-language)
- [Supported Operators](#supported-operators)

### Declaring Variables
`let` is used to define variables and does not require an initial value. `numbers` are the only thing that can be assigned to variables. `strings` will be automatically hashed. Registers 10-15 are used for variables.
```
let pi
let y = -2
pi = 3.14
let s = "Hello World!"
```
```
move r11 -2
move r10 3.14
move r12 HASH("Hello World!")
```
You can still technically use all the registers, but this may interfere with how variables are used by the compiler *(not recommended)*.
#### Variable Scopes
A variable that was defined inside of a scope will be freed as soon as the scope ends.
```
loop
  let x = 1
end
x = 2  <-- Error: x is not defined
```
You cannot define a variable with the same name in a shared scope.
```
let x = 1
let x = 2  <-- Error: x was already defined
loop
  let x = 3  <-- Error: x was already defined
end
```
### Using Variables
Once a variable has been defined it can be used.
```
let x = 1
let y = x
```
```
move r10 1
move r11 r10
```
### Comments
```
# This is a comment
```
### Arithmetic
Click [here](#supported-operators) to see the list of all supported operators.
```
let x = 2 * 2
```
```
mul r10 2 2
```
Increment/decrement
```
let x = 0
x++
let y = --x
```
```
move r10 0
add r10 r10 1
sub r10 r10 1
move r11 r10
```
### Booleans
```
let x = true
let y = false
```
```
move r10 1
move r11 0
```
### Labels and Jumps
Labels can be used with jumps just like in IC10.
The compiled output is the exact same.
```
top:
jal bottom
j top
bottom:
j ra
```
### Loops
```
loop
  yield # Pause for one game tick
end
```
```
scope1:
yield
j scope1
```
Break statements:
```
loop
  break
end
```
```
scope1:
j end1
j scope1
end1:
```
Continue statements:
```
loop
  continue
end
```
```
scope2:
j scope2
j scope2
```
While loops:
```
while true do
  yield
end
```
Repeat until loops:
```
let x = 0
repeat
  x = x + 1
until x > 10
```
### If Statements
A single if statement:
```
if true then
  yield
end
```
```
beq 1 0 end1
yield
end1:
```
If else statement:
```
if false then
  yield
else
  yield
end
```
```
beq 0 0 scope2
yield
j end1
scope2:
yield
end1:
```
If elif else statement:
```
if false then
  yield
elif true then
  yield
else
  yield
end
```
```
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
let x = pump.On
```
```
alias pump d0
s pump Setting 1
l r10 pump On
```
Referencing channels can be done similarly
```
device pump = d0
let x = pump:0.Channel0
d0:0.Channel0 = 1
```
```
alias pump d0
l r10 pump:0 Channel0
s d0:0 Channel0 1
```
### Using Definitions
Definitions let you assign a number or a string to an identifier. A list of all aggregator functions (like Sum) can be found [here](#functions).
```
define light = "StructureWallLight"
define active = true
define y = 100
define logicType = Setting

# Count how many lights are on
let x = Sum(light.On)

# Turn on all of your wall lights 
light.On = active

# Logic type based on definition
s(db, logicType, y)
```
```
define light HASH("StructureWallLight")
define active 1
define y 100
lb r10 light On Sum
sb light On active
s db Setting y
```
Reading from and writing to devices with specific names
```
define light = "StructureWallLight"

# Count how many lights are on inside
let x = Sum(light.Inside.On)

# Turn on all the lights inside
light.Inside.On = true
```
```
define light HASH("StructureWallLight")
lbn r10 light HASH("Inside") On Sum
sbn light HASH("Inside") On 1
```
Setting a variable to a definition of a string will hash it.
```
define str = "Hello World!"
let s = str
```
```
define str HASH("Hello World!")
move r10 str
```
Without quotes it will just copy the identifier you wrote.
```
define str = HelloWorld
let s = str
```
```
move r10 HelloWorld
```
### Calling Functions
Aggregator functions:
- Average, Sum, Minimum, Maximum
Everything else is converted directly into an IC10 instruction.
```
# Take the average of a logic type for a device group
let x = Average(deviceHash.LogicType) # (deviceHash.logicType)
```
```
lb r10 HASH("deviceHash") LogicType Average
```
String parameters can be used to specify an IC10 variable.
loadSlot is unique in that the return value can be assigned to a variable directly without using a parameter.
```
# Load the quantity at slot 0 for device d0
let y = loadSlot(d0, 0, Quantity) # (device, slot index, logic type)
```
```
ls r10 d0 0 Quantity
```
Example using setSlot:
```
# Program a sorter
define iron = "ItemIronIngot"
define type = PrefabHash
setSlot(d0, 0, type, iron)
```
```
define iron HASH("ItemIronIngot")
ss d0 0 PrefabHash iron
```
### Defining Functions
After some work, we finally got our own functions with their own scope!
It doesn't matter where a function is defined, it will always appear at the top.
Here is how you use them:
```
fn foo(a, b)
  return a + b
end
let x = foo(1, 2)
```
When you use functions you will see some extra code at the top of your program.
This is to handle the use of stack when entering/leaving function scope.
You can also try your hand at some recursive functions!
```
fn fib(n)
  if n <= 1 then
    return n
  end
  return fib(n - 1) + fib(n - 2)
end
let x = fib(6)
```
Keep in mind the overhead when using functions. It isn't too much when you just have
a single function, but when you nest them it can grow to be quite a bit!
### Using IC10 Functions/Variables in the High-Level Language
Since this high level language is fully backwards compatible with IC10, this means you can use functions and variables from the standard IC10 language directly inside your code! Functions are used in place of instructions. Just pass the parameters you would normally. You may be wondering how to write IC10 without using the registers. The solution is to just use the variable names and the compiler will substitute it with the register that it has been assigned.
```
let x = DisplayMode.Seconds
top:
sleep x
j top
```
```
move r10 DisplayMode.Seconds
top:
sleep r10
j top
```
Syntax from IC10 that can be written the same way:
- yield
- sleep
- j/jal
- labels
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
