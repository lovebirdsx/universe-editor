/**
 * `$createDecorationType` turns a plugin's decoration color fields into CSS:
 * literal colors pass through, `ThemeColor` references become `var(--vscode-<id>)`
 * (theme-following), and an `overviewRulerColor` ThemeColor id resolves to a
 * concrete color at decoration-creation time (Monaco's overview ruler can't
 * paint `var()`). Runs in renderer-dom because `_injectRule` touches `document`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  IEditorGroupsService,
  IEditorService,
  IFileService,
  IInstantiationService,
  ILogger,
  IThemeService,
  IUriIdentityService,
} from '@universe-editor/platform'
import { MainThreadEditor } from '../MainThreadEditor.js'

vi.mock('../../../workbench/editor/monaco/MonacoLoader.js', () => ({
  MonacoLoader: {
    ensureInitialized: () => Promise.resolve({}),
    peek: () => ({}),
    get: () => {
      throw new Error('[MonacoLoader] not initialized; call ensureInitialized() first')
    },
  },
}))

vi.mock('../../../workbench/editor/monaco/MonacoModelRegistry.js', () => ({
  MonacoModelRegistry: { peek: () => undefined, acquire: () => ({}) },
}))

describe('MainThreadEditor.$createDecorationType', () => {
  const getColor = vi.fn()
  const themeService = {
    getColorTheme: () => ({ getColor }),
  } as unknown as IThemeService

  function makeEditor(): MainThreadEditor {
    return new MainThreadEditor(
      {} as IEditorService,
      {} as IUriIdentityService,
      undefined,
      {} as IFileService,
      {} as IEditorGroupsService,
      { createInstance: () => ({ apply: vi.fn() }) } as unknown as IInstantiationService,
      { warn: vi.fn() } as unknown as ILogger,
      themeService,
    )
  }

  beforeEach(() => {
    getColor.mockReset()
    document.head.querySelectorAll('style[data-ext-decorations]').forEach((el) => el.remove())
  })

  it('injects var(--vscode-<id>) for ThemeColor background/border colors', async () => {
    await makeEditor().$createDecorationType(1, {
      backgroundColor: { id: 'myExt.color1' },
      borderColor: { id: 'myExt.color2' },
    })

    const style = document.head.querySelector('style[data-ext-decorations]')
    expect(style?.textContent).toContain('background-color:var(--vscode-myExt-color1)')
    expect(style?.textContent).toContain('solid var(--vscode-myExt-color2)')
  })

  it('passes literal colors through verbatim without a var()', async () => {
    await makeEditor().$createDecorationType(2, { backgroundColor: '#ff0000' })

    const style = document.head.querySelector('style[data-ext-decorations]')
    expect(style?.textContent).toContain('#ff0000')
    expect(style?.textContent).not.toContain('var(')
  })

  it('resolves a ThemeColor overviewRulerColor against the current theme, not as var()', async () => {
    getColor.mockReturnValue({ toString: () => '#00ff00' })

    await makeEditor().$createDecorationType(3, { overviewRulerColor: { id: 'myExt.color3' } })

    expect(getColor).toHaveBeenCalledWith('myExt.color3')
    // No line style was requested, so no CSS rule is injected for the ruler color.
    expect(document.head.querySelector('style[data-ext-decorations]')).toBeNull()
  })
})
