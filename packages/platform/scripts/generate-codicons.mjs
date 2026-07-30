// Regenerate packages/platform/src/theme/codicons.ts's icon table from the
// installed @vscode/codicons package (codicon.css content rules). Run:
//   node packages/platform/scripts/generate-codicons.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// @vscode/codicons is a dependency of apps/editor, not of platform (platform
// must stay UI-dependency-free); resolve it from the editor package.
const editorRequire = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '../../../apps/editor/package.json'),
)
const cssPath = editorRequire.resolve('@vscode/codicons/dist/codicon.css')
const css = readFileSync(cssPath, 'utf8')

const re = /\.codicon-([a-z0-9-]+):before\s*\{\s*content:\s*['"]\\([0-9a-f]+)['"]/gi
const entries = new Map()
let m
while ((m = re.exec(css)) !== null) {
  const name = m[1]
  const code = parseInt(m[2], 16)
  if (entries.has(name) && entries.get(name) !== code) {
    console.warn(`[generate-codicons] conflicting code for ${name}`)
  }
  entries.set(name, code)
}

const names = [...entries.keys()].sort((a, b) => a.localeCompare(b))
console.log(`[generate-codicons] ${names.length} icons from ${cssPath}`)

const body = names
  .map((n) => `  ${JSON.stringify(n)}: 0x${entries.get(n).toString(16)}`)
  .join(',\n')

const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'theme', 'codicons.ts')
const src = readFileSync(target, 'utf8')
const markerRe = /CODICON_LIBRARY_PLACEHOLDER|\{\n  "[\s\S]*?\n\}/
if (!markerRe.test(src)) {
  throw new Error('codicons.ts library table marker not found')
}
writeFileSync(target, src.replace(markerRe, '{\n' + body + ',\n}'), 'utf8')
console.log('[generate-codicons] codicons.ts updated')
