/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  `workbench.action.vim.showKeymapCheatSheet`: services are taken before the first await
 *  (the accessor dies there) and the focused surface's own keymap is merged into its section.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import {
  CommandsRegistry,
  InstantiationService,
  IQuickInputService,
  ServiceCollection,
  registerAction2,
  type QuickPickInput,
} from '@universe-editor/platform'
import {
  __resetVimSurfacesForTests,
  registerVimSurface,
  type IVimKeymapEntry,
  type VimSurfaceKind,
} from '@universe-editor/workbench-ui'
import { IVimModeService } from '../../services/vim/vimModeService.js'
import {
  registerWorkbenchDocument,
  setActiveWorkbenchDocument,
} from '../../services/windows/workbenchDocuments.js'
import { ShowVimCheatSheetAction } from '../vimActions.js'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  __resetVimSurfacesForTests()
})

const OWN: readonly IVimKeymapEntry[] = [
  { id: 'settings.search', keys: ['/'], command: 'workbench.action.focusSettingsSearch' },
]

interface Run {
  readonly picked: QuickPickInput[]
  readonly getEffectiveKeymap: ReturnType<typeof vi.fn>
  readonly pick: ReturnType<typeof vi.fn>
}

async function run(
  options: { focusList?: boolean; activeKind?: VimSurfaceKind } = {},
): Promise<Run> {
  const win = new Window()
  const doc = win.document as unknown as Document
  const documentRegistration = registerWorkbenchDocument(doc)
  setActiveWorkbenchDocument(doc)
  cleanups.push(() => documentRegistration.dispose())

  if (options.focusList === true) {
    const element = doc.createElement('div')
    element.tabIndex = 0
    doc.body.appendChild(element)
    const surface = registerVimSurface(
      {
        id: 'settings-list',
        kind: 'list',
        focus: 'within',
        getElement: () => element,
        getSurfaceKey: () => 'list:settings',
        defaultMode: 'normal',
        actions: {},
        keymap: OWN,
      },
      doc,
    )
    cleanups.push(() => surface.dispose())
    element.focus()
  }

  const getEffectiveKeymap = vi.fn((kind: VimSurfaceKind, own?: readonly IVimKeymapEntry[]) => [
    { id: `base.${kind}`, keys: ['j'], command: `base.${kind}` },
    ...(own ?? []),
  ])
  const picked: QuickPickInput[] = []
  const pick = vi.fn(async (items: QuickPickInput[]) => {
    picked.push(...items)
    return undefined
  })
  const services = new ServiceCollection()
  services.set(IVimModeService, {
    _serviceBrand: undefined,
    activeSurface:
      options.activeKind === undefined
        ? undefined
        : { surfaceKey: 'k', kind: options.activeKind, id: 'k', defaultMode: 'normal' },
    getEffectiveKeymap,
  } as never)
  services.set(IQuickInputService, { _serviceBrand: undefined, pick } as never)

  const registration = registerAction2(ShowVimCheatSheetAction)
  cleanups.push(() => registration.dispose())
  const instantiation = new InstantiationService(services)
  const command = CommandsRegistry.getCommand(ShowVimCheatSheetAction.ID)
  expect(command).toBeDefined()
  // The accessor is revoked as soon as invokeFunction returns, i.e. at the action's
  // first await; reaching `pick` proves every service was taken before it.
  await instantiation.invokeFunction((accessor) => command!.handler(accessor) as Promise<void>)
  return { picked, getEffectiveKeymap, pick }
}

describe('ShowVimCheatSheetAction', () => {
  it('shows the picker without throwing after the dynamic import await', async () => {
    const { pick, picked } = await run({ activeKind: 'list' })
    expect(pick).toHaveBeenCalledTimes(1)
    expect(pick.mock.calls[0]?.[1]).toMatchObject({
      id: 'vim.cheatSheet',
      matchOnDescription: true,
    })
    expect(picked.length).toBeGreaterThan(0)
  })

  it('asks for every surface kind, starting with the one that had the keyboard', async () => {
    const { getEffectiveKeymap, picked } = await run({ activeKind: 'terminal' })
    const kinds = getEffectiveKeymap.mock.calls.map((call) => call[0])
    expect(kinds).toEqual([
      'editor',
      'list',
      'menu',
      'overlay',
      'tabs',
      'activityBar',
      'viewContainerTabs',
      'terminal',
      'reader',
    ])
    const separators = picked.filter((item) => 'type' in item && /^sep:[a-zA-Z]+$/.test(item.id))
    expect(separators[0]?.id).toBe('sep:terminal')
    expect((separators[0] as { label: string }).label).toContain('(current)')
  })

  it("merges the focused surface's own keymap into its kind only", async () => {
    const { getEffectiveKeymap, picked } = await run({ focusList: true, activeKind: 'list' })
    for (const [kind, own] of getEffectiveKeymap.mock.calls) {
      if (kind === 'list') expect(own).toBe(OWN)
      else expect(own).toBeUndefined()
    }
    const ids = picked.map((item) => item.id)
    expect(ids).toContain('list:settings.search')
    expect(ids).not.toContain('menu:settings.search')
  })

  it('passes no surface keymap when focus is outside every surface', async () => {
    const { getEffectiveKeymap } = await run({ activeKind: 'list' })
    expect(getEffectiveKeymap.mock.calls.every((call) => call[1] === undefined)).toBe(true)
  })

  it('still lists the workbench keys when no surface is active', async () => {
    const { picked } = await run()
    const separators = picked.filter((item) => 'type' in item && /^sep:[a-zA-Z]+$/.test(item.id))
    expect(separators.length).toBeGreaterThan(0)
    expect(separators.some((item) => (item as { label: string }).label.includes('(current)'))).toBe(
      false,
    )
  })
})
