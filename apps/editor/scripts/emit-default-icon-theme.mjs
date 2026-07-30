// Emit the built-in VSCode-format file icon theme for theme-defaults.
//
// Reads the generated materialIconMap.ts and rewrites the six Material maps
// into a `contributes.iconThemes` document:
//   extensions/theme-defaults/icons/universe-material-icon-theme.json
// and copies the referenced SVGs next to it. The runtime treats this like any
// third-party icon theme: FileIconThemeData loads the JSON and generates a
// selector-driven stylesheet (`.show-file-icons .ts-ext-file-icon…`).
//
// Re-run after `import-material-icons.mjs` (which regenerates the map):
//
//   node apps/editor/scripts/emit-default-icon-theme.mjs

import { writeFileSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const editorRoot = resolve(scriptDir, '..')
const iconsSrcDir = join(editorRoot, 'src/renderer/workbench/files/icons')
const outDir = resolve(editorRoot, '../../extensions/theme-defaults/icons')

const {
  materialIconDefaults,
  materialFileExtensions,
  materialFileNames,
  materialLanguageIds,
  materialFolderNames,
  materialFolderNamesExpanded,
} = await import(
  pathToFileURL(join(editorRoot, 'src/renderer/workbench/files/materialIconMap.ts')).href
)

const definitions = new Set([
  materialIconDefaults.file,
  materialIconDefaults.folder,
  materialIconDefaults.folderExpanded,
])
for (const map of [
  materialFileExtensions,
  materialFileNames,
  materialLanguageIds,
  materialFolderNames,
  materialFolderNamesExpanded,
]) {
  for (const iconName of Object.values(map)) definitions.add(iconName)
}

const iconDefinitions = {}
for (const name of [...definitions].sort((a, b) => a.localeCompare(b))) {
  iconDefinitions[`_${name}`] = { iconPath: `./${name}.svg` }
}

const ref = (name) => `_${name}`
const remap = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, ref(v)]))

const document = {
  iconDefinitions,
  file: ref(materialIconDefaults.file),
  folder: ref(materialIconDefaults.folder),
  folderExpanded: ref(materialIconDefaults.folderExpanded),
  folderNames: remap(materialFolderNames),
  folderNamesExpanded: remap(materialFolderNamesExpanded),
  fileExtensions: remap(materialFileExtensions),
  fileNames: remap(materialFileNames),
  languageIds: remap(materialLanguageIds),
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
writeFileSync(
  join(outDir, 'universe-material-icon-theme.json'),
  JSON.stringify(document, null, 2) + '\n',
  'utf8',
)
let copied = 0
for (const name of definitions) {
  copyFileSync(join(iconsSrcDir, `${name}.svg`), join(outDir, `${name}.svg`))
  copied++
}
copyFileSync(join(iconsSrcDir, 'LICENSE'), join(outDir, 'LICENSE'))

console.log(
  `[emit-default-icon-theme] ${copied} svg(s), ${definitions.size} definition(s) → ${outDir}`,
)
