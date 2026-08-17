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
]

export const SDK_PACKAGE_SHORT_NAMES = SDK_PACKAGE_DIRS.map((dir) => dir.split('/')[1])
