/**
 * Copies a template tree to the target directory with token substitution.
 * Templates are real, buildable projects kept under `templates/` — no
 * template engine, just `__token__` string replacement in text files.
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ScaffoldError } from './errors.js'
import { buildPlaceholders, type ScaffoldAnswers } from './placeholders.js'
import type { SdkVersions } from './sdkVersions.js'

export interface ScaffoldOptions {
  readonly targetDir: string
  readonly force: boolean
  readonly versions: SdkVersions
}

/** Extensions whose content gets token substitution; anything else (icon.png)
 *  is copied byte-for-byte. */
const TEXT_EXTENSIONS = new Set(['.ts', '.mjs', '.json', '.md', '.yml', '.yaml', '.html', '.css'])

/** `_gitignore` ships under that name because npm/git special-case dotfiles;
 *  it lands as `.gitignore` in the generated project. */
const RENAME_MAP: Record<string, string> = {
  _gitignore: '.gitignore',
}

function templatesRoot(): string {
  // dist/scaffold.js → <pkg>/templates
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates')
}

async function copyTree(
  srcDir: string,
  destDir: string,
  placeholders: Record<string, string>,
  written: string[],
): Promise<void> {
  const entries = await readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name)
    const destName = RENAME_MAP[entry.name] ?? entry.name
    const dest = path.join(destDir, destName)
    if (entry.isDirectory()) {
      await mkdir(dest, { recursive: true })
      await copyTree(src, dest, placeholders, written)
      continue
    }
    await mkdir(path.dirname(dest), { recursive: true })
    if (TEXT_EXTENSIONS.has(path.extname(entry.name)) || path.extname(entry.name) === '') {
      let content = await readFile(src, 'utf8')
      for (const [token, value] of Object.entries(placeholders)) {
        content = content.replaceAll(token, value)
      }
      await writeFile(dest, content)
    } else {
      await copyFile(src, dest)
    }
    written.push(dest)
  }
}

/**
 * Scaffold `answers.template` into `targetDir`. Refuses a non-empty directory
 * unless `force` — and even then only overwrites files it owns, never deletes.
 * Returns the written file paths.
 */
export async function scaffold(answers: ScaffoldAnswers, opts: ScaffoldOptions): Promise<string[]> {
  const targetDir = path.resolve(opts.targetDir)
  const templateDir = path.join(templatesRoot(), answers.template)
  if (!existsSync(templateDir)) {
    throw new ScaffoldError(`unknown template "${answers.template}"`, [
      'available templates: basic, webview',
    ])
  }

  if (existsSync(targetDir) && !opts.force) {
    const existing = await readdir(targetDir)
    if (existing.length > 0) {
      throw new ScaffoldError(`target directory is not empty: ${targetDir}`, [
        'pass --force to write into it anyway (existing files are never deleted)',
        'or pick a new directory',
      ])
    }
  }

  const written: string[] = []
  await mkdir(targetDir, { recursive: true })
  await copyTree(templateDir, targetDir, buildPlaceholders(answers, opts.versions), written)
  return written
}
