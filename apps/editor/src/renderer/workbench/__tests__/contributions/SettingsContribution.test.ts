import { afterEach, describe, expect, it } from 'vitest'
import { ConfigurationRegistry } from '@universe-editor/platform'
import { SettingsContribution } from '../../../contributions/SettingsContribution.js'

describe('SettingsContribution', () => {
  let contribution: SettingsContribution | undefined

  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
  })

  it('registers the workbench/editor/files nodes on construction', () => {
    contribution = new SettingsContribution()
    const ids = ConfigurationRegistry.getConfigurationNodes().map((n) => n.id)
    expect(ids).toContain('workbench')
    expect(ids).toContain('editor')
    expect(ids).toContain('files')
  })

  it('exposes sensible defaults via getDefaultValue', () => {
    contribution = new SettingsContribution()
    expect(ConfigurationRegistry.getDefaultValue('editor.fontSize')).toBe(14)
    expect(ConfigurationRegistry.getDefaultValue('editor.tabSize')).toBe(4)
    expect(ConfigurationRegistry.getDefaultValue('editor.wordWrap')).toBe(false)
    expect(ConfigurationRegistry.getDefaultValue('editor.minimap.enabled')).toBe(true)
    expect(ConfigurationRegistry.getDefaultValue('workbench.colorTheme')).toBe('dark')
    expect(ConfigurationRegistry.getDefaultValue('files.autoSave')).toBe('off')
    expect(ConfigurationRegistry.getDefaultValue('files.autoSaveDelay')).toBe(1000)
  })

  it('dispose unregisters all nodes', () => {
    const local = new SettingsContribution()
    expect(ConfigurationRegistry.getConfigurationNodes().some((n) => n.id === 'workbench')).toBe(
      true,
    )
    local.dispose()
    const remaining = ConfigurationRegistry.getConfigurationNodes()
    expect(remaining.some((n) => n.id === 'workbench')).toBe(false)
    expect(remaining.some((n) => n.id === 'editor')).toBe(false)
    expect(remaining.some((n) => n.id === 'files')).toBe(false)
  })
})
