import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { Slice } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import {
  diff as diffPlugin,
  startDiffReviewCmd,
  clearDiffReviewCmd,
} from "@milkdown/kit/plugin/diff";
import {
  diffComponent,
  diffComponentConfig,
} from "@milkdown/kit/component/diff";
import { callCommand } from "@milkdown/kit/utils";
import { unifiedMergeView } from "@codemirror/merge";
import {
  EditorView as CMView,
  keymap as cmKeymap,
  drawSelection,
  highlightActiveLine,
  lineNumbers,
} from "@codemirror/view";
import {
  EditorState as CMState,
  Compartment,
  Transaction as CMTransaction,
  type Extension as CMExtension,
} from "@codemirror/state";
import {
  history as cmHistory,
  historyKeymap,
  defaultKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown as cmMarkdown } from "@codemirror/lang-markdown";
import { languages as languageData } from "@codemirror/language-data";
import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import mermaid from "mermaid";

import "@milkdown/crepe/theme/common/style.css";
import "./style.css";

// Provided by VSCode inside webviews.
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
};

const vscode = acquireVsCodeApi();

type Mode = "rich" | "raw";

const appEl = document.getElementById("app")!;
const rawEl = document.getElementById("raw")!;

let crepe: Crepe | undefined;
let cmView: CMView | undefined;
let mode: Mode = "rich";
let isDark = document.body.classList.contains("zd-dark");
let resourceBase = "";

/** Authoritative markdown text inside the webview. */
let currentText = "";
/** Last text posted to (or received from) the extension. */
let sentText = "";
/** True while an external update / mode switch is being applied. */
let applyingExternal = false;

/** Diff-against-HEAD state. */
let diffActive = false;
let baselineText: string | undefined;
let baselinePending = false;

// ---------------------------------------------------------------------------
// document sync: local edits are debounced so the text document's undo
// stack gets chunked steps instead of one per keystroke. Undo/redo inside
// the webview is handled locally by ProseMirror / CodeMirror history.
// ---------------------------------------------------------------------------
let sendTimer: number | undefined;

function onLocalEdit(text: string) {
  if (text === currentText) {
    return;
  }
  currentText = text;
  if (sendTimer !== undefined) {
    clearTimeout(sendTimer);
  }
  sendTimer = window.setTimeout(flushSend, 200);
}

function flushSend() {
  if (sendTimer !== undefined) {
    clearTimeout(sendTimer);
    sendTimer = undefined;
  }
  if (currentText === sentText) {
    return;
  }
  sentText = currentText;
  vscode.postMessage({ type: "change", text: currentText });
}

// ---------------------------------------------------------------------------
// image upload bridge: webview -> extension -> assets/xxx.png -> back
// ---------------------------------------------------------------------------
let uploadSeq = 0;
const pendingUploads = new Map<
  number,
  { resolve: (relPath: string) => void; reject: (e: Error) => void }
>();

function uploadImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = ++uploadSeq;
    pendingUploads.set(id, { resolve, reject });
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1] ?? "";
      vscode.postMessage({ type: "upload-image", id, name: file.name, base64 });
    };
    reader.onerror = () => {
      pendingUploads.delete(id);
      reject(new Error("failed to read file"));
    };
    reader.readAsDataURL(file);
  });
}

/** Resolve relative image paths against the document directory for display,
 *  while the markdown itself keeps the plain relative path. */
function toDisplayUrl(url: string): string {
  if (/^(https?:|data:|vscode-)/i.test(url)) {
    return url;
  }
  return `${resourceBase}/${url.replace(/^\.\//, "")}`;
}

// ---------------------------------------------------------------------------
// mermaid
// ---------------------------------------------------------------------------
let mermaidSeq = 0;
/** Rendered diagram containers and their sources, for theme re-rendering. */
const mermaidBlocks = new Map<HTMLElement, string>();

function initMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: isDark ? "dark" : "default",
  });
}

async function renderMermaidInto(el: HTMLElement, source: string): Promise<void> {
  const id = `zd-mermaid-${++mermaidSeq}`;
  try {
    const { svg } = await mermaid.render(id, source);
    el.innerHTML = svg;
    el.classList.remove("zd-mermaid-error");
  } catch (err) {
    // mermaid may leave its temporary render node behind on failure
    document.getElementById(id)?.remove();
    el.textContent = err instanceof Error ? err.message : String(err);
    el.classList.add("zd-mermaid-error");
  }
}

