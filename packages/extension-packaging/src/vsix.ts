/**
 * VSIX (zip) reading + extraction. A VSIX is a plain zip whose extension body
 * lives under `extension/`; the client only cares about that subtree and reads
 * `extension/package.json` for the manifest (the `extension.vsixmanifest` XML is
 * a server-side product we ignore, matching VSCode's client).
 *
 * Node-side, no network — unit-testable. zip-slip is guarded on extraction: every
 * entry must resolve inside the target directory.
 */
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import AdmZip from 'adm-zip'
import { parseManifest } from '@universe-editor/extensions-common/manifest-schema'
import type { IExtensionManifest } from '@universe-editor/extensions-common'
import { extensionPackageFiles } from './packageFiles.js'

/** Prefix (posix) every extension file lives under inside a VSIX. */
const EXTENSION_PREFIX = 'extension/'

/**
 * Extra top-level docs bundled into a VSIX when present, even if not listed in
 * the manifest `files[]`: the gallery reads them out of the VSIX to render the
 * marketplace details/changelog pages.
 */
const EXTRA_DOC_FILES = ['README.md', 'CHANGELOG.md'] as const

/** Normalize a zip entry name to forward slashes (zip entries are always posix). */
function toPosix(entryName: string): string {
  return entryName.replace(/\\/g, '/')
}

/**
 * Read and validate `extension/package.json` from a VSIX without extracting.
 * Throws if the file is absent or the manifest fails zod validation.
 */
export function readVsixManifest(vsixPath: string): IExtensionManifest {
  const zip = new AdmZip(vsixPath)
  const entry = zip.getEntry(`${EXTENSION_PREFIX}package.json`)
  if (!entry) {
    throw new Error(`invalid VSIX: missing ${EXTENSION_PREFIX}package.json`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(entry.getData().toString('utf8'))
  } catch (err) {
    throw new Error(`invalid VSIX: unparseable package.json (${(err as Error).message})`)
  }
  return parseManifest(raw)
}

/**
 * Extract only the `extension/**` subtree of a VSIX into `targetDir`, stripping
 * the `extension/` prefix so the result mirrors an installed extension folder
 * (`<targetDir>/package.json`, `<targetDir>/dist/...`). `targetDir` must already
 * exist. zip-slip is rejected: any entry resolving outside `targetDir` aborts.
 */
export async function extractVsix(vsixPath: string, targetDir: string): Promise<void> {
  const zip = new AdmZip(vsixPath)
  const resolvedTarget = path.resolve(targetDir)
  for (const entry of zip.getEntries()) {
    const name = toPosix(entry.entryName)
    if (!name.startsWith(EXTENSION_PREFIX) || name === EXTENSION_PREFIX) continue
    const relative = name.slice(EXTENSION_PREFIX.length)
    if (relative === '') continue
    const dest = path.resolve(resolvedTarget, relative)
    // zip-slip guard: the resolved path must stay within targetDir.
    if (dest !== resolvedTarget && !dest.startsWith(resolvedTarget + path.sep)) {
      throw new Error(`invalid VSIX: entry "${name}" escapes the target directory`)
    }
    if (entry.isDirectory) {
      await mkdir(dest, { recursive: true })
      continue
    }
    await mkdir(path.dirname(dest), { recursive: true })
    await writeFile(dest, entry.getData())
  }
}

/**
 * Pack an extension directory into a VSIX at `outPath`. The payload is derived
 * from the manifest (`package.json` + `files[]`, or a `dist` default) via the
 * shared {@link extensionPackageFiles} rule — the same set runtime staging
 * ships — plus README/CHANGELOG when present. The two server-side OPC files
 * (`[Content_Types].xml`, `extension.vsixmanifest`) are written as placeholders
 * since the client ignores them (see {@link readVsixManifest}).
 *
 * Throws if `extensionDir/package.json` is missing or fails manifest validation.
 */
export async function createVsix(extensionDir: string, outPath: string): Promise<void> {
  const extRoot = path.resolve(extensionDir)
  const manifestPath = path.join(extRoot, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`cannot package: missing ${manifestPath}`)
  }
  // Validate before packing so a malformed manifest fails fast, not at install.
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  parseManifest(manifest)

  const zip = new AdmZip()
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'))
  zip.addFile('extension.vsixmanifest', Buffer.from('<PackageManifest/>'))

  const entries = extensionPackageFiles(manifest as IExtensionManifest)
  for (const doc of EXTRA_DOC_FILES) {
    if (!entries.includes(doc) && existsSync(path.join(extRoot, doc))) entries.push(doc)
  }

  for (const rel of entries) {
    const abs = path.join(extRoot, rel)
    if (!existsSync(abs)) {
      if (rel === 'package.json') throw new Error(`cannot package: missing ${abs}`)
      continue
    }
    if (statSync(abs).isDirectory()) {
      zip.addLocalFolder(abs, `${EXTENSION_PREFIX}${rel}`)
    } else {
      zip.addLocalFile(abs, path.posix.dirname(`${EXTENSION_PREFIX}${rel}`))
    }
  }

  await mkdir(path.dirname(path.resolve(outPath)), { recursive: true })
  zip.writeZip(path.resolve(outPath))
}
