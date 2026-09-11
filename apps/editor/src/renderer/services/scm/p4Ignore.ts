/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  p4Ignore — the built-in Perforce ignore-rule engine (parse + evaluate).
 *
 *  Pure: no DI, no IO, no path normalization. Callers hand in paths that are
 *  already forward-slashed and already relative to the rule file's directory —
 *  separator and case policy belong to the service layer, which owns an
 *  `IUriIdentityService`.
 *
 *  Semantics follow `p4 ignores` (help.perforce.com → P4IGNORE):
 *
 *    - A rule file governs its own directory and every directory below it, so
 *      several files can apply to one path. The file closest to the path wins,
 *      and inside one file the LAST matching line wins — which is also how `!`
 *      re-includes something an earlier line excluded.
 *    - `#` in column 1 starts a comment; a backslash escapes a leading `#` and
 *      a leading `!` to the literal character.
 *    - A trailing slash restricts the rule to directories.
 *    - A LEADING slash anchors the rule to the rule file's own directory. Only
 *      the leading one: an inner separator is an ordinary one, so `a/b` still
 *      matches at any depth. This is the opposite of gitignore.
 *    - `*` stops at a separator, a double star crosses separators, `?` matches
 *      one non-separator character.
 *    - A rule with no leading slash matches at any depth.
 *    - A rule that matches a directory governs everything under it.
 *
 *  Deliberate divergences from `p4 ignores`, each on the permissive side of
 *  "what did the user mean":
 *
 *    - gitignore's "nothing inside an excluded directory can be re-included" is
 *      NOT implemented — Perforce's documentation states no such rule, and
 *      Unreal-style rule files rely on re-inclusion under an excluded tree.
 *    - `{a,b}` alternatives and `[...]` character classes are honoured because
 *      the shared glob compiler supports them; `p4` has no such syntax.
 *    - Matching is case-sensitive even where the filesystem is not.
 *
 *  The adjudicator for any suspected drift is `p4 ignores -i -v <path>`.
 *--------------------------------------------------------------------------------------------*/

import { makeGlobMatcher } from '@universe-editor/platform'

/** Rule file names Perforce looks for by default (P4 Server 2023.2+), in the
 *  order `p4 ignores` searches them. */
export const P4_IGNORE_FILE_NAMES: readonly string[] = ['.p4ignore', 'p4ignore.txt']

/** Config file names searched when `P4CONFIG` is not set in the environment. */
export const P4_CONFIG_FILE_NAMES: readonly string[] = ['.p4config', 'p4config.txt']

export interface P4IgnorePattern {
  /** The line as written, for diagnostics (parity with `p4 ignores -v`). */
  readonly source: string
  /** Tests a path relative to the rule file's directory. */
  readonly matches: (relPath: string) => boolean
  /** Trailing slash: only a directory can be hit. */
  readonly directoryOnly: boolean
  /** Leading `!`: a hit re-includes instead of excluding. */
  readonly negated: boolean
}

/**
 * Compile rule-file text into patterns, in file order. Unparseable and
 * unevaluatable lines are skipped rather than fatal — a malformed rule file
 * must never take the caller down.
 */
export function parseP4IgnoreFile(content: string): readonly P4IgnorePattern[] {
  const patterns: P4IgnorePattern[] = []
  for (const raw of content.split('\n')) {
    let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim() === '') continue
    if (line.startsWith('#')) continue

    let negated = false
    if (line.startsWith('\\#') || line.startsWith('\\!')) {
      line = line.slice(1)
    } else if (line.startsWith('!')) {
      negated = true
      line = line.slice(1)
    }

    let directoryOnly = false
    if (line.endsWith('/') || line.endsWith('\\')) {
      directoryOnly = true
      line = line.slice(0, -1)
    }

    let anchored = false
    if (line.startsWith('/')) {
      anchored = true
      line = line.slice(1)
    }
    // Separators normalize only after the escapes and the leading anchor have
    // been taken off, so an escaped `#`/`!` stays literal and a backslash
    // separator can't be mistaken for an anchor.
    line = line.replace(/\\/g, '/')
    if (line.startsWith('/')) {
      anchored = true
      line = line.replace(/^\/+/, '')
    }
    if (line === '') continue

    const matches = makeGlobMatcher([anchored ? line : `**/${line}`])
    if (matches === null) continue
    patterns.push({ source: raw, matches, directoryOnly, negated })
  }
  return patterns
}

