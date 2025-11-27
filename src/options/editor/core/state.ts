import type { EditorView } from "@codemirror/view";

type OperationType = "import" | "theme" | "storage" | "init";

interface Operation {
  type: OperationType;
  execute: () => Promise<void>;
  id: string;
}

export class EditorStateManager {
  private editor: EditorView | null = null;
  private operationQueue: Operation[] = [];
  private isProcessing = false;
  private currentThemeName: string | null = null;
  private isCustomTheme = false;
  private saveCount = 0;
  private isUserTyping = false;
  private isProgrammaticChange = false;
  private isSaving = false;
  private saveTimeout: number | null = null;
  private saveCustomThemeTimeout: number | null = null;

  setEditor(editor: EditorView): void {
    this.editor = editor;
    console.log("[EditorStateManager] Editor instance registered");
  }

  getEditor(): EditorView | null {
    return this.editor;
  }

  getCurrentThemeName(): string | null {
    return this.currentThemeName;
  }

  setCurrentThemeName(name: string | null): void {
    this.currentThemeName = name;
    console.log(`[EditorStateManager] Theme name set to: ${name}`);
  }

  getIsCustomTheme(): boolean {
    return this.isCustomTheme;
  }

  setIsCustomTheme(value: boolean): void {
    this.isCustomTheme = value;
  }

  incrementSaveCount(): void {
    this.saveCount++;
    console.log(`[EditorStateManager] Save count incremented to: ${this.saveCount}`);
  }

  decrementSaveCount(): void {
    this.saveCount = Math.max(0, this.saveCount - 1);
    console.log(`[EditorStateManager] Save count decremented to: ${this.saveCount}`);
  }

  getSaveCount(): number {
    return this.saveCount;
  }

  resetSaveCount(): void {
    this.saveCount = 0;
    console.log("[EditorStateManager] Save count reset to 0");
  }

  getIsUserTyping(): boolean {
    return this.isUserTyping;
  }

  setIsUserTyping(value: boolean): void {
    this.isUserTyping = value;
  }

  getIsProgrammaticChange(): boolean {
    return this.isProgrammaticChange;
  }

  getIsSaving(): boolean {
    return this.isSaving;
  }

  setIsSaving(value: boolean): void {
    this.isSaving = value;
    console.log(`[EditorStateManager] isSaving set to: ${value}`);
  }

  getSaveTimeout(): number | null {
    return this.saveTimeout;
  }

  setSaveTimeout(timeout: number): void {
    this.saveTimeout = timeout;
  }

  clearSaveTimeout(): void {
    if (this.saveTimeout !== null) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
  }

  getSaveCustomThemeTimeout(): number | null {
    return this.saveCustomThemeTimeout;
  }

  setSaveCustomThemeTimeout(timeout: number): void {
    this.saveCustomThemeTimeout = timeout;
  }

  clearSaveCustomThemeTimeout(): void {
    if (this.saveCustomThemeTimeout !== null) {
      clearTimeout(this.saveCustomThemeTimeout);
      this.saveCustomThemeTimeout = null;
    }
  }

  private async processQueue(): Promise<void> {
    if (this.isProcessing || this.operationQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    console.log(`[EditorStateManager] Processing queue (${this.operationQueue.length} operations)`);

    try {
      while (this.operationQueue.length > 0) {
        const operation = this.operationQueue.shift()!;
        console.log(`[EditorStateManager] Executing operation: ${operation.type} (${operation.id})`);

        try {
          await operation.execute();
          console.log(`[EditorStateManager] Operation completed: ${operation.type} (${operation.id})`);
        } catch (error) {
          console.error(`[EditorStateManager] Operation failed: ${operation.type} (${operation.id})`, error);
        }
      }
    } finally {
      this.isProcessing = false;
      console.log("[EditorStateManager] Queue processing complete");
    }
  }

  async queueOperation(type: OperationType, execute: () => Promise<void>): Promise<void> {
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    console.log(`[EditorStateManager] Queuing operation: ${type} (${id})`);

    return new Promise((resolve, reject) => {
      this.operationQueue.push({
        type,
        id,
        execute: async () => {
          try {
            await execute();
            resolve();
          } catch (error) {
            reject(error);
          }
        },
      });

      this.processQueue();
    });
  }

  async setEditorContent(css: string, source: string): Promise<void> {
    if (!this.editor) {
      throw new Error("[EditorStateManager] Editor not initialized");
    }

    const currentContent = this.editor.state.doc.toString();

    if (currentContent === css) {
      console.log(`[EditorStateManager] Content unchanged from: ${source}, skipping update`);
      return;
    }

    console.log(`[EditorStateManager] Setting editor content from: ${source} (${css.length} bytes)`);

    this.isProgrammaticChange = true;
    this.editor.dispatch({
      changes: {
        from: 0,
        to: this.editor.state.doc.length,
        insert: css,
      },
    });
    this.isProgrammaticChange = false;

    console.log(`[EditorStateManager] Editor content set successfully from: ${source}`);
  }

  async clearThemeState(): Promise<void> {
    console.log("[EditorStateManager] Clearing theme state");
    await chrome.storage.sync.remove("themeName");
    this.currentThemeName = null;
    this.isCustomTheme = false;
    console.log("[EditorStateManager] Theme state cleared");
  }
}

export const editorStateManager = new EditorStateManager();
