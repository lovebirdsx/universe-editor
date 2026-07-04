/*---------------------------------------------------------------------------------------------
 *  Tests for LanguageServicePrewarmContribution — verifies the idle prewarm fires
 *  `onLanguage:<id>` for each configured language (default typescript + markdown),
 *  awaits the workspace, is a no-op when the setting is [], and re-runs when the
 *  extension host relaunches (onDidChangeContributions).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConfigurationService,
  ConfigurationTarget,
  Emitter,
  IConfigurationService,
  IWorkspaceService,
} from '@universe-editor/platform'
import { type IExtensionDescriptionDto } from '@universe-editor/extensions-common'
import { LanguageServicePrewarmContribution } from '../LanguageServicePrewarmContribution.js'
import { IExtensionHostClientService } from '../../services/extensions/ExtensionHostClientService.js'

function setup(prewarm?: string[]) {
  const config = new ConfigurationService()
  if (prewarm !== undefined) {
    config.loadLayer(ConfigurationTarget.User, { 'languageServices.prewarm': prewarm })
  }

  const activations: string[] = []
  const onDidChangeContributions = new Emitter<readonly IExtensionDescriptionDto[]>()
  const client = {
    _serviceBrand: undefined,
    onDidChangeContributions: onDidChangeContributions.event,
    activateByEvent: (event: string) => {
      activations.push(event)
      return Promise.resolve()
    },
  } as unknown as IExtensionHostClientService

  const workspace = {
    _serviceBrand: undefined,
    whenReady: Promise.resolve(),
  } as unknown as IWorkspaceService

  const contribution = new LanguageServicePrewarmContribution(
    config as unknown as IConfigurationService,
    workspace,
    client,
  )

  return { contribution, activations, onDidChangeContributions }
}

describe('LanguageServicePrewarmContribution', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('prewarms the default languages (typescript + markdown) when unset', async () => {
    const { contribution, activations } = setup()
    // runWhenIdle falls back to setTimeout(0) under happy-dom; let it fire.
    await new Promise((r) => setTimeout(r, 0))
    await Promise.resolve()

    expect(activations).toContain('onLanguage:typescript')
    expect(activations).toContain('onLanguage:markdown')
    expect(activations).toHaveLength(2)
    contribution.dispose()
  })

  it('respects a custom prewarm list', async () => {
    const { contribution, activations } = setup(['python'])
    await new Promise((r) => setTimeout(r, 0))
    await Promise.resolve()

    expect(activations).toEqual(['onLanguage:python'])
    contribution.dispose()
  })

  it('is a no-op when the list is empty', async () => {
    const { contribution, activations } = setup([])
    await new Promise((r) => setTimeout(r, 0))
    await Promise.resolve()

    expect(activations).toEqual([])
    contribution.dispose()
  })

  it('re-prewarms when the extension host relaunches (workspace swap / crash)', async () => {
    const { contribution, activations, onDidChangeContributions } = setup()
    await new Promise((r) => setTimeout(r, 0))
    await Promise.resolve()
    expect(activations).toHaveLength(2)

    // A relaunched host re-fires only the startup events, not onLanguage:* — the
    // contribution must re-activate the language plugins on this signal.
    onDidChangeContributions.fire([])
    await Promise.resolve()
    await Promise.resolve()

    expect(activations.filter((e) => e === 'onLanguage:typescript')).toHaveLength(2)
    expect(activations.filter((e) => e === 'onLanguage:markdown')).toHaveLength(2)
    contribution.dispose()
  })
})
