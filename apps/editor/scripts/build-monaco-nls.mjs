/*---------------------------------------------------------------------------------------------
 *  Build flat NLS dictionaries for the monaco-editor ESM bundle.
 *
 *  Background: monaco-editor 0.52 ESM keeps string-keyed `localize('caseDescription',
 *  'Match Case')` calls, so the upstream `_VSCODE_NLS_MESSAGES` index-array shim
 *  (which only services the AMD build path) has no effect. We instead patch
 *  monaco's `nls.js` at build time to look up `globalThis.__MONACO_NLS__[key]`,
 *  and that table is produced here.
 *
 *  Source data: microsoft/vscode-loc (clone or sparse-checkout at the path below).
 *  Strategy: scan every `localize|localize2` call in monaco's ESM bundle, collect
 *  the keys monaco actually references, then look each up in vscode-loc.
 *  Collisions pick the most popular translation. ~98% of monaco's keys are
 *  globally unique in vscode-loc, so this is safe in practice.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const monacoEsm = path.join(repoRoot, 'node_modules/monaco-editor/esm/vs')
const outDir = path.join(repoRoot, 'src/renderer/vendor/monaco-nls')

const LOCALES = [
  { source: 'zh-hans', out: 'zh-cn' },
]

function findVscodeLocRoot() {
  const candidates = [
    process.env.VSCODE_LOC_ROOT,
    path.resolve(repoRoot, '../../tools/vscode-loc'),
    'D:/tmp_vscode_loc',
  ].filter(Boolean)
  for (const c of candidates) {
    if (
      fs.existsSync(path.join(c, 'i18n/vscode-language-pack-zh-hans/translations/main.i18n.json'))
    ) {
      return c
    }
  }
  throw new Error(
    'vscode-loc not found. Clone https://github.com/microsoft/vscode-loc and set VSCODE_LOC_ROOT to its directory.',
  )
}

function collectUsedKeys() {
  const used = new Set()
  const re1 = /\blocalize2?\(\s*['"`]([\w][\w.\-]*)['"`]/g
  const re2 = /\blocalize2?\(\s*\{\s*key\s*:\s*['"`]([\w][\w.\-]*)['"`]/g
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8')
        let m
        while ((m = re1.exec(src))) used.add(m[1])
        while ((m = re2.exec(src))) used.add(m[1])
      }
    }
  }
  walk(monacoEsm)
  return used
}

function buildDict(localePackName, usedKeys, vscodeLocRoot) {
  const file = path.join(
    vscodeLocRoot,
    `i18n/vscode-language-pack-${localePackName}/translations/main.i18n.json`,
  )
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const tally = new Map()
  for (const mod in data.contents) {
    for (const k in data.contents[mod]) {
      if (!usedKeys.has(k)) continue
      if (!tally.has(k)) tally.set(k, new Map())
      const t = data.contents[mod][k]
      tally.get(k).set(t, (tally.get(k).get(t) || 0) + 1)
    }
  }
  const out = {}
  let missing = 0
  for (const k of usedKeys) {
    const t = tally.get(k)
    if (!t) {
      missing++
      continue
    }
    const [winner] = [...t.entries()].sort((a, b) => b[1] - a[1])[0]
    out[k] = winner
  }
  return { dict: out, missing }
}

function main() {
  const vscodeLocRoot = findVscodeLocRoot()
  const usedKeys = collectUsedKeys()
  fs.mkdirSync(outDir, { recursive: true })
  console.log(`monaco ESM references ${usedKeys.size} distinct NLS keys`)
  for (const { source, out } of LOCALES) {
    const { dict, missing } = buildDict(source, usedKeys, vscodeLocRoot)
    const outPath = path.join(outDir, `${out}.json`)
    fs.writeFileSync(outPath, JSON.stringify(dict))
    const size = fs.statSync(outPath).size
    console.log(
      `  ${out}: ${Object.keys(dict).length} entries (${missing} missing) → ${outPath} (${size} bytes)`,
    )
  }
}

main()
