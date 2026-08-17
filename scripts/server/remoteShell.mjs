/*---------------------------------------------------------------------------------------------
 *  开发机侧 ssh 远端执行共用小件：Windows 远端默认 shell 探测 + ssh 非交互参数。
 *  被 deploy.mjs / setupRemote.mjs 共用（两者只跑在开发机）。
 *
 *  为什么不做 cmd/PowerShell 兼容封装：远端命令里带引号的 Windows 路径
 *  （如 --app-dir "C:\a b"）在两种默认 shell 下没有同时存活的写法——实机验证
 *  「cmd /c "..." + 引号翻倍」经 Win32-OpenSSH 送达 cmd 时引号被剥掉（一个词拆成两个），
 *  而裸引号在 PowerShell 下会被拆词。所以远端命令保持 cmd 语法，前置探测默认 shell，
 *  不是 cmd.exe 就立即报错并给修复指引，绝不让其静默解析失败。
 *
 *  另一个坑：Win32-OpenSSH 在继承控制台 stdin 的非交互命令上退出时可能挂起
 *  （close - IO is still pending on closed socket，scp 上是无害告警，ssh 上会整进程
 *  卡死）。非交互调用一律加 -n 让 ssh 从 nul 读 stdin；密码/host-key 确认走 TTY 不受影响。
 *
 *  还有一个坑：ssh -t 下远端 sudo 从 TTY 读密码，Windows 控制台经 spawnSync 继承的
 *  stdin 偶发不转发首次输入——远端 sudo 一直卡在读密码（termios -echo），本地却无任何
 *  输出。所以提权路径不再走 -t，改为本地读密码后经 ssh 的 stdin 管道喂远端 sudo -S
 *  （stdinPipe）：数据经管道可靠传输，不依赖控制台交互；BatchMode=yes 让 host-key
 *  未信任等情况 fail-fast 而非挂起，也不拦 stdin 数据转发。
 *--------------------------------------------------------------------------------------------*/

import { spawnSync } from 'node:child_process'

// cmd 会展开 %comspec% 回显 cmd.exe 路径；其它 shell（PowerShell/bash）原样回显该字面量。
export const CMD_SHELL_PROBE = 'echo %comspec%'

export const CMD_SHELL_FIX_HINT =
  '远端命令按 cmd 语法构造（带引号的路径参数在 cmd 与 PowerShell 两种 shell 间无安全互通写法，不做兼容封装）。\n' +
  "  修复（远端管理员 PowerShell）：New-ItemProperty -Path 'HKLM:\\SOFTWARE\\OpenSSH' " +
  "-Name DefaultShell -Value 'C:\\Windows\\System32\\cmd.exe' -PropertyType String -Force"

export function isCmdExeShell(answer) {
  return typeof answer === 'string' && /\\cmd\.exe\s*$/i.test(answer.trim())
}

// tty=true（Linux sudo 就地输密码）分配 TTY；stdinPipe=true 不加 -t/-n（要转发 stdin 给远端
// sudo -S 读密码），改用 BatchMode=yes 禁用 ssh 层交互（host-key 确认等 fail-fast）；否则 -n
// （stdin=nul），见文件头坑说明。
export function buildSshArgs({ baseArgs, remote, command, tty = false, stdinPipe = false }) {
  if (stdinPipe) return [...baseArgs, '-o', 'BatchMode=yes', remote, command]
  return [...baseArgs, tty ? '-t' : '-n', remote, command]
}

// 探测远端默认 shell 的回显；ssh 本身失败（不可达/拒连）返回 null。
export function probeRemoteShellAnswer({ baseArgs, remote, timeoutMs = 15000 }) {
  const res = spawnSync('ssh', buildSshArgs({ baseArgs, remote, command: CMD_SHELL_PROBE }), {
    encoding: 'utf8',
    timeout: timeoutMs,
  })
  if (res.error || res.status !== 0) return null
  return (res.stdout ?? '').trim()
}
