/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/lifecycle/lifecycleService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  LifecyclePhase,
  LifecycleService,
  ShutdownReason,
  runWhenPhase,
} from '../../lifecycle/lifecycleService.js'

describe('LifecycleService', () => {
  it('starts at Starting phase', () => {
    const svc = new LifecycleService()
    expect(svc.phase).toBe(LifecyclePhase.Starting)
  })

  it('when(Starting) resolves immediately', async () => {
    const svc = new LifecycleService()
    let resolved = false
    await svc.when(LifecyclePhase.Starting).then(() => (resolved = true))
    expect(resolved).toBe(true)
  })

  it('advances phases monotonically', async () => {
    const svc = new LifecycleService()
    svc.setPhase(LifecyclePhase.Ready)
    expect(svc.phase).toBe(LifecyclePhase.Ready)

    svc.setPhase(LifecyclePhase.Restored)
    expect(svc.phase).toBe(LifecyclePhase.Restored)

    svc.setPhase(LifecyclePhase.Eventually)
    expect(svc.phase).toBe(LifecyclePhase.Eventually)
  })

  it('when(Ready) resolves after setPhase(Ready)', async () => {
    const svc = new LifecycleService()
    let resolved = false
    const p = svc.when(LifecyclePhase.Ready).then(() => (resolved = true))
    expect(resolved).toBe(false)
    svc.setPhase(LifecyclePhase.Ready)
    await p
    expect(resolved).toBe(true)
  })

  it('when() resolves immediately if phase has already passed', async () => {
    const svc = new LifecycleService()
    svc.setPhase(LifecyclePhase.Restored)
    let resolved = false
    await svc.when(LifecyclePhase.Ready).then(() => (resolved = true))
    expect(resolved).toBe(true)
  })

  it('setPhase is a no-op for same or lower phase', () => {
    const svc = new LifecycleService()
    svc.setPhase(LifecyclePhase.Ready)
    expect(() => svc.setPhase(LifecyclePhase.Starting)).not.toThrow()
    expect(svc.phase).toBe(LifecyclePhase.Ready)
  })

  it('onBeforeShutdown fires during shutdown()', async () => {
    const svc = new LifecycleService()
    let fired = false
    svc.onBeforeShutdown(() => {
      fired = true
    })
    await svc.shutdown(ShutdownReason.Quit)
    expect(fired).toBe(true)
  })

  it('passes the shutdown reason to onBeforeShutdown listeners', async () => {
    const svc = new LifecycleService()
    let seen: ShutdownReason | undefined
    svc.onBeforeShutdown((e) => {
      seen = e.reason
    })
    await svc.shutdown(ShutdownReason.SwitchWorkspace)
    expect(seen).toBe(ShutdownReason.SwitchWorkspace)
  })

  it('passes shutdown confirmation context to participants', async () => {
    const svc = new LifecycleService()
    let runningSessionCount: number | undefined
    svc.onBeforeShutdown((e) => {
      runningSessionCount = e.context?.runningSessionCount
    })

    await svc.confirmBeforeShutdown(ShutdownReason.Quit, { runningSessionCount: 2 })

    expect(runningSessionCount).toBe(2)
  })

  it('shutdown() returns whether it was vetoed', async () => {
    const svc = new LifecycleService()
    svc.onBeforeShutdown((e) => e.veto(true, 'test'))
    expect(await svc.shutdown(ShutdownReason.Quit)).toBe(true)

    const svc2 = new LifecycleService()
    expect(await svc2.shutdown(ShutdownReason.Quit)).toBe(false)
  })

  it('confirmBeforeShutdown does not fire onWillShutdown', async () => {
    const svc = new LifecycleService()
    let willShutdownFired = false
    svc.onWillShutdown(() => {
      willShutdownFired = true
    })
    const vetoed = await svc.confirmBeforeShutdown(ShutdownReason.SwitchWorkspace)
    expect(vetoed).toBe(false)
    expect(willShutdownFired).toBe(false)
  })

  it('confirmBeforeShutdown returns true when vetoed', async () => {
    const svc = new LifecycleService()
    svc.onBeforeShutdown((e) => e.veto(true, 'busy'))
    expect(await svc.confirmBeforeShutdown(ShutdownReason.CloseWindow)).toBe(true)
  })

  it('veto(true) prevents shutdown', async () => {
    const svc = new LifecycleService()
    let willShutdownFired = false

    svc.onBeforeShutdown((e) => e.veto(true, 'test'))
    svc.onWillShutdown(() => {
      willShutdownFired = true
    })

    await svc.shutdown(ShutdownReason.Quit)
    expect(willShutdownFired).toBe(false)
  })

  it('veto(false) does not prevent shutdown', async () => {
    const svc = new LifecycleService()
    let willShutdownFired = false

    svc.onBeforeShutdown((e) => e.veto(false, 'test'))
    svc.onWillShutdown(() => {
      willShutdownFired = true
    })

    await svc.shutdown(ShutdownReason.Quit)
    expect(willShutdownFired).toBe(true)
  })

  it('async veto(Promise<true>) prevents shutdown', async () => {
    const svc = new LifecycleService()
    let willShutdownFired = false

    svc.onBeforeShutdown((e) => e.veto(Promise.resolve(true), 'async-veto'))
    svc.onWillShutdown(() => {
      willShutdownFired = true
    })

    await svc.shutdown(ShutdownReason.Quit)
    expect(willShutdownFired).toBe(false)
  })

  it('onWillShutdown join() is awaited before resolve', async () => {
    const svc = new LifecycleService()
    let joinDone = false

    svc.onWillShutdown((e) => {
      e.join(
        new Promise<void>((resolve) =>
          setTimeout(() => {
            joinDone = true
            resolve()
          }, 10),
        ),
        'test-join',
      )
    })

    await svc.shutdown(ShutdownReason.Quit)
    expect(joinDone).toBe(true)
  })
})

describe('runWhenPhase', () => {
  it('runs fn when phase is reached', async () => {
    const svc = new LifecycleService()
    let ran = false
    runWhenPhase(svc, LifecyclePhase.Ready, () => (ran = true))
    expect(ran).toBe(false)
    svc.setPhase(LifecyclePhase.Ready)
    await Promise.resolve() // flush microtasks
    expect(ran).toBe(true)
  })

  it('does not run if disposed before phase is reached', async () => {
    const svc = new LifecycleService()
    let ran = false
    const d = runWhenPhase(svc, LifecyclePhase.Ready, () => (ran = true))
    d.dispose()
    svc.setPhase(LifecyclePhase.Ready)
    await Promise.resolve()
    expect(ran).toBe(false)
  })
})
