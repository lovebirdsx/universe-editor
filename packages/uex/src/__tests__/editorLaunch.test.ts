import { describe, it, expect } from 'vitest'
import { buildEditorArgs } from '../lib/editorLaunch.js'

describe('buildEditorArgs', () => {
  it('always passes the dev extension path', () => {
    expect(buildEditorArgs({ extensionPath: 'D:/dev/my-ext' })).toEqual([
      '--extension-development-path=D:/dev/my-ext',
    ])
  })

  it('maps --inspect to the editor’s --inspect-extensions', () => {
    expect(buildEditorArgs({ extensionPath: '/ext', inspectPort: 9229 })).toEqual([
      '--extension-development-path=/ext',
      '--inspect-extensions=9229',
    ])
  })

  it('forwards --user-data-dir', () => {
    expect(
      buildEditorArgs({ extensionPath: '/ext', inspectPort: 9229, userDataDir: '/tmp/ud' }),
    ).toEqual([
      '--extension-development-path=/ext',
      '--inspect-extensions=9229',
      '--user-data-dir=/tmp/ud',
    ])
  })

  it('keeps every arg a single --key=value element (no shell splitting)', () => {
    for (const arg of buildEditorArgs({
      extensionPath: 'C:/Program Files/ext',
      inspectPort: 9229,
    })) {
      expect(arg.startsWith('--')).toBe(true)
      expect(arg).toContain('=')
    }
  })
})