/** One rule file, paired with the candidate path expressed relative to it. */
export interface P4IgnoreLevel {
  /** The rule file's directory, carried through for diagnostics only. */
  readonly dir: string
  /** Candidate path relative to the rule file's directory, forward-slashed. */
  readonly relPath: string
  readonly patterns: readonly P4IgnorePattern[]
}

/** The rule that decided a verdict, so callers can say why (as `p4 ignores -v` does). */
export interface P4IgnoreMatch {
  readonly dir: string
  /** The winning line, verbatim. */
  readonly source: string
  /** True when the winning line was a `!` re-inclusion. */
  readonly negated: boolean
}

export interface P4IgnoreVerdict {
  readonly ignored: boolean
  /** The last (i.e. deciding) matching rule, or null when nothing matched. */
  readonly by: P4IgnoreMatch | null
}

/**
 * Final verdict for a candidate against every rule file that applies to it.
 * `levels` runs from the shallowest (farthest ancestor) to the deepest, i.e.
 * increasing precedence; within a level the last matching line wins. An empty
 * or non-matching `levels` is "not ignored".
 */
export function evaluateP4Ignore(
  levels: readonly P4IgnoreLevel[],
  isDirectory: boolean,
): P4IgnoreVerdict {
  let by: P4IgnoreMatch | null = null
  for (const level of levels) {
    const segments = level.relPath.split('/').filter((segment) => segment !== '')
    for (const pattern of level.patterns) {
      if (hits(pattern, segments, isDirectory)) {
        by = { dir: level.dir, source: pattern.source, negated: pattern.negated }
      }
    }
  }
  return { ignored: by !== null && !by.negated, by }
}

/**
 * A rule hits when it matches the candidate itself or any of its ancestor
 * directories — a rule matching a directory governs everything under it, so the
 * ancestors have to be offered to the matcher too.
 */
function hits(
  pattern: P4IgnorePattern,
  segments: readonly string[],
  isDirectory: boolean,
): boolean {
  for (let depth = segments.length; depth >= 1; depth--) {
    // At full depth the candidate is the item itself, which is a directory only
    // when the caller said so; every shallower candidate is an ancestor.
    if (pattern.directoryOnly && depth === segments.length && !isDirectory) continue
    if (pattern.matches(segments.slice(0, depth).join('/'))) return true
  }
  return false
}

/**
 * The `P4IGNORE` value declared by a p4 config file, or null when it declares
 * none. Keys are matched case-insensitively; `#` starts a comment.
 */
export function parseP4IgnoreSetting(configContent: string): string | null {
  for (const raw of configContent.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    if (line.slice(0, eq).trim().toUpperCase() !== 'P4IGNORE') continue
    return line.slice(eq + 1).trim()
  }
  return null
}

/** A `P4IGNORE` value split into the two things it can name. */
export interface P4IgnoreSpec {
  /** Bare file names, searched in every directory of the chain like the defaults. */
  readonly names: readonly string[]
  /** Entries carrying a separator: rule files at a fixed location. */
  readonly paths: readonly string[]
}

/** Split a `P4IGNORE` value (a `;`-separated list) into names and paths. */
export function splitP4IgnoreSpec(spec: string): P4IgnoreSpec {
  const names: string[] = []
  const paths: string[] = []
  for (const entry of spec.split(';')) {
    const trimmed = entry.trim()
    if (trimmed === '') continue
    if (trimmed.includes('/') || trimmed.includes('\\')) paths.push(trimmed)
    else names.push(trimmed)
  }
  return { names, paths }
}