/** Code block preview hook: renders ```mermaid blocks as diagrams. */
function renderPreview(
  language: string,
  content: string,
  applyPreview: (value: null | string | HTMLElement) => void
): void | null {
  if (language.toLowerCase() !== "mermaid" || !content.trim()) {
    return null;
  }
  const el = document.createElement("div");
  el.className = "zd-mermaid";
  mermaidBlocks.set(el, content);
  void renderMermaidInto(el, content).then(() => applyPreview(el));
  // returning undefined => async preview; a loading placeholder is shown
}

// Language entry so "mermaid" appears in the code block language picker.
const mermaidLanguage = LanguageDescription.of({
  name: "mermaid",
  alias: ["mmd"],
  extensions: ["mmd", "mermaid"],
  load: async () =>
    new LanguageSupport(
      StreamLanguage.define({
        token(stream) {
          stream.skipToEnd();
          return null;
        },
      })
    ),
});

const codeLanguages = [...languageData, mermaidLanguage];

// ---------------------------------------------------------------------------
// rich editor (milkdown crepe)
// ---------------------------------------------------------------------------
async function createRichEditor(initialText: string): Promise<void> {
  crepe = new Crepe({
    root: appEl,
    defaultValue: initialText,
    features: {
      // katex is not bundled; keep the editor lean
      [Crepe.Feature.Latex]: false,
    },
    featureConfigs: {
      [Crepe.Feature.ImageBlock]: {
        onUpload: uploadImage,
        proxyDomURL: toDisplayUrl,
      },
      [Crepe.Feature.CodeMirror]: {
        languages: codeLanguages,
        renderPreview,
      },
    },
  });

  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, markdown) => {
      if (applyingExternal || mode !== "rich") {
        return;
      }
      onLocalEdit(markdown);
    });
  });

  // Diff review support: shows changes against the git HEAD baseline.
  // Direction is current -> baseline, so "accept" restores the baseline
  // chunk (Revert) and "reject" keeps the current text (Keep).
  crepe.editor
    .config((ctx) => {
      ctx.update(diffComponentConfig.key, (config) => ({
        ...config,
        acceptLabel: "Revert",
        rejectLabel: "Keep",
      }));
    })
    .use(diffPlugin)
    .use(diffComponent);

  await crepe.create();
}

/** Replace the rich editor content without polluting ProseMirror history,
 *  restoring the cursor to (approximately) where it was. */
function applyToRich(text: string) {
  if (!crepe) {
    return;
  }
  applyingExternal = true;
  try {
    crepe.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      const doc = parser(text);
      if (!doc) {
        return;
      }
      const prevPos = view.state.selection.from;
      const tr = view.state.tr
        .replace(0, view.state.doc.content.size, new Slice(doc.content, 0, 0))
        .setMeta("addToHistory", false);
      view.dispatch(tr);
      const pos = Math.min(prevPos, view.state.doc.content.size);
      view.dispatch(
        view.state.tr
          .setSelection(TextSelection.near(view.state.doc.resolve(pos)))
          .setMeta("addToHistory", false)
      );
    });
  } finally {
    applyingExternal = false;
  }
}

// ---------------------------------------------------------------------------
// raw editor (codemirror 6)
// ---------------------------------------------------------------------------
const cmThemeCompartment = new Compartment();
const cmDiffCompartment = new Compartment();

function cmThemeExtensions(dark: boolean): CMExtension {
  return dark ? oneDark : syntaxHighlighting(defaultHighlightStyle);
}

function createRawEditor(initialText: string) {
  cmView = new CMView({
    parent: rawEl,
    state: CMState.create({
      doc: initialText,
      extensions: [
        cmHistory(),
        drawSelection(),
        highlightActiveLine(),
        lineNumbers(),
        cmKeymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        cmMarkdown({ codeLanguages }),
        CMView.lineWrapping,
        cmThemeCompartment.of(cmThemeExtensions(isDark)),
        cmDiffCompartment.of([]),
        CMView.updateListener.of((update) => {
          if (!update.docChanged || applyingExternal || mode !== "raw") {
            return;
          }
          onLocalEdit(update.state.doc.toString());
        }),
      ],
    }),
  });
}

/** Replace the raw editor content without polluting CodeMirror history. */
function applyToRaw(text: string) {
  if (!cmView || cmView.state.doc.toString() === text) {
    return;
  }
  applyingExternal = true;
  try {
    const prevPos = cmView.state.selection.main.head;
    cmView.dispatch({
      changes: { from: 0, to: cmView.state.doc.length, insert: text },
      selection: { anchor: Math.min(prevPos, text.length) },
      annotations: CMTransaction.addToHistory.of(false),
    });
  } finally {
    applyingExternal = false;
  }
}

