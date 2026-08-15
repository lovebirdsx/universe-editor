import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  Emitter,
  InstantiationService,
  IWorkspaceService,
  ServiceCollection,
  URI,
  type IWorkspace,
} from '@universe-editor/platform'
import { ServicesContext } from '../useService.js'
import { useRemoteAuthority } from '../useRemoteAuthority.js'

const REMOTE = URI.from({ scheme: 'remote-ssh', authority: 'user@host', path: '/home/user/proj' })
const LOCAL = URI.file('/home/user/proj')

function makeWorkspace(initial: IWorkspace | null) {
  const emitter = new Emitter<IWorkspace | null>()
  let current = initial
  return {
    _serviceBrand: undefined,
    get current() {
      return current
    },
    onDidChangeWorkspace: emitter.event,
    set(next: IWorkspace | null) {
      current = next
      emitter.fire(next)
    },
  }
}

function mount(workspace?: ReturnType<typeof makeWorkspace>) {
  const services = new ServiceCollection()
  if (workspace) services.set(IWorkspaceService, workspace as never)
  const instantiation = new InstantiationService(services)

  function Consumer() {
    const authority = useRemoteAuthority()
    return <div data-testid="out">{authority ?? ''}</div>
  }

  render(
    <ServicesContext.Provider value={instantiation}>
      <Consumer />
    </ServicesContext.Provider>,
  )
}

afterEach(() => cleanup())

describe('useRemoteAuthority', () => {
  it('returns undefined when no workspace service is bound', () => {
    mount()
    expect(screen.getByTestId('out').textContent).toBe('')
  })

  it('tracks workspace hydration: undefined → authority after onDidChangeWorkspace', () => {
    const workspace = makeWorkspace(null)
    mount(workspace)
    expect(screen.getByTestId('out').textContent).toBe('')

    act(() => {
      workspace.set({ folder: REMOTE, name: 'proj' })
    })
    expect(screen.getByTestId('out').textContent).toBe('user@host')
  })

  it('returns undefined for a local file workspace', () => {
    mount(makeWorkspace({ folder: LOCAL, name: 'proj' }))
    expect(screen.getByTestId('out').textContent).toBe('')
  })

  it('returns undefined again when the remote workspace closes (remote → null)', () => {
    const workspace = makeWorkspace({ folder: REMOTE, name: 'proj' })
    mount(workspace)
    expect(screen.getByTestId('out').textContent).toBe('user@host')

    act(() => {
      workspace.set(null)
    })
    expect(screen.getByTestId('out').textContent).toBe('')
  })
})
