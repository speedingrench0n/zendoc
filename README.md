# ZenDoc — WYSIWYG Markdown Editor for VSCode

Notion-like WYSIWYG markdown editing inside VSCode, built on
[Milkdown Crepe](https://milkdown.dev/). The editor is a
`CustomTextEditorProvider`, so everything you type is live-synced with the
underlying `.md` file — dirty state, save, hot exit and source control all
behave like a normal text editor.

## Features

- **Notion-like editing** — slash commands (`/`), drag handles, floating
  toolbar, tables, task lists, link tooltips, image paste/drop
  (saved to `assets/` next to the document).
- **Two-way `.md` sync** — edits in the rich editor are written to the text
  document as *minimal diffs*; external changes (git checkout, edits in a
  side-by-side source editor) are pushed back into the rich view.
- **Sane undo/redo** — `Ctrl+Z` / `Ctrl+Shift+Z` inside the editor is handled
  by the editor's own history (ProseMirror in rich mode, CodeMirror in raw
  mode). External document syncs are applied with `addToHistory: false`, so
  undo never replays file-sync noise.
- **Instant render on/off** — toggle between the rendered view and raw
  markdown (CodeMirror with syntax highlighting) without leaving the tab:
  the floating `</> Raw` button, the title bar icon, or `Ctrl+Alt+M`
  (`Cmd+Alt+M` on macOS).
- **Mermaid** — ` ```mermaid ` code blocks render as diagrams with a
  preview/code toggle, following the light/dark theme.
- **Code snippets** — syntax-highlighted code blocks with a searchable
  language picker (all CodeMirror languages), copy button included.

## Usage

`.md` files open in ZenDoc by default. To get the plain text editor instead,
use the *Open in Text Editor* title button, or right-click the tab →
*Reopen Editor With… → Text Editor*.

| Command | Description |
| --- | --- |
| `ZenDoc: Open with ZenDoc` | Open a markdown file in the rich editor |
| `ZenDoc: Open in Text Editor` | Escape hatch to the plain source editor |
| `ZenDoc: Toggle Markdown Rendering (Rich / Raw)` | Instant render on/off (`Ctrl+Alt+M`) |

To make the text editor the default again, add to `settings.json`:

```json
"workbench.editorAssociations": { "*.md": "default" }
```

## Development

```bash
npm install
npm run build      # or: npm run watch
```

Press `F5` in VSCode to launch an Extension Development Host.

```bash
npm run typecheck  # tsc --noEmit
npx @vscode/vsce package  # build a .vsix
```

### Architecture

```
src/extension.ts        activation, commands, theme listener
src/editorProvider.ts   CustomTextEditorProvider: webview <-> TextDocument sync
webview/main.ts         Milkdown Crepe (rich) + CodeMirror 6 (raw) + mermaid
```

Sync protocol: the webview posts debounced `change` messages; the extension
applies them as minimal range edits and suppresses the echo by comparing the
resulting document text. Messages are handled through a serialized queue so
`save` always lands after the pending `change`.
