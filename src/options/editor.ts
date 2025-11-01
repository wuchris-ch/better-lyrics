import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, indentUnit } from "@codemirror/language";
import { type Diagnostic, linter, lintGutter, lintKeymap } from "@codemirror/lint";
import { highlightSelectionMatches } from "@codemirror/search";
import { EditorState } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
  tooltips,
} from "@codemirror/view";
import { materialDark } from "@fsegurai/codemirror-theme-material-dark";

let saveTimeout: number;
let editor: EditorView;
let currentThemeName: string | null = null;
let isUserTyping = false;
let saveCount = 0;
const SAVE_DEBOUNCE_DELAY = 1000;

// Storage quota limits (in bytes)
const SYNC_STORAGE_LIMIT = 7000; // Leave some buffer under 8KB limit
const MAX_RETRY_ATTEMPTS = 3;

import THEMES, {
  type CustomTheme,
  deleteCustomTheme,
  getCustomThemes,
  renameCustomTheme,
  saveCustomTheme,
} from "./themes";

const showAlert = (message: string): void => {
  const status = document.getElementById("status-css")!;
  status.innerText = message;
  status.classList.add("active");

  setTimeout(() => {
    status.classList.remove("active");
    setTimeout(() => {
      status.innerText = "";
    }, 200);
  }, 2000);
};

const openEditCSS = (): void => {
  const editCSS = document.getElementById("css");
  const options = document.getElementById("options");
  const themeContent = document.getElementById("themes-content");
  if (editCSS && themeContent && options) {
    editCSS.style.display = "block";
    options.style.display = "none";
    themeContent.style.display = "none";
  }
};

document.getElementById("edit-css-btn")?.addEventListener("click", openEditCSS);

const openOptions = (): void => {
  const editCSS = document.getElementById("css");
  const options = document.getElementById("options");
  const themeContent = document.getElementById("themes-content");

  if (editCSS && themeContent && options) {
    editCSS.style.display = "";
    options.style.display = "";
    themeContent.style.display = "";
  }
};

document.addEventListener("keydown", function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault(); // Prevent the browser's default save dialog
    saveToStorage();
  }
});

document.getElementById("back-btn")?.addEventListener("click", openOptions);

const CONFIG = {
  rules: {
    // https://github.com/stylelint/stylelint-config-recommended/blob/main/index.js
    "annotation-no-unknown": true,
    "at-rule-no-unknown": true,
    "block-no-empty": true,
    "color-no-invalid-hex": true,
    "comment-no-empty": true,
    "custom-property-no-missing-var-function": true,
    "declaration-block-no-duplicate-custom-properties": true,
    "declaration-block-no-duplicate-properties": [
      true,
      {
        ignore: ["consecutive-duplicates-with-different-values"],
      },
    ],
    "declaration-block-no-shorthand-property-overrides": true,
    "font-family-no-duplicate-names": true,
    "font-family-no-missing-generic-family-keyword": true,
    "function-calc-no-unspaced-operator": true,
    "function-linear-gradient-no-nonstandard-direction": true,
    "function-no-unknown": true,
    "keyframe-block-no-duplicate-selectors": true,
    "keyframe-declaration-no-important": true,
    "media-feature-name-no-unknown": true,
    "named-grid-areas-no-invalid": true,
    "no-descending-specificity": true,
    "no-duplicate-at-import-rules": true,
    "no-duplicate-selectors": true,
    "no-empty-source": true,
    "no-invalid-double-slash-comments": true,
    "no-invalid-position-at-import-rule": true,
    "no-irregular-whitespace": true,
    "property-no-unknown": true,
    "selector-pseudo-class-no-unknown": true,
    "selector-pseudo-element-no-unknown": true,
    "selector-type-no-unknown": [
      true,
      {
        ignore: ["custom-elements"],
      },
    ],
    "string-no-newline": true,
    "unit-no-unknown": true,
  },
};

