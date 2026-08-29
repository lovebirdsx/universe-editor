/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the one-time session-title hints: the "no model configured" Info
 *  notification that deep-links to the session-title model picker, and the
 *  "output limit" Warning notification that deep-links to AI Settings. Both are
 *  gated by a GLOBAL storage flag written before the toast fires.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AiError,
  AiErrorCode,
  Event,
  LogLevel,
  NullLogger,
  Severity,
  StorageScope,
  observableValue,
} from '@universe-editor/platform'
import type {
  AiModelMetadata,
  IAiModelService,
  ICommandService,
  ILogger,
  ILoggerService,
  INotification,
  INotificationHandle,
  INotificationService,
  IObservable,
  IPromptChoice,
  IStorageService,
} from '@universe-editor/platform'
import { AcpSessionTitleService } from '../acpSessionTitleService.js'

const NO_MODEL_HINT_KEY = 'acp.sessionTitle.noModelHintShown'
const OUTPUT_LIMIT_HINT_KEY = 'acp.sessionTitle.outputLimitHintShown'

class StubStorageService implements IStorageService {
  declare readonly _serviceBrand: undefined
  readonly values = new Map<string, unknown>()
  readonly onDidChangeWorkspaceScope = Event.None
  failReads = false
  async get<T>(key: string, _scope?: StorageScope): Promise<T | undefined> {
    if (this.failReads) throw new Error('storage unavailable')
    return this.values.get(key) as T | undefined
  }
  async set(key: string, value: unknown, _scope?: StorageScope): Promise<void> {
    this.values.set(key, value)
  }
  async remove(key: string, _scope?: StorageScope): Promise<void> {
    this.values.delete(key)
  }
}

function stubNotificationHandle(): INotificationHandle {
  return {
    id: 'stub-handle',
    progress: { report: () => {}, done: () => {} },
    updateMessage: () => {},
    updateSeverity: () => {},
    dispose: () => {},
  }
}

class StubNotificationService implements INotificationService {
  declare readonly _serviceBrand: undefined
  readonly notifications: IObservable<readonly INotification[]> = observableValue(
    'stub.notifications',
    [] as readonly INotification[],
  )
  readonly unreadCount: IObservable<number> = observableValue('stub.unreadCount', 0)
  readonly centerVisible: IObservable<boolean> = observableValue('stub.centerVisible', false)
  readonly notified: {
    severity: Severity
    message: string
    actions: IPromptChoice[] | undefined
  }[] = []
  notify(opts: {
    severity: Severity
    message: string
    actions?: IPromptChoice[]
  }): INotificationHandle {
    this.notified.push({ severity: opts.severity, message: opts.message, actions: opts.actions })
    return stubNotificationHandle()
  }
  async prompt(): Promise<void> {}
  status(): INotificationHandle {
    return stubNotificationHandle()
  }
  dismiss(): void {}
  cancelProgress(): void {}
  clearAll(): void {}
  toggleCenter(): void {}
  markAllAsRead(): void {}
}

class StubLoggerService implements ILoggerService {
  declare readonly _serviceBrand: undefined
  createLogger(): ILogger {
    return new NullLogger()
  }
  setLevel(): void {}
  getLevel(): LogLevel {
    return LogLevel.Info
  }
}

function stubAiModel(options: {
  sessionTitleModelId?: string
  models?: readonly AiModelMetadata[]
}): IAiModelService {
  return {
    getSessionTitleModelId: vi.fn(async () => options.sessionTitleModelId),
    getModels: vi.fn(async () => options.models ?? []),
  } as unknown as IAiModelService
}

let storage: StubStorageService
let notification: StubNotificationService
let executeCommand: ReturnType<typeof vi.fn>
let aiModel: IAiModelService

function makeService(): AcpSessionTitleService {
  return new AcpSessionTitleService(aiModel, new StubLoggerService(), notification, storage, {
    executeCommand,
  } as unknown as ICommandService)
}

beforeEach(() => {
  storage = new StubStorageService()
  notification = new StubNotificationService()
  executeCommand = vi.fn(async () => undefined)
  aiModel = stubAiModel({})
})

