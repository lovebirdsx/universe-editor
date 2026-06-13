/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Generates `editorOptionsSchema.generated.ts` by extracting the full
 *  configuration schema of every Monaco editor option from the VSCode source
 *  tree. VSCode keeps a rich `.schema` (type/enum/min/max/description) on each
 *  EditorOption; the published monaco-editor npm package strips it. We bundle
 *  `editorOptionsRegistry` with esbuild (stubbing out `nls` so localize() falls
 *  back to the default English message), read every option's schema, adapt it to
 *  our IConfigurationPropertySchema shape, and emit a committed TS module.
 *
 *  Usage:
 *    node scripts/gen-editor-schema.mjs [path-to-vscode-src-vs]
 *
 *  The VSCode checkout defaults to ../vscode relative to this repo. Re-run after
 *  bumping the monaco-editor catalog version or pulling a newer VSCode tree.
 *--------------------------------------------------------------------------------------------*/

import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { pathToFileURL } from 'url'
import { dirname, resolve, join } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
// Resolve deps (esbuild, monaco-editor) from apps/editor where they are installed.
const require = createRequire(join(REPO_ROOT, 'apps/editor/package.json'))

// --- locate inputs -------------------------------------------------------------

const vscodeArg = process.argv[2]
const VS = resolve(
  vscodeArg ? vscodeArg : join(REPO_ROOT, '..', 'vscode', 'src', 'vs'),
).replace(/\\/g, '/')

if (!existsSync(join(VS, 'editor/common/config/editorOptions.ts'))) {
  console.error(
    `[gen-editor-schema] Cannot find editorOptions.ts under "${VS}".\n` +
      `Pass the path to the VSCode "src/vs" directory:\n` +
      `  node scripts/gen-editor-schema.mjs /path/to/vscode/src/vs`,
  )
  process.exit(1)
}

const MONACO_DTS = require.resolve('monaco-editor/monaco.d.ts')
const OUT_DIR = join(REPO_ROOT, 'apps/editor/src/renderer/contributions/generated')
const OUT_SCHEMA = join(OUT_DIR, 'editorOptionsSchema.generated.ts')
const OUT_NLS = join(OUT_DIR, 'editorOptions.nls.generated.json')

// --- 1. bundle + run the VSCode option registry to dump every schema -----------

const esbuild = require(
  require.resolve('esbuild', { paths: [dirname(require.resolve('vite/package.json'))] }),
)

const nlsStub = `
export function localize(info, msg){ return msg }
export function localize2(info, msg){ return { value: msg, original: msg } }
export function getConfiguredDefaultLocale(){ return undefined }
export default { localize, localize2, getConfiguredDefaultLocale }
`

const entry = `
import { editorOptionsRegistry } from '${VS}/editor/common/config/editorOptions.js'
const out = {}
for (const opt of editorOptionsRegistry) {
  if (!opt) continue
  out[opt.name] = { id: opt.id, name: opt.name, schema: opt.schema }
}
export const DUMP = out
`

const nlsPlugin = {
  name: 'nls-stub',
  setup(b) {
    b.onResolve({ filter: /nls\.js$/ }, () => ({ path: 'nls-stub', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: nlsStub, loader: 'js' }))
  },
}

const res = await esbuild.build({
  stdin: { contents: entry, resolveDir: VS + '/editor/common/config', loader: 'js' },
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
  plugins: [nlsPlugin],
  logLevel: 'silent',
})

const bundlePath = join(tmpdir(), `editor-options-dump.${process.pid}.mjs`)
writeFileSync(bundlePath, res.outputFiles[0].text)
const { DUMP } = await import(pathToFileURL(bundlePath).href)

// --- 2. build the allow-list of options supported by the local monaco ----------

const dts = readFileSync(MONACO_DTS, 'utf8')
const enumBlock = dts.match(/export enum EditorOption \{([\s\S]*?)\}/)
if (!enumBlock) {
  console.error('[gen-editor-schema] Could not find EditorOption enum in monaco.d.ts')
  process.exit(1)
}
const localOptionNames = new Set(
  [...enumBlock[1].matchAll(/^\s*([a-zA-Z0-9]+)\s*=/gm)].map((m) => m[1]),
)

// --- 3. filtering rules --------------------------------------------------------

// Keys already declared by the hand-written SettingsContribution. We keep those
// (they carry project-specific semantics, e.g. boolean wordWrap, language fonts)
// and let them win over the generated table.
const HANDWRITTEN_KEYS = new Set([
  'editor.fontSize',
  'editor.fontFamily',
  'editor.fontWeight',
  'editor.lineHeight',
  'editor.letterSpacing',
  'editor.disableMonospaceOptimizations',
  'editor.renderLineHighlight',
  'editor.occurrencesHighlight',
  'editor.lineHighlightBackground',
  'editor.lineHighlightBorder',
  'editor.languageFonts',
  'editor.tabSize',
  'editor.wordWrap',
  'editor.minimap.enabled',
])

