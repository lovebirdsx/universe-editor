import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import {
  IEditorResolverService,
  InstantiationService,
  ServiceCollection,
  type URI,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { ConfigFileLink, getSiblingConfigPath } from '../ConfigFileLink.js'

function mount(path: string, opts?: { label?: string; authority?: string }) {
  const opened: URI[] = []
  const services = new ServiceCollection()
  services.set(IEditorResolverService, {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose: () => {} }),
    resolveEditors: () => [],
    openEditor: async (uri: URI) => {
      opened.push(uri)
    },
  } as never)

  const instantiation = new InstantiationService(services)
  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <ConfigFileLink path={path} {...opts} />
    </ServicesContext.Provider>,
  )
  return { ...utils, opened }
}

describe('ConfigFileLink', () => {
  it('opens the linked filesystem path in the editor', () => {
    const { getByRole, opened } = mount('C:\\Users\\kuro\\.claude\\settings.json')

    fireEvent.click(getByRole('button', { name: 'Open C:\\Users\\kuro\\.claude\\settings.json' }))

    expect(opened).toHaveLength(1)
    expect(opened[0]!.scheme).toBe('file')
    expect(opened[0]!.fsPath).toBe('C:/Users/kuro/.claude/settings.json')
  })

  it('opens a remote-ssh URI when authority is provided', () => {
    const { getByRole, opened } = mount('/home/user/.claude/settings.json', {
      authority: 'user@host',
    })

    fireEvent.click(getByRole('button', { name: 'Open /home/user/.claude/settings.json' }))

    expect(opened).toHaveLength(1)
    expect(opened[0]!.scheme).toBe('remote-ssh')
    expect(opened[0]!.authority).toBe('user@host')
    expect(opened[0]!.path).toBe('/home/user/.claude/settings.json')
  })

  it('derives sibling config paths while preserving path separators', () => {
    expect(getSiblingConfigPath('C:\\Users\\kuro\\.codex\\config.toml', 'auth.json')).toBe(
      'C:\\Users\\kuro\\.codex\\auth.json',
    )
    expect(getSiblingConfigPath('/home/kuro/.codex/config.toml', 'auth.json')).toBe(
      '/home/kuro/.codex/auth.json',
    )
  })
})
