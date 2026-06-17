import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { schemaFileMatchForUri } from '../schemaFileMatch.js'

describe('schemaFileMatchForUri', () => {
  it('lower-cases a Windows drive letter and drops the leading slash', () => {
    const uri = URI.file('D:/Users/admin/AppData/Roaming/UniverseEditor/settings.json')
    expect(schemaFileMatchForUri(uri)).toBe(
      'd:/Users/admin/AppData/Roaming/UniverseEditor/settings.json',
    )
  })

  it('preserves spaces in directory names (Monaco matches the decoded path)', () => {
    const uri = URI.file('D:/Users/admin/AppData/Roaming/Universe Editor/settings.json')
    expect(schemaFileMatchForUri(uri)).toBe(
      'd:/Users/admin/AppData/Roaming/Universe Editor/settings.json',
    )
  })

  it('drops the leading slash on a posix path (no drive letter)', () => {
    const uri = URI.file('/Users/foo/.config/universe-editor/settings.json')
    expect(schemaFileMatchForUri(uri)).toBe('Users/foo/.config/universe-editor/settings.json')
  })

  it('targets a project settings file under .universe-editor', () => {
    const uri = URI.file('C:/work/my-project/.universe-editor/settings.json')
    expect(schemaFileMatchForUri(uri)).toBe('c:/work/my-project/.universe-editor/settings.json')
  })

  it("matches the normalized URI string Monaco's worker tests against", () => {
    // Monaco wraps the pattern in `**​/` and tests it against the resource
    // string its bundled vscode-uri produces — a `file://` URI with a
    // lower-cased drive and decoded path (spaces left intact). The pattern must
    // be a suffix of that string so `**​/` absorbs the `file:///` prefix.
    const uri = URI.file('D:/git/Universe Editor/aiSettings.json')
    const pattern = schemaFileMatchForUri(uri)
    const monacoNormalized = 'file:///d:/git/Universe Editor/aiSettings.json'
    expect(monacoNormalized.endsWith('/' + pattern)).toBe(true)
  })
})
