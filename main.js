import { compile, CompileError } from "./compiler.ts";
import { getAST } from "./ast.js";
import { editor, output, updateTextEditor, setRunCallback } from "./codemirror.js";

const LINE_LIMIT = 128;
const BYTE_LIMIT = 4096;

const stats = document.querySelector("#stats");

function run() {
  const txt = editor.state.doc.toString();

  let ic10;
  try {
    let ast = getAST(txt);
    // console.log(ast);
    let config = { removeLabels: true };
    ic10 = compile(ast, config);
  } catch (e) {
    if (e instanceof CompileError) {
      updateTextEditor(output, `# ${e.message}`);
      stats.textContent = "";
      return;
    }
    throw e;
  }

  updateTextEditor(output, ic10);

  const lineCount = ic10 === "" ? 0 : ic10.split("\n").length;
  const byteCount = new TextEncoder().encode(ic10).length;
  stats.textContent = `${lineCount}/${LINE_LIMIT} lines · ${byteCount}/${BYTE_LIMIT} bytes`;
  stats.classList.toggle("over-limit", lineCount > LINE_LIMIT || byteCount > BYTE_LIMIT);
}

// ---------------------- script storage (localStorage) ----------------------

const SCRIPTS_KEY = "ic10-scripts";
const LAST_KEY = "ic10-last-script";

const scriptSelect = document.querySelector("#script-select");
let currentScript = localStorage.getItem(LAST_KEY) ?? "";

function readScripts() {
  try {
    return JSON.parse(localStorage.getItem(SCRIPTS_KEY)) ?? {};
  } catch {
    return {};
  }
}

function writeScripts(scripts) {
  localStorage.setItem(SCRIPTS_KEY, JSON.stringify(scripts));
}

function refreshScriptList() {
  const scripts = readScripts();
  scriptSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "unsaved";
  placeholder.disabled = true;
  scriptSelect.appendChild(placeholder);
  for (const name of Object.keys(scripts).sort()) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    scriptSelect.appendChild(option);
  }
  scriptSelect.value = currentScript && scripts[currentScript] !== undefined ? currentScript : "";
}

function setCurrentScript(name) {
  currentScript = name;
  if (name) localStorage.setItem(LAST_KEY, name);
  else localStorage.removeItem(LAST_KEY);
  refreshScriptList();
}

document.querySelector("#script-save").addEventListener("click", () => {
  const name = currentScript || (window.prompt("Save script as:") ?? "").trim();
  if (!name) return;
  const scripts = readScripts();
  scripts[name] = editor.state.doc.toString();
  writeScripts(scripts);
  setCurrentScript(name);
});

document.querySelector("#script-new").addEventListener("click", () => {
  updateTextEditor(editor, "");
  setCurrentScript("");
});

document.querySelector("#script-delete").addEventListener("click", () => {
  if (!currentScript) return;
  const scripts = readScripts();
  delete scripts[currentScript];
  writeScripts(scripts);
  setCurrentScript("");
});

document.querySelector("#copy-output").addEventListener("click", () => {
  navigator.clipboard.writeText(output.state.doc.toString());
});

scriptSelect.addEventListener("change", () => {
  const scripts = readScripts();
  const name = scriptSelect.value;
  if (!name || scripts[name] === undefined) return;
  updateTextEditor(editor, scripts[name]);
  setCurrentScript(name);
});

// Restore the last opened script before the first compile
{
  const scripts = readScripts();
  if (currentScript && scripts[currentScript] !== undefined) {
    updateTextEditor(editor, scripts[currentScript]);
  } else {
    currentScript = "";
  }
  refreshScriptList();
}

setRunCallback(run);
run();