const cssLinter = linter(async view => {
  let diagnostics: Diagnostic[] = [];
  const doc = view.state.doc.toString();

  try {
    // @ts-ignore
    const result = await window.stylelint.lint({
      code: doc,
      config: {
        ...CONFIG,
      },
      // Suppress console output from stylelint
    });

    if (result.results && result.results.length > 0) {
      result.results[0].warnings.forEach((warning: any) => {
        console.log(warning);
        diagnostics.push({
          from: view.state.doc.line(warning.line).from + warning.column - 1,
          to:
            view.state.doc.line(warning.endLine || warning.line).from +
            warning.column +
            (warning.endColumn ? warning.endColumn - warning.column : 0) -
            1,
          severity: warning.severity as "error" | "warning" | "info",
          message: warning.text,
        });
      });
    }
  } catch (error) {
    console.error("Stylelint error:", error);
  }

  return diagnostics;
});

function createEditorState(initialContents: string) {
  let extensions = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    indentUnit.of("  "),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    keymap.of([
      { key: "Tab", run: acceptCompletion },
      indentWithTab,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
    ]),
    css(),
    lintGutter(),
    cssLinter,
    tooltips(),
    materialDark,
    EditorView.updateListener.of(update => {
      let text = update.state.doc.toString();
      if (update.docChanged && !text.startsWith("Loading")) {
        onChange(text);
      }
    }),
  ];

  return EditorState.create({
    doc: initialContents,
    extensions,
  });
}

function createEditorView(state: EditorState, parent: Element) {
  return new EditorView({ state, parent });
}

const themeSelector = document.getElementById("theme-selector") as HTMLSelectElement | null;
const syncIndicator = document.getElementById("sync-indicator")!;
const themeNameDisplay = document.getElementById("theme-name-display");
const themeNameText = document.getElementById("theme-name-text");
const editThemeBtn = document.getElementById("edit-theme-btn");
const deleteThemeBtn = document.getElementById("delete-theme-btn");

let isCustomTheme = false;

function showThemeName(themeName: string, custom: boolean = false): void {
  if (themeNameDisplay && themeNameText) {
    themeNameText.textContent = themeName;
    themeNameDisplay.classList.add("active");
    isCustomTheme = custom;

    console.log("showThemeName called:", { themeName, custom, editThemeBtn, deleteThemeBtn });

    if (editThemeBtn) {
      if (custom) {
        editThemeBtn.classList.add("active");
        console.log("Added active class to edit button");
      } else {
        editThemeBtn.classList.remove("active");
      }
    } else {
      console.warn("editThemeBtn not found!");
    }

    if (deleteThemeBtn) {
      if (custom) {
        deleteThemeBtn.classList.add("active");
        console.log("Added active class to delete button");
      } else {
        deleteThemeBtn.classList.remove("active");
      }
    } else {
      console.warn("deleteThemeBtn not found!");
    }
  }
}

function hideThemeName(): void {
  if (themeNameDisplay) {
    themeNameDisplay.classList.remove("active");
  }
  if (editThemeBtn) {
    editThemeBtn.classList.remove("active");
  }
  if (deleteThemeBtn) {
    deleteThemeBtn.classList.remove("active");
  }
  isCustomTheme = false;
}

function onChange(state: string) {
  isUserTyping = true;
  if (currentThemeName !== null && !isCustomTheme) {
    if (themeSelector) {
      themeSelector.value = "";
    }
    currentThemeName = null;
    chrome.storage.sync.remove("themeName");
    hideThemeName();
  } else if (isCustomTheme && currentThemeName) {
    debounceSaveCustomTheme();
  }
  debounceSave();
}

let saveCustomThemeTimeout: number;
const SAVE_CUSTOM_THEME_DEBOUNCE = 2000;

function debounceSaveCustomTheme() {
  clearTimeout(saveCustomThemeTimeout);
  saveCustomThemeTimeout = window.setTimeout(async () => {
    if (currentThemeName && isCustomTheme) {
      const css = editor.state.doc.toString();
      const cleanCss = css.replace(/^\/\*.*?\*\/\n\n/s, "").trim();

      try {
        await saveCustomTheme(currentThemeName, cleanCss);
        console.log(`Auto-saved custom theme: ${currentThemeName}`);
      } catch (error) {
        console.error("Error auto-saving custom theme:", error);
      }
    }
  }, SAVE_CUSTOM_THEME_DEBOUNCE);
}

