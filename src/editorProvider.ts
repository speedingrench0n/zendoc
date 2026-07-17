import * as vscode from "vscode";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Messages exchanged with the webview.
 *
 * extension -> webview:
 *   { type: "init",   text, resourceBase, dark }   initial document content
 *   { type: "update", text }                       external edit (git, other tab, undo in source, ...)
 *   { type: "theme",  dark }                       VSCode color theme changed
 *   { type: "toggle-mode" }                        toggle rich/raw rendering
 *   { type: "toggle-diff" }                        toggle diff-vs-HEAD display
 *   { type: "baseline", text | error }             git HEAD content of the document
 *   { type: "upload-image-result", id, relPath | error }
 *
 * webview -> extension:
 *   { type: "ready" }                              webview script loaded
 *   { type: "change", text }                       user edited (rich or raw mode)
 *   { type: "save" }                               user hit Ctrl/Cmd+S inside the webview
 *   { type: "open-source" }                        open the plain text editor
 *   { type: "request-baseline" }                   fetch git HEAD content for diffing
 *   { type: "upload-image", id, name, base64 }     paste / drop image
 */
export class ZendocEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "zendoc.editor";

  /** Uri + panel of the currently focused ZenDoc editor (for commands). */
  private active: { uri: vscode.Uri; panel: vscode.WebviewPanel } | undefined;
  private readonly panels = new Set<vscode.WebviewPanel>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  public get activeDocumentUri(): vscode.Uri | undefined {
    return this.active?.uri;
  }

  /** Ask the focused editor to toggle between rich and raw rendering. */
  public toggleActiveMode(): void {
    this.active?.panel.webview.postMessage({ type: "toggle-mode" });
  }

  /** Ask the focused editor to toggle the diff-vs-HEAD display. */
  public toggleActiveDiff(): void {
    this.active?.panel.webview.postMessage({ type: "toggle-diff" });
  }

  public broadcastTheme(): void {
    const dark = isDarkTheme();
    for (const panel of this.panels) {
      panel.webview.postMessage({ type: "theme", dark });
    }
  }

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const docDir = vscode.Uri.file(path.dirname(document.uri.fsPath));

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
        docDir,
        ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? []),
      ],
    };
    webviewPanel.webview.html = this.getHtml(webviewPanel.webview);

    this.panels.add(webviewPanel);
    this.active = { uri: document.uri, panel: webviewPanel };

    // --- sync state --------------------------------------------------------
    // The exact document text produced by the latest webview edit. When
    // onDidChangeTextDocument reports that text we must not echo it back,
    // or the editor state (cursor, IME composition, PM history) would be
    // destroyed.
    let lastWebviewText: string | undefined;

    // Webview messages are handled strictly in order. Without this, a
    // "save" could run before the preceding "change" finished applying,
    // and two racing "change" edits could corrupt the echo suppression.
    let queue: Promise<void> = Promise.resolve();
    const enqueue = (task: () => Promise<void> | void) => {
      queue = queue.then(task, task) as Promise<void>;
      queue = queue.catch((err) => {
        console.error("[zendoc]", err);
      });
    };

    /**
     * Apply a webview edit as a *minimal* range replace instead of a whole
     * document replace. This keeps the text document's undo stack sane
     * (small steps instead of full snapshots) and avoids flicker in a
     * side-by-side source editor.
     */
    const applyWebviewChange = async (text: string) => {
      if (document.isClosed) {
        return;
      }
      const old = document.getText();
      if (text === old) {
        lastWebviewText = text;
        return;
      }
      lastWebviewText = text;

      let start = 0;
      const minLen = Math.min(old.length, text.length);
      while (start < minLen && old.charCodeAt(start) === text.charCodeAt(start)) {
        start++;
      }
      let oldEnd = old.length;
      let newEnd = text.length;
      while (
        oldEnd > start &&
        newEnd > start &&
        old.charCodeAt(oldEnd - 1) === text.charCodeAt(newEnd - 1)
      ) {
        oldEnd--;
        newEnd--;
      }

      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        document.uri,
        new vscode.Range(document.positionAt(start), document.positionAt(oldEnd)),
        text.slice(start, newEnd)
      );
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) {
        // Edit was rejected — resync the webview with reality.
        lastWebviewText = undefined;
        webviewPanel.webview.postMessage({ type: "update", text: document.getText() });
      }
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      if (e.contentChanges.length === 0) {
        return;
      }
      const text = e.document.getText();
      if (text === lastWebviewText) {
        return; // our own edit bouncing back — ignore
      }
      // The document diverged from the webview (git checkout, source editor
      // typing, undo of an older step, ...) — push the new truth.
      lastWebviewText = undefined;
      webviewPanel.webview.postMessage({ type: "update", text });
    });

    const focusSub = webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.active = { uri: document.uri, panel: webviewPanel };
      }
    });

    webviewPanel.onDidDispose(() => {
      changeSub.dispose();
      focusSub.dispose();
      this.panels.delete(webviewPanel);
      if (this.active?.panel === webviewPanel) {
        this.active = undefined;
      }
    });

    webviewPanel.webview.onDidReceiveMessage((msg) => {
      switch (msg.type) {
        case "ready": {
          enqueue(() => {
            webviewPanel.webview.postMessage({
              type: "init",
              text: document.getText(),
              resourceBase: webviewPanel.webview.asWebviewUri(docDir).toString(),
              dark: isDarkTheme(),
            });
          });
          break;
        }
        case "change": {
          enqueue(() => applyWebviewChange(String(msg.text ?? "")));
          break;
        }
        case "save": {
          // Runs after any pending "change", so the saved file is current.
          enqueue(async () => {
            await vscode.workspace.save(document.uri);
          });
          break;
        }
        case "open-source": {
          void vscode.commands.executeCommand("vscode.openWith", document.uri, "default");
          break;
        }
        case "request-baseline": {
          void this.getGitBaseline(document)
            .then((text) => {
              webviewPanel.webview.postMessage({ type: "baseline", text });
            })
            .catch((err) => {
              webviewPanel.webview.postMessage({
                type: "baseline",
                error: gitErrorMessage(err),
              });
            });
          break;
        }
        case "upload-image": {
          void this.saveImage(document, String(msg.name ?? "image.png"), String(msg.base64 ?? ""))
            .then((relPath) => {
              webviewPanel.webview.postMessage({
                type: "upload-image-result",
                id: msg.id,
                relPath,
              });
            })
            .catch((err) => {
              webviewPanel.webview.postMessage({
                type: "upload-image-result",
                id: msg.id,
                error: String(err),
              });
            });
          break;
        }
      }
    });
  }

  /** The document's content at git HEAD, used as the diff baseline. */
  private async getGitBaseline(document: vscode.TextDocument): Promise<string> {
    if (document.uri.scheme !== "file") {
      throw new Error("document is not a file on disk");
    }
    const docDir = path.dirname(document.uri.fsPath);
    const { stdout: topOut } = await execFileAsync(
      "git",
      ["-C", docDir, "rev-parse", "--show-toplevel"]
    );
    const repoRoot = topOut.trim();
    const relPath = path
      .relative(repoRoot, document.uri.fsPath)
      .split(path.sep)
      .join("/");
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoRoot, "show", `HEAD:${relPath}`],
      { maxBuffer: 64 * 1024 * 1024 }
    );
    return stdout;
  }

  /** Save a pasted/dropped image next to the document under assets/, return the relative path. */
  private async saveImage(
    document: vscode.TextDocument,
    originalName: string,
    base64: string
  ): Promise<string> {
    const docDir = path.dirname(document.uri.fsPath);
    const assetsDir = vscode.Uri.file(path.join(docDir, "assets"));
    await vscode.workspace.fs.createDirectory(assetsDir);

    const ext = path.extname(originalName) || ".png";
    const base =
      path
        .basename(originalName, ext)
        .replace(/[^\w\-]+/g, "-")
        .slice(0, 40) || "image";
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const fileName = `${base}-${stamp}${ext}`;

    const target = vscode.Uri.joinPath(assetsDir, fileName);
    await vscode.workspace.fs.writeFile(target, Buffer.from(base64, "base64"));
    return `assets/${fileName}`;
  }

  private getHtml(webview: vscode.Webview): string {
    const dist = (...p: string[]) =>
      webview.asWebviewUri(
        vscode.Uri.joinPath(this.context.extensionUri, "dist", ...p)
      );

    const nonce = getNonce();
    const dark = isDarkTheme();

    // style-src needs 'unsafe-inline': ProseMirror decorations, Crepe
    // components and mermaid all set inline styles. font-src https: keeps
    // remote theme fonts working when online; it degrades gracefully offline.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: https:`,
      `style-src ${webview.cspSource} 'unsafe-inline' https:`,
      `font-src ${webview.cspSource} data: https:`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${dist("webview.css")}" />
  <link id="zd-theme-light" rel="stylesheet" href="${dist("theme-light.css")}" ${dark ? "disabled" : ""} />
  <link id="zd-theme-dark" rel="stylesheet" href="${dist("theme-dark.css")}" ${dark ? "" : "disabled"} />
</head>
<body class="${dark ? "zd-dark" : "zd-light"}">
  <div id="app"></div>
  <div id="raw" class="zd-hidden"></div>
  <script nonce="${nonce}" src="${dist("webview.js")}"></script>
</body>
</html>`;
  }
}

/** Turn raw git stderr into something readable in the webview notice. */
function gitErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/not a git repository/i.test(raw)) {
    return "file is not inside a git repository";
  }
  if (/does not exist in 'HEAD'|exists on disk, but not in/i.test(raw)) {
    return "file has no committed version yet (new file)";
  }
  if (/HEAD/.test(raw) && /unknown revision|ambiguous argument/i.test(raw)) {
    return "repository has no commits yet";
  }
  const line = raw.split("\n").find((l) => l.includes("fatal:")) ?? raw;
  return line.replace(/^.*fatal:\s*/, "").trim() || "git error";
}

export function isDarkTheme(): boolean {
  const kind = vscode.window.activeColorTheme.kind;
  return (
    kind === vscode.ColorThemeKind.Dark ||
    kind === vscode.ColorThemeKind.HighContrast
  );
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
