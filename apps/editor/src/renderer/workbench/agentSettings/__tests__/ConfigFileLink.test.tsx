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

function mount(path: string, label?: string) {
  const opened: string[] = []
  const services = new ServiceCollection()
  services.set(IEditorResolverService, {
    _serviceBrand: undefined,
    registerEditor: () => ({ dispose: () => {} }),
    resolveEditors: () => [],
    openEditor: async (uri: URI) => {
      opened.push(uri.fsPath)
    },
  } as never)

  const instantiation = new InstantiationService(services)
  const props = label === undefined ? { path } : { path, label }
  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <ConfigFileLink {...props} />
    </ServicesContext.Provider>,
  )
  return { ...utils, opened }
}

describe('ConfigFileLink', () => {
  it('opens the linked filesystem path in the editor', () => {
    const { getByRole, opened } = mount('C:\\Users\\kuro\\.claude\\settings.json')

    fireEvent.click(getByRole('button', { name: 'Open C:\\Users\\kuro\\.claude\\settings.json' }))

    expect(opened).toEqual(['C:/Users/kuro/.claude/settings.json'])
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
