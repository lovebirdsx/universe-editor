// One-time (re-runnable) importer for the Material Icon Theme file icons.
//
// Reads the `material-icon-theme` package (a build-time-only devDependency) and,
// for a curated allow-list of icon names, copies the matching SVGs into
// `src/renderer/workbench/files/icons/` and regenerates `materialIconMap.ts`
// (the fileName / extension / languageId / folderName → icon-name maps).
//
// The generated SVGs and map are committed to the repo, so the runtime never
// depends on `material-icon-theme`. Re-run after bumping the package or editing
// the allow-list below:
//
//   node apps/editor/scripts/import-material-icons.mjs
//
// The full theme ships ~1250 icons (3.3 MB); inlining all of them would bloat
// the bundle. We keep only the icons named below plus every mapping key that
// points at one of them — so a single `nodejs` icon automatically pulls in
// `package.json`, `package-lock.json`, … without listing each key by hand.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, join } from 'node:path'
import { readFileSync, writeFileSync, rmSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs'

const require = createRequire(import.meta.url)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const editorRoot = resolve(scriptDir, '..')

const manifestPath = require.resolve('material-icon-theme/dist/material-icons.json')
const themeRoot = resolve(dirname(manifestPath), '..') // package root (dist/ → package/)
const themeIconsDir = join(themeRoot, 'icons')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))

const outIconsDir = resolve(editorRoot, 'src/renderer/workbench/files/icons')
const outMapPath = resolve(editorRoot, 'src/renderer/workbench/files/materialIconMap.ts')

// ── Curated icon allow-list ────────────────────────────────────────────────
// Icon *names* (matching material's iconDefinitions keys, i.e. the svg basename
// without extension). Every mapping key in the manifest that resolves to one of
// these is imported automatically.
const KEEP_FILE_ICONS = [
  // defaults
  'file',
  // web / scripting
  'typescript',
  'typescript-def',
  'react',
  'react_ts',
  'javascript',
  'javascript-map',
  'vue',
  'svelte',
  'angular',
  'astro',
  'html',
  'css',
  'sass',
  'less',
  'stylus',
  'tailwindcss',
  'json',
  'yaml',
  'xml',
  'toml',
  'graphql',
  'markdown',
  'mdx',
  'document',
  'pdf',
  'python',
  'python-misc',
  'ruby',
  'php',
  'lua',
  'perl',
  'r',
  'julia',
  'elixir',
  'erlang',
  'clojure',
  'coffee',
  'dart',
  'haskell',
  'ocaml',
  'nim',
  'zig',
  // systems / compiled
  'nodejs',
  'nodejs_alt',
  'deno',
  'bun',
  'go',
  'go-mod',
  'rust',
  'java',
  'jar',
  'kotlin',
  'swift',
  'objective-c',
  'objective-cpp',
  'c',
  'h',
  'cpp',
  'hpp',
  'csharp',
  'fsharp',
  'visualstudio',
  'scala',
  'vala',
  'pascal',
  'fortran',
  'assembly',
  'solidity',
  'shader',
  'webassembly',
  // shell / infra / data
  'console',
  'powershell',
  'makefile',
  'cmake',
  'docker',
  'kubernetes',
  'terraform',
  'vagrant',
  'nginx',
  'database',
  'prisma',
  'proto',
  'graphql',
  // config / tooling (name-based)
  'tsconfig',
  'eslint',
  'prettier',
  'babel',
  'webpack',
  'vite',
  'rollup',
  'esbuild',
  'turborepo',
  'nodemon',
  'editorconfig',
  'git',
  'gitlab',
  'npm',
  'yarn',
  'pnpm',
  'travis',
  'jenkins',
  'circleci',
  'appveyor',
  'netlify',
  'vercel',
  'readme',
  'license',
  'changelog',
  'contributing',
  'credits',
  'authors',
  'todo',
  'settings',
  'lock',
  'key',
  'tune', // .env
  'nest',
  'storybook',
  'jest',
  'vitest',
  'cypress',
  'playwright',
  'test-ts',
  'test-js',
  'test-jsx',
  // assets
  'image',
  'svg',
  'favicon',
  'font',
  'audio',
  'video',
  'zip',
  'exe',
  'disc',
  'certificate',
  'email',
  'table', // csv / xlsx
  'powerpoint',
  'word',
]

const KEEP_FOLDER_ICONS = [
  'folder',
  'folder-src',
  'folder-dist',
  'folder-node',
  'folder-components',
  'folder-test',
  'folder-scripts',
  'folder-config',
  'folder-public',
  'folder-resource',
  'folder-images',
  'folder-css',
  'folder-docs',
  'folder-git',
  'folder-github',
  'folder-vscode',
  'folder-app',
  'folder-lib',
  'folder-utils',
  'folder-hook',
  'folder-context',
  'folder-store',
  'folder-server',
  'folder-client',
  'folder-api',
  'folder-theme',
  'folder-i18n',
  'folder-temp',
  'folder-plugin',
  'folder-packages',
  'folder-shared',
  'folder-container',
]

