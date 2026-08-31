import { readFileSync } from 'node:fs'

/**
 * Mirror p4 `-x <argfile>`: consume the flag and append file lines after argv.
 * Spawn-mocking tests that inspect path lists must expand, otherwise a batch
 * that already sits on the char budget (chunkByLength) plus subcommand flags
 * trips the spawn-layer `-x` and those paths vanish from the mocked argv.
 */
export function expandP4Argv(argv: readonly string[]): string[] {
  const out: string[] = []
  const fromFile: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-x') {
      const file = argv[++i]
      if (file === undefined) continue
      try {
        for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
          if (line !== '') fromFile.push(line)
        }
      } catch {
        // missing argfile — leave the rest of argv as-is so the test fails loudly
      }
      continue
    }
    if (a !== undefined) out.push(a)
  }
  return fromFile.length > 0 ? [...out, ...fromFile] : out
}
