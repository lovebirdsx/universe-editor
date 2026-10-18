/**
 * p4delta version parsing and ordering — the numbers behind "is the upstream
 * release newer than the copy on disk?" and "is the build at this path one this
 * extension can drive?".
 *
 * Deliberately strict: a version is exactly `[v]MAJOR.MINOR.PATCH`, with no
 * pre-release or build suffix. The inputs are the places upstream spells a
 * version (a release tag like `v0.1.10`, a mirror's `latest.json`) and the
 * engine's own `--version` banner; anything else means we are not looking at
 * what we think we are, and the caller must refuse to act on it rather than
 * guess an ordering from it.
 *
 * The admission floor lives here too ({@link P4DELTA_MIN_VERSION}) so the gate
 * and the managed store compare against the same number.
 */
export type P4deltaVersion = readonly [number, number, number]

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/

/**
 * The oldest p4delta this build drives. Admission is fail-closed: a build that
 * reports anything lower — or nothing readable at all — is refused and the
 * session stays on native p4 (`resolveP4deltaEngine`). Raise this only when the
 * extension starts relying on behavior a newer release introduced.
 */
export const P4DELTA_MIN_VERSION: P4deltaVersion = [0, 1, 19]

/** `'v0.1.10'` / `'0.1.10'` → `[0, 1, 10]`; anything else → undefined. */
export function parseP4deltaVersion(text: string): P4deltaVersion | undefined {
  const match = VERSION_RE.exec(text.trim())
  if (match === null) return undefined
  return [Number(match[1]!), Number(match[2]!), Number(match[3]!)]
}

/** The spelling every on-disk name uses: `<version>/` directories and `.active`. */
export function formatP4deltaVersion(version: P4deltaVersion): string {
  return `${version[0]}.${version[1]}.${version[2]}`
}

/**
 * `p4delta --version` 的 clap banner（`p4delta 0.1.6`）→ `'0.1.6'`。只服务**诊断显示**
 * （命令「显示 p4delta 信息」）；引擎准入用下面的严格版。
 */
export function parseP4deltaVersionBanner(text: string): string | undefined {
  return /v?(\d+\.\d+\.\d+)/.exec(text)?.[1]
}

/**
 * 准入用：行首必须是 `p4delta`，后接 semver，且该行到词尾为止不能再有别的内容。锚定行首
 * 是为了让「配置路径指向了别的工具」不能靠恰好打印一个版本号混过去；没有 banner →
 * undefined（调用方 fail-closed）。预发布 / 构建后缀（`0.1.19-rc1`、`0.1.19+build.1`）按
 * 它命名的版本算，与历史门槛一致；`0.1.19junk`、`0.1.19.5` 这类不算。
 */
export function parseP4deltaVersionBannerStrict(text: string): P4deltaVersion | undefined {
  const match = /^p4delta[ \t]+v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?[ \t\r]*$/m.exec(text)
  if (match === null) return undefined
  return [Number(match[1]!), Number(match[2]!), Number(match[3]!)]
}

/** Standard semantic ordering; `0` means equal. */
export function compareP4deltaVersion(a: P4deltaVersion, b: P4deltaVersion): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1
  if (a[2] !== b[2]) return a[2] < b[2] ? -1 : 1
  return 0
}
