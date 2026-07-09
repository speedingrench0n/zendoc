import { Crepe } from "@milkdown/crepe";
import { editorViewCtx, parserCtx } from "@milkdown/kit/core";
import { Slice } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
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
// mode toggle (instant rich <-> raw)
// ---------------------------------------------------------------------------
let toggleBtn: HTMLButtonElement | undefined;

function setMode(next: Mode) {
  if (mode === next) {
    return;
  }
  flushSend(); // push pending local edits before switching views
  mode = next;
  if (next === "raw") {
    applyToRaw(currentText);
    appEl.classList.add("zd-hidden");
    rawEl.classList.remove("zd-hidden");
    cmView?.focus();
  } else {
    applyToRich(currentText);
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

function createToolbar() {
  const bar = document.createElement("div");
  bar.id = "zd-toolbar";

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
    applyToRich(text);
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
    }
  },
  true
);

vscode.postMessage({ type: "ready" });
