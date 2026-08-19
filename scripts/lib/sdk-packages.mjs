/*---------------------------------------------------------------------------------------------
 *  外部 SDK 发布集合清单（目录序 = 发布拓扑序：依赖先于被依赖）。
 *  scripts/ext-packages/publish.mjs 与 scripts/gallery/publish-sdk.mjs 共用；
 *  人读版清单在 docs/development/publishing-sdk.md 的「发布集合」节，改这里要同步改文档。
 *--------------------------------------------------------------------------------------------*/

export const SDK_PACKAGE_DIRS = [
  'packages/extension-api',
  'packages/extension-manifest',
  'packages/extension-packaging',
  'packages/uex',
  'packages/create-extension',
  'packages/e2e-contract',
  'packages/e2e-harness',
]

export const SDK_PACKAGE_SHORT_NAMES = SDK_PACKAGE_DIRS.map((dir) => dir.split('/')[1])

/**
 * 版本耦合表：源包内嵌的版本常量被目标包引用——create-extension 内嵌 extension-api/uex，
 * uex 内嵌 extension-api（见各自 sdkVersions.ts / sdkVersion.ts，由 generate-sdk-versions.mjs 生成）。
 * 源包发布时目标包必须同发，否则目标包 npm 发布物里仍是旧版本常量，无法送达用户。
 * 键 = 源包短名，值 = 引用该源包版本常量的目标包短名列表。
 */
export const SDK_VERSION_COUPLINGS = {
  'extension-api': ['uex', 'create-extension'],
  uex: ['create-extension'],
}
