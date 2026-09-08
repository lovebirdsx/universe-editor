export type EditorBundleTarget = 'main' | 'renderer'
export type EditorBundleMode = 'src' | 'dist'

export interface EditorBundlePackage {
  pkg: string
  main?: EditorBundleMode
  renderer?: EditorBundleMode
}

export const EDITOR_BUNDLE_PACKAGES: EditorBundlePackage[]

export function pkgShortFor(entry: EditorBundlePackage): string
export function pkgDirFor(entry: EditorBundlePackage): string
export function srcDirFor(entry: EditorBundlePackage): string
export function distDirFor(entry: EditorBundlePackage): string
export function modeFor(
  entry: EditorBundlePackage,
  target: EditorBundleTarget,
): EditorBundleMode | undefined
export function inputDirFor(entry: EditorBundlePackage, target: EditorBundleTarget): string
export function inputDirsFor(target: EditorBundleTarget): string[]
export function aliasMapFor(target: EditorBundleTarget): Record<string, string>
export function externExcludesFor(target: EditorBundleTarget): string[]
export function optimizeExcludesFor(target: EditorBundleTarget): string[]
export function packagesRequiringDist(): EditorBundlePackage[]
export function tokensCssFile(): string
