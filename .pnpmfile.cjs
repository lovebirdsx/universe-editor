// @vscode/windows-process-tree 是 Windows-only 原生模块：install 脚本为 node-gyp rebuild，
// tarball 还自带 binding.gyp，pnpm 会据此自动重建（readPackage 删不掉该文件）。非 win32 平台
// 把该包在 allowBuilds 显式置 false 跳过构建（免 build-essential），运行时由 processList.ts 的 win32 守卫隔离。
module.exports = {
  hooks: {
    updateConfig(config) {
      if (process.platform !== 'win32') {
        config.allowBuilds = config.allowBuilds ?? {}
        config.allowBuilds['@vscode/windows-process-tree'] = false
      }
      return config
    },
  },
}
