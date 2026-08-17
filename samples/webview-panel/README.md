# Webview Panel

A minimal `window.createWebviewPanel` sample: an extension-owned webview tab
that is **not** bound to any file (unlike a custom editor, where the workbench
owns the tab and routes matching files to your provider).

Three commands:

- **Webview Panel: Show Panel** — creates the panel (or reveals the existing
  one); sets its HTML.
- **Webview Panel: Reveal Panel** — updates the HTML and re-activates the tab.
- **Webview Panel: Dispose Panel** — closes the tab; `onDidDispose` fires.

Current differences from VSCode: no `ViewColumn` argument (the tab opens in the
active group; `{ preserveFocus: true }` opens it in the background), no
`retainContextWhenHidden` (the iframe always keeps its state while hidden), and
no `WebviewPanelSerializer` (the tab is not restored after a window reload).

## Develop

```bash
npm install
npm run watch          # bundle src/ → dist/ and rebuild on change
npx uex dev --inspect=9229
#   launches the Extension Development Host with this folder loaded
```

## Package and install

```bash
npm run package        # → <publisher>.<name>-<version>.vsix
```

Install the `.vsix` from the editor's Extensions view ("Install from VSIX…")
and run `Webview Panel: Show Panel` from the command palette.

## Publish

Register at `<marketplace-url>/gallery/register` (the token is shown once;
publishing is approval-based — `npx uex whoami` shows the status), then:

```bash
npx uex login universe-samples --registry <marketplace-url>
npx uex publish               # packages (via universe:prepublish) and uploads
```

## Documentation

The full guide to webview surfaces (custom editors and standalone panels)
lives in the Universe Editor repository under `docs/extension-dev/zh-CN/`
(see `webview-guide.md`).
