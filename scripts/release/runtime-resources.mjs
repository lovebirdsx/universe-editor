#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Build/package helper for runtime resources that live outside app.asar.
 *
 *  electron-builder copies apps/editor/.runtime-resources into resources/.
 *  This keeps packaged resources in one staged tree instead of scattering
 *  extraResources entries across every runtime subsystem.
 *--------------------------------------------------------------------------------------------*/

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')
const editorRoot = join(repoRoot, 'apps/editor')
const releaseResourcesRoot = join(editorRoot, 'release/win-unpacked/resources')

export const runtimeResourcesDir = join(editorRoot, '.runtime-resources')
export const extensionsRoot = join(repoRoot, 'extensions')

const REQUIRED_SOURCE_FILES = [
  {
    label: 'Claude ACP agent',
    source: join(repoRoot, 'vendor/claude-agent-acp/dist/index.js'),
    packaged: 'claude-agent-acp/dist/index.js',
  },
  {
    label: 'Codex ACP agent',
    source: join(repoRoot, 'vendor/codex-acp/dist/index.js'),
    packaged: 'codex-acp/dist/index.js',
  },
  {
    label: 'extension host bootstrap',
    source: join(repoRoot, 'packages/extension-host/dist/bootstrap.js'),
    packaged: 'extension-host/dist/bootstrap.js',
  },
  {
    label: 'typescript-language-server cli',
    source: join(
      repoRoot,
      'vendor/typescript-language-server/node_modules/typescript-language-server/lib/cli.mjs',
    ),
    packaged: 'typescript-language-server/node_modules/typescript-language-server/lib/cli.mjs',
  },
  {
    label: 'tsserver (typescript)',
    source: join(repoRoot, 'vendor/typescript-language-server/node_modules/typescript/lib/tsserver.js'),
    packaged: 'typescript-language-server/node_modules/typescript/lib/tsserver.js',
  },
  {
    label: 'release notes',
    source: join(editorRoot, 'resources/release-notes.json'),
    packaged: 'release-notes.json',
  },
]

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function fail(message) {
  throw new Error(message)
}

function assertExists(path, label) {
  if (!existsSync(path)) fail(`Missing ${label}: ${path}`)
}

function normalizePackageFileEntry(entry) {
  if (typeof entry !== 'string' || entry.trim() === '') {
    fail(`Invalid package files entry: ${String(entry)}`)
  }
  let normalized = entry.trim().replaceAll('\\', '/').replace(/^\.\/+/, '')
  if (normalized.endsWith('/**')) normalized = normalized.slice(0, -3)
  if (
    normalized.startsWith('/') ||
    normalized.includes(':') ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    fail(`Package files entry must stay inside the extension: ${entry}`)
  }
  if (/[*?[\]{}]/.test(normalized)) {
    fail(`Package files entry must be a literal file or directory: ${entry}`)
  }
  return normalized
}

function unique(values) {
  return [...new Set(values)]
}

export function extensionPackageFiles(manifest) {
  const explicitFiles = Array.isArray(manifest.files)
    ? manifest.files.map(normalizePackageFileEntry)
    : null
  const defaultFiles = manifest.main ? ['dist'] : []
  return unique(['package.json', ...(explicitFiles ?? defaultFiles)])
}

export function discoverBuiltinExtensions(root = extensionsRoot) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const extensionPath = join(root, entry.name)
      const manifestPath = join(extensionPath, 'package.json')
      if (!existsSync(manifestPath)) return null
      return {
        id: entry.name,
        extensionPath,
        manifestPath,
        manifest: readJson(manifestPath),
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.id.localeCompare(b.id))
}

function copyPath(source, destination) {
  assertExists(source, 'runtime resource source')
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: statSync(source).isDirectory(), force: true })
}

function assertPackagedFile(root, relativePath, label) {
  assertExists(join(root, ...relativePath.split('/')), label)
}

function assertSourceFile(relativeRoot, relativePath, label) {
  assertExists(join(relativeRoot, ...relativePath.split('/')), label)
}

