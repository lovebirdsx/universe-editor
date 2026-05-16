/*---------------------------------------------------------------------------------------------
 *  Smoke test: verifies the platform package public API surface is importable.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  Emitter,
  DisposableStore,
  createDecorator,
  InstantiationService,
  ServiceCollection,
  LogLevel,
  NullLogger,
  LifecycleService,
  LifecyclePhase,
  CommandsRegistry,
  MenuRegistry,
  MenuId,
  ConfigurationRegistry,
  ConfigurationService,
} from '../index.js'

describe('platform public API surface', () => {
  it('exports Emitter and DisposableStore from base', () => {
    const store = new DisposableStore()
    const emitter = new Emitter<number>()
    store.add(emitter)
    let last = 0
    emitter.event((n) => (last = n))
    emitter.fire(42)
    expect(last).toBe(42)
    store.dispose()
  })

  it('exports DI container', () => {
    const IFoo = createDecorator<{ value: number }>('foo')
    const services = new ServiceCollection()
    services.set(IFoo, { value: 7 })
    const di = new InstantiationService(services)
    di.invokeFunction((acc) => {
      expect(acc.get(IFoo).value).toBe(7)
    })
    di.dispose()
  })

  it('exports log module', () => {
    const log = new NullLogger(LogLevel.Info)
    expect(() => log.info('ok')).not.toThrow()
    log.dispose()
  })

  it('exports lifecycle service', () => {
    const svc = new LifecycleService()
    expect(svc.phase).toBe(LifecyclePhase.Starting)
    svc.dispose()
  })

  it('exports command registry', () => {
    const d = CommandsRegistry.registerCommand('smoke.cmd', () => 'ok')
    expect(CommandsRegistry.getCommand('smoke.cmd')).toBeDefined()
    d.dispose()
  })

  it('exports menu registry', () => {
    const d = MenuRegistry.addMenuItem(MenuId.CommandPalette, { command: 'smoke.menu' })
    expect(
      MenuRegistry.getMenuItems(MenuId.CommandPalette).some(
        (i) => 'command' in i && i.command === 'smoke.menu',
      ),
    ).toBe(true)
    d.dispose()
  })

  it('exports configuration system', () => {
    const d = ConfigurationRegistry.registerConfiguration({
      id: 'smoke',
      properties: { 'smoke.val': { type: 'string', default: 'x' } },
    })
    const svc = new ConfigurationService()
    expect(svc.get('smoke.val')).toBe('x')
    svc.dispose()
    d.dispose()
  })
})
