import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfigurationService, ConfigurationTarget } from '@universe-editor/platform'
import { ThemeContribution } from '../ThemeContribution.js'

const monacoMock = vi.hoisted(() => ({
  setTheme: vi.fn(),
  defineTheme: vi.fn(),
}))

vi.mock('../../workbench/editor/monaco/MonacoLoader.js', () => {
  const editor = {
    setTheme: monacoMock.setTheme,
    defineTheme: monacoMock.defineTheme,
  }
  return {
    MonacoLoader: {
      get: () => ({ editor }),
      ensureInitialized: () => Promise.resolve({ editor }),
    },
  }
})

afterEach(() => {
  monacoMock.setTheme.mockReset()
  monacoMock.defineTheme.mockReset()
  delete document.documentElement.dataset.theme
  document.documentElement.style.colorScheme = ''
})

describe('ThemeContribution', () => {
  it('applies the configured workbench theme to CSS and Monaco', () => {
    const config = new ConfigurationService()
    config.update('workbench.colorTheme', 'light', ConfigurationTarget.User)

    const contribution = new ThemeContribution(config)

    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(monacoMock.setTheme).toHaveBeenLastCalledWith('output-light')

    config.update('workbench.colorTheme', 'dark', ConfigurationTarget.User)

    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(monacoMock.setTheme).toHaveBeenLastCalledWith('output-dark')

    contribution.dispose()
  })
})
