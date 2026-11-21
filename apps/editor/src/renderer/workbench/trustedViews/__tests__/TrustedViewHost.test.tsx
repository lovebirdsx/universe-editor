import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  InstantiationService,
  ServiceCollection,
  URI,
  type IHostService,
  type ILoggerService,
} from '@universe-editor/platform'
import type { IExtHostTrustedViews } from '@universe-editor/extensions-common'
import type { TrustedViewComponentProps } from '@universe-editor/trusted-view-api'
import { ServicesContext } from '../../useService.js'
import { IResourceAccessService } from '../../../../shared/ipc/resourceAccessService.js'
import {
  ITrustedViewService,
  TrustedViewService,
} from '../../../services/trustedViews/TrustedViewService.js'
import { TrustedViewHost } from '../TrustedViewHost.js'

const VIEW_ID = 'acme.status'

function Body({ context }: TrustedViewComponentProps) {
  return <div data-testid="trusted-view-body">view={context.viewId}</div>
}

function setup(options: { loader?: (url: string) => Promise<unknown> } = {}) {
  const extHost = {
    $resolveSession: vi.fn().mockResolvedValue(undefined),
    $request: vi.fn().mockResolvedValue(undefined),
    $disposeSession: vi.fn().mockResolvedValue(undefined),
  } satisfies IExtHostTrustedViews
  const service = new TrustedViewService(
    { allowRoots: vi.fn().mockResolvedValue(undefined) } as unknown as IResourceAccessService,
    {
      createLogger: vi.fn().mockReturnValue({
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      }),
    } as unknown as ILoggerService,
    { platform: 'linux' } as IHostService,
  )
  service.setModuleLoader(options.loader ?? vi.fn().mockResolvedValue({ default: Body }))
  service.setExtHost(extHost, vi.fn().mockResolvedValue(undefined))
  service.registerView({
    viewId: VIEW_ID,
    extensionId: 'acme.ext',
    extensionLocation: URI.file('/ext'),
    contribution: {
      id: VIEW_ID,
      name: 'Acme Status',
      location: 'editor',
      entry: './dist/renderer/view.js',
    },
  })
  const services = new ServiceCollection()
  services.set(ITrustedViewService, service)
  return { service, extHost, services }
}

function renderHost(services: ServiceCollection): void {
  render(
    <ServicesContext.Provider value={new InstantiationService(services)}>
      <TrustedViewHost viewId={VIEW_ID} />
    </ServicesContext.Provider>,
  )
}

afterEach(() => cleanup())

describe('TrustedViewHost', () => {
  it('renders the extension component with the bridge context', async () => {
    const { service, services } = setup()
    service.markProviderRegistered(VIEW_ID)
    renderHost(services)

    const body = await screen.findByTestId('trusted-view-body')
    expect(body.textContent).toBe(`view=${VIEW_ID}`)
    expect(screen.getByTestId('trusted-view').getAttribute('data-view-id')).toBe(VIEW_ID)
    expect(screen.getByTestId('trusted-view').getAttribute('data-extension-id')).toBe('acme.ext')
    service.dispose()
  })

  it('shows the loading placeholder while a provider is missing, then the error placeholder', async () => {
    const { service, services } = setup()
    service.setSessionTimeouts(20, 1000)
    renderHost(services)

    expect(screen.getByTestId('trusted-view-loading')).toBeTruthy()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40))
    })
    expect((await screen.findByTestId('trusted-view-error')).textContent).toContain(
      'no provider registered',
    )
    service.dispose()
  })

  it('exposes a retry button on load errors and recovers when clicked', async () => {
    let attempt = 0
    const loader = vi.fn(() => {
      attempt += 1
      return attempt === 1
        ? Promise.reject(new Error('transient import failure'))
        : Promise.resolve({ default: Body })
    })
    const { service, services } = setup({ loader })
    service.markProviderRegistered(VIEW_ID)
    renderHost(services)

    expect((await screen.findByTestId('trusted-view-error')).textContent).toContain(
      'transient import failure',
    )
    fireEvent.click(screen.getByTestId('trusted-view-retry'))
    expect(await screen.findByTestId('trusted-view-body')).toBeTruthy()
    expect(loader).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('auto-recovers a timed-out session when its provider registers afterwards', async () => {
    const { service, services } = setup()
    service.setSessionTimeouts(20, 1000)
    renderHost(services)

    expect((await screen.findByTestId('trusted-view-error')).textContent).toContain(
      'no provider registered',
    )
    expect(screen.getByTestId('trusted-view-retry')).toBeTruthy()

    await act(async () => {
      service.markProviderRegistered(VIEW_ID)
    })
    expect(await screen.findByTestId('trusted-view-body')).toBeTruthy()
    service.dispose()
  })

  it('shows an error placeholder when the module default export is invalid', async () => {
    const { service, services } = setup({ loader: vi.fn().mockResolvedValue({ default: {} }) })
    service.markProviderRegistered(VIEW_ID)
    renderHost(services)

    expect((await screen.findByTestId('trusted-view-error')).textContent).toContain(
      'default-export a React function component',
    )
    service.dispose()
  })

  it('catches render errors from the extension component', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    function Broken(): never {
      throw new Error('boom from extension')
    }
    const { service, services } = setup({ loader: vi.fn().mockResolvedValue({ default: Broken }) })
    service.markProviderRegistered(VIEW_ID)
    renderHost(services)

    expect((await screen.findByTestId('trusted-view-error')).textContent).toContain(
      'boom from extension',
    )
    errorSpy.mockRestore()
    service.dispose()
  })

  it('remounts the session after an extension-host restart', async () => {
    const { service, extHost, services } = setup()
    service.markProviderRegistered(VIEW_ID)
    renderHost(services)
    await screen.findByTestId('trusted-view-body')

    await act(async () => {
      service.reset()
    })
    // Reset drops the provider too: the remounted session waits, then loads
    // again once the new host connection registers it.
    expect(screen.getByTestId('trusted-view-loading')).toBeTruthy()
    await act(async () => {
      service.setExtHost(extHost, vi.fn().mockResolvedValue(undefined))
      service.markProviderRegistered(VIEW_ID)
    })
    await screen.findByTestId('trusted-view-body')
    service.dispose()
  })
})
