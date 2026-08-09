/*---------------------------------------------------------------------------------------------
 *  Tests for the watcher utility transport's process-role registration:
 *  the registry handle must come down on kill() synchronously — on the main
 *  process shutdown path the child's 'exit' event never gets dispatched
 *  before `process.on('exit')` leak reporting runs.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 4321
  killed = false
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  postMessage = vi.fn()
  kill(): void {
    this.killed = true
  }
}

let lastChild: FakeUtilityProcess

vi.mock('electron', () => ({
  utilityProcess: {
    fork: vi.fn(() => {
      lastChild = new FakeUtilityProcess()
      return lastChild
    }),
  },
}))

const { createWatcherUtilityTransportFactory } = await import('../watcherUtilityTransport.js')
const { processRoleRegistry } = await import('../../process/processRoleRegistry.js')

function spawnTransport() {
  const factory = createWatcherUtilityTransportFactory('/fake/watcherHost.js', {
    debug: () => {},
    warn: () => {},
  } as never)
  const transport = factory()
  lastChild.emit('spawn')
  return transport
}

describe('watcherUtilityTransport role registration', () => {
  afterEach(() => {
    // Drain any registration a failed assertion left behind.
    if (processRoleRegistry.snapshot().has(4321)) lastChild.emit('exit', 0)
  })

  it('registers the child pid once spawned', () => {
    const transport = spawnTransport()
    expect(processRoleRegistry.snapshot().get(4321)).toEqual({
      role: 'utility',
      label: 'file-watcher',
    })
    transport.kill()
  })

  it('unregisters synchronously on kill (shutdown path cannot await child exit)', () => {
    const transport = spawnTransport()
    transport.kill()
    expect(lastChild.killed).toBe(true)
    expect(processRoleRegistry.snapshot().has(4321)).toBe(false)
  })

  it('unregisters on child exit', () => {
    spawnTransport()
    lastChild.emit('exit', 0)
    expect(processRoleRegistry.snapshot().has(4321)).toBe(false)
  })

  it('tolerates exit after kill (idempotent dispose)', () => {
    const transport = spawnTransport()
    transport.kill()
    expect(() => lastChild.emit('exit', 0)).not.toThrow()
    expect(processRoleRegistry.snapshot().has(4321)).toBe(false)
  })
})
