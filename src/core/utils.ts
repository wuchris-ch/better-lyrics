

import {getStorage} from "./storage";

class Logger {
  private enabled = true;

  constructor() {
    this.updateStatus();
  }

  updateStatus() {
    getStorage({isLogsEnabled: true}, (items: { isLogsEnabled: boolean }) => {
      this.enabled = items.isLogsEnabled;
    });
  }

  log(...args: any[]) {
    if (this.enabled) {
      console.log(...args);
    }
  }
}

const logger = new Logger();

/**
 * Conditionally logs messages based on the isLogsEnabled setting.
 */
export const log = logger.log.bind(logger);

/**
 * Configures the logging function based on user settings.
 */
export const setUpLog = logger.updateStatus.bind(logger);


/**
 * Converts time string in MM:SS format to total seconds.
 */
export function timeToInt(time: string): number {
  const parts = time.split(":");
  return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
}

/**
 * Unescapes HTML entities in a string.
 * Converts &amp;, &lt;, and &gt; back to their original characters.
 */
export function unEntity(str: string): string {
  return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/**
 * Applies custom CSS to the page by creating or updating a style tag.
 */
export function applyCustomCSS(css: string): void {
  let styleTag = document.getElementById("blyrics-custom-style");
  if (styleTag) {
    styleTag.textContent = css;
  } else {
    styleTag = document.createElement("style");
    styleTag.id = "blyrics-custom-style";
    styleTag.textContent = css;
    document.head.appendChild(styleTag);
  }
}
