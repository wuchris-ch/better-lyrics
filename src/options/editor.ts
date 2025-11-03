// ============================================================================
// IMPORTS
// ============================================================================

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
import { linter, type Diagnostic, lintGutter, lintKeymap } from "@codemirror/lint";
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
import THEMES, { deleteCustomTheme, getCustomThemes, renameCustomTheme, saveCustomTheme } from "./themes";

// ============================================================================
// TYPE DECLARATIONS
// ============================================================================

declare global {
  interface Window {
    stylelint: any;
  }
}

interface ModalOptions {
  title: string;
  message: string;
  inputPlaceholder?: string;
  inputValue?: string;
  confirmText?: string;
  cancelText?: string;
  confirmDanger?: boolean;
  showInput?: boolean;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const SAVE_DEBOUNCE_DELAY = 1000;
const SAVE_CUSTOM_THEME_DEBOUNCE = 2000;
const SYNC_STORAGE_LIMIT = 7000;
const MAX_RETRY_ATTEMPTS = 3;

const stylelintConfig = {
  rules: {
    "annotation-no-unknown": true,
    "at-rule-descriptor-no-unknown": true,
    "at-rule-descriptor-value-no-unknown": true,
    "at-rule-no-deprecated": true,
    "at-rule-no-unknown": true,
    "at-rule-prelude-no-invalid": [true, { ignoreAtRules: ["media"] }],
    "block-no-empty": true,
    "comment-no-empty": true,
    "custom-property-no-missing-var-function": true,
    "declaration-block-no-duplicate-custom-properties": true,
    "declaration-block-no-duplicate-properties": [
      true,
      {
        ignore: ["consecutive-duplicates-with-different-syntaxes"],
      },
    ],
    "declaration-block-no-shorthand-property-overrides": true,
    "declaration-property-value-keyword-no-deprecated": true,
    "declaration-property-value-no-unknown": true,
    "font-family-no-duplicate-names": true,
    "font-family-no-missing-generic-family-keyword": true,
    "function-calc-no-unspaced-operator": true,
    "keyframe-block-no-duplicate-selectors": true,
    "keyframe-declaration-no-important": true,
    "media-feature-name-no-unknown": true,
    "media-feature-name-value-no-unknown": true,
    "media-query-no-invalid": true,
    "media-type-no-deprecated": true,
    "named-grid-areas-no-invalid": true,
    "nesting-selector-no-missing-scoping-root": true,
    "no-descending-specificity": true,
    "no-duplicate-at-import-rules": true,
    "no-duplicate-selectors": true,
    "no-empty-source": true,
    "no-invalid-double-slash-comments": true,
    "no-invalid-position-at-import-rule": true,
    "no-invalid-position-declaration": true,
    "no-irregular-whitespace": true,
    "property-no-deprecated": true,
    "property-no-unknown": true,
    "selector-anb-no-unmatchable": true,
    "selector-pseudo-class-no-unknown": true,
    "selector-pseudo-element-no-unknown": true,
    "selector-type-no-unknown": [
      true,
      {
        ignore: ["custom-elements"],
      },
    ],
    "string-no-newline": [true, { ignore: ["at-rule-preludes", "declaration-values"] }],
    "syntax-string-no-invalid": true,
  },
};

// ============================================================================
// GLOBAL REFERENCES
// ============================================================================

const stylelint = window.stylelint;

// ============================================================================
// STATE VARIABLES
// ============================================================================

let editor: EditorView;
let currentThemeName: string | null = null;
let isUserTyping = false;
let isCustomTheme = false;
let saveCount = 0;
let saveTimeout: number;
let saveCustomThemeTimeout: number;

// ============================================================================
// DOM ELEMENTS
// ============================================================================

const modalOverlay = document.getElementById("modal-overlay") as HTMLElement;
const modalTitle = document.getElementById("modal-title") as HTMLElement;
const modalMessage = document.getElementById("modal-message") as HTMLElement;
const modalInput = document.getElementById("modal-input") as HTMLInputElement;
const modalConfirmBtn = document.getElementById("modal-confirm") as HTMLButtonElement;
const modalCancelBtn = document.getElementById("modal-cancel") as HTMLButtonElement;
const modalCloseBtn = document.getElementById("modal-close") as HTMLButtonElement;
const syncIndicator = document.getElementById("sync-indicator")!;
const themeNameDisplay = document.getElementById("theme-name-display");
const themeNameText = document.getElementById("theme-name-text");
const editThemeBtn = document.getElementById("edit-theme-btn");
const deleteThemeBtn = document.getElementById("delete-theme-btn");
const themeSelectorBtn = document.getElementById("theme-selector-btn") as HTMLButtonElement | null;
const themeModalOverlay = document.getElementById("theme-modal-overlay") as HTMLElement | null;
const themeModalClose = document.getElementById("theme-modal-close") as HTMLButtonElement | null;
const themeModalGrid = document.getElementById("theme-modal-grid") as HTMLElement | null;

// ============================================================================
// MODAL UTILITIES
// ============================================================================

function showModal(options: ModalOptions): Promise<string | null> {
  return new Promise(resolve => {
    modalTitle.textContent = options.title;
    modalMessage.innerHTML = options.message;
    modalConfirmBtn.textContent = options.confirmText || "Confirm";
    modalCancelBtn.textContent = options.cancelText || "Cancel";

    if (options.confirmDanger) {
      modalConfirmBtn.classList.add("modal-btn-danger");
      modalConfirmBtn.classList.remove("modal-btn-primary");
    } else {
      modalConfirmBtn.classList.add("modal-btn-primary");
      modalConfirmBtn.classList.remove("modal-btn-danger");
    }

    if (options.showInput) {
      modalInput.style.display = "block";
      modalInput.placeholder = options.inputPlaceholder || "";
      modalInput.value = options.inputValue || "";
      modalMessage.style.marginBottom = "1rem";
    } else {
      modalInput.style.display = "none";
      modalMessage.style.marginBottom = "0";
    }

    modalOverlay.style.display = "flex";

    requestAnimationFrame(() => {
      modalOverlay.classList.add("active");
    });

    if (options.showInput) {
      setTimeout(() => {
        modalInput.focus();
        modalInput.select();
      }, 100);
    }

    const cleanup = (withAnimation = true) => {
      if (withAnimation) {
        const modal = modalOverlay.querySelector(".modal");
        if (modal) {
          modal.classList.add("closing");
        }
        modalOverlay.classList.remove("active");

        setTimeout(() => {
          modalOverlay.style.display = "none";
          if (modal) {
            modal.classList.remove("closing");
          }
        }, 200);
      } else {
        modalOverlay.classList.remove("active");
        modalOverlay.style.display = "none";
      }

      modalConfirmBtn.onclick = null;
      modalCancelBtn.onclick = null;
      modalCloseBtn.onclick = null;
      modalOverlay.onclick = null;
      modalInput.onkeydown = null;
      document.onkeydown = null;
    };

    const handleConfirm = () => {
      const value = options.showInput ? modalInput.value : "confirmed";
      cleanup();
      resolve(value);
    };

    const handleCancel = () => {
      cleanup();
      resolve(null);
    };

    modalConfirmBtn.onclick = handleConfirm;
    modalCancelBtn.onclick = handleCancel;
    modalCloseBtn.onclick = handleCancel;

    modalOverlay.onclick = e => {
      if (e.target === modalOverlay) {
        handleCancel();
      }
    };

    modalInput.onkeydown = e => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleConfirm();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      }
    };

    document.onkeydown = e => {
      if (e.key === "Escape" && modalOverlay.classList.contains("active")) {
        e.preventDefault();
        handleCancel();
      }
    };
  });
}

