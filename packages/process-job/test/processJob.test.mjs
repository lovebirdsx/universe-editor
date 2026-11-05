// 真实 Job Object 行为测试（仅 win32 且 addon 已构建时运行）：
// 嵌套在 libuv 全局 job 之下、孙进程继承、terminate、句柄关闭即杀、父进程被强杀后整棵树消失。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const addonPath = join(root, 'build', 'Release', 'process_job.node')
const runnable = process.platform === 'win32' && existsSync(addonPath)
const addon = runnable ? createRequire(import.meta.url)(addonPath) : undefined

const SLEEPER = 'setInterval(() => {}, 1000)'
// 等 stdin 的 "go" 再生孙进程：保证测试先把本进程 assign 进 job，孙进程才会继承。
const PARENT_WITH_GRANDCHILD = `
  const { spawn } = require('node:child_process')
  process.stdin.once('data', () => {
    const g = spawn(process.execPath, ['-e', ${JSON.stringify(SLEEPER)}], { stdio: 'ignore' })
    process.stdout.write('grandchild=' + g.pid + '\\n')
  })
  setInterval(() => {}, 1000)
`

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return predicate()
}

function spawnNode(script) {
  return spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'inherit'] })
}

function readLine(child, prefix) {
  return new Promise((resolve, reject) => {
    let buf = ''
    child.stdout.on('data', (d) => {
      buf += d
      const m = new RegExp(`${prefix}=(\\d+)`).exec(buf)
      if (m) resolve(Number(m[1]))
    })
    child.once('exit', () => reject(new Error(`exited before printing ${prefix}`)))
  })
}

describe('process_job addon', { skip: !runnable && 'win32 + built addon only' }, () => {
  it('assigns a spawned child (already in the inherited launch job) and terminates it', async () => {
    const job = addon.createJob()
    const child = spawnNode(SLEEPER)
    try {
      assert.equal(addon.assign(job, child.pid), 0)
      assert.deepEqual(addon.listPids(job), [child.pid])
      const exited = new Promise((resolve) => child.once('exit', resolve))
      assert.equal(addon.terminate(job, 1), true)
      await exited
    } finally {
      addon.close(job)
      child.kill()
    }
  })

  it('keeps sibling children in separate jobs (one tree per job)', async () => {
    // Windows only lets a process that is already in a job join an EMPTY job (or one in
    // its own job hierarchy). Children inherit the runner's job, so the registry gives
    // every tree a fresh job; this is the OS behaviour that requires it.
    const jobA = addon.createJob()
    const jobB = addon.createJob()
    const a = spawnNode(SLEEPER)
    const b = spawnNode(SLEEPER)
    try {
      assert.equal(addon.assign(jobA, a.pid), 0)
      assert.equal(addon.assign(jobB, b.pid), 0)
      assert.deepEqual(addon.listPids(jobA), [a.pid])
      assert.deepEqual(addon.listPids(jobB), [b.pid])
    } finally {
      addon.close(jobA)
      addon.close(jobB)
      a.kill()
      b.kill()
    }
  })

  it('keeps grandchildren in the job (no breakaway) and kills the whole tree', async () => {
    const job = addon.createJob()
    const parent = spawnNode(PARENT_WITH_GRANDCHILD)
    let grandchild
    try {
      assert.equal(addon.assign(job, parent.pid), 0)
      const gp = readLine(parent, 'grandchild')
      parent.stdin.write('go\n')
      grandchild = await gp
      assert.ok(await waitUntil(() => addon.listPids(job).includes(grandchild)))
      assert.equal(addon.terminate(job, 1), true)
      assert.ok(await waitUntil(() => !isAlive(parent.pid) && !isAlive(grandchild)))
    } finally {
      addon.close(job)
      parent.kill()
      if (grandchild) {
        try {
          process.kill(grandchild)
        } catch {}
      }
    }
  })

  it('closing the last job handle kills members (KILL_ON_JOB_CLOSE)', async () => {
    const job = addon.createJob()
    const child = spawnNode(SLEEPER)
    assert.equal(addon.assign(job, child.pid), 0)
    assert.equal(addon.close(job), true)
    assert.ok(await waitUntil(() => !isAlive(child.pid)))
  })

  it('reports a child that exited before assign as aborted, not as access denied', () => {
    // 短命子进程（ripgrep）常在 assign 前就退出。libuv 在事件循环处理 exit 前仍持有句柄，
    // 进程处于僵尸态：AssignProcessToJobObject 对它返回 ACCESS_DENIED。
    const job = addon.createJob()
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20)'], { stdio: 'ignore' })
    try {
      const until = Date.now() + 300
      while (Date.now() < until) {} // 阻塞事件循环，让子进程退出但句柄不被回收
      assert.equal(addon.assign(job, child.pid), 1067) // ERROR_PROCESS_ABORTED
    } finally {
      addon.close(job)
    }
  })

  it('refuses to contain the calling process and reports missing pids', () => {
    const job = addon.createJob()
    try {
      assert.equal(addon.assign(job, process.pid), -1)
      assert.notEqual(addon.assign(job, 0x7ffffff0), 0)
    } finally {
      addon.close(job)
    }
  })

  it('kills the whole tree when the owning process is force-killed', async () => {
    // 控制进程创建 job、把子进程放进去、再让孙进程出生，然后被测试强杀（等价 main 崩溃）。
    const controller = spawnNode(`
      const { spawn } = require('node:child_process')
      const addon = require(${JSON.stringify(addonPath)})
      const job = addon.createJob()
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(PARENT_WITH_GRANDCHILD)}], { stdio: ['pipe', 'pipe', 'inherit'] })
      addon.assign(job, child.pid)
      process.stdout.write('child=' + child.pid + '\\n')
      child.stdout.on('data', (d) => process.stdout.write(d))
      child.stdin.write('go\\n')
      setInterval(() => {}, 1000)
    `)
    let childPid
    let grandchildPid
    try {
      childPid = await readLine(controller, 'child')
      grandchildPid = await readLine(controller, 'grandchild')
      assert.ok(isAlive(childPid) && isAlive(grandchildPid))
      process.kill(controller.pid, 'SIGKILL')
      assert.ok(
        await waitUntil(() => !isAlive(childPid) && !isAlive(grandchildPid)),
        'child tree must die with its owner',
      )
    } finally {
      for (const pid of [controller.pid, childPid, grandchildPid]) {
        if (pid && isAlive(pid)) {
          try {
            process.kill(pid)
          } catch {}
        }
      }
    }
  })
})
