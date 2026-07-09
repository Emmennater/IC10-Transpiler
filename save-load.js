const SCRIPTS_LOCAL_STORAGE_KEY = "ic10-scripts";
const LAST_SCRIPT_LOCAL_STORAGE_KEY = "ic10-last-script";
const AUTOSAVE_SCRIPT_DELAY = 500; // ms
let lastSavedTimeout = null;
let timeoutActive = false;
let lastSaved = false;
let currentScriptName = "";

const defaultScriptText = `
# This script automatically stops a machine after producing
# the number of items that the stacker is set to.
device machine = d0
device stacker = d1

machine.ClearMemory = 1

loop
  yield
  if machine.ExportCount == stacker.Setting then
    machine.Activate = 0
    machine.ClearMemory = 1
  elif machine.Activate == 0 then
    machine.ClearMemory = 1
  end
end
`.substring(1);

function isObject(obj) {
  return obj !== null && typeof obj === "object";
}

function generateDefaultScriptName(boilerplate = false) {
  const currentScriptName = document.getElementById("scripts-input").value;
  const prefix = boilerplate ? "default-script" : "script";
  let otherScripts = new Set([
    currentScriptName,
    ...document.getElementById("scripts").children,
    ...getScriptNames()
  ]);

  for (let i = 0; true; i++) {
    const name = i === 0 ? prefix : `${prefix}-${i}`;
    if (otherScripts.has(name)) continue;
    return name;
  }
}

function getScriptNames() {
  let scripts = localStorage.getItem(SCRIPTS_LOCAL_STORAGE_KEY);
  scripts = JSON.parse(scripts);
  if (!isObject(scripts)) return [];
  return Object.keys(scripts);
}

function updateScriptName() {
  const oldScriptName = currentScriptName;
  const newScriptName = document.getElementById("scripts-input").value;
  
  if (oldScriptName === newScriptName) return true;
  
  // Check if script name is empty
  if (newScriptName === "") {
    alert("Script name cannot be empty");
    document.getElementById("scripts-input").value = oldScriptName;
    return false;
  }

  // Check if the script name exists
  if (getScriptNames().includes(newScriptName)) {
    alert("Script name already exists");
    document.getElementById("scripts-input").value = oldScriptName;
    return false;
  }

  localStorage.setItem(LAST_SCRIPT_LOCAL_STORAGE_KEY, newScriptName);
  let scripts = JSON.parse(localStorage.getItem(SCRIPTS_LOCAL_STORAGE_KEY));

  if (!isObject(scripts)) scripts = {};

  scripts[newScriptName] = scripts[oldScriptName];
  delete scripts[oldScriptName];
  localStorage.setItem(SCRIPTS_LOCAL_STORAGE_KEY, JSON.stringify(scripts));
  currentScriptName = newScriptName;

  return true;
}

function updateLastScript() {
  currentScriptName = document.getElementById("scripts-input").value;
  localStorage.setItem(LAST_SCRIPT_LOCAL_STORAGE_KEY, currentScriptName);
}

function getSavedScript(name) {
  let scripts = localStorage.getItem(SCRIPTS_LOCAL_STORAGE_KEY);
  scripts = JSON.parse(scripts);

  if (!isObject(scripts)) {
    scripts = {};
  }

  return scripts[name];
}

function saveScript(text) {
  if (!updateScriptName()) {
    return false;
  }

  const scriptName = document.getElementById("scripts-input").value;
  let scripts = localStorage.getItem(SCRIPTS_LOCAL_STORAGE_KEY);
  
  try {
    scripts = JSON.parse(scripts);
  } catch (e) {
    scripts = {};
  }

  if (!isObject(scripts)) {
    scripts = {};
  }

  scripts[scriptName] = text;

  scripts = JSON.stringify(scripts);
  localStorage.setItem(SCRIPTS_LOCAL_STORAGE_KEY, scripts);

  return true;
}

function saveSuccessful(yes) {
  const savedIcon = document.getElementById("saved-icon");
  
  if (yes) {
    savedIcon.innerText = "✔";
    lastSaved = true;
  } else {
    savedIcon.innerText = "✖";
  }
}

function saving() {
  const savedIcon = document.getElementById("saved-icon");
  savedIcon.innerText = "↻";
}

function cancelSave() {
  if (lastSavedTimeout !== null) {
    if (timeoutActive) {
      clearTimeout(lastSavedTimeout);
    }
  }
}

export function notSaved() {
  lastSaved = false;
  const savedIcon = document.getElementById("saved-icon");
  savedIcon.innerText = "✖";
}