async function showPrompt(
  title: string,
  message: string,
  defaultValue = "",
  placeholder = "",
  confirmText = "OK"
): Promise<string | null> {
  return showModal({
    title,
    message,
    inputValue: defaultValue,
    inputPlaceholder: placeholder,
    showInput: true,
    confirmText,
  });
}

async function showConfirm(title: string, message: string, danger = false, confirmText?: string): Promise<boolean> {
  const result = await showModal({
    title,
    message,
    showInput: false,
    confirmText: confirmText || (danger ? "Delete" : "OK"),
    confirmDanger: danger,
  });
  return result !== null;
}

// ============================================================================
// UI UTILITIES
// ============================================================================

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

// ============================================================================
// NAVIGATION
// ============================================================================

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

document.getElementById("edit-css-btn")?.addEventListener("click", openEditCSS);
document.getElementById("back-btn")?.addEventListener("click", openOptions);

document.addEventListener("keydown", function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    saveToStorage();
  }
});

// ============================================================================
// CSS LINTING
// ============================================================================

const cssLinter = linter(async view => {
  const diagnostics: Diagnostic[] = [];
  const code = view.state.doc.toString();

  const getPosition = (line: number, column: number) => {
    const lines = code.split("\n");
    let offset = 0;
    for (let i = 0; i < line - 1; i++) {
      offset += lines[i].length + 1;
    }
    return offset + column - 1;
  };

  try {
    const result = await stylelint.lint({
      code,
      config: stylelintConfig,
    });

    if (result.results && result.results.length > 0) {
      const warnings = result.results[0].warnings;

      warnings.forEach((warning: any) => {
        const from = getPosition(warning.line, warning.column);
        const to = warning.endLine && warning.endColumn ? getPosition(warning.endLine, warning.endColumn) : from + 1;

        const cleanMessage = warning.text.replace(/\s*\([^)]+\)\s*$/, "").trim();

        diagnostics.push({
          from: Math.max(0, from),
          to: Math.max(from + 1, to),
          severity: warning.severity as "error" | "warning",
          message: cleanMessage,
        });
      });
    }
  } catch (error) {
    console.error("[BetterLyrics] Stylelint error:", error);
  }

  return diagnostics;
});

