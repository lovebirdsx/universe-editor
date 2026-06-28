import { describe, expect, it } from 'vitest'
import type { IMainThreadCommands } from '@universe-editor/extensions-common'
import { ExtensionCommandRegistry } from '../commandRegistry.js'

function recording(): {
  impl: IMainThreadCommands
  registered: string[]
  unregistered: string[]
  executed: Array<{ id: string; args: unknown[] }>
} {
  const registered: string[] = []
  const unregistered: string[] = []
  const executed: Array<{ id: string; args: unknown[] }> = []
  return {
    registered,
    unregistered,
    executed,
    impl: {
      $registerCommand: (id) => {
        registered.push(id)
        return Promise.resolve()
      },
      $unregisterCommand: (id) => {
        unregistered.push(id)
        return Promise.resolve()
      },
      $executeCommand: (id, args) => {
        executed.push({ id, args })
        return Promise.resolve(`forwarded:${id}`)
      },
    },
  }
}

describe('ExtensionCommandRegistry', () => {
  it('registers a command and runs its handler locally', async () => {
    const mt = recording()
    const reg = new ExtensionCommandRegistry(mt.impl)
    reg.register('test.cmd', (...args) => `ran:${args.join('|')}`)
    expect(mt.registered).toEqual(['test.cmd'])
    await expect(reg.execute('test.cmd', ['a', 'b'])).resolves.toBe('ran:a|b')
    expect(mt.executed).toEqual([])
  })

  it('rejects a duplicate registration', () => {
    const mt = recording()
    const reg = new ExtensionCommandRegistry(mt.impl)
    reg.register('dup', () => 1)
    expect(() => reg.register('dup', () => 2)).toThrow(/already registered/)
  })

  it('unregisters on dispose, allowing re-registration', () => {
    const mt = recording()
    const reg = new ExtensionCommandRegistry(mt.impl)
    const d = reg.register('x', () => 1)
    d.dispose()
    expect(mt.unregistered).toEqual(['x'])
    expect(() => reg.register('x', () => 2)).not.toThrow()
  })

  it('forwards an unknown command to the renderer', async () => {
    const mt = recording()
    const reg = new ExtensionCommandRegistry(mt.impl)
    await expect(reg.execute('_workbench.openDiff', [{ x: 1 }])).resolves.toBe(
      'forwarded:_workbench.openDiff',
    )
    expect(mt.executed).toEqual([{ id: '_workbench.openDiff', args: [{ x: 1 }] }])
  })
})
