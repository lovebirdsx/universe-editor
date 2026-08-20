/**
 * Pre-publish manifest checks. The shared packaging/manifest libraries carry
 * the *schema* truth (zod); this module layers the *publish policy* on top —
 * rules that must hold before an extension may be uploaded or installed from
 * a VSIX but that the host deliberately tolerates when scanning (e.g. missing
 * publisher is fine for a local dev extension, fatal for the marketplace).
 */
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import type { IExtensionManifest } from '@universe-editor/extension-manifest'
import {
  EXTENSION_CATEGORIES,
  isExtensionCategory,
  satisfies,
} from '@universe-editor/extension-manifest'

export interface CheckIssue {
  readonly level: 'error' | 'warning'
  readonly message: string
  readonly hint?: string
  /** Stable marker so callers can target one check (e.g. the --force downgrade) without matching on message text. */
  readonly code?: string
}

export interface CheckContext {
  readonly extensionDir: string
  /** Editor version the author most likely targets (uex's bundled SDK; unified app version space). */
  readonly currentApiVersion: string
  /** --force: downgrade the coverage error to a warning instead of blocking. */
  readonly force?: boolean
}

/** The manifest plus the npm-level `files` whitelist (not part of the host schema). */
export type PublishManifest = Omit<IExtensionManifest, 'publisher'> & {
  readonly publisher?: string | undefined
  files?: readonly string[] | undefined
}

/** `x.y.z` only — the host's semver negotiation does not understand prereleases. */
const STRICT_VERSION = /^\d+\.\d+\.\d+$/

/** The host's satisfies() fail-closes on `||` and hyphen ranges; catch them early. */
const UNSUPPORTED_RANGE = /\|\||\d\s+-\s+\d/

function entryExists(extensionDir: string, rel: string): boolean {
  return existsSync(path.join(extensionDir, rel))
}

/**
 * Collect publish-policy issues for `manifest`. Order is stable (tests lock
 * it): required-identity errors first, then range/category errors, then the
 * soft warnings. Errors block packaging; warnings print and continue.
 */
export function checkManifestForPublish(
  manifest: PublishManifest,
  ctx: CheckContext,
): CheckIssue[] {
  const issues: CheckIssue[] = []
  const m = manifest

  if (!m.publisher || m.publisher.trim() === '') {
    issues.push({
      level: 'error',
      message: 'manifest is missing "publisher"',
      hint: 'add "publisher": "your-id" to package.json — it must match the publisher your publish token belongs to',
    })
  }

  if (!Array.isArray(m.files) || m.files.length === 0) {
    issues.push({
      level: 'error',
      message: 'manifest is missing "files" (the VSIX whitelist)',
      hint: 'add e.g. "files": ["dist", "icon.png"] — packaging is whitelist-based so secrets and node_modules can never leak into a VSIX',
    })
  }

  if (!STRICT_VERSION.test(m.version)) {
    issues.push({
      level: 'error',
      message: `"version" must be a plain x.y.z version, got "${m.version}"`,
      hint: 'use plain "x.y.z" (no prerelease tags) — the host’s version negotiation does not understand them',
    })
  }

  if (UNSUPPORTED_RANGE.test(m.engines.universe)) {
    issues.push({
      level: 'error',
      message: `"engines.universe" uses a range form the host does not support: "${m.engines.universe}"`,
      hint: 'the host fail-closes on "||" and hyphen ranges — write an explicit range like ">=0.7.1 <1.0.0"',
    })
  } else if (!satisfies(ctx.currentApiVersion, m.engines.universe)) {
    issues.push({
      level: ctx.force ? 'warning' : 'error',
      code: 'engine-coverage',
      message: `"engines.universe" ("${m.engines.universe}") does not cover the current editor version (${ctx.currentApiVersion})`,
      hint: 'the extension will install but refuse to activate on the current editor — widen the range or pin the matching editor version',
    })
  }

  for (const category of m.categories ?? []) {
    if (!isExtensionCategory(category)) {
      issues.push({
        level: 'error',
        message: `unknown category "${category}"`,
        hint: `valid categories: ${EXTENSION_CATEGORIES.join(', ')}`,
      })
    }
  }

  for (const rel of m.files ?? []) {
    if (!entryExists(ctx.extensionDir, rel)) {
      issues.push({
        level: 'warning',
        message: `"files" entry "${rel}" does not exist on disk`,
        hint: 'it will be silently skipped in the VSIX — fix the path or build the artifact first',
      })
    }
  }

  if (m.icon && !entryExists(ctx.extensionDir, m.icon)) {
    issues.push({
      level: 'warning',
      message: `"icon" ("${m.icon}") does not exist on disk`,
      hint: 'the marketplace page renders without an icon; also make sure the icon is listed in "files"',
    })
  }

  const declaredCommands = new Set(
    (m.contributes?.commands ?? []).map((c: { command: string }) => c.command),
  )
  for (const event of m.activationEvents ?? []) {
    if (event.startsWith('onCommand:')) {
      const id = event.slice('onCommand:'.length)
      if (!declaredCommands.has(id)) {
        issues.push({
          level: 'warning',
          message: `activation event "onCommand:${id}" has no matching contributes.commands entry`,
          hint: 'the command will not show in the command palette — add it under contributes.commands',
        })
      }
    }
  }

  return issues
}