// ---------------------------------------------------------------------------
// diff against the git HEAD baseline (rendered in rich mode, unified in raw)
// ---------------------------------------------------------------------------
function enableRichDiff() {
  if (baselineText === undefined) {
    return;
  }
  crepe?.editor.action(callCommand(startDiffReviewCmd.key, baselineText));
}

function disableRichDiff() {
  crepe?.editor.action(callCommand(clearDiffReviewCmd.key));
}

function enableRawDiff() {
  if (baselineText === undefined) {
    return;
  }
  cmView?.dispatch({
    effects: cmDiffCompartment.reconfigure(
      unifiedMergeView({
        original: baselineText,
        allowInlineDiffs: true,
        // same wording as the rendered diff: keep the edit / revert to HEAD
        mergeControls: (type, action) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.name = type;
          btn.textContent = type === "accept" ? "Keep" : "Revert";
          btn.addEventListener("click", action);
          return btn;
        },
      })
    ),
  });
}

function disableRawDiff() {
  cmView?.dispatch({ effects: cmDiffCompartment.reconfigure([]) });
}

function toggleDiff() {
  if (diffActive) {
    diffActive = false;
    baselineText = undefined; // refetched next time, so it tracks new commits
    if (mode === "rich") {
      disableRichDiff();
    } else {
      disableRawDiff();
    }
    document.body.classList.remove("zd-diffing");
    updateDiffButton();
    return;
  }
  if (baselinePending) {
    return;
  }
  baselinePending = true;
  vscode.postMessage({ type: "request-baseline" });
}

function onBaseline(text: string | undefined, error: string | undefined) {
  baselinePending = false;
  if (error !== undefined || text === undefined) {
    showNotice(`Diff unavailable: ${error ?? "no baseline"}`);
    return;
  }
  baselineText = text;
  diffActive = true;
  if (mode === "rich") {
    enableRichDiff();
  } else {
    enableRawDiff();
  }
  document.body.classList.add("zd-diffing");
  updateDiffButton();
}

let noticeTimer: number | undefined;

