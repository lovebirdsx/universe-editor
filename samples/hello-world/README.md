# Hello World

A minimal Universe Editor extension sample.

This is the exact output of `npm create @universe-editor/extension` (basic
template, `hello-world` / `universe-samples`) with a few explanatory comments
added on top — it is what a third-party author's project looks like outside
the Universe Editor repository. The CI drift check (see "Drift check" below)
keeps every other file byte-identical to the scaffold output.

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

Install the `.vsix` from the editor's Extensions view ("Install from VSIX…") and run `Hello World: Hello World` from the command palette.

## Publish

```bash
npx uex login universe-samples   # once, with the token from your marketplace operator
npx uex publish               # packages (via universe:prepublish) and uploads
```

## Documentation

The full third-party developer guide lives in the Universe Editor repository
under `docs/extension-dev/zh-CN/` (getting started, contribution points, API
overview, debugging, publishing, migration from VSCode).

## Drift check

When the basic template changes, regenerate this sample and re-apply the
comment edits to `src/extension.ts` and this README:

```bash
node packages/create-extension/dist/cli.js samples/hello-world --force \
  --name hello-world --publisher universe-samples \
  --display-name "Hello World" \
  --description "A minimal Universe Editor extension sample." --template basic
```

CI (`scripts/toolchain/template-smoke.mjs`) scaffolds the same command into a
temp dir and asserts every file except `src/extension.ts` and `README.md`
matches byte-for-byte.