// Internal / accessibility / experimental options that should never surface as
// user settings. Matched against the top-level option name.
const EXCLUDE_OPTION_NAMES = new Set([
  'ariaLabel',
  'ariaRequired',
  'tabIndex',
  'domReadOnly',
  'overflowWidgetsDomNode',
  'editContext',
  'allowOverflow',
])
const EXCLUDE_NAME_PATTERN = /(^aria|^screenReader|experiment|accessib|^model$|^dimension$)/i

// Some flat keys are noise even when their parent option is useful.
const EXCLUDE_FLAT_PATTERN = /(experimental|\.experiment$)/i

// --- 4. schema adaptation ------------------------------------------------------

function cleanText(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/`#([^#]+)#`/g, '`$1`') // setting links: `#editor.foo#` -> `editor.foo`
    .replace(/#([\w.]+)#/g, '$1')
    .replace(/\{(\d+)\}/g, '') // drop positional placeholders we cannot fill
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean'])

// Adapt a single VSCode IConfigurationPropertySchema to ours. Returns null when
// the property is not worth emitting.
function adaptProp(flatKey, vs) {
  const out = {}

  // type may be a string or array (union); pass arrays through unchanged.
  if (vs.type !== undefined) out.type = vs.type
  if (vs.anyOf !== undefined) out.anyOf = vs.anyOf.map((s) => adaptProp(flatKey, s)).filter(Boolean)

  if (vs.default !== undefined) out.default = vs.default
  if (vs.enum !== undefined) out.enum = vs.enum
  if (typeof vs.minimum === 'number') out.minimum = vs.minimum
  if (typeof vs.maximum === 'number') out.maximum = vs.maximum
  if (vs.items !== undefined) {
    const it = adaptProp(flatKey, vs.items)
    if (it) out.items = it
  }
  if (vs.properties !== undefined) {
    out.properties = {}
    for (const [k, v] of Object.entries(vs.properties)) {
      const child = adaptProp(`${flatKey}.${k}`, v)
      if (child) out.properties[k] = child
    }
  }
  if (vs.additionalProperties !== undefined) {
    out.additionalProperties =
      typeof vs.additionalProperties === 'boolean'
        ? vs.additionalProperties
        : adaptProp(flatKey, vs.additionalProperties)
  }

  const desc = cleanText(vs.markdownDescription ?? vs.description)
  if (desc) out.description = desc

  const enumDesc = vs.enumDescriptions ?? vs.markdownEnumDescriptions
  if (Array.isArray(enumDesc)) out.enumDescriptions = enumDesc.map(cleanText)

  return out
}

// --- 5. collect ----------------------------------------------------------------

/** @type {Record<string, object>} */
const collected = {}
/** @type {Record<string, string>} key -> english message, for translation */
const nls = {}

let skippedExisting = 0
let skippedExcluded = 0

function emit(flatKey, adapted, optionName) {
  if (!adapted || (!adapted.type && !adapted.anyOf)) return
  if (HANDWRITTEN_KEYS.has(flatKey)) {
    skippedExisting++
    return
  }
  if (EXCLUDE_FLAT_PATTERN.test(flatKey)) {
    skippedExcluded++
    return
  }
  collected[flatKey] = adapted
}

for (const name of Object.keys(DUMP).sort()) {
  if (!localOptionNames.has(name)) continue
  if (EXCLUDE_OPTION_NAMES.has(name) || EXCLUDE_NAME_PATTERN.test(name)) {
    skippedExcluded++
    continue
  }
  const schema = DUMP[name].schema
  if (!schema) continue

  // Two shapes: a single schema (scalar/union/anyOf) keyed by `editor.<name>`,
  // or a path-map whose keys are already full `editor.x.y` dotted paths.
  const isSingle = schema.type !== undefined || schema.anyOf !== undefined
  if (isSingle) {
    emit(`editor.${name}`, adaptProp(`editor.${name}`, schema), name)
  } else {
    for (const [flatKey, sub] of Object.entries(schema)) {
      emit(flatKey, adaptProp(flatKey, sub), name)
    }
  }
}

// Assign stable nls keys and replace inline descriptions with localize() refs at
// codegen time. We record english text into the nls map for translation.
function nlsKeyFor(flatKey) {
  return `editorOption.${flatKey}`
}

// --- 6. codegen ----------------------------------------------------------------

function jsLiteral(value) {
  return JSON.stringify(value)
}

function renderSchema(flatKey, schema, indent) {
  const pad = '  '.repeat(indent)
  const pad2 = '  '.repeat(indent + 1)
  const lines = ['{']

  if (schema.type !== undefined) lines.push(`${pad2}type: ${jsLiteral(schema.type)},`)
  if (schema.default !== undefined) lines.push(`${pad2}default: ${jsLiteral(schema.default)},`)
  if (schema.enum !== undefined) lines.push(`${pad2}enum: ${jsLiteral(schema.enum)},`)
  if (schema.minimum !== undefined) lines.push(`${pad2}minimum: ${jsLiteral(schema.minimum)},`)
  if (schema.maximum !== undefined) lines.push(`${pad2}maximum: ${jsLiteral(schema.maximum)},`)

  if (typeof schema.description === 'string' && schema.description.trim()) {
    const key = nlsKeyFor(flatKey)
    nls[key] = schema.description
    lines.push(`${pad2}description: localize(${jsLiteral(key)}, ${jsLiteral(schema.description)}),`)
  }
  if (schema.enumDescriptions !== undefined) {
    const parts = schema.enumDescriptions.map((d, i) => {
      // Empty descriptions are common (no per-value doc); keep the slot aligned
      // with `enum` but emit a static '' rather than polluting the nls table.
      if (typeof d !== 'string' || !d.trim()) return `''`
      const key = `${nlsKeyFor(flatKey)}.enum.${i}`
      nls[key] = d
      return `localize(${jsLiteral(key)}, ${jsLiteral(d)})`
    })
    lines.push(`${pad2}enumDescriptions: [${parts.join(', ')}],`)
  }
  if (schema.items !== undefined) {
    lines.push(`${pad2}items: ${renderSchema(`${flatKey}.items`, schema.items, indent + 1)},`)
  }
  if (schema.properties !== undefined) {
    lines.push(`${pad2}properties: {`)
    for (const [k, v] of Object.entries(schema.properties)) {
      lines.push(`${'  '.repeat(indent + 2)}${jsLiteral(k)}: ${renderSchema(`${flatKey}.${k}`, v, indent + 2)},`)
    }
    lines.push(`${pad2}},`)
  }
  if (schema.additionalProperties !== undefined) {
    const ap =
      typeof schema.additionalProperties === 'boolean'
        ? jsLiteral(schema.additionalProperties)
        : renderSchema(`${flatKey}.additionalProperties`, schema.additionalProperties, indent + 1)
    lines.push(`${pad2}additionalProperties: ${ap},`)
  }
  if (schema.anyOf !== undefined) {
    const parts = schema.anyOf.map((s, i) => renderSchema(`${flatKey}.anyOf.${i}`, s, indent + 1))
    lines.push(`${pad2}anyOf: [${parts.join(', ')}],`)
  }

  lines.push(`${pad}}`)
  return lines.join('\n')
}

const keys = Object.keys(collected).sort()
const entries = keys
  .map((flatKey) => `  ${jsLiteral(flatKey)}: ${renderSchema(flatKey, collected[flatKey], 1)},`)
  .join('\n')

const header = `/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  GENERATED FILE — DO NOT EDIT BY HAND.
 *  Regenerate with: node scripts/gen-editor-schema.mjs [path-to-vscode/src/vs]
 *
 *  Full Monaco editor option schema extracted from the VSCode source tree,
 *  adapted to IConfigurationPropertySchema. Hand-written editor.* settings win
 *  over these (they are excluded here). Descriptions are wrapped in localize()
 *  so zh-CN translations in messages/editorOptions.zh-CN.ts apply at runtime.
 *--------------------------------------------------------------------------------------------*/

import type { IConfigurationPropertySchema } from '@universe-editor/platform'
import { localize } from '@universe-editor/platform'

export const GENERATED_EDITOR_OPTIONS: Record<string, IConfigurationPropertySchema> = {
${entries}
}
`

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT_SCHEMA, header)
writeFileSync(OUT_NLS, JSON.stringify(nls, null, 2) + '\n')

try {
  execFileSync('pnpm', ['exec', 'prettier', '--write', OUT_SCHEMA, OUT_NLS], {
    cwd: REPO_ROOT,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  })
} catch {
  console.warn('[gen-editor-schema] prettier formatting skipped (run pnpm lint --fix manually)')
}

const scalarCount = keys.filter((k) => {
  const t = collected[k].type
  return typeof t === 'string' && SCALAR_TYPES.has(t)
}).length

console.log(`[gen-editor-schema] emitted ${keys.length} keys (${scalarCount} scalar)`)
console.log(`[gen-editor-schema]   skipped ${skippedExisting} hand-written, ${skippedExcluded} excluded`)
console.log(`[gen-editor-schema]   ${Object.keys(nls).length} nls strings`)
console.log(`[gen-editor-schema] wrote ${OUT_SCHEMA}`)
console.log(`[gen-editor-schema] wrote ${OUT_NLS}`)