function showNotice(text: string) {
  let el = document.getElementById("zd-notice");
  if (!el) {
    el = document.createElement("div");
    el.id = "zd-notice";
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add("zd-visible");
  if (noticeTimer !== undefined) {
    clearTimeout(noticeTimer);
  }
  noticeTimer = window.setTimeout(() => {
    el.classList.remove("zd-visible");
  }, 4000);
}

// ---------------------------------------------------------------------------
// mode toggle (instant rich <-> raw)
// ---------------------------------------------------------------------------
let toggleBtn: HTMLButtonElement | undefined;
let diffBtn: HTMLButtonElement | undefined;

function setMode(next: Mode) {
  if (mode === next) {
    return;
  }
  flushSend(); // push pending local edits before switching views
  mode = next;
  if (next === "raw") {
    if (diffActive) {
      disableRichDiff();
    }
    applyToRaw(currentText);
    if (diffActive) {
      enableRawDiff();
    }
    appEl.classList.add("zd-hidden");
    rawEl.classList.remove("zd-hidden");
    cmView?.focus();
  } else {
    if (diffActive) {
      disableRawDiff();
    }
    applyToRich(currentText);
    if (diffActive) {
      enableRichDiff();
    }
    rawEl.classList.add("zd-hidden");
    appEl.classList.remove("zd-hidden");
    crepe?.editor.action((ctx) => ctx.get(editorViewCtx).focus());
  }
  updateToggleButton();
  vscode.setState({ mode });
}

function toggleMode() {
  setMode(mode === "rich" ? "raw" : "rich");
}

function updateToggleButton() {
  if (!toggleBtn) {
    return;
  }
  toggleBtn.textContent = mode === "rich" ? "</> Raw" : "Aa Rich";
  toggleBtn.title =
    mode === "rich"
      ? "Show raw markdown (Ctrl+Alt+M)"
      : "Show rendered markdown (Ctrl+Alt+M)";
}

function updateDiffButton() {
  if (!diffBtn) {
    return;
  }
  diffBtn.classList.toggle("zd-active", diffActive);
  diffBtn.title = diffActive
    ? "Hide changes since HEAD (Ctrl+Alt+D)"
    : "Show changes since HEAD (Ctrl+Alt+D)";
}

function createToolbar() {
  const bar = document.createElement("div");
  bar.id = "zd-toolbar";

  diffBtn = document.createElement("button");
  diffBtn.type = "button";
  diffBtn.textContent = "± Diff";
  diffBtn.addEventListener("click", toggleDiff);
  bar.appendChild(diffBtn);

  toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.addEventListener("click", toggleMode);
  bar.appendChild(toggleBtn);

  const sourceBtn = document.createElement("button");
  sourceBtn.type = "button";
  sourceBtn.textContent = "Open source";
  sourceBtn.title = "Open in the plain text editor";
  sourceBtn.addEventListener("click", () =>
    vscode.postMessage({ type: "open-source" })
  );
  bar.appendChild(sourceBtn);

  document.body.appendChild(bar);
  updateToggleButton();
  updateDiffButton();
}

// ---------------------------------------------------------------------------
// theme
// ---------------------------------------------------------------------------
function applyTheme(dark: boolean) {
  if (dark === isDark) {
    return;
  }
  isDark = dark;
  document.body.classList.toggle("zd-dark", dark);
  document.body.classList.toggle("zd-light", !dark);
  const light = document.getElementById("zd-theme-light") as HTMLLinkElement | null;
  const darkLink = document.getElementById("zd-theme-dark") as HTMLLinkElement | null;
  if (light) light.disabled = dark;
  if (darkLink) darkLink.disabled = !dark;

  cmView?.dispatch({
    effects: cmThemeCompartment.reconfigure(cmThemeExtensions(dark)),
  });

  // re-render mermaid diagrams with the matching theme
  initMermaid();
  for (const [el, source] of [...mermaidBlocks]) {
    if (!el.isConnected) {
      mermaidBlocks.delete(el);
      continue;
    }
    void renderMermaidInto(el, source);
  }
}

// ---------------------------------------------------------------------------
// external updates & message pump
// ---------------------------------------------------------------------------
/** Apply a document change coming from outside the webview. */
function applyExternal(text: string) {
  if (text === currentText) {
    return;
  }
  if (sendTimer !== undefined) {
    clearTimeout(sendTimer);
    sendTimer = undefined;
  }
  currentText = text;
  sentText = text; // the document already holds this text
  if (mode === "rich") {
    // While a diff review is active the diff plugin blocks every
    // doc-changing transaction that isn't its own, so suspend the review
    // around the update and restart it against the same baseline.
    if (diffActive) {
      disableRichDiff();
      applyToRich(text);
      enableRichDiff();
    } else {
      applyToRich(text);
    }
  } else {
    applyToRaw(text);
  }
  // the hidden editor is re-synced from currentText on the next mode switch
}

async function init(text: string, dark: boolean) {
  currentText = text;
  sentText = text;
  if (dark !== isDark) {
    isDark = dark;
    document.body.classList.toggle("zd-dark", dark);
    document.body.classList.toggle("zd-light", !dark);
  }
  initMermaid();
  createRawEditor(text);
  await createRichEditor(text);
  createToolbar();

  const saved = vscode.getState() as { mode?: Mode } | undefined;
  if (saved?.mode === "raw") {
    setMode("raw");
  }
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  switch (msg.type) {
    case "init": {
      resourceBase = msg.resourceBase ?? "";
      void init(msg.text ?? "", !!msg.dark);
      break;
    }
    case "update": {
      applyExternal(msg.text ?? "");
      break;
    }
    case "theme": {
      applyTheme(!!msg.dark);
      break;
    }
    case "toggle-mode": {
      toggleMode();
      break;
    }
    case "toggle-diff": {
      toggleDiff();
      break;
    }
    case "baseline": {
      onBaseline(
        typeof msg.text === "string" ? msg.text : undefined,
        typeof msg.error === "string" ? msg.error : undefined
      );
      break;
    }
    case "upload-image-result": {
      const pending = pendingUploads.get(msg.id);
      if (!pending) {
        break;
      }
      pendingUploads.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.relPath);
      }
      break;
    }
  }
});

// Ctrl/Cmd+S must save the *current* text even while a debounced change is
// pending, so flush before asking the extension to save. Ctrl/Cmd+Alt+M
// toggles rendering (VSCode keybindings don't reach a focused webview).
window.addEventListener(
  "keydown",
  (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "s") {
      e.preventDefault();
      flushSend();
      vscode.postMessage({ type: "save" });
    } else if (mod && e.altKey && e.key.toLowerCase() === "m") {
      e.preventDefault();
      toggleMode();
    } else if (mod && e.altKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
      toggleDiff();
    }
  },
  true
);

vscode.postMessage({ type: "ready" });
