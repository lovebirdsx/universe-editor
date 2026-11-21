import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ViewContainerLocation,
  ViewContainerRegistry,
  ViewRegistry,
  URI,
  type IDisposable,
  type ILogger,
} from '@universe-editor/platform'
import type { IExtensionDescriptionDto } from '@universe-editor/extensions-common'
import { ExtensionPointTranslator } from '../ExtensionPointTranslator.js'
import { EXTENSION_TRUSTED_VIEW_COMPONENT_KEY } from '../../views/trustedViews.js'
import { isTrustedViewExtension } from '../../trustedViews/trustedViewTrust.js'
import type { ITrustedViewRegistration } from '../../trustedViews/TrustedViewService.js'

function dto(overrides: Partial<IExtensionDescriptionDto> = {}): IExtensionDescriptionDto {
  return {
    id: 'acme.ext',
    name: 'acme',
    activationEvents: [],
    contributes: {},
    hasMain: true,
    extensionLocation: URI.file('/extensions/acme'),
    extensionIsBuiltin: false,
    ...overrides,
  }
}

function viewTrustedView(
  overrides: Partial<
    NonNullable<IExtensionDescriptionDto['contributes']['trustedViews']>[number]
  > = {},
) {
  return {
    id: 'acme.status',
    name: 'Acme Status',
    location: 'view' as const,
    container: 'explorer',
    entry: './dist/renderer/status.js',
    ...overrides,
  }
}

interface IHarness {
  readonly translator: ExtensionPointTranslator
  readonly registrations: ITrustedViewRegistration[]
  readonly handles: IDisposable[]
  readonly untrusted: ReturnType<typeof vi.fn>
}

