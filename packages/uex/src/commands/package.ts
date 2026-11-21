import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { parseManifest } from '@universe-editor/extension-manifest/manifest-schema'
import {
  createVsix,
  extensionPackageFiles,
  isPathCoveredByPackageFiles,
} from '@universe-editor/extension-packaging'
import { UexError } from '../errors.js'
import { info, warn, printUexError } from '../output.js'
import { parseCommandArgs } from '../args.js'
import { checkManifestForPublish, type PublishManifest } from '../lib/manifestChecks.js'
import { runPrepublishScript } from '../lib/prepublish.js'
import { CURRENT_API_VERSION } from '../lib/sdkVersion.js'

export interface RunPackageOptions {
  readonly cwd: string
  readonly out?: string
  /** --force: downgrade the engines.universe coverage error to a warning. */
  readonly force?: boolean
}

export interface RunPackageResult {
  readonly vsixPath: string
  readonly manifest: PublishManifest
}

async function readManifest(extensionDir: string): Promise<PublishManifest> {
  const manifestPath = path.join(extensionDir, 'package.json')
  if (!existsSync(manifestPath)) {
    throw new UexError(`no package.json in ${extensionDir}`, [
      'run `uex package` from your extension root (the folder containing package.json)',
    ])
  }
  const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
  // The zod schema strips npm-level fields (`files`, `scripts`, …) that are
  // not part of the host manifest protocol — merge them back from the raw
  // package.json after validation.
  const validated = parseManifest(raw) as PublishManifest
  const rawFiles = (raw as { files?: unknown }).files
  if (Array.isArray(rawFiles)) validated.files = rawFiles as readonly string[]
  return validated
}

/**
 * The full packaging pipeline, shared by `uex package` and `uex publish`.
 * Order is the contract (tests lock it): manifest → policy checks →
 * universe:prepublish → entry-point check → createVsix.
 */
export async function runPackage(opts: RunPackageOptions): Promise<RunPackageResult> {
  const extensionDir = path.resolve(opts.cwd)
  const manifest = await readManifest(extensionDir)

  const issues = checkManifestForPublish(manifest, {
    extensionDir,
    currentApiVersion: CURRENT_API_VERSION,
    ...(opts.force ? { force: true } : {}),
  })
  for (const issue of issues) {
    if (issue.level === 'warning') {
      warn(issue.message + (issue.hint ? ` — ${issue.hint}` : ''))
    } else {
      console.error(`error: ${issue.message}` + (issue.hint ? `\n→ ${issue.hint}` : ''))
    }
  }
  const errorCount = issues.filter((i) => i.level === 'error').length
  if (errorCount > 0) {
    throw new UexError(`manifest checks failed (${errorCount} error${errorCount > 1 ? 's' : ''})`)
  }

  // package.json's npm-level `scripts` block — not part of the host schema,
  // read straight from disk again to keep the zod manifest untouched.
  const rawPkg: { scripts?: Record<string, string> } = JSON.parse(
    await readFile(path.join(extensionDir, 'package.json'), 'utf8'),
  )
  await runPrepublishScript(extensionDir, rawPkg.scripts)

  if (manifest.main && !existsSync(path.join(extensionDir, manifest.main))) {
    throw new UexError(`entry point "${manifest.main}" does not exist`, [
      'run `npm run build` first (or wire "universe:prepublish" so packaging builds for you)',
    ])
  }

  // Trusted-view entries are loaded directly by the renderer, so they must
  // exist on disk AND be shipped by the files whitelist. A silently unshipped
  // entry turns into a runtime load failure only on the user's machine.
  const trustedViews = manifest.contributes?.trustedViews ?? []
  if (trustedViews.length > 0) {
    const shipped = extensionPackageFiles(
      manifest as {
        main?: string
        contributes?: { trustedViews?: readonly unknown[] }
        files?: readonly string[]
      },
    )
    for (const view of trustedViews) {
      const entry = view.entry.replaceAll('\\', '/')
      if (!existsSync(path.join(extensionDir, entry))) {
        throw new UexError(`trusted view "${view.id}" entry "${view.entry}" does not exist`, [
          'run `npm run build` first so the browser ESM component is emitted',
        ])
      }
      if (!isPathCoveredByPackageFiles(shipped, entry)) {
        throw new UexError(
          `trusted view "${view.id}" entry "${view.entry}" is not covered by the package files whitelist`,
          [`add the directory containing "${entry}" to "files" in package.json`],
        )
      }
    }
  }

  const publisher = manifest.publisher ?? ''
  const name = manifest.name
  const version = manifest.version
  const vsixPath = opts.out
    ? path.resolve(opts.out)
    : path.join(extensionDir, `${publisher}.${name}-${version}.vsix`)
  await createVsix(extensionDir, vsixPath)
  return { vsixPath, manifest }
}

export async function run(argv: string[]): Promise<number> {
  const { values } = parseCommandArgs('package', argv, {
    out: { type: 'string' },
    force: { type: 'boolean' },
    help: { type: 'boolean' },
  })
  if (values.help) {
    info('usage: uex package [--out <path>] [--force]')
    info('')
    info('validate the manifest, run universe:prepublish, and produce')
    info('<publisher>.<name>-<version>.vsix in the extension root (or --out).')
    info('--force downgrades the engines.universe coverage error to a warning.')
    return 0
  }
  try {
    const { vsixPath } = await runPackage({
      cwd: process.cwd(),
      ...(typeof values.out === 'string' ? { out: values.out } : {}),
      force: values.force === true,
    })
    info(`created ${vsixPath}`)
    info('next: `uex publish` to upload it, or install it from the editor’s Extensions view')
    return 0
  } catch (err) {
    printUexError(err)
    return err instanceof UexError ? err.exitCode : 1
  }
}
