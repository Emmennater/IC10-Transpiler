import { editor, output, updateTextEditor, setRunCallback } from "./codemirror.js";

const SCRIPTS_KEY = "ic10-compiler-scripts";
const LAST_KEY = "ic10-compiler-last-script";

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

export function documentChanged() {
  const savedIcon = document.querySelector("#saved-icon");
  savedIcon.innerHTML = currentScript ? "✖" : "";
}

export function saveScript() {
  const name = currentScript || (window.prompt("Save script as:") ?? "").trim();
  if (!name) return;
  const scripts = readScripts();
  scripts[name] = editor.state.doc.toString();
  writeScripts(scripts);
  setCurrentScript(name);
  const savedIcon = document.querySelector("#saved-icon");
  savedIcon.innerHTML = "✔";
}

document.querySelector("#script-rename").addEventListener("click", () => {
  if (!currentScript) return;
  const name = window.prompt("Rename script to:") ?? "";
  if (!name) return;
  const scripts = readScripts();
  scripts[name] = scripts[currentScript];
  delete scripts[currentScript];
  writeScripts(scripts);
  setCurrentScript(name);
});

document.querySelector("#script-save").addEventListener("click", saveScript);

document.querySelector("#script-new").addEventListener("click", () => {
  updateTextEditor(editor, "");
  setCurrentScript("");
});

document.querySelector("#script-delete").addEventListener("click", () => {
  if (!currentScript) return;
  if (!window.confirm(`Delete "${currentScript}"?`)) return;
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

export function setup(run) {
  if (!run) throw new Error("Missing run callback");

  // Restore the last opened script before the first compile
  const scripts = readScripts();
  
  if (currentScript && scripts[currentScript] !== undefined) {
    updateTextEditor(editor, scripts[currentScript]);
  } else {
    currentScript = "";
  }

  document.querySelector("#script-run").addEventListener("click", run);

  refreshScriptList();
  setRunCallback(run);
  run();

  const savedIcon = document.querySelector("#saved-icon");
  savedIcon.innerHTML = "✔";
}