// ============================================================================
// EDITOR INITIALIZATION
// ============================================================================

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

// ============================================================================
// THEME MANAGEMENT
// ============================================================================

function showThemeName(themeName: string, custom: boolean = false): void {
  if (themeNameDisplay && themeNameText) {
    themeNameText.textContent = themeName;
    themeNameDisplay.classList.add("active");
    isCustomTheme = custom;

    console.log("showThemeName called:", {
      themeName,
      custom,
      editThemeBtn,
      deleteThemeBtn,
    });

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
    currentThemeName = null;
    chrome.storage.sync.remove("themeName");
    hideThemeName();
    updateThemeSelectorButton();
  } else if (isCustomTheme && currentThemeName) {
    debounceSaveCustomTheme();
  }
  debounceSave();
}

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

// ============================================================================
// STORAGE MANAGEMENT
// ============================================================================

const getStorageStrategy = (css: string): "local" | "sync" => {
  const cssSize = new Blob([css]).size;
  return cssSize > SYNC_STORAGE_LIMIT ? "local" : "sync";
};

const saveToStorageWithFallback = async (
  css: string,
  isTheme = false,
  retryCount = 0
): Promise<{
  success: boolean;
  strategy?: "local" | "sync";
  wasRetry?: boolean;
  error?: any;
}> => {
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

// ============================================================================
// THEME SELECTOR & MODAL
// ============================================================================

function updateThemeSelectorButton() {
  if (themeSelectorBtn) {
    if (currentThemeName) {
      themeSelectorBtn.textContent = currentThemeName;
    } else {
      themeSelectorBtn.textContent = "Choose a theme";
    }
  }
}

async function populateThemeModal(): Promise<void> {
  if (!themeModalGrid) return;

  themeModalGrid.innerHTML = "";

  const customThemes = await getCustomThemes();

  // Add built-in themes
  const builtInSection = document.createElement("div");
  builtInSection.className = "theme-modal-section";
  builtInSection.innerHTML = '<h3 class="theme-modal-section-title">Built-in Themes</h3>';

  const builtInGrid = document.createElement("div");
  builtInGrid.className = "theme-modal-items";

  THEMES.forEach((theme, index) => {
    const card = createThemeCard({
      name: theme.name,
      author: theme.author,
      isCustom: false,
      index,
    });
    builtInGrid.appendChild(card);
  });

  builtInSection.appendChild(builtInGrid);
  themeModalGrid.appendChild(builtInSection);

  // Add custom themes if any
  if (customThemes.length > 0) {
    const customSection = document.createElement("div");
    customSection.className = "theme-modal-section";
    customSection.innerHTML = '<h3 class="theme-modal-section-title">Custom Themes</h3>';

    const customGrid = document.createElement("div");
    customGrid.className = "theme-modal-items";

    customThemes.forEach((theme, index) => {
      const card = createThemeCard({
        name: theme.name,
        author: "You",
        isCustom: true,
        index,
      });
      customGrid.appendChild(card);
    });

    customSection.appendChild(customGrid);
    themeModalGrid.appendChild(customSection);
  }
}

function createThemeCard(options: { name: string; author: string; isCustom: boolean; index: number }): HTMLElement {
  const card = document.createElement("div");
  card.className = "theme-card";

  if (currentThemeName === options.name) {
    card.classList.add("selected");
  }

  const info = document.createElement("div");
  info.className = "theme-card-info";

  const name = document.createElement("div");
  name.className = "theme-card-name";
  name.textContent = options.name;
  name.title = options.name;

  const author = document.createElement("div");
  author.className = "theme-card-author";
  author.textContent = `by ${options.author}`;
  author.title = `by ${options.author}`;

  info.appendChild(name);
  info.appendChild(author);
  card.appendChild(info);

  card.addEventListener("click", () => {
    selectTheme(options.isCustom, options.index, options.name);
    closeThemeModal();
  });

  return card;
}

async function selectTheme(isCustom: boolean, index: number, themeName: string) {
  if (isCustom) {
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
      updateThemeSelectorButton();
      showAlert(`Applied custom theme: ${selectedTheme.name}`);
    }
  } else {
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
          updateThemeSelectorButton();
          showAlert(`Applied theme: ${selectedTheme.name}`);
        });
    }
  }
}

