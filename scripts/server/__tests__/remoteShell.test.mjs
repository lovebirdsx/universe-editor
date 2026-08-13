import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CMD_SHELL_PROBE,
  buildSshArgs,
  isCmdExeShell,
} from '../remoteShell.mjs'

test('isCmdExeShell：cmd 展开 %comspec% 回显 cmd.exe 路径，其它 shell 原样回显字面量', () => {
  assert.equal(isCmdExeShell('C:\\windows\\system32\\cmd.exe'), true)
  assert.equal(isCmdExeShell('c:\\WINDOWS\\SYSTEM32\\CMD.EXE\r\n'), true)
  assert.equal(isCmdExeShell('C:\\Windows\\SysWOW64\\cmd.exe'), true)
  assert.equal(isCmdExeShell('%comspec%'), false)
  assert.equal(isCmdExeShell('/bin/bash'), false)
  assert.equal(isCmdExeShell(''), false)
  assert.equal(isCmdExeShell(null), false)
  assert.equal(isCmdExeShell(undefined), false)
})

test('CMD_SHELL_PROBE 用 cmd 风格变量展开做判别', () => {
  assert.equal(CMD_SHELL_PROBE, 'echo %comspec%')
})

test('buildSshArgs：非交互一律 -n（stdin=nul 防 Win32-OpenSSH 退出挂起），交互才 -t', () => {
  const base = ['-p', '22', '-i', 'k']
  assert.deepEqual(
    buildSshArgs({ baseArgs: base, remote: 'u@h', command: 'dir /b' }),
    ['-p', '22', '-i', 'k', '-n', 'u@h', 'dir /b'],
  )
  assert.deepEqual(
    buildSshArgs({ baseArgs: base, remote: 'u@h', command: 'sudo bash setup.sh', tty: true }),
    ['-p', '22', '-i', 'k', '-t', 'u@h', 'sudo bash setup.sh'],
  )
  // -n 与 -t 互斥，绝不同时出现
  for (const tty of [true, false]) {
    const args = buildSshArgs({ baseArgs: [], remote: 'u@h', command: 'x', tty })
    assert.equal(args.includes('-n'), !tty)
    assert.equal(args.includes('-t'), tty)
  }
})
