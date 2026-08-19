import { describe, expect, it } from 'vitest'
import { ThemeColor } from '@universe-editor/extension-api'
import { toDecorationOptionsDto, toSelectionDto } from '../hostHandles.js'

describe('toDecorationOptionsDto', () => {
  it('serializes ThemeColor to { id } and passes literal color strings through', () => {
    const dto = toDecorationOptionsDto({
      backgroundColor: new ThemeColor('myExt.color1'),
      borderColor: '#ff0000',
      borderWidth: '2px',
      overviewRulerColor: new ThemeColor('myExt.color2'),
      overviewRulerLane: 4,
    })

    expect(dto.backgroundColor).toEqual({ id: 'myExt.color1' })
    expect(dto.borderColor).toBe('#ff0000')
    expect(dto.borderWidth).toBe('2px')
    expect(dto.overviewRulerColor).toEqual({ id: 'myExt.color2' })
    expect(dto.overviewRulerLane).toBe(4)
  })

  it('omits undefined fields so they never become null on the wire', () => {
    const dto = toDecorationOptionsDto({ isWholeLine: true })

    expect(dto.isWholeLine).toBe(true)
    expect('backgroundColor' in dto).toBe(false)
    expect('gutterIconPath' in dto).toBe(false)
    expect('overviewRulerColor' in dto).toBe(false)
  })
})

describe('toSelectionDto', () => {
  it('passes anchor/active positions through', () => {
    const dto = toSelectionDto({
      anchor: { line: 0, character: 1 },
      active: { line: 2, character: 3 },
    })
    expect(dto).toEqual({
      anchor: { line: 0, character: 1 },
      active: { line: 2, character: 3 },
    })
  })
})