function makeTranslator(
  options: {
    readonly trusted?: (ext: IExtensionDescriptionDto) => boolean
    readonly register?: (registration: ITrustedViewRegistration) => IDisposable
    readonly untrusted?: ReturnType<typeof vi.fn>
  } = {},
): IHarness {
  const registrations: ITrustedViewRegistration[] = []
  const handles: IDisposable[] = []
  const untrusted = options.untrusted ?? vi.fn()
  const register =
    options.register ??
    ((registration: ITrustedViewRegistration) => {
      registrations.push(registration)
      const handle = { dispose: vi.fn() }
      handles.push(handle)
      return handle
    })
  const translator = new ExtensionPointTranslator(
    vi.fn(),
    vi.fn(),
    undefined,
    { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ILogger,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.trusted ?? (() => true),
    register,
    untrusted,
  )
  return { translator, registrations, handles, untrusted }
}

const disposables: IDisposable[] = []

function registerExplorerContainer(): void {
  disposables.push(
    ViewContainerRegistry.registerViewContainer({
      id: 'workbench.view.explorer',
      label: 'Explorer',
      icon: 'files',
      order: 1,
      location: ViewContainerLocation.SideBar,
    }),
  )
}

afterEach(() => {
  for (const disposable of disposables.splice(0)) disposable.dispose()
})

describe('ExtensionPointTranslator — trusted views', () => {
  it('registers a trusted view with the shared component key, container and when', () => {
    registerExplorerContainer()
    const { translator, registrations } = makeTranslator()
    disposables.push(translator)

    translator.translate([
      dto({
        contributes: {
          trustedViews: [viewTrustedView({ when: 'acme.ready', icon: '$(rocket)' })],
        },
      }),
    ])

    expect(registrations).toHaveLength(1)
    expect(registrations[0]).toMatchObject({
      viewId: 'acme.status',
      extensionId: 'acme.ext',
      contribution: { location: 'view' },
    })
    expect(ViewRegistry.getView('acme.status')).toMatchObject({
      name: 'Acme Status',
      containerId: 'workbench.view.explorer',
      componentKey: EXTENSION_TRUSTED_VIEW_COMPONENT_KEY,
      order: 0,
      icon: 'rocket',
      when: 'acme.ready',
    })
  })

  it('registers an editor trusted view without a view descriptor', () => {
    const { translator, registrations } = makeTranslator()
    disposables.push(translator)

    translator.translate([
      dto({
        contributes: {
          trustedViews: [
            {
              id: 'acme.status',
              name: 'Acme Status',
              location: 'editor',
              entry: './dist/renderer/status.js',
            },
          ],
        },
      }),
    ])

    expect(registrations).toHaveLength(1)
    expect(ViewRegistry.getView('acme.status')).toBeUndefined()
  })

  it('does not register anything for an untrusted extension and asks the contribution to notify', () => {
    registerExplorerContainer()
    const { translator, registrations, untrusted } = makeTranslator({ trusted: () => false })
    disposables.push(translator)

    translator.translate([dto({ contributes: { trustedViews: [viewTrustedView()] } })])

    expect(registrations).toEqual([])
    expect(ViewRegistry.getView('acme.status')).toBeUndefined()
    expect(untrusted).toHaveBeenCalledTimes(1)
  })

  it('trusts built-in and development extensions through the shared predicate', () => {
    registerExplorerContainer()
    const trust = (ext: IExtensionDescriptionDto): boolean => isTrustedViewExtension(ext, [])
    const builtin = makeTranslator({ trusted: trust })
    const dev = makeTranslator({ trusted: trust })
    disposables.push(builtin.translator, dev.translator)

    builtin.translator.translate([
      dto({
        id: 'acme.builtin',
        extensionIsBuiltin: true,
        contributes: { trustedViews: [viewTrustedView({ id: 'acme.builtin.view' })] },
      }),
    ])
    dev.translator.translate([
      dto({
        id: 'acme.dev',
        extensionIsUnderDevelopment: true,
        contributes: { trustedViews: [viewTrustedView({ id: 'acme.dev.view' })] },
      }),
    ])

    expect(builtin.registrations).toHaveLength(1)
    expect(dev.registrations).toHaveLength(1)
  })

  it('skips a duplicate id and keeps translating the remaining views', () => {
    registerExplorerContainer()
    const register = vi
      .fn()
      .mockImplementationOnce(() => ({ dispose: vi.fn() }))
      .mockImplementationOnce(() => {
        throw new Error('trusted view id is already registered')
      })
    const { translator } = makeTranslator({ register })
    disposables.push(translator)

    translator.translate([
      dto({
        contributes: {
          trustedViews: [viewTrustedView(), viewTrustedView({ id: 'acme.other' })],
        },
      }),
    ])

    expect(register).toHaveBeenCalledTimes(2)
    expect(ViewRegistry.getView('acme.status')).toBeDefined()
    expect(ViewRegistry.getView('acme.other')).toBeUndefined()
  })

  it('skips a view id already used by a regular contributes.views entry', () => {
    registerExplorerContainer()
    const { translator, registrations } = makeTranslator()
    disposables.push(translator)

    translator.translate([
      dto({
        contributes: {
          views: { explorer: [{ id: 'acme.status', name: 'Regular' }] },
          trustedViews: [viewTrustedView()],
        },
      }),
    ])

    expect(registrations).toEqual([])
    expect(ViewRegistry.getView('acme.status')?.componentKey).not.toBe(
      EXTENSION_TRUSTED_VIEW_COMPONENT_KEY,
    )
  })

  it('skips an unknown container', () => {
    const { translator, registrations } = makeTranslator()
    disposables.push(translator)
    translator.translate([
      dto({ contributes: { trustedViews: [viewTrustedView({ container: 'no.such' })] } }),
    ])
    expect(registrations).toEqual([])
    expect(ViewRegistry.getView('acme.status')).toBeUndefined()
  })

  it('disposes both the view descriptor and the service registration', () => {
    registerExplorerContainer()
    const { translator, handles } = makeTranslator()
    translator.translate([dto({ contributes: { trustedViews: [viewTrustedView()] } })])

    expect(ViewRegistry.getView('acme.status')).toBeDefined()
    translator.dispose()
    expect(ViewRegistry.getView('acme.status')).toBeUndefined()
    expect(handles[0]!.dispose).toHaveBeenCalled()
  })
})
