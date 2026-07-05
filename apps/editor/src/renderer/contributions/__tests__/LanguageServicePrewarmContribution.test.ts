/*---------------------------------------------------------------------------------------------
 *  Tests for LanguageServicePrewarmContribution — verifies the idle prewarm fires
 *  `onLanguage:<id>` for each configured language (default typescript + markdown),
 *  awaits the workspace, is a no-op when the setting is [], and re-runs when the
 *  extension host relaunches (onDidChangeContributions). Also verifies the
 *  `typescript.prewarm.projects` setting is registered with an enum of the
 *  workspace's tsconfig paths (for settings.json completion).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConfigurationRegistry,
  ConfigurationService,
  ConfigurationTarget,
  Emitter,
  IConfigurationService,
  IFileSearchService,
  IWorkspaceService,
  URI,
  type IFileSearchComplete,
  type IFileSearchMatch,
  type IWorkspace,
} from '@universe-editor/platform'
import { type IExtensionDescriptionDto } from '@universe-editor/extensions-common'
import { LanguageServicePrewarmContribution } from '../LanguageServicePrewarmContribution.js'
import { IExtensionHostClientService } from '../../services/extensions/ExtensionHostClientService.js'

function fileMatch(relativePath: string): IFileSearchMatch {
  const basename = relativePath.split('/').pop() ?? relativePath
  return {
    resource: URI.file('/w/' + relativePath),
    fsPath: '/w/' + relativePath,
    relativePath,
    basename,
    score: 0,
  }
}

function setup(prewarm?: string[], tsconfigPaths: string[] = []) {
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

  const onDidChangeWorkspace = new Emitter<IWorkspace | null>()
  const workspace = {
    _serviceBrand: undefined,
    whenReady: Promise.resolve(),
    current: { folder: URI.file('/w'), name: 'w' },
    onDidChangeWorkspace: onDidChangeWorkspace.event,
  } as unknown as IWorkspaceService

  const fileSearch = {
    _serviceBrand: undefined,
    search: (): Promise<IFileSearchComplete> =>
      Promise.resolve({
        results: tsconfigPaths.map(fileMatch),
        limitHit: false,
        filesWalked: 0,
        directoriesWalked: 0,
        durationMs: 0,
      }),
  } as unknown as IFileSearchService

  const contribution = new LanguageServicePrewarmContribution(
    config as unknown as IConfigurationService,
    workspace,
    client,
    fileSearch,
  )

  return { contribution, activations, onDidChangeContributions, onDidChangeWorkspace }
}

/** Read the currently-registered `typescript.prewarm.projects` item schema. */
function tsProjectsItemSchema(): { type?: unknown; enum?: unknown[] } | undefined {
  for (const node of ConfigurationRegistry.getConfigurationNodes()) {
    const prop = node.properties['typescript.prewarm.projects']
    if (prop) return prop.items as { type?: unknown; enum?: unknown[] }
  }
  return undefined
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

  it('registers typescript.prewarm.projects with an enum of workspace tsconfigs', async () => {
    const { contribution } = setup(undefined, ['tsconfig.json', 'packages/app/tsconfig.json'])
    // The schema registration awaits workspace.whenReady + the file search; a
    // macrotask flushes the whole microtask chain deterministically.
    await new Promise((r) => setTimeout(r, 0))

    const item = tsProjectsItemSchema()
    expect(item?.enum).toEqual(['packages/app/tsconfig.json', 'tsconfig.json'])
    contribution.dispose()
  })

  it('omits the enum when the workspace has no tsconfig', async () => {
    const { contribution } = setup(undefined, [])
    await new Promise((r) => setTimeout(r, 0))

    const item = tsProjectsItemSchema()
    expect(item?.type).toBe('string')
    expect(item?.enum).toBeUndefined()
    contribution.dispose()
  })

  it('unregisters the tsconfig schema on dispose', async () => {
    const { contribution } = setup(undefined, ['tsconfig.json'])
    await new Promise((r) => setTimeout(r, 0))
    expect(tsProjectsItemSchema()).toBeDefined()

    contribution.dispose()
    expect(tsProjectsItemSchema()).toBeUndefined()
  })
})
