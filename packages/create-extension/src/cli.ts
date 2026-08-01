#!/usr/bin/env node
/**
 * create-extension CLI entry (`npm create @universe-editor/extension`).
 */
async function main(): Promise<number> {
  console.error('create-extension: not implemented yet')
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