function openThemeModal() {
  if (themeModalOverlay) {
    populateThemeModal();
    themeModalOverlay.style.display = "flex";
    requestAnimationFrame(() => {
      themeModalOverlay.classList.add("active");
    });
  }
}

function closeThemeModal() {
  if (themeModalOverlay) {
    const modal = themeModalOverlay.querySelector(".theme-modal");
    if (modal) {
      modal.classList.add("closing");
    }
    themeModalOverlay.classList.remove("active");

    setTimeout(() => {
      themeModalOverlay.style.display = "none";
      if (modal) {
        modal.classList.remove("closing");
      }
    }, 200);
  }
}

async function setThemeName() {
  await chrome.storage.sync.get("themeName").then(async syncData => {
    if (syncData.themeName) {
      const builtInIndex = THEMES.findIndex(theme => theme.name === syncData.themeName);
      if (builtInIndex !== -1) {
        currentThemeName = syncData.themeName;
        showThemeName(syncData.themeName, false);
      } else {
        const customThemes = await getCustomThemes();
        const customIndex = customThemes.findIndex(theme => theme.name === syncData.themeName);
        if (customIndex !== -1) {
          currentThemeName = syncData.themeName;
          showThemeName(syncData.themeName, true);
        } else {
          hideThemeName();
        }
      }
    } else {
      hideThemeName();
    }
    updateThemeSelectorButton();
  });
}

// ============================================================================
// INITIALIZATION
// ============================================================================