function debounceSave() {
  syncIndicator.style.display = "block";
  clearTimeout(saveTimeout);
  saveTimeout = window.setTimeout(saveToStorage, SAVE_DEBOUNCE_DELAY);
}

// Enhanced storage management
const getStorageStrategy = (css: string): "local" | "sync" => {
  const cssSize = new Blob([css]).size;
  return cssSize > SYNC_STORAGE_LIMIT ? "local" : "sync";
};

const saveToStorageWithFallback = async (
  css: string,
  isTheme = false,
  retryCount = 0
): Promise<{ success: boolean; strategy?: "local" | "sync"; wasRetry?: boolean; error?: any }> => {
  try {
    const strategy = getStorageStrategy(css);

    if (strategy === "local") {
      // Use local storage for large content
      await chrome.storage.local.set({ customCSS: css });
      // Clear any sync storage CSS to avoid conflicts
      await chrome.storage.sync.remove("customCSS");
      // Store a flag indicating we're using local storage
      await chrome.storage.sync.set({ cssStorageType: "local" });
    } else {
      // Use sync storage for smaller content
      await chrome.storage.sync.set({ customCSS: css, cssStorageType: "sync" });
      // Clear any local storage CSS to avoid conflicts
      await chrome.storage.local.remove("customCSS");
    }

    // Always handle theme name in sync storage (small data)
    if (!isTheme && isUserTyping && !isCustomTheme) {
      await chrome.storage.sync.remove("themeName");
      if (themeSelector) {
        themeSelector.value = "";
      }
      currentThemeName = null;
    }

    return { success: true, strategy };
  } catch (error: any) {
    console.error("Storage save attempt failed:", error);

    if (error.message?.includes("quota") && retryCount < MAX_RETRY_ATTEMPTS) {
      // Quota exceeded, try with local storage
      try {
        await chrome.storage.local.set({ customCSS: css });
        await chrome.storage.sync.remove("customCSS");
        await chrome.storage.sync.set({ cssStorageType: "local" });
        return { success: true, strategy: "local", wasRetry: true };
      } catch (localError) {
        console.error("Local storage fallback failed:", localError);
        return { success: false, error: localError };
      }
    }

    return { success: false, error };
  }
};

function saveToStorage(isTheme = false) {
  saveCount++;
  const css = editor.state.doc.toString();

  if (!isTheme && isUserTyping && !isCustomTheme) {
    // Only remove theme selection if it's not a theme save and the user is typing
    chrome.storage.sync.remove("themeName");
    if (themeSelector) {
      themeSelector.value = "";
    }
    currentThemeName = null;
  }

  saveToStorageWithFallback(css, isTheme)
    .then(result => {
      if (result.success) {
        syncIndicator.innerText =
          result.strategy === "local" ? (result.wasRetry ? "Saved (Large CSS - Local)" : "Saved (Local)") : "Saved!";
        syncIndicator.classList.add("success");

        setTimeout(() => {
          syncIndicator.style.display = "none";
          syncIndicator.innerText = "Saving...";
          syncIndicator.classList.remove("success");
        }, 1000);

        // Send message to all tabs to update CSS
        try {
          chrome.runtime
            .sendMessage({
              action: "updateCSS",
              css: css,
              storageType: result.strategy,
            })
            .catch(error => {
              console.log("[BetterLyrics] (Safe to ignore) Error sending message:", error);
            });
        } catch (err) {
          console.log(err);
        }
      } else {
        throw result.error;
      }
    })
    .catch(err => {
      console.error("Error saving to storage:", err);

      let errorMessage = "Something went wrong!";
      if (err.message?.includes("quota")) {
        errorMessage = "CSS too large for storage!";
      }

      syncIndicator.innerText = errorMessage;
      syncIndicator.classList.add("error");
      setTimeout(() => {
        syncIndicator.style.display = "none";
        syncIndicator.innerText = "Saving...";
        syncIndicator.classList.remove("error");
      }, 3000);
    });

  isUserTyping = false;
}

