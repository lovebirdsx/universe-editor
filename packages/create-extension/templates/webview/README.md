# __displayName__

__description__

A [Universe Editor](https://github.com/lovebirdsx/universe-editor) extension with a webview-backed custom editor, scaffolded with `npm create @universe-editor/extension`.

Opening any `*.__name__` file renders it in a preview editor tab (`__displayName__ Preview`). The renderer in `src/extension.ts` is a static-HTML starting point — replace it with your own (see the webview guide for CSP, `asWebviewUri`, and `localResourceRoots`).

## Develop

```bash
npm install
npm run watch          # bundle src/ → dist/ and rebuild on change
npx uex dev --inspect=9229
#   launches the Extension Development Host with this folder loaded;
#   then F5 in VSCode attaches the debugger to the extension host
```

In the dev-host window, create a file named `sample.__name__` and open it — your preview tab appears. Iterate: edit `src/extension.ts`, let watch rebuild, then run **Restart Extension Host** from the command palette.

## Package and install

```bash
npm run package        # → <publisher>.<name>-<version>.vsix
```

Install the `.vsix` from the editor's Extensions view ("Install from VSIX…").

## Publish

```bash
npx uex login __publisher__   # once, with the token from your marketplace operator
npx uex publish               # packages (via universe:prepublish) and uploads
```
