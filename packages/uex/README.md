# @universe-editor/uex

The command-line toolchain for [Universe Editor](https://github.com/lovebirdsx/universe-editor) extension authors — the Universe equivalent of `vsce`. Requires Node.js 20+.

```bash
npm install --save-dev @universe-editor/uex
```

## Commands

| Command | Purpose |
|---|---|
| `uex package` | Validate the manifest, run `universe:prepublish`, and produce `<publisher>.<name>-<version>.vsix` |
| `uex ls` | Print the exact file list that would go into the VSIX (whitelist: `package.json` + `files[]` + README/CHANGELOG) |
| `uex dev [--inspect=<port>] [--user-data-dir=<dir>] [--editor-path=<exe>]` | Launch an installed Universe Editor with the current directory loaded as an extension under development |
| `uex login <publisher>` | Store a marketplace publish token (verified against `whoami` before saving) |
| `uex publish [--package-path <vsix>] [--registry <url>]` | Package (unless `--package-path` is given) and upload to the marketplace |
| `uex unpublish <publisher.name>[@<version>] [--yes]` | Remove one version, or the whole extension when no version is given |

## Packaging rules

- **`files` whitelist is required.** Only `package.json`, the `files[]` entries, and `README.md`/`CHANGELOG.md` ship. An extension without `files` is refused — this keeps `.env`, secrets, and `node_modules` out of VSIX files by construction.
- **`publisher` is required.** It must match the publisher your publish token belongs to, or the marketplace rejects the upload.
- `engines.universe` must use plain ranges like `">=0.7.1 <1.0.0"` — `||` and hyphen ranges are rejected (the host refuses to load extensions declaring them).

## Registry and credentials

- Registry URL: `--registry` flag → `UNIVERSE_GALLERY_URL` env → `~/.uex/config.json`. No default.
- Token: `UNIVERSE_MARKET_TOKEN` env (CI) → `~/.uex/config.json` (written by `uex login`, stored per registry).
- **The config file stores the token in plain text** (`~/.vsce` does the same). Prefer the environment variable on shared machines.

## Versioning policy (0.x)

Until the extension API reaches 1.0, **any minor release may carry breaking changes** (semver 0.x semantics). The CLI itself follows the same rule while it is 0.x.

## License

Apache-2.0
