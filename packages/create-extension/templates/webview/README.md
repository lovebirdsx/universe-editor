# __displayName__

__description__

A [Universe Editor](https://github.com/lovebirdsx/universe-editor) extension with a webview-backed custom editor, scaffolded with `npm create @universe-editor/extension`.

Opening any `*.__name__` file renders it in a preview editor tab (`__displayName__ Preview`). The renderer in `src/extension.ts` is a static-HTML starting point — replace it with your own (see the webview guide for CSP, `asWebviewUri`, and `localResourceRoots`).

## Workspace Trust

The manifest declares `"capabilities": { "untrustedWorkspaces": true }` — this starter only renders a static preview, so it activates in untrusted workspaces. If your extension will read or execute workspace code (running builds, spawning processes from workspace content), change it to `{ "supported": false, "description": "…" }` (or `"supported": "limited"` to degrade gracefully). With a `main` entry and no declaration, the extension silently does not activate in untrusted workspaces.

## Develop

```bash
npm install
npm run watch          # bundle src/ → dist/ and rebuild on change
npx uex dev --inspect=9229
#   launches the Extension Development Host with this folder loaded;
#   then F5 in VSCode attaches the debugger to the extension host
```

In the dev-host window, create a file named `sample.__name__` and open it — your preview tab appears. Iterate: edit `src/extension.ts`, let watch rebuild, then run **Restart Extension Host** from the command palette.

## Test

```bash
npm test               # vitest unit tests (src/__tests__)
npm run test:e2e       # Playwright e2e (e2e/specs) against a real editor
```

`test:e2e` builds the extension and cold-launches a fresh editor with only this
extension loaded, asserting through the editor's E2E probe (see `e2e/specs/`).
The editor binary is auto-detected on Windows (`%LOCALAPPDATA%\Programs\Universe Editor\Universe Editor.exe`);
set `UNIVERSE_EDITOR_BIN` to point at another build (a packaged executable, or
`out/main/index.js` for a dev build) to override it.

## Package and install

```bash
npm run package        # → <publisher>.<name>-<version>.vsix
```

Install the `.vsix` from the editor's Extensions view ("Install from VSIX…").

## Publish

Register at `<marketplace-url>/gallery/register` (the token is shown once;
publishing is approval-based — `npx uex whoami` shows the status), then:

```bash
npx uex login __publisher__ --registry <marketplace-url>
npx uex publish               # packages (via universe:prepublish) and uploads
```
