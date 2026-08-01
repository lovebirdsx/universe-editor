#!/usr/bin/env node
/**
 * uex CLI entry. Subcommands are imported lazily so `uex package` does not pay
 * for fetch/editor-locator modules it never uses.
 */
async function main(): Promise<number> {
  console.error('uex: not implemented yet')
  return 1
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  },
)