const keepFile = new Set(KEEP_FILE_ICONS)
const keepFolder = new Set(KEEP_FOLDER_ICONS)

// Which icons actually exist in the package (guard against typos in the lists).
const availableSvgs = new Set(
  readdirSync(themeIconsDir)
    .filter((f) => f.endsWith('.svg'))
    .map((f) => f.slice(0, -4)),
)

function warnMissing(names, label) {
  const missing = names.filter((n) => !availableSvgs.has(n))
  if (missing.length) {
    console.warn(`[import-material-icons] ${label} not found in package: ${missing.join(', ')}`)
  }
}
warnMissing(KEEP_FILE_ICONS, 'file icons')
warnMissing(KEEP_FOLDER_ICONS, 'folder icons')

// The set of icon names we will actually emit (kept ∧ exists). Folder-open
// variants are pulled in alongside their base folder icon below.
const emit = new Set()
for (const name of keepFile) if (availableSvgs.has(name)) emit.add(name)
for (const name of keepFolder) if (availableSvgs.has(name)) emit.add(name)

// ── Build the reverse maps from the manifest ───────────────────────────────
// manifest.fileExtensions/fileNames/languageIds: key → iconName
// Keep only entries whose icon we're emitting. `lowerKey` normalizes keys to
// lowercase (fileNames/folderNames are matched case-insensitively at runtime).
function pickAssoc(assoc, allowed, lowerKey = false) {
  const out = {}
  for (const [key, iconName] of Object.entries(assoc ?? {})) {
    if (allowed.has(iconName)) out[lowerKey ? key.toLowerCase() : key] = iconName
  }
  return out
}

const fileExtensions = pickAssoc(manifest.fileExtensions, keepFile, true)
const fileNames = pickAssoc(manifest.fileNames, keepFile, true)
const languageIds = pickAssoc(manifest.languageIds, keepFile)
const folderNames = pickAssoc(manifest.folderNames, keepFolder, true)

// Folder-open variants: for every kept folder icon, prefer material's
// folderNamesExpanded mapping; also emit the "<name>-open" svg when present.
const folderNamesExpanded = {}
for (const [key, iconName] of Object.entries(manifest.folderNamesExpanded ?? {})) {
  const lower = key.toLowerCase()
  if (folderNames[lower]) {
    folderNamesExpanded[lower] = iconName
    if (availableSvgs.has(iconName)) emit.add(iconName)
  }
}
for (const iconName of [...keepFolder]) {
  const open = `${iconName}-open`
  if (availableSvgs.has(open)) emit.add(open)
}

// Defaults (always present in the manifest).
const defaults = {
  file: manifest.file,
  folder: manifest.folder,
  folderExpanded: manifest.folderExpanded,
}
for (const name of Object.values(defaults)) {
  if (availableSvgs.has(name)) emit.add(name)
}

// ── Copy SVGs ──────────────────────────────────────────────────────────────
rmSync(outIconsDir, { recursive: true, force: true })
mkdirSync(outIconsDir, { recursive: true })
let copied = 0
for (const name of [...emit].sort()) {
  copyFileSync(join(themeIconsDir, `${name}.svg`), join(outIconsDir, `${name}.svg`))
  copied++
}
// Ship the upstream license for attribution (MIT).
copyFileSync(join(themeRoot, 'LICENSE'), join(outIconsDir, 'LICENSE'))

// ── Emit materialIconMap.ts ────────────────────────────────────────────────
const sortObj = (o) =>
  Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))

const header = `/* eslint-disable */
// GENERATED by apps/editor/scripts/import-material-icons.mjs — do not edit by hand.
// Source: material-icon-theme (MIT). Re-run the script to regenerate.
//
// Values are Material icon names; the matching SVG lives in ./icons/<name>.svg.

`

const body =
  `export const materialIconDefaults = ${JSON.stringify(sortObj(defaults), null, 2)} as const\n\n` +
  `export const materialFileNames: Record<string, string> = ${JSON.stringify(sortObj(fileNames), null, 2)}\n\n` +
  `export const materialFileExtensions: Record<string, string> = ${JSON.stringify(sortObj(fileExtensions), null, 2)}\n\n` +
  `export const materialLanguageIds: Record<string, string> = ${JSON.stringify(sortObj(languageIds), null, 2)}\n\n` +
  `export const materialFolderNames: Record<string, string> = ${JSON.stringify(sortObj(folderNames), null, 2)}\n\n` +
  `export const materialFolderNamesExpanded: Record<string, string> = ${JSON.stringify(sortObj(folderNamesExpanded), null, 2)}\n`

writeFileSync(outMapPath, header + body, 'utf-8')

console.log(
  `[import-material-icons] copied ${copied} svg(s); ` +
    `fileNames=${Object.keys(fileNames).length} ` +
    `fileExtensions=${Object.keys(fileExtensions).length} ` +
    `languageIds=${Object.keys(languageIds).length} ` +
    `folderNames=${Object.keys(folderNames).length}`,
)