async function loadCustomCSS(): Promise<string> {
  // Enhanced loading function to check both storage types
  let css: string | null = null;
  try {
    // First check which storage type was used
    const syncData = await chrome.storage.sync.get(["cssStorageType", "customCSS"]);

    if (syncData.cssStorageType === "local") {
      // Load from local storage
      const localData = await chrome.storage.local.get("customCSS");
      css = localData.customCSS;
    } else {
      // Load from sync storage or fallback to sync if no type is set
      css = syncData.customCSS;
    }
  } catch (error) {
    console.error("Error loading CSS:", error);
    // Fallback: try both storages
    try {
      const localData = await chrome.storage.local.get("customCSS");
      if (localData.customCSS) {
        css = localData.customCSS;
      }

      const syncData = await chrome.storage.sync.get("customCSS");
      css = syncData.customCSS;
    } catch (fallbackError) {
      console.error("Fallback loading failed:", fallbackError);
    }
  }
  return css || "";
}

async function populateThemeSelector(): Promise<void> {
  if (!themeSelector) return;

  themeSelector.innerHTML = "<option selected value>Choose a theme</option>";

  const builtInGroup = document.createElement("optgroup");
  builtInGroup.label = "Built-in Themes";
  THEMES.forEach((theme, index) => {
    const option = document.createElement("option");
    option.value = `builtin-${index}`;
    option.textContent = `${theme.name} by ${theme.author}`;
    builtInGroup.appendChild(option);
  });
  themeSelector.appendChild(builtInGroup);

  const customThemes = await getCustomThemes();
  if (customThemes.length > 0) {
    const customGroup = document.createElement("optgroup");
    customGroup.label = "Custom Themes";
    customThemes.forEach((theme, index) => {
      const option = document.createElement("option");
      option.value = `custom-${index}`;
      option.textContent = theme.name;
      customGroup.appendChild(option);
    });
    themeSelector.appendChild(customGroup);
  }
}