export function save(text, delayed = true) {
  cancelSave();
  saving();

  if (delayed) {
    timeoutActive = true;
    lastSavedTimeout = setTimeout(() => {
      timeoutActive = false;
      saveSuccessful(saveScript(text));
      updateLastScript();
    }, AUTOSAVE_SCRIPT_DELAY);
  } else {
    saveSuccessful(saveScript(text));
    updateLastScript();
  }
}

export function setup(loadScript, getScript, compile) {
  if (!loadScript) {
    throw "loadScript is required";
  }

  if (!getScript) {
    throw "getScript is required";
  }

  if (!compile) {
    throw "compile is required";
  }

  document.getElementById("scripts-input").addEventListener("input", (e) => {
    if (e.key === "Enter") return;
    notSaved();
  });

  document.getElementById("scripts-input").addEventListener("keydown", (e) => {
    const isSaveShortcut = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s";

    if (isSaveShortcut) {
      e.preventDefault();
      save(getScript(), false);
    }
  });

  document.getElementById("scripts-button").addEventListener("mousedown", () => {
    const scripts = document.getElementById("scripts");

    // Update with all script names except current one
    const scriptNames = getScriptNames();
    const currentScriptName = document.getElementById("scripts-input").value;

    scripts.innerHTML = "";

    for (let name of scriptNames) {
      if (name === currentScriptName) continue;
      
      const option = document.createElement("div");
      
      option.innerText = name;
      option.classList.add("item");
      option.addEventListener("mousedown", () => {
        if (!lastSaved &&
          !window.confirm("You have unsaved changes. Are you sure you want to open a new script?")) {
          scripts.style.display = "none";
          document.getElementById("scripts-input-wrapper").classList.toggle("open");
          return;
        }

        document.getElementById("scripts-input").value = name;
        document.getElementById("scripts-input-wrapper").classList.toggle("open");
        const scriptText = getSavedScript(name);

        if (scriptText !== undefined) {
          loadScript(scriptText);
          updateLastScript();
          saveSuccessful(true);
          compile();
        } else {
          alert("Script not found");
        }

        scripts.style.display = "none";
      });

      scripts.appendChild(option);
    }

    if (scripts.children.length > 0) {
      scripts.style.display = scripts.style.display === "none" ? "block" : "none";

      // Toggle class "open" for animation
      document.getElementById("scripts-input-wrapper").classList.toggle("open");
    } else {
      alert("No other scripts found");
    }
  });

  document.getElementById("new-script").addEventListener("mousedown", () => {
    if (!lastSaved) {
      if (!window.confirm("You have unsaved changes. Are you sure you want to create a new script?")) {
        return;
      }

      cancelSave();
      document.getElementById("scripts-input").value = "";
      currentScriptName = "";
    }

    const scriptName = generateDefaultScriptName();
    document.getElementById("scripts-input").value = scriptName;
    updateLastScript();
    loadScript("");
    notSaved();
  });

  document.getElementById("delete-script").addEventListener("mousedown", () => {
    if (!window.confirm("Are you sure you want to delete this script?")) {
      return;
    }
    
    const scriptName = document.getElementById("scripts-input").value;
    const scripts = localStorage.getItem(SCRIPTS_LOCAL_STORAGE_KEY);
    const scriptsJson = JSON.parse(scripts);

    if (!isObject(scriptsJson)) return;

    delete scriptsJson[scriptName];
    
    document.getElementById("scripts-input").value = "";
    localStorage.setItem(SCRIPTS_LOCAL_STORAGE_KEY, JSON.stringify(scriptsJson));

    if (Object.keys(scriptsJson).length > 0) {
      // If there is another script, select it
      document.getElementById("scripts-input").value = Object.keys(scriptsJson)[0];
      loadScript(scriptsJson[Object.keys(scriptsJson)[0]]);
      updateLastScript();
      saveSuccessful(true);
    } else {
      // If there are no scripts, create a new one
      document.getElementById("scripts-input").value = generateDefaultScriptName(true);
      loadScript(defaultScriptText);
      notSaved();
      updateLastScript();
    }
  });

  const lastScriptName = localStorage.getItem(LAST_SCRIPT_LOCAL_STORAGE_KEY);
  const scriptText = lastScriptName ? getSavedScript(lastScriptName) : "";
  
  if (lastScriptName && scriptText !== undefined) {
    // Load the last script
    document.getElementById("scripts-input").value = lastScriptName;
    loadScript(scriptText);
    updateLastScript();
    saveSuccessful(true);
  } else {
    // Create a new script
    document.getElementById("scripts-input").value = generateDefaultScriptName(true);
    loadScript(defaultScriptText);
    updateLastScript();
    notSaved();
  }
}
