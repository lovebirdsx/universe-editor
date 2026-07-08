/**
 * VSIX (zip) reading + extraction. A VSIX is a plain zip whose extension body
 * lives under `extension/`; the client only cares about that subtree and reads
 * `extension/package.json` for the manifest (the `extension.vsixmanifest` XML is
 * a server-side product we ignore, matching VSCode's client).
 *
 * Node-side, no network — unit-testable. zip-slip is guarded on extraction: every
 * entry must resolve inside the target directory.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import AdmZip from 'adm-zip'
import { parseManifest } from '@universe-editor/extensions-common/manifest-schema'
import type { IExtensionManifest } from '@universe-editor/extensions-common'

/** Prefix (posix) every extension file lives under inside a VSIX. */
const EXTENSION_PREFIX = 'extension/'

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