async function setThemeName() {
  await chrome.storage.sync.get("themeName").then(async syncData => {
    if (syncData.themeName) {
      const builtInIndex = THEMES.findIndex(theme => theme.name === syncData.themeName);
      if (builtInIndex !== -1) {
        if (themeSelector) {
          themeSelector.value = `builtin-${builtInIndex}`;
        }
        currentThemeName = syncData.themeName;
        showThemeName(syncData.themeName, false);
      } else {
        const customThemes = await getCustomThemes();
        const customIndex = customThemes.findIndex(theme => theme.name === syncData.themeName);
        if (customIndex !== -1) {
          if (themeSelector) {
            themeSelector.value = `custom-${customIndex}`;
          }
          currentThemeName = syncData.themeName;
          showThemeName(syncData.themeName, true);
        } else {
          if (themeSelector) {
            themeSelector.value = "";
          }
          hideThemeName();
        }
      }
    } else {
      hideThemeName();
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  console.log("DOM loaded");
  editor = createEditorView(createEditorState("Loading..."), document.getElementById("editor")!);
  document.getElementById("editor-popout-button")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("pages/standalone-editor.html") });
  });

  await populateThemeSelector();

  let setSelectedThemePromise = setThemeName();

  let loadCustomCssPromise = loadCustomCSS().then(result => {
    console.log("Loaded Custom CSS:", result);
    editor.setState(createEditorState(result));
  });

  await Promise.allSettled([setSelectedThemePromise, loadCustomCssPromise]);

  themeSelector?.addEventListener("change", async function () {
    if (this.value === "") {
      editor.setState(createEditorState(""));
      saveToStorage();
      chrome.storage.sync.remove("themeName");
      currentThemeName = null;
      hideThemeName();
      showAlert("Cleared theme");
      return;
    }

    const [type, indexStr] = this.value.split("-");
    const index = parseInt(indexStr, 10);

    if (type === "builtin") {
      const selectedTheme = THEMES[index];
      if (selectedTheme) {
        fetch(chrome.runtime.getURL(`css/themes/${selectedTheme.path}`))
          .then(response => response.text())
          .then(css => {
            const themeContent = `/* ${selectedTheme.name}, a theme for BetterLyrics by ${selectedTheme.author} ${selectedTheme.link && `(${selectedTheme.link})`} */\n\n${css}\n`;
            editor.setState(createEditorState(themeContent));

            chrome.storage.sync.set({ themeName: selectedTheme.name });
            currentThemeName = selectedTheme.name;
            isUserTyping = false;
            saveToStorage(true);
            showThemeName(selectedTheme.name, false);
            showAlert(`Applied theme: ${selectedTheme.name}`);
          });
      }
    } else if (type === "custom") {
      const customThemes = await getCustomThemes();
      const selectedTheme = customThemes[index];
      if (selectedTheme) {
        const themeContent = `/* ${selectedTheme.name}, a custom theme for BetterLyrics */\n\n${selectedTheme.css}\n`;
        editor.setState(createEditorState(themeContent));

        chrome.storage.sync.set({ themeName: selectedTheme.name });
        currentThemeName = selectedTheme.name;
        isUserTyping = false;
        saveToStorage(true);
        showThemeName(selectedTheme.name, true);
        showAlert(`Applied custom theme: ${selectedTheme.name}`);
      }
    }
  });

  document.getElementById("save-theme-btn")?.addEventListener("click", async () => {
    const css = editor.state.doc.toString();
    if (!css || css.trim() === "") {
      showAlert("No CSS to save as theme!");
      return;
    }

    const themeName = prompt("Enter a name for this theme:");
    if (!themeName || themeName.trim() === "") {
      showAlert("Theme name cannot be empty!");
      return;
    }

    const cleanCss = css.replace(/^\/\*.*?\*\/\n\n/s, "").trim();

    try {
      await saveCustomTheme(themeName.trim(), cleanCss);
      await populateThemeSelector();

      chrome.storage.sync.set({ themeName: themeName.trim() });
      currentThemeName = themeName.trim();

      const customThemes = await getCustomThemes();
      const themeIndex = customThemes.findIndex(t => t.name === themeName.trim());
      if (themeSelector && themeIndex !== -1) {
        themeSelector.value = `custom-${themeIndex}`;
      }

      showThemeName(themeName.trim(), true);
      showAlert(`Saved custom theme: ${themeName.trim()}`);
    } catch (error) {
      console.error("Error saving theme:", error);
      showAlert("Failed to save theme!");
    }
  });

  themeSelector?.addEventListener("contextmenu", async e => {
    e.preventDefault();
    const selectElement = e.target as HTMLSelectElement;
    const selectedValue = selectElement.value;

    if (!selectedValue || !selectedValue.startsWith("custom-")) {
      return;
    }

    const confirmed = confirm("Delete this custom theme?");
    if (!confirmed) return;

    const [, indexStr] = selectedValue.split("-");
    const index = parseInt(indexStr, 10);

    const customThemes = await getCustomThemes();
    const themeToDelete = customThemes[index];

    if (themeToDelete) {
      try {
        await deleteCustomTheme(themeToDelete.name);
        await populateThemeSelector();

        if (currentThemeName === themeToDelete.name) {
          chrome.storage.sync.remove("themeName");
          currentThemeName = null;
          if (themeSelector) {
            themeSelector.value = "";
          }
        }

        showAlert(`Deleted custom theme: ${themeToDelete.name}`);
      } catch (error) {
        console.error("Error deleting theme:", error);
        showAlert("Failed to delete theme!");
      }
    }
  });

  const renameTheme = async () => {
    if (!currentThemeName || !isCustomTheme) return;

    const newName = prompt("Enter new theme name:", currentThemeName);
    if (!newName || newName.trim() === "" || newName.trim() === currentThemeName) {
      return;
    }

    try {
      await renameCustomTheme(currentThemeName, newName.trim());
      await populateThemeSelector();

      currentThemeName = newName.trim();
      chrome.storage.sync.set({ themeName: currentThemeName });

      const customThemes = await getCustomThemes();
      const themeIndex = customThemes.findIndex(t => t.name === currentThemeName);
      if (themeSelector && themeIndex !== -1) {
        themeSelector.value = `custom-${themeIndex}`;
      }

      showThemeName(currentThemeName, true);
      showAlert(`Theme renamed to: ${currentThemeName}`);
    } catch (error: any) {
      console.error("Error renaming theme:", error);
      const errorMsg = error.message || "Failed to rename theme!";
      showAlert(errorMsg);
    }
  };

  deleteThemeBtn?.addEventListener("click", async () => {
    if (!currentThemeName || !isCustomTheme) return;

    const confirmed = confirm(`Delete custom theme "${currentThemeName}"?`);
    if (!confirmed) return;

    try {
      await deleteCustomTheme(currentThemeName);
      await populateThemeSelector();

      chrome.storage.sync.remove("themeName");
      currentThemeName = null;
      if (themeSelector) {
        themeSelector.value = "";
      }

      hideThemeName();
      showAlert("Custom theme deleted!");
    } catch (error) {
      console.error("Error deleting theme:", error);
      showAlert("Failed to delete theme!");
    }
  });

  editThemeBtn?.addEventListener("click", renameTheme);
  themeNameText?.addEventListener("click", renameTheme);
});

