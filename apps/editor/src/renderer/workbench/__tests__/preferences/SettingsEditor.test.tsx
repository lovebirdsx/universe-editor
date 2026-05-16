import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render, act } from '@testing-library/react'
import {
  ConfigurationRegistry,
  ConfigurationService,
  ConfigurationTarget,
  IConfigurationService,
  InstantiationService,
  ServiceCollection,
  type IDisposable,
} from '@universe-editor/platform'
import { ServicesContext } from '../../useService.js'
import { SettingsEditor } from '../../preferences/SettingsEditor.js'

function mount() {
  const config = new ConfigurationService()
  const services = new ServiceCollection()
  services.set(IConfigurationService, config)
  const instantiation = new InstantiationService(services)

  const utils = render(
    <ServicesContext.Provider value={instantiation}>
      <SettingsEditor />
    </ServicesContext.Provider>,
  )

  return { ...utils, config }
}

describe('SettingsEditor', () => {
  let disposables: IDisposable[] = []

  function registerSeedSchema() {
    disposables.push(
      ConfigurationRegistry.registerConfiguration({
        id: 'editor',
        title: 'Editor',
        properties: {
          'editor.fontSize': { type: 'number', default: 14, minimum: 8, maximum: 32 },
          'editor.wordWrap': { type: 'boolean', default: false },
        },
      }),
      ConfigurationRegistry.registerConfiguration({
        id: 'files',
        title: 'Files',
        properties: {
          'files.autoSave': { type: 'string', default: 'off', enum: ['off', 'afterDelay'] },
        },
      }),
    )
  }

  afterEach(() => {
    disposables.forEach((d) => d.dispose())
    disposables = []
  })

  it('renders a section per registered node', () => {
    registerSeedSchema()
    const { container } = mount()
    const sections = container.querySelectorAll('section')
    expect(sections.length).toBe(2)
    const titles = Array.from(sections).map((s) => s.querySelector('h2')?.textContent)
    expect(titles).toEqual(['Editor', 'Files'])
  })

  it('renders one row per property, with correct controls', () => {
    registerSeedSchema()
    const { container } = mount()
    expect(container.querySelector('[data-key="editor.fontSize"] input[type=number]')).toBeTruthy()
    expect(
      container.querySelector('[data-key="editor.wordWrap"] input[type=checkbox]'),
    ).toBeTruthy()
    expect(container.querySelector('[data-key="files.autoSave"] select')).toBeTruthy()
  })

  it('search filter narrows visible rows', () => {
    registerSeedSchema()
    const { container } = mount()
    const search = container.querySelector('input[type=search]') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'fontSize' } })

    expect(container.querySelector('[data-key="editor.fontSize"]')).toBeTruthy()
    expect(container.querySelector('[data-key="editor.wordWrap"]')).toBeNull()
    expect(container.querySelector('[data-key="files.autoSave"]')).toBeNull()
  })

  it('editing a number writes to the User layer', () => {
    registerSeedSchema()
    const { container, config } = mount()
    const input = container.querySelector(
      '[data-key="editor.fontSize"] input[type=number]',
    ) as HTMLInputElement
    fireEvent.change(input, { target: { value: '20' } })

    expect(config.get('editor.fontSize')).toBe(20)
    expect(
      (config.getLayerSnapshot(ConfigurationTarget.User) as Record<string, unknown>)[
        'editor.fontSize'
      ],
    ).toBe(20)
  })

  it('editing a boolean writes to the User layer', () => {
    registerSeedSchema()
    const { container, config } = mount()
    const cb = container.querySelector(
      '[data-key="editor.wordWrap"] input[type=checkbox]',
    ) as HTMLInputElement
    fireEvent.click(cb)
    expect(config.get('editor.wordWrap')).toBe(true)
  })

  it('editing an enum writes to the User layer', () => {
    registerSeedSchema()
    const { container, config } = mount()
    const select = container.querySelector(
      '[data-key="files.autoSave"] select',
    ) as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'afterDelay' } })
    expect(config.get('files.autoSave')).toBe('afterDelay')
  })

  it('external config.update is reflected in the input', () => {
    registerSeedSchema()
    const { container, config } = mount()
    act(() => {
      config.update('editor.fontSize', 22, ConfigurationTarget.User)
    })
    const input = container.querySelector(
      '[data-key="editor.fontSize"] input[type=number]',
    ) as HTMLInputElement
    expect(Number(input.value)).toBe(22)
  })
})
