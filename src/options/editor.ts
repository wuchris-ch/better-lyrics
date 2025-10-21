import { EditorState } from "@codemirror/state";
import { basicSetup } from "@codemirror/basic-setup";
import { openSearchPanel, highlightSelectionMatches } from "@codemirror/search";
import { type Diagnostic, linter, lintGutter, lintKeymap } from "@codemirror/lint";
import { indentWithTab, history, defaultKeymap, historyKeymap } from "@codemirror/commands";
import {
  foldGutter,
  indentOnInput,
  indentUnit,
  bracketMatching,
  foldKeymap,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { closeBrackets, autocompletion, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import {
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  keymap,
  EditorView,
  type EditorViewConfig,
  ViewPlugin,
  tooltips,
} from "@codemirror/view";

import { oneDark } from "@codemirror/theme-one-dark";

import { css, cssLanguage } from "@codemirror/lang-css";

let saveTimeout: number;
let editor: EditorView;
let currentThemeName: string | null = null;
let isUserTyping = false;
let saveCount = 0;
const SAVE_DEBOUNCE_DELAY = 1000;

// Storage quota limits (in bytes)
const SYNC_STORAGE_LIMIT = 7000; // Leave some buffer under 8KB limit
const MAX_RETRY_ATTEMPTS = 3;

import THEMES from "./themes";

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
    oneDark,
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

function onChange(state: string) {
  isUserTyping = true;
  if (currentThemeName !== null) {
    if (themeSelector) {
      themeSelector.value = "";
    }
    currentThemeName = null;
    chrome.storage.sync.remove("themeName");
  }
  debounceSave();
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
    if (!isTheme && isUserTyping) {
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

  if (!isTheme && isUserTyping) {
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

async function setThemeName() {
  await chrome.storage.sync.get("themeName").then(syncData => {
    if (syncData.themeName && themeSelector) {
      const themeIndex = THEMES.findIndex(theme => theme.name === syncData.themeName);
      if (themeIndex !== -1) {
        themeSelector.value = themeIndex.toString();
        currentThemeName = syncData.themeName;
      } else {
        themeSelector.value = String(0);
      }
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  console.log("DOM loaded");
  editor = createEditorView(createEditorState("Loading..."), document.getElementById("editor")!);
  document.getElementById("editor-popout-button")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("pages/standalone-editor.html") });
  });

  // Load themes
  THEMES.forEach((theme, index) => {
    const option = document.createElement("option");
    option.value = index.toString();
    option.textContent = `${theme.name} by ${theme.author}`;
    themeSelector?.appendChild(option);
  });

  let setSelectedThemePromise = setThemeName();

  let loadCustomCssPromise = loadCustomCSS().then(result => {
    console.log("Loaded Custom CSS:", result);
    editor.setState(createEditorState(result));
  });

  await Promise.allSettled([setSelectedThemePromise, loadCustomCssPromise]);

  // Handle theme selection
  themeSelector?.addEventListener("change", function () {
    // @ts-ignore
    const selectedTheme = THEMES[this.value];
    if (this.value === "") {
      editor.setState(createEditorState(""));
      saveToStorage();
      chrome.storage.sync.remove("themeName");
      currentThemeName = null;
      showAlert("Cleared theme");
      return;
    }

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
          showAlert(`Applied theme: ${selectedTheme.name}`);
        });
    }
  });
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