// Themes

const generateDefaultFilename = (): string => {
  const date = new Date();
  const timestamp = date.toISOString().replace(/[:.]/g, "-").slice(0, -5);
  return `blyrics-theme-${timestamp}.css`;
};

const saveCSSToFile = (css: string, defaultFilename: string): void => {
  chrome.permissions.contains({ permissions: ["downloads"] }, hasPermission => {
    if (hasPermission) {
      downloadFile(css, defaultFilename);
    } else {
      chrome.permissions.request({ permissions: ["downloads"] }, granted => {
        if (granted) {
          downloadFile(css, defaultFilename);
        } else {
          fallbackSaveMethod(css, defaultFilename);
        }
      });
    }
  });
};

const downloadFile = (css: string, defaultFilename: string): void => {
  const blob = new Blob([css], { type: "text/css" });
  const url = URL.createObjectURL(blob);

  if (chrome.downloads) {
    chrome.downloads
      .download({
        url: url,
        filename: defaultFilename,
        saveAs: true,
      })
      .then(() => {
        showAlert("CSS file save dialog opened. Choose where to save your file.");
        URL.revokeObjectURL(url);
      })
      .catch(error => {
        console.log(error);
        showAlert("Error saving file. Please try again.");
        URL.revokeObjectURL(url);
      });
  } else {
    fallbackSaveMethod(css, defaultFilename);
  }
};

const fallbackSaveMethod = (css: string, defaultFilename: string): void => {
  const blob = new Blob([css], { type: "text/css" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = defaultFilename;

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  setTimeout(() => URL.revokeObjectURL(url), 100);

  showAlert("CSS file download initiated. Check your downloads folder.");
};

const loadCSSFromFile = (file: File): Promise<string | ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => {
      if (event.target?.result !== null) {
        resolve(event.target!.result);
      } else {
        reject("File was not found");
        return;
      }
    };
    reader.onerror = error => {
      reject(error);
    };
    reader.readAsText(file);
  });
};

document.getElementById("file-import-btn")!.addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".css";
  input.onchange = (event: Event) => {
    const file = (event.target as HTMLInputElement).files?.[0]!;
    loadCSSFromFile(file)
      .then(css => {
        editor.setState(createEditorState(css as string));

        if (themeSelector) {
          themeSelector.value = "";
        }
        currentThemeName = null;
        chrome.storage.sync.remove("themeName");
        hideThemeName();

        isUserTyping = false;
        saveToStorage();

        showAlert(`CSS file "${file.name}" imported!`);
      })
      .catch(err => {
        console.error("Error reading CSS file:", err);
        showAlert("Error reading CSS file! Please try again.");
      });
  };
  input.click();
});

document.getElementById("file-export-btn")!.addEventListener("click", () => {
  const css = editor.state.doc.toString();
  if (!css) {
    showAlert("No styles to export!");
    return;
  }
  const defaultFilename = generateDefaultFilename();
  saveCSSToFile(css, defaultFilename);
});

chrome.storage.onChanged.addListener(async (changes, namespace) => {
  console.log("storage", changes, namespace);
  if (Object.hasOwn(changes, "customCSS")) {
    if (saveCount == 0) {
      await loadCustomCSS().then(result => {
        console.log("Got a CSS Update");
        editor.setState(createEditorState(result));
      });
    }
    saveCount = Math.max(saveCount - 1, 0);
  }

  if (Object.hasOwn(changes, "themeName")) {
    console.log("Got a Theme Name Update");
    await setThemeName();
  }
});
