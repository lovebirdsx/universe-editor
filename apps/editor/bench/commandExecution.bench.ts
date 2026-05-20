import { bench, describe, beforeAll } from 'vitest'
import {
  CommandsRegistry,
  InstantiationService,
  NoopTelemetryService,
  ServiceCollection,
  IInstantiationService,
  ITelemetryService,
} from '@universe-editor/platform'
import { CommandService } from '../src/renderer/workbench/CommandService.js'

let commandService: CommandService

beforeAll(() => {
  const services = new ServiceCollection()
  const telemetry = new NoopTelemetryService()
  services.set(ITelemetryService, telemetry)
  const instantiation = new InstantiationService(services)
  services.set(IInstantiationService, instantiation)

  commandService = new CommandService(instantiation, telemetry)

  // Register a cheap no-op command used only in benchmarks
  CommandsRegistry.registerCommand('bench.noop', (_accessor) => undefined)
})

describe('commandExecution', () => {
  bench('executeCommand single invocation (with telemetry noop)', async () => {
    await commandService.executeCommand('bench.noop')
  })

  bench('executeCommand 100 invocations', async () => {
    for (let i = 0; i < 100; i++) {
      await commandService.executeCommand('bench.noop')
    }
  })
})
