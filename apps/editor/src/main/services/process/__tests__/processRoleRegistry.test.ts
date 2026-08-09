import { describe, expect, it } from 'vitest'
import { ProcessRoleRegistry } from '../processRoleRegistry.js'

describe('ProcessRoleRegistry', () => {
  it('register 后 snapshot 可见，含 role 与 label', () => {
    const registry = new ProcessRoleRegistry()
    registry.register(100, { role: 'pty', label: 'pwsh.exe' })
    registry.register(200, { role: 'window' })
    expect(registry.snapshot().get(100)).toEqual({ role: 'pty', label: 'pwsh.exe' })
    expect(registry.snapshot().get(200)).toEqual({ role: 'window' })
  })

  it('dispose 后 snapshot 移除', () => {
    const registry = new ProcessRoleRegistry()
    const handle = registry.register(100, { role: 'pty' })
    handle.dispose()
    expect(registry.snapshot().has(100)).toBe(false)
  })

  it('dispose 幂等', () => {
    const registry = new ProcessRoleRegistry()
    const handle = registry.register(100, { role: 'pty' })
    handle.dispose()
    handle.dispose()
    expect(registry.snapshot().size).toBe(0)
  })

  it('同 pid 重登记者覆盖，旧句柄 dispose 不误删新登记', () => {
    const registry = new ProcessRoleRegistry()
    const old = registry.register(100, { role: 'pty', label: 'old' })
    registry.register(100, { role: 'utility', label: 'new' })
    old.dispose()
    expect(registry.snapshot().get(100)).toEqual({ role: 'utility', label: 'new' })
  })

  it('同 pid 新登记 dispose 后正常移除', () => {
    const registry = new ProcessRoleRegistry()
    const old = registry.register(100, { role: 'pty' })
    const next = registry.register(100, { role: 'utility' })
    old.dispose()
    next.dispose()
    expect(registry.snapshot().has(100)).toBe(false)
  })

  it('snapshot 返回副本，外部修改不影响内部状态', () => {
    const registry = new ProcessRoleRegistry()
    registry.register(100, { role: 'pty' })
    const snapshot = registry.snapshot() as Map<number, { role: string }>
    snapshot.delete(100)
    expect(registry.snapshot().has(100)).toBe(true)
  })
})
