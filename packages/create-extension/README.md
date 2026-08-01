# @universe-editor/create-extension

Scaffold a new [Universe Editor](https://github.com/lovebirdsx/universe-editor) extension — the Universe equivalent of `yo code`.

```bash
npm create @universe-editor/extension my-extension
```

Answer four prompts (name / publisher / displayName / template) and you get a buildable extension project: esbuild bundle + watch, strict TypeScript, VSCode attach debugging preconfigured, and the `uex` CLI wired into npm scripts.

Then:

```bash
cd my-extension
npm install
npm run watch          # bundle to dist/ and rebuild on change
npx uex dev --inspect=9229   # launch the Extension Development Host
# F5 in VSCode attaches the debugger to the extension host process
```

## Templates

| Template | Contents |
|---|---|
| `basic` | A `Hello World` command contributed to the command palette |
| `webview` | A read-only custom-editor preview (mirrors the built-in PDF viewer's shape) |

## Non-interactive usage

Every prompt has a matching flag, so CI and AI agents can scaffold without a TTY:

```bash
npm create @universe-editor/extension my-extension -- \
  --name my-extension --publisher my-publisher --template basic
```

| Flag | Purpose |
|---|---|
| `--name <id>` | Extension id (lowercase npm-name rules) |
| `--publisher <id>` | Publisher id — must match the publish token you get from the marketplace |
| `--display-name <text>` | Human-readable name (defaults to `--name`) |
| `--description <text>` | One-line description |
| `--template <basic\|webview>` | Project template |
| `--force` | Allow writing into a non-empty directory (never deletes existing files) |

## Versioning policy (0.x)

Until the extension API reaches 1.0, **any minor release may carry breaking changes** (semver 0.x semantics). The scaffold pins `engines.universe` to `>=<current API> <1.0.0` — re-check your extension on each API minor bump.

## License

Apache-2.0
