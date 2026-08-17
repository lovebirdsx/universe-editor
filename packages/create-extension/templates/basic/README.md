# __displayName__

__description__

A [Universe Editor](https://github.com/lovebirdsx/universe-editor) extension, scaffolded with `npm create @universe-editor/extension`.

## Develop

```bash
npm install
npm run watch          # bundle src/ → dist/ and rebuild on change
npx uex dev --inspect=9229
#   launches the Extension Development Host with this folder loaded;
#   then F5 in VSCode attaches the debugger to the extension host
```

Iterate: edit `src/extension.ts`, let watch rebuild, then run **Restart Extension Host** in the dev-host window's command palette.

## Package and install

```bash
npm run package        # → <publisher>.<name>-<version>.vsix
```

Install the `.vsix` from the editor's Extensions view ("Install from VSIX…") and run `__displayName__: Hello World` from the command palette.

## Publish

Register at `<marketplace-url>/gallery/register` (the token is shown once;
publishing is approval-based — `npx uex whoami` shows the status), then:

```bash
npx uex login __publisher__ --registry <marketplace-url>
npx uex publish               # packages (via universe:prepublish) and uploads
```
