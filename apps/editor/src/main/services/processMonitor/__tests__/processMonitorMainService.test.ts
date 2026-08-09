import { describe, expect, it } from 'vitest'
import { ProcessRoleRegistry } from '../../process/processRoleRegistry.js'
import type { ProcessItem } from '../processList.js'
import { ProcessMonitorMainService } from '../processMonitorMainService.js'

function fakeTree(): ProcessItem {
  return {
    name: 'main',
    cmd: 'electron .',
    pid: process.pid,
    ppid: 1,
    load: 3,
    mem: 100 * 1024 * 1024,
    children: [
      { name: 'window', cmd: '--type=renderer', pid: 4242, ppid: process.pid, load: 1, mem: 50 },
    ],
  }
}

describe('ProcessMonitorMainService', () => {
  it('registers the main pid role and unregisters on dispose', () => {
    const registry = new ProcessRoleRegistry()
    const service = new ProcessMonitorMainService(registry)
    expect(registry.snapshot().get(process.pid)?.role).toBe('main')
    service.dispose()
    expect(registry.snapshot().has(process.pid)).toBe(false)
  })

  it('returns the collected tree with registry roles applied', async () => {
    const registry = new ProcessRoleRegistry()
    const service = new ProcessMonitorMainService(registry, {
      listProcesses: async (rootPid, roles) => {
        expect(rootPid).toBe(process.pid)
        expect(roles.get(process.pid)?.role).toBe('main')
        return fakeTree()
      },
    })
    const snapshot = await service.resolveProcesses()
    expect(snapshot.errorMessage).toBeUndefined()
    expect(snapshot.root.pid).toBe(process.pid)
    expect(snapshot.root.children?.[0]?.pid).toBe(4242)
    service.dispose()
  })

  it('degrades to a main-only snapshot with errorMessage when collection fails', async () => {
    const registry = new ProcessRoleRegistry()
    const service = new ProcessMonitorMainService(registry, {
      listProcesses: async () => {
        throw new Error('ps boom')
      },
    })
    const snapshot = await service.resolveProcesses()
    expect(snapshot.errorMessage).toContain('ps boom')
    expect(snapshot.root.name).toBe('main')
    expect(snapshot.root.pid).toBe(process.pid)
    expect(snapshot.root.children).toBeUndefined()
    service.dispose()
  })

  it('refuses to kill the main process', async () => {
    const service = new ProcessMonitorMainService(new ProcessRoleRegistry())
    await expect(service.killProcess(process.pid)).rejects.toThrow('refusing to kill main process')
    service.dispose()
  })

  it('passes the signal through to process.kill', async () => {
    const calls: [number, string | undefined][] = []
    const service = new ProcessMonitorMainService(new ProcessRoleRegistry(), {
      kill: (pid, signal) => {
        calls.push([pid, signal])
      },
    })
    await service.killProcess(4242)
    await service.killProcess(4243, 'SIGKILL')
    expect(calls).toEqual([
      [4242, 'SIGTERM'],
      [4243, 'SIGKILL'],
    ])
    service.dispose()
  })

  it('propagates kill failures as rejection', async () => {
    const service = new ProcessMonitorMainService(new ProcessRoleRegistry(), {
      kill: () => {
        throw new Error('ESRCH')
      },
    })
    await expect(service.killProcess(4242)).rejects.toThrow('ESRCH')
    service.dispose()
  })

  it('formats the tree, prefixing the error line when degraded', async () => {
    const registry = new ProcessRoleRegistry()
    const ok = new ProcessMonitorMainService(registry, {
      listProcesses: async () => fakeTree(),
    })
    const okText = await ok.formatProcessList()
    expect(okText.startsWith('CPU %')).toBe(true)
    expect(okText).not.toContain('(!)')
    ok.dispose()

    const degraded = new ProcessMonitorMainService(registry, {
      listProcesses: async () => {
        throw new Error('ps boom')
      },
    })
    const degradedText = await degraded.formatProcessList()
    expect(degradedText.startsWith('(!) Error: ps boom\n')).toBe(true)
    degraded.dispose()
  })
})
