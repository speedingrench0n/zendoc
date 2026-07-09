import * as vscode from "vscode";
import { ZendocEditorProvider } from "./editorProvider";

export function activate(context: vscode.ExtensionContext) {
  const provider = new ZendocEditorProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      ZendocEditorProvider.viewType,
      provider,
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    )
  );

  // Explorer context menu / command palette: open a .md file with ZenDoc.
  context.subscriptions.push(
    vscode.commands.registerCommand("zendoc.openWith", (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        return;
      }
      void vscode.commands.executeCommand(
        "vscode.openWith",
        target,
        ZendocEditorProvider.viewType
      );
    })
  );

  // Escape hatch: from the rich editor back to the plain text editor.
  context.subscriptions.push(
    vscode.commands.registerCommand("zendoc.openSource", () => {
      const uri = provider.activeDocumentUri;
      if (!uri) {
        return;
      }
      void vscode.commands.executeCommand("vscode.openWith", uri, "default");
    })
  );

  // Instant rich/raw rendering toggle inside the active ZenDoc editor.
  context.subscriptions.push(
    vscode.commands.registerCommand("zendoc.toggleRaw", () => {
      provider.toggleActiveMode();
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme(() => {
      provider.broadcastTheme();
    })
  );
}

export function deactivate() {}
