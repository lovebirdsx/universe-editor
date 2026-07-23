/*---------------------------------------------------------------------------------------------
 *  Tests for LargeFileOptimizationsContribution — verifies the warning prompt
 *  fires only for models Monaco flagged as too large, carries the file name,
 *  and that the force-enable action flips the setting + asks for a reopen.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConfigurationTarget,
  LogLevel,
  NullLogger,
  Severity,
  URI,
  type IConfigurationService,
  type ILoggerService as ILoggerServiceType,
  type INotificationService,
  type INotificationPromptOptions,
  type IPromptChoice,
} from '@universe-editor/platform'

const hoisted = vi.hoisted(() => {
  interface FakeModel {
    isDisposed(): boolean
    isTooLargeForTokenization(): boolean
    getValueLength(): number
    getLineCount(): number
  }
  // Minimal self-contained emitter — vi.hoisted runs before imports resolve,
  // so platform's Emitter is unavailable here.
  const listeners: ((uri: unknown) => void)[] = []
  return {
    models: new Map<string, FakeModel>(),
    event: (listener: (uri: unknown) => void) => {
      listeners.push(listener)
      return { dispose: () => listeners.splice(listeners.indexOf(listener), 1) }
    },
    fire: (uri: unknown) => {
      for (const l of [...listeners]) l(uri)
    },
  }
})
const { models } = hoisted

interface FakeModel {
  isDisposed(): boolean
  isTooLargeForTokenization(): boolean
  getValueLength(): number
  getLineCount(): number
}

vi.mock('../../workbench/editor/monaco/MonacoModelRegistry.js', () => ({
  MonacoModelRegistry: {
    peek: (uri: { toString: () => string }) => hoisted.models.get(uri.toString()),
    onDidAddModel: hoisted.event,
  },
}))

import { LargeFileOptimizationsContribution } from '../LargeFileOptimizationsContribution.js'

function makeModel(tooLarge: boolean): FakeModel {
  return {
    isDisposed: () => false,
    isTooLargeForTokenization: () => tooLarge,
    getValueLength: () => 21 * 1024 * 1024,
    getLineCount: () => 42,
  }
}

interface PromptCall {
  severity: Severity
  message: string
  choices: IPromptChoice[]
  options: INotificationPromptOptions | undefined
}

function makeNotification(): INotificationService & {
  prompts: PromptCall[]
  notified: { severity: Severity; message: string }[]
} {
  const prompts: PromptCall[] = []
  const notified: { severity: Severity; message: string }[] = []
  return {
    prompts,
    notified,
    async prompt(
      severity: Severity,
      message: string,
      choices: IPromptChoice[],
      options?: INotificationPromptOptions,
    ) {
      prompts.push({ severity, message, choices, options })
    },
    notify(opts: { severity: Severity; message: string }) {
      notified.push({ severity: opts.severity, message: opts.message })
      return {
        id: 'n',
        progress: { report() {}, done() {} },
        updateMessage() {},
        updateSeverity() {},
        dispose() {},
      }
    },
  } as unknown as INotificationService & {
    prompts: PromptCall[]
    notified: { severity: Severity; message: string }[]
  }
}

function makeConfiguration(): IConfigurationService & {
  updates: { key: string; value: unknown; target: ConfigurationTarget | undefined }[]
} {
  const updates: { key: string; value: unknown; target: ConfigurationTarget | undefined }[] = []
  return {
    updates,
    update(key: string, value: unknown, target?: ConfigurationTarget) {
      updates.push({ key, value, target })
    },
  } as unknown as IConfigurationService & {
    updates: { key: string; value: unknown; target: ConfigurationTarget | undefined }[]
  }
}

function makeLoggerService(): ILoggerServiceType {
  return {
    _serviceBrand: undefined,
    createLogger: () => new NullLogger(),
    setLevel: () => {},
    getLevel: () => LogLevel.Info,
  }
}

describe('LargeFileOptimizationsContribution', () => {
  let notification: ReturnType<typeof makeNotification>
  let configuration: ReturnType<typeof makeConfiguration>
  let contribution: LargeFileOptimizationsContribution

  beforeEach(() => {
    models.clear()
    notification = makeNotification()
    configuration = makeConfiguration()
    contribution?.dispose()
    contribution = new LargeFileOptimizationsContribution(
      notification,
      configuration,
      makeLoggerService(),
    )
  })

  function fireModel(resource: URI, model: FakeModel | undefined): void {
    if (model) models.set(resource.toString(), model)
    hoisted.fire(resource)
  }

  it('prompts with the file name when the model is too large', () => {
    const resource = URI.parse('file:///ws/logs/huge.log')
    fireModel(resource, makeModel(true))

    expect(notification.prompts).toHaveLength(1)
    const prompt = notification.prompts[0]!
    expect(prompt.severity).toBe(Severity.Info)
    expect(prompt.message).toContain('huge.log')
    expect(prompt.message).toContain('tokenization')
    expect(prompt.choices.map((c) => c.label)).toEqual(['Forcefully Enable Features'])
    expect(prompt.options?.neverShowAgain).toEqual({
      id: 'editor.contrib.largeFileOptimizationsWarner',
    })
  })

  it('stays quiet for regular-size models', () => {
    fireModel(URI.parse('file:///ws/src/small.ts'), makeModel(false))
    expect(notification.prompts).toHaveLength(0)
  })

  it('stays quiet when the model is gone from the registry', () => {
    fireModel(URI.parse('file:///ws/src/gone.ts'), undefined)
    expect(notification.prompts).toHaveLength(0)
  })

  it('force-enable writes the setting and asks for a reopen', () => {
    const resource = URI.parse('file:///ws/huge.json')
    fireModel(resource, makeModel(true))

    notification.prompts[0]!.choices[0]!.run()

    expect(configuration.updates).toEqual([
      { key: 'editor.largeFileOptimizations', value: false, target: ConfigurationTarget.User },
    ])
    expect(notification.notified).toHaveLength(1)
    expect(notification.notified[0]!.severity).toBe(Severity.Info)
    expect(notification.notified[0]!.message).toContain('reopen')
  })

  it('warns again when the model is re-created after disposal', () => {
    const resource = URI.parse('file:///ws/huge.log')
    fireModel(resource, makeModel(true))
    models.delete(resource.toString())
    fireModel(resource, makeModel(true))
    expect(notification.prompts).toHaveLength(2)
  })
})
