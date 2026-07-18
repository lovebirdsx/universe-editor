// electron-builder afterPack 钩子:删掉框架释放到 win-unpacked 根目录、但运行期
// 用不到的大文件。`files: '!...'` 只能排除进 app 包(asar/resources)的内容,管不到
// Electron 框架文件,故必须在这里删(打包后、封 7z 前)。
//
// LICENSES.chromium.html(~8.7MB)是纯法务文本,运行期从不读取。删掉减小净荷,缩短
// 静默更新的 NSIS 安装解压耗时(解压把净荷双写落盘 + Defender 扫描,耗时随字节线性)。
//
// 项目是 ESM("type":"module"),electron-builder 用 require() 加载钩子,故此文件须为 .cjs。
const fs = require('node:fs')
const path = require('node:path')

const REMOVE = ['LICENSES.chromium.html']

exports.default = async function afterPack({ appOutDir }) {
  for (const name of REMOVE) {
    fs.rmSync(path.join(appOutDir, name), { force: true })
  }
}
