/**
 * `uex ls`: the exact file list a VSIX would carry, expanded on disk. Shares
 * the whitelist rule with createVsix (extensionPackageFiles) and appends the
 * same README/CHANGELOG extras, so `ls` never drifts from `package`.
 */
import { existsSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import * as path from 'node:path'
import { extensionPackageFiles } from '@universe-editor/extension-packaging'
import type { PublishManifest } from './manifestChecks.js'

/** Kept in sync with EXTRA_DOC_FILES in extension-packaging/src/vsix.ts. */
const EXTRA_DOC_FILES = ['README.md', 'CHANGELOG.md'] as const

async function walk(absDir: string, relPrefix: string, acc: string[]): Promise<void> {
  const entries = await readdir(absDir, { withFileTypes: true })
  for (const entry of entries) {
    const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`
    const abs = path.join(absDir, entry.name)
    if (entry.isDirectory()) {
      await walk(abs, rel, acc)
    } else if (entry.isFile()) {
      acc.push(rel)
    }
  }
}

/**
 * Expand the packaging whitelist to concrete files (posix, sorted). Missing
 * entries are skipped — surfacing them is manifestChecks' job.
 */
export async function listPackageFiles(
  extensionDir: string,
  manifest: PublishManifest,
): Promise<string[]> {
  const root = path.resolve(extensionDir)
  // PublishManifest widens optional props with `| undefined` for
  // exactOptionalPropertyTypes; extensionPackageFiles takes the narrow shape.
  const entries = extensionPackageFiles(manifest as { main?: string; files?: readonly string[] })
  for (const doc of EXTRA_DOC_FILES) {
    if (!entries.includes(doc) && existsSync(path.join(root, doc))) entries.push(doc)
  }

  const files: string[] = []
  for (const rel of entries) {
    const abs = path.join(root, rel)
    if (!existsSync(abs)) continue
    if (statSync(abs).isDirectory()) {
      await walk(abs, rel, files)
    } else {
      files.push(rel)
    }
  }
  return files.sort()
}
