import { describe, expect, it } from 'vitest'
import {
  isScalarSchema,
  settingDisplayTitle,
  splitSettingKey,
  wordifySettingName,
} from '../settingsKeys.js'

describe('isScalarSchema', () => {
  it('accepts boolean / number / integer / string', () => {
    expect(isScalarSchema({ type: 'boolean' })).toBe(true)
    expect(isScalarSchema({ type: 'number' })).toBe(true)
    expect(isScalarSchema({ type: 'integer' })).toBe(true)
    expect(isScalarSchema({ type: 'string' })).toBe(true)
  })

  it('accepts enum regardless of declared type', () => {
    expect(isScalarSchema({ enum: ['a', 'b'] })).toBe(true)
  })

  it('rejects object / array / union / anyOf', () => {
    expect(isScalarSchema({ type: 'object' })).toBe(false)
    expect(isScalarSchema({ type: 'array' })).toBe(false)
    expect(isScalarSchema({ type: ['boolean', 'string'] })).toBe(false)
    expect(isScalarSchema({ anyOf: [{ type: 'boolean' }] })).toBe(false)
  })
})

describe('splitSettingKey', () => {
  it('splits at the last dot', () => {
    expect(splitSettingKey('editor.minimap.enabled')).toEqual({
      category: 'editor.minimap',
      name: 'enabled',
    })
  })

  it('handles keys without a dot', () => {
    expect(splitSettingKey('telemetry')).toEqual({ category: '', name: 'telemetry' })
  })
})

describe('wordifySettingName', () => {
  it('splits camelCase humps', () => {
    expect(wordifySettingName('fontSize')).toBe('Font Size')
    expect(wordifySettingName('wordWrap')).toBe('Word Wrap')
  })

  it('splits dot / dash / underscore separators', () => {
    expect(wordifySettingName('editor.minimap')).toBe('Editor Minimap')
    expect(wordifySettingName('auto-save')).toBe('Auto Save')
    expect(wordifySettingName('auto_save')).toBe('Auto Save')
  })

  it('capitalizes single words', () => {
    expect(wordifySettingName('enabled')).toBe('Enabled')
  })
})

describe('settingDisplayTitle', () => {
  it('uses the last prefix segment as category', () => {
    expect(settingDisplayTitle('editor.minimap.enabled', 'Editor')).toEqual({
      category: 'Minimap',
      label: 'Enabled',
    })
  })

  it('drops the category when it echoes the group title', () => {
    expect(settingDisplayTitle('editor.fontSize', 'Editor')).toEqual({
      category: '',
      label: 'Font Size',
    })
  })

  it('handles keys without a category', () => {
    expect(settingDisplayTitle('telemetry', 'Application')).toEqual({
      category: '',
      label: 'Telemetry',
    })
  })
})
