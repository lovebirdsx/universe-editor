import {
  commands,
  window,
  type ExtensionContext,
  type WebviewPanel,
} from '@universe-editor/extension-api'

const VIEW_TYPE = 'webviewPanel.counter'

// The extension owns the panel: it creates it, decides when to reveal it, and
// must dispose it (or track the user closing the tab via onDidDispose). The tab
// is not bound to any file — nothing is persisted across window reloads.
let panel: WebviewPanel | undefined
let count = 0

function render(): string {
  return `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline';">
</head><body>
<h1>Extension-owned panel</h1>
<p>This tab is not backed by a file. Refreshed ${count} time(s).</p>
</body></html>`
}

export function activate(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand('webview-panel.show', () => {
      // One live panel at a time: showing again just reveals the existing tab.
      if (panel) {
        panel.reveal()
        return
      }
      // No ViewColumn argument (unlike VSCode): the tab opens in the active
      // group; pass { preserveFocus: true } to open it in the background.
      panel = window.createWebviewPanel(VIEW_TYPE, 'Counter', undefined, {
        enableScripts: false,
      })
      panel.webview.html = render()
      panel.onDidDispose(() => {
        panel = undefined
      })
    }),
    commands.registerCommand('webview-panel.reveal', () => {
      count += 1
      if (panel) {
        panel.webview.html = render()
        panel.reveal()
      }
    }),
    commands.registerCommand('webview-panel.dispose', () => {
      panel?.dispose()
    }),
  )
}

export function deactivate(): void {}
