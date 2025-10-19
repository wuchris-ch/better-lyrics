import { EditorState } from "@codemirror/state";
import { openSearchPanel, highlightSelectionMatches } from "@codemirror/search";
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
} from "@codemirror/view";

import { oneDark } from "@codemirror/theme-one-dark";

import { css } from "@codemirror/lang-css";

let saveTimeout: number;
let editor: EditorView;
let currentThemeName: string | null = null;
let isUserTyping = false;
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
  const editCSS = document.getElementById("css")!;
  const options = document.getElementById("themes-content")!;

  editCSS.style.display = "block";
  options.style.display = "none";
};

document.getElementById("edit-css-btn")?.addEventListener("click", openEditCSS);

const openOptions = (): void => {
  const editCSS = document.getElementById("css")!;
  const options = document.getElementById("themes-content")!;

  editCSS.style.display = "none";
  options.style.display = "block";
};

document.addEventListener("keydown", function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault(); // Prevent the browser's default save dialog
    saveToStorage();
  }
});

document.getElementById("back-btn")?.addEventListener("click", openOptions);

function createEditorState(initialContents: string, options = {}) {
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
    ]),
    css(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    oneDark,
    EditorView.updateListener.of(update => {
      if (update.docChanged) {
        onChange(update.view.state.doc.toString());
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

const themeSelector = document.getElementById("theme-selector") as HTMLSelectElement;
const syncIndicator = document.getElementById("sync-indicator")!;

function onChange(state: string) {
  isUserTyping = true;
  if (currentThemeName !== null) {
    themeSelector.value = "";
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
      themeSelector.value = "";
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

document.addEventListener("DOMContentLoaded", () => {
  console.log("DOM loaded");
  editor = createEditorView(createEditorState("Loading..."), document.getElementById("editor")!);
  document.getElementById("editor-popout-button")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("pages/standalone-editor.html") });
  });

  // Enhanced loading function to check both storage types
  const loadCustomCSS = async (): Promise<string> => {
    try {
      // First check which storage type was used
      const syncData = await chrome.storage.sync.get(["cssStorageType", "customCSS"]);

      if (syncData.cssStorageType === "local") {
        // Load from local storage
        const localData = await chrome.storage.local.get("customCSS");
        return localData.customCSS || "";
      } else {
        // Load from sync storage or fallback to sync if no type is set
        return syncData.customCSS || "";
      }
    } catch (error) {
      console.error("Error loading CSS:", error);
      // Fallback: try both storages
      try {
        const localData = await chrome.storage.local.get("customCSS");
        if (localData.customCSS) return localData.customCSS;

        const syncData = await chrome.storage.sync.get("customCSS");
        return syncData.customCSS || "";
      } catch (fallbackError) {
        console.error("Fallback loading failed:", fallbackError);
        return "";
      }
    }
  };

  // Load saved content with enhanced loading
  loadCustomCSS().then(css => {
    if (css) {
      editor.setState(createEditorState(css));
    }
  });

  // Load themes
  THEMES.forEach((theme, index) => {
    const option = document.createElement("option");
    option.value = index.toString();
    option.textContent = `${theme.name} by ${theme.author}`;
    themeSelector?.appendChild(option);
  });

  // Enhanced theme and CSS loading
  Promise.all([chrome.storage.sync.get(["themeName"] as any), loadCustomCSS()]).then(([syncData, css]) => {
    if (syncData.themeName) {
      const themeIndex = THEMES.findIndex(theme => theme.name === syncData.themeName);
      if (themeIndex !== -1) {
        themeSelector.value = themeIndex.toString();
        currentThemeName = syncData.themeName;
      }
    }
    if (css) {
      editor.setState(createEditorState(css));
    }
  });

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
      const themeContent = `/* ${selectedTheme.name}, a theme for BetterLyrics by ${selectedTheme.author} ${selectedTheme.link && `(${selectedTheme.link})`} */

${selectedTheme.css}
`;
      editor.setState(createEditorState(themeContent));

      chrome.storage.sync.set({ themeName: selectedTheme.name });
      currentThemeName = selectedTheme.name;
      isUserTyping = false;
      saveToStorage(true);
      showAlert(`Applied theme: ${selectedTheme.name}`);
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
