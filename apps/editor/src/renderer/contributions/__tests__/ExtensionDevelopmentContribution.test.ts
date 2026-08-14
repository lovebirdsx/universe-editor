/*---------------------------------------------------------------------------------------------
 *  Tests for ExtensionDevelopmentContribution — the status-bar entry appears only
 *  in extension-development mode and tracks the dev extension count across host
 *  restarts.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { Emitter, URI } from '@universe-editor/platform'
import type { IExtensionDescriptionDto } from '@universe-editor/extensions-common'
import { EXTENSION_DEVELOPMENT_ENABLED_KEY } from '../../../shared/extensionDevelopment.js'
import { StatusBarService } from '../../services/statusbar/StatusBarService.js'
import type { IExtensionHostClientService } from '../../services/extensions/ExtensionHostClientService.js'
import { ExtensionDevelopmentContribution } from '../ExtensionDevelopmentContribution.js'

function dto(id: string, dev: boolean): IExtensionDescriptionDto {
  return {
    id,
    name: id,
    activationEvents: [],
    contributes: {},
    hasMain: true,
    extensionLocation: URI.file(`/dev/${id}`),
    extensionIsBuiltin: false,
    ...(dev ? { extensionIsUnderDevelopment: true } : {}),
  }
}

function fakeHostClient(initial: readonly IExtensionDescriptionDto[]) {
  const onDidChangeContributions = new Emitter<readonly IExtensionDescriptionDto[]>()
  const client = {
    getContributions: () => Promise.resolve(initial),
    onDidChangeContributions: onDidChangeContributions.event,
  } as unknown as IExtensionHostClientService
  return {
    client,
    fire: (dtos: readonly IExtensionDescriptionDto[]) => onDidChangeContributions.fire(dtos),
  }
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

describe('ExtensionDevelopmentContribution', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window
  })

  it('shows nothing outside extension-development mode', async () => {
    const statusBar = new StatusBarService()
    const { client } = fakeHostClient([dto('dev.a', true)])
    const contrib = new ExtensionDevelopmentContribution(statusBar, client)
    await flush()
    expect(statusBar.entries.get()).toHaveLength(0)
    contrib.dispose()
  })

  it('shows the entry with the dev extension count', async () => {
    ;(globalThis as Record<string, unknown>).window = {
      [EXTENSION_DEVELOPMENT_ENABLED_KEY]: true,
    }
    const statusBar = new StatusBarService()
    const { client } = fakeHostClient([
      dto('dev.a', true),
      dto('dev.b', true),
      dto('user.c', false),
    ])
    const contrib = new ExtensionDevelopmentContribution(statusBar, client)
    await flush()
    const texts = statusBar.entries.get().map((e) => e.entry.text)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('(2)')
    contrib.dispose()
  })

  it('recomputes the count when contributions change (host restart)', async () => {
    ;(globalThis as Record<string, unknown>).window = {
      [EXTENSION_DEVELOPMENT_ENABLED_KEY]: true,
    }
    const statusBar = new StatusBarService()
    const { client, fire } = fakeHostClient([dto('dev.a', true)])
    const contrib = new ExtensionDevelopmentContribution(statusBar, client)
    await flush()
    expect(statusBar.entries.get()[0]?.entry.text).toContain('(1)')

    fire([dto('dev.a', true), dto('dev.b', true)])
    await flush()
    expect(statusBar.entries.get()[0]?.entry.text).toContain('(2)')
    contrib.dispose()
  })
})