describe('AcpSessionTitleService no-model hint', () => {
  it('notifies once and persists the flag when no session-title model is configured', async () => {
    const service = makeService()
    const title = await service.generateTitle('hello', 'hi')
    expect(title).toBeUndefined()
    expect(notification.notified).toHaveLength(1)
    expect(notification.notified[0]?.severity).toBe(Severity.Info)
    expect(await storage.get<boolean>(NO_MODEL_HINT_KEY, StorageScope.GLOBAL)).toBe(true)
  })

  it('stays silent when the hint was already shown', async () => {
    await storage.set(NO_MODEL_HINT_KEY, true, StorageScope.GLOBAL)
    const service = makeService()
    await service.generateTitle('hello', 'hi')
    expect(notification.notified).toHaveLength(0)
  })

  it('shows the hint only once across repeated re-armed attempts', async () => {
    const service = makeService()
    await service.generateTitle('first prompt', '')
    await service.generateTitle('second prompt', '')
    expect(notification.notified).toHaveLength(1)
  })

  it('routes the notification action to ai.sessionTitle.pickModel', async () => {
    const service = makeService()
    await service.generateTitle('hello', 'hi')
    const action = notification.notified[0]?.actions?.[0]
    expect(action).toBeDefined()
    action?.run()
    expect(executeCommand).toHaveBeenCalledWith('ai.sessionTitle.pickModel')
  })

  it('does not hint when a model is configured but not in the available list', async () => {
    aiModel = stubAiModel({ sessionTitleModelId: 'chat/missing-model', models: [] })
    const service = makeService()
    const title = await service.generateTitle('hello', 'hi')
    expect(title).toBeUndefined()
    expect(notification.notified).toHaveLength(0)
  })

  it('keeps generateTitle best-effort when storage reads fail', async () => {
    storage.failReads = true
    const service = makeService()
    await expect(service.generateTitle('hello', 'hi')).resolves.toBeUndefined()
    expect(notification.notified).toHaveLength(0)
  })
})

describe('AcpSessionTitleService output-limit hint', () => {
  const MODEL_ID = 'acme/anthropic-messages/deepseek-v4-flash[1m]'

  const model: AiModelMetadata = {
    id: MODEL_ID,
    providerId: 'acme',
    protocol: 'anthropic-messages',
    channelModel: 'deepseek-v4-flash[1m]',
    name: 'deepseek-v4-flash[1m]',
    family: 'deepseek-v4-flash',
    maxInputTokens: 128000,
    maxOutputTokens: 8192,
    capabilities: { streaming: true },
  }

  beforeEach(() => {
    // The model stub fails with an OutputLimit AiError on sendRequest. The
    // result promise is caught so the unread rejection stays silent — the
    // service only reads the stream, mirroring how consumers behave.
    aiModel = stubAiModel({ sessionTitleModelId: MODEL_ID, models: [model] })
    ;(aiModel as { sendRequest?: unknown }).sendRequest = () => {
      const error = new AiError(AiErrorCode.OutputLimit, 'output limit reached')
      return {
        stream: {
          async *[Symbol.asyncIterator]() {
            throw error
          },
        },
        result: Promise.reject(error).catch(() => ({})),
      }
    }
  })

  it('notifies once and persists the flag when thinking consumed the budget', async () => {
    const service = makeService()
    const title = await service.generateTitle('hello', 'hi')
    expect(title).toBeUndefined()
    expect(notification.notified).toHaveLength(1)
    expect(notification.notified[0]?.severity).toBe(Severity.Warning)
    expect(await storage.get<boolean>(OUTPUT_LIMIT_HINT_KEY, StorageScope.GLOBAL)).toBe(true)
  })

  it('stays silent when the output-limit hint was already shown', async () => {
    await storage.set(OUTPUT_LIMIT_HINT_KEY, true, StorageScope.GLOBAL)
    const service = makeService()
    await service.generateTitle('hello', 'hi')
    expect(notification.notified).toHaveLength(0)
  })

  it('routes the notification action to ai.manageModels', async () => {
    const service = makeService()
    await service.generateTitle('hello', 'hi')
    const action = notification.notified[0]?.actions?.[0]
    expect(action).toBeDefined()
    action?.run()
    expect(executeCommand).toHaveBeenCalledWith('ai.manageModels')
  })

  it('does not hint when generation fails with a different error', async () => {
    aiModel = stubAiModel({ sessionTitleModelId: MODEL_ID, models: [model] })
    ;(aiModel as { sendRequest?: unknown }).sendRequest = () => {
      throw new Error('network down')
    }
    const service = makeService()
    const title = await service.generateTitle('hello', 'hi')
    expect(title).toBeUndefined()
    expect(notification.notified).toHaveLength(0)
  })
})