export function verifySourceRuntimeResources() {
  for (const required of REQUIRED_SOURCE_FILES) {
    assertExists(required.source, required.label)
  }

  for (const extension of discoverBuiltinExtensions()) {
    for (const file of extensionPackageFiles(extension.manifest)) {
      assertSourceFile(extension.extensionPath, file, `${extension.id} packaged file`)
    }
    if (extension.manifest.main) {
      assertSourceFile(
        extension.extensionPath,
        normalizePackageFileEntry(extension.manifest.main),
        `${extension.id} main entry`,
      )
    }
  }
}

export function stageRuntimeResources(stageDir = runtimeResourcesDir) {
  verifySourceRuntimeResources()
  rmSync(stageDir, { recursive: true, force: true })
  mkdirSync(stageDir, { recursive: true })

  copyPath(join(repoRoot, 'vendor/claude-agent-acp/dist'), join(stageDir, 'claude-agent-acp/dist'))
  copyPath(join(repoRoot, 'vendor/codex-acp/dist'), join(stageDir, 'codex-acp/dist'))
  copyPath(join(repoRoot, 'packages/extension-host/dist'), join(stageDir, 'extension-host/dist'))
  // The TS/JS language server is a prebuilt third-party CLI that needs its own
  // node_modules at runtime (typescript-language-server + tsserver). Stage the
  // whole tree — do NOT prune `typescript`, tsserver lives inside it.
  copyPath(
    join(repoRoot, 'vendor/typescript-language-server/node_modules'),
    join(stageDir, 'typescript-language-server/node_modules'),
  )
  copyPath(join(editorRoot, 'resources/release-notes.json'), join(stageDir, 'release-notes.json'))

  for (const extension of discoverBuiltinExtensions()) {
    const destinationRoot = join(stageDir, 'extensions', extension.id)
    for (const file of extensionPackageFiles(extension.manifest)) {
      copyPath(
        join(extension.extensionPath, ...file.split('/')),
        join(destinationRoot, ...file.split('/')),
      )
    }
  }

  verifyPackagedRuntimeResources(stageDir)
}

export function verifyPackagedRuntimeResources(resourcesRoot = releaseResourcesRoot) {
  for (const required of REQUIRED_SOURCE_FILES) {
    assertPackagedFile(resourcesRoot, required.packaged, required.label)
  }

  for (const extension of discoverBuiltinExtensions()) {
    assertPackagedFile(resourcesRoot, `extensions/${extension.id}/package.json`, `${extension.id} manifest`)
    for (const file of extensionPackageFiles(extension.manifest)) {
      assertPackagedFile(resourcesRoot, `extensions/${extension.id}/${file}`, `${extension.id} packaged file`)
    }
    if (extension.manifest.main) {
      assertPackagedFile(
        resourcesRoot,
        `extensions/${extension.id}/${normalizePackageFileEntry(extension.manifest.main)}`,
        `${extension.id} main entry`,
      )
    }
  }
}

function usage() {
  return [
    'Usage: node scripts/release/runtime-resources.mjs <command>',
    '',
    'Commands:',
    '  stage            Recreate apps/editor/.runtime-resources',
    '  verify-source    Check source build outputs required for staging',
    '  verify-packaged  Check apps/editor/release/win-unpacked/resources',
    '  verify-packaged <resourcesRoot>',
  ].join('\n')
}

function main(argv) {
  const command = argv[0]
  if (command === 'stage') {
    stageRuntimeResources()
    console.log(`runtime resources staged: ${runtimeResourcesDir}`)
    return
  }
  if (command === 'verify-source') {
    verifySourceRuntimeResources()
    console.log('runtime resource sources verified')
    return
  }
  if (command === 'verify-packaged') {
    verifyPackagedRuntimeResources(argv[1] ? resolve(repoRoot, argv[1]) : undefined)
    console.log('packaged runtime resources verified')
    return
  }
  console.error(usage())
  process.exit(command ? 1 : 0)
}

const isMain =
  process.argv[1] && realpathSync(process.argv[1]).split(sep).join('/') === fileURLToPath(import.meta.url).split(sep).join('/')
if (isMain) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`runtime resources: ${message}`)
    process.exit(1)
  }
}