document.addEventListener("DOMContentLoaded", async () => {
  console.log("DOM loaded");
  editor = createEditorView(createEditorState("Loading..."), document.getElementById("editor")!);
  document.getElementById("editor-popout-button")?.addEventListener("click", () => {
    chrome.tabs.create({
      url: chrome.runtime.getURL("pages/standalone-editor.html"),
    });
  });

  let setSelectedThemePromise = setThemeName();

  let loadCustomCssPromise = loadCustomCSS().then(result => {
    console.log("Loaded Custom CSS:", result);
    editor.setState(createEditorState(result));
  });

  await Promise.allSettled([setSelectedThemePromise, loadCustomCssPromise]);

  // Theme modal event listeners
  themeSelectorBtn?.addEventListener("click", openThemeModal);

  themeModalClose?.addEventListener("click", closeThemeModal);

  themeModalOverlay?.addEventListener("click", e => {
    if (e.target === themeModalOverlay) {
      closeThemeModal();
    }
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && themeModalOverlay?.classList.contains("active")) {
      closeThemeModal();
    }
  });

  document.getElementById("save-theme-btn")?.addEventListener("click", async () => {
    const css = editor.state.doc.toString();
    if (!css || css.trim() === "") {
      showAlert("No CSS to save as theme!");
      return;
    }

    const themeName = await showPrompt("Save as Theme", "Enter a name for this theme:", "", "Theme name");
    if (!themeName || themeName.trim() === "") {
      return;
    }

    const cleanCss = css.replace(/^\/\*.*?\*\/\n\n/s, "").trim();

    try {
      await saveCustomTheme(themeName.trim(), cleanCss);

      chrome.storage.sync.set({ themeName: themeName.trim() });
      currentThemeName = themeName.trim();

      showThemeName(themeName.trim(), true);
      updateThemeSelectorButton();
      showAlert(`Saved custom theme: ${themeName.trim()}`);
    } catch (error) {
      console.error("Error saving theme:", error);
      showAlert("Failed to save theme!");
    }
  });

  const renameTheme = async () => {
    if (!currentThemeName || !isCustomTheme) return;

    const newName = await showPrompt(
      "Rename Theme",
      "Enter a new name for this theme:",
      currentThemeName,
      "Theme name"
    );
    if (!newName || newName.trim() === "" || newName.trim() === currentThemeName) {
      return;
    }

    try {
      await renameCustomTheme(currentThemeName, newName.trim());

      currentThemeName = newName.trim();
      chrome.storage.sync.set({ themeName: currentThemeName });

      showThemeName(currentThemeName, true);
      updateThemeSelectorButton();
      showAlert(`Theme renamed to: ${currentThemeName}`);
    } catch (error: any) {
      console.error("Error renaming theme:", error);
      const errorMsg = error.message || "Failed to rename theme!";
      showAlert(errorMsg);
    }
  };

  deleteThemeBtn?.addEventListener("click", async () => {
    if (!currentThemeName || !isCustomTheme) return;

    const confirmed = await showConfirm(
      "Delete Theme",
      `Are you sure you want to delete the theme <code>${currentThemeName}</code>?`,
      true
    );
    if (!confirmed) return;

    try {
      await deleteCustomTheme(currentThemeName);

      chrome.storage.sync.remove("themeName");
      currentThemeName = null;

      hideThemeName();
      updateThemeSelectorButton();
      showAlert("Custom theme deleted!");
    } catch (error) {
      console.error("Error deleting theme:", error);
      showAlert("Failed to delete theme!");
    }
  });

  editThemeBtn?.addEventListener("click", renameTheme);
  themeNameText?.addEventListener("click", renameTheme);
});

// ============================================================================
// FILE OPERATIONS (IMPORT/EXPORT)
// ============================================================================

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

// ============================================================================
// STORAGE CHANGE LISTENERS
// ============================================================================

chrome.storage.onChanged.addListener(async (changes, namespace) => {
  console.log("storage", changes, namespace);
  if (Object.hasOwn(changes, "customCSS")) {
    if (saveCount === 0) {
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
