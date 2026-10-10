/**
 * Where a managed p4delta comes from, and how the three upstream documents are
 * read: the "what is the latest release" answer, the release archive itself, and
 * the checksum list that has to vouch for it.
 *
 * Two sources, one shape. The default is the project's public GitHub releases; a
 * mirror (`perforce.p4delta.downloadBaseUrl`) is the escape hatch for machines
 * that cannot reach GitHub. Both are addressed by CONSTRUCTING the asset URL
 * from the version — never by reading `assets[].browser_download_url`, which in
 * a mirrored release payload would point back at github.com — so the two differ
 * in exactly one function ({@link releaseBaseUrl}) and a mirror holding
 * upstream's files verbatim needs no rewriting.
 *
 * A mirror directory holds:
 *
 *     <base>/latest.json                               {"version":"0.1.10"}
 *     <base>/SHA256SUMS                                upstream's own file
 *     <base>/p4delta-0.1.10-x86_64-pc-windows-msvc.zip
 *
 * Everything here is a pure function over strings and parsed JSON: no I/O, and
 * no opinion on what to do when a document is missing or malformed. The store
 * refuses to install in those cases (see p4deltaStore).
 */
import { parseP4deltaVersion, type P4deltaVersion } from './p4deltaVersion.js'

export type P4deltaSource =
  | { readonly mode: 'github'; readonly repo: string }
  | { readonly mode: 'mirror'; readonly baseUrl: string }

/** The project's public release page — the default source. */
export const P4DELTA_DEFAULT_SOURCE: P4deltaSource = {
  mode: 'github',
  repo: 'lovebirdsx/p4delta',
}

/**
 * The Rust target triple upstream names its assets with, or undefined when no
 * asset exists for this machine. Only win32-x64 today: the project's release
 * workflow builds that one platform, and a missing triple is a skip with one log
 * line — never an error, because δ is optional everywhere.
 */
export function p4deltaTargetTriple(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc'
  return undefined
}

export function assetNameFor(version: string, triple: string): string {
  return `p4delta-${version}-${triple}.zip`
}

/**
 * The mirror source for a configured base URL, or undefined when the setting is
 * not an absolute http(s) URL. Trailing slashes are normalized away so callers
 * can join unconditionally; requiring a host rejects the relative-path typo that
 * would otherwise produce a URL nothing can fetch.
 */
export function sourceFromBaseUrl(baseUrl: string): P4deltaSource | undefined {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!/^https?:\/\/[^/]+/i.test(trimmed)) return undefined
  return { mode: 'mirror', baseUrl: trimmed }
}

/**
 * The source this session should use: the environment override, then the
 * setting, then GitHub.
 *
 * A value that is not an absolute http(s) URL is demoted to the default rather
 * than failing the feature — the escape hatch must not be able to break a
 * machine that would have worked out of the box. Plain http is allowed on
 * purpose (internal static mirrors rarely have a certificate) but is called out
 * in the log: the digest and the archive it vouches for travel the same
 * unauthenticated channel, so it defends against a corrupted download, not
 * against whoever sits on the wire.
 */
export function resolveP4deltaSource(
  envBaseUrl: string | undefined,
  configuredBaseUrl: string,
  log: (msg: string) => void,
): P4deltaSource {
  const fromEnv = (envBaseUrl ?? '').trim()
  const configured = fromEnv !== '' ? fromEnv : configuredBaseUrl
  if (configured.trim() === '') return P4DELTA_DEFAULT_SOURCE
  const source = sourceFromBaseUrl(configured)
  if (source === undefined) {
    log(`[perforce] p4delta: ignoring "${configured}"; not an absolute http URL`)
    return P4DELTA_DEFAULT_SOURCE
  }
  if (source.mode === 'mirror' && !/^https:\/\//i.test(source.baseUrl)) {
    log(
      `[perforce] p4delta: downloading from a plain-http mirror (${source.baseUrl}); ` +
        'the checksum list and the archive share that channel',
    )
  }
  return source
}

/** The document that names the latest release. */
export function latestUrl(source: P4deltaSource): string {
  return source.mode === 'github'
    ? `https://api.github.com/repos/${source.repo}/releases/latest`
    : `${source.baseUrl}/latest.json`
}

/** The directory the release's files live in, for one version. */
export function releaseBaseUrl(source: P4deltaSource, version: string): string {
  return source.mode === 'github'
    ? `https://github.com/${source.repo}/releases/download/v${version}`
    : source.baseUrl
}

export function assetUrl(base: string, name: string): string {
  return `${base}/${name}`
}

/**
 * The version the latest-release document names, parsed and ready to compare.
 * GitHub spells it in the tag (`v0.1.10`), a mirror in its own field
 * (`{"version":"0.1.10"}`); both go through the same strict parser, so a
 * document that is not one — or names something that is not a version — comes
 * back undefined and the caller refuses to act on it.
 */
export function latestVersionFrom(
  source: P4deltaSource,
  json: unknown,
): P4deltaVersion | undefined {
  const raw =
    source.mode === 'github' ? stringField(json, 'tag_name') : stringField(json, 'version')
  return raw === undefined ? undefined : parseP4deltaVersion(raw)
}

function stringField(json: unknown, key: string): string | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const value = (json as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * The lowercase hex digest a `sha256sum` listing records for `assetName`, or
 * undefined when the file does not list it.
 *
 * Handles what real listings carry: CRLF, comment lines, the `*` binary-mode
 * marker, upper-case digests, and `./` path prefixes. A digest that is not 64
 * hex characters is skipped rather than returned — the caller turns "no digest"
 * into a refusal, and a malformed one must not be mistaken for a checked one.
 */
export function parseSha256Sums(text: string, assetName: string): string | undefined {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const spaceAt = line.search(/\s/)
    if (spaceAt <= 0) continue
    const digest = line.slice(0, spaceAt)
    let name = line.slice(spaceAt).trim()
    if (name.startsWith('*')) name = name.slice(1)
    if (name.startsWith('./')) name = name.slice(2)
    if (name !== assetName) continue
    if (!/^[0-9a-f]{64}$/i.test(digest)) continue
    return digest.toLowerCase()
  }
  return undefined
}
