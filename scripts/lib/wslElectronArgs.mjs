/*---------------------------------------------------------------------------------------------
 *  WSLg dev 环境下的 Electron Wayland 注入。
 *
 *  背景：WSLg 的 RDP 层会吃掉宿主的 DPI 缩放（宿主机 125% 时 weston 对 Linux 应用
 *  报告 scale=1，分辨率也是缩放后的有效值）。Electron 默认走 X11/XWayland，X11 无
 *  DPI 概念，Chromium 按 scale=1 低分辨率渲染再被合成器拉伸——表现为窗口比宿主
 *  应用小、整体模糊。改走原生 Wayland 后端后，Chromium 经 fractional-scale 协议
 *  拿到宿主真实缩放，尺寸与清晰度恢复正常。
 *
 *  用法（dev.mjs / dev-run.mjs 共用，须在 loadEnv() 之后调用）:
 *    import { wslElectronArgs } from '../../../scripts/lib/wslElectronArgs.mjs'
 *    const wsl = wslElectronArgs()
 *    // wsl.active → 把 wsl.args 拼进 electron 的 argv
 *
 *  逃生口：UNIVERSE_WSL_WAYLAND=0 强制关闭（shell 或 .env.local 均可）。
 *  Windows / macOS / 原生 Linux 恒不生效。
 *--------------------------------------------------------------------------------------------*/

export const WSL_WAYLAND_ARGS = [
  '--ozone-platform=wayland',
  '--enable-features=WaylandWindowDecorations',
]

export function wslElectronArgs({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'linux') return { active: false, args: [], reason: 'not linux' }
  if (env.UNIVERSE_WSL_WAYLAND === '0') {
    return { active: false, args: [], reason: 'UNIVERSE_WSL_WAYLAND=0' }
  }
  if (!env.WSL_DISTRO_NAME && !env.WSL_INTEROP) return { active: false, args: [], reason: 'not WSL' }
  // 没有 Wayland 合成器时（headless WSL / SSH 会话）传 wayland flag 会启动即失败
  if (!env.WAYLAND_DISPLAY) {
    return { active: false, args: [], reason: 'WSL but no WAYLAND_DISPLAY' }
  }
  return { active: true, args: WSL_WAYLAND_ARGS, reason: `WAYLAND_DISPLAY=${env.WAYLAND_DISPLAY}` }
}
