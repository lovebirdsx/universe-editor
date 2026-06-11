/*---------------------------------------------------------------------------------------------
 *  Build the English→Chinese NLS dictionary consumed by the monaco-editor ESM bundle.
 *
 *  Background: monaco-editor ≥0.55 ships a *prebuilt* ESM bundle whose `localize`
 *  calls are index-based — `localize(786, "Developer: Inspect Tokens")` — and look
 *  the message up in `globalThis._VSCODE_NLS_MESSAGES[index]`, falling back to the
 *  inline English string. The old string-key path (`localize('inspectTokens', …)`)
 *  is gone, so a `key → 中文` table can no longer be matched against monaco at all.
 *
 *  Strategy (zero external repos): the inline fallback in every monaco call IS the
 *  English source text. We bridge it to Chinese via the VS Code source tree, whose
 *  `localize('key', "English")` calls still carry both the key and the English text:
 *
 *    monaco index  →(inline fallback)  English text
 *    English text  ←(VS Code source)   key            (key → English)
 *    key           →(zh-cn.json)        中文           (key → 中文, existing snapshot)
 *    ⇒ English text → 中文   (this script's output)
 *
 *  The patched `nls.js` (see monacoNlsPatch.ts) then looks the English fallback up
 *  in `globalThis.__MONACO_NLS__` before returning it untranslated.
 *
 *  Inputs:
 *    - src/renderer/vendor/monaco-nls/zh-cn.json   (key → 中文, kept as the source dict)
 *    - VS Code source tree (key → English), located via VSCODE_SRC_ROOT or defaults
 *  Output:
 *    - src/renderer/vendor/monaco-nls/zh-cn.messages.json   (English → 中文, runtime)
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const monacoEsm = path.join(repoRoot, 'node_modules/monaco-editor/esm/vs')
const nlsDir = path.join(repoRoot, 'src/renderer/vendor/monaco-nls')
const keysDictPath = path.join(nlsDir, 'zh-cn.json')
const outPath = path.join(nlsDir, 'zh-cn.messages.json')

function findVscodeSrcRoot() {
  const candidates = [
    process.env.VSCODE_SRC_ROOT,
    'D:/git_project/vscode',
    path.resolve(repoRoot, '../../../vscode'),
    path.resolve(repoRoot, '../../vscode'),
  ].filter(Boolean)
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'src/vs/nls.ts'))) return c
  }
  throw new Error(
    'VS Code source tree not found. Clone microsoft/vscode and set VSCODE_SRC_ROOT to its directory.',
  )
}

function walk(dir, ext, cb) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, ext, cb)
    else if (ent.name.endsWith(ext)) cb(p)
  }
}

// key → English, scanned from the VS Code source tree's string-keyed localize calls.
function collectKeyToEnglish(vsRoot) {
  const key2en = new Map()
  const re = /\blocalize2?\(\s*['"]([\w][\w.\/-]*)['"]\s*,\s*"((?:[^"\\]|\\.)*)"/g
  walk(path.join(vsRoot, 'src/vs'), '.ts', (p) => {
    const src = fs.readFileSync(p, 'utf8')
    let m
    while ((m = re.exec(src))) {
      try {
        key2en.set(m[1], JSON.parse('"' + m[2] + '"'))
      } catch {
        // Skip strings whose escapes JSON.parse rejects (rare template edge cases).
      }
    }
  })
  return key2en
}

// The English fallbacks monaco actually references, for a coverage report.
function collectMonacoEnglish() {
  const en = new Set()
  const re = /\blocalize2?\(\s*\d+\s*,\s*"((?:[^"\\]|\\.)*)"/g
  walk(monacoEsm, '.js', (p) => {
    const src = fs.readFileSync(p, 'utf8')
    let m
    while ((m = re.exec(src))) {
      try {
        en.add(JSON.parse('"' + m[1] + '"'))
      } catch {
        // ignore
      }
    }
  })
  return en
}

function main() {
  const vsRoot = findVscodeSrcRoot()
  const keysDict = JSON.parse(fs.readFileSync(keysDictPath, 'utf8'))
  const key2en = collectKeyToEnglish(vsRoot)

  const en2zh = {}
  let bridged = 0
  let noEnglish = 0
  for (const key of Object.keys(keysDict)) {
    const english = key2en.get(key)
    if (typeof english !== 'string') {
      noEnglish++
      continue
    }
    // Last write wins on the rare English-text collision; conflicts are few.
    en2zh[english] = keysDict[key]
    bridged++
  }

  fs.mkdirSync(nlsDir, { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(en2zh))
  const size = fs.statSync(outPath).size

  // Coverage report against the English strings monaco really uses.
  const monacoEn = collectMonacoEnglish()
  let hit = 0
  for (const e of monacoEn) if (e in en2zh) hit++

  console.log(`VS Code source: ${key2en.size} key→English entries (from ${vsRoot})`)
  console.log(`zh-cn.json: ${Object.keys(keysDict).length} key→中文 entries`)
  console.log(`Bridged: ${bridged} English→中文 (${noEnglish} keys had no English match)`)
  console.log(
    `monaco 0.55 references ${monacoEn.size} English strings; covered ${hit} = ${(
      (hit / monacoEn.size) *
      100
    ).toFixed(1)}%`,
  )
  console.log(`→ ${outPath} (${size} bytes)`)
}

main()
