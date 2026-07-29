/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/color.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { Color, HSLA, RGBA } from '../../base/color.js'

describe('Color', () => {
  it('parses #RRGGBB hex', () => {
    const c = Color.fromHex('#1a2b3c')
    expect(c.rgba).toEqual(new RGBA(0x1a, 0x2b, 0x3c, 1))
  })

  it('parses #RRGGBBAA hex', () => {
    const c = Color.fromHex('#1a2b3c80')
    expect(c.rgba.r).toBe(0x1a)
    expect(c.rgba.a).toBeCloseTo(0x80 / 0xff, 3)
  })

  it('parses short #RGB and #RGBA', () => {
    expect(Color.fromHex('#abc').rgba).toEqual(new RGBA(0xaa, 0xbb, 0xcc, 1))
    expect(Color.fromHex('#abc8').rgba.a).toBeCloseTo(0x88 / 0xff, 3)
  })

  it('fromHex falls back to red on invalid input', () => {
    expect(Color.fromHex('nope').rgba).toEqual(Color.red.rgba)
  })

  it('round-trips through HSLA with at most 1/255 precision loss', () => {
    const c = Color.fromHex('#3a7bd5')
    const back = new Color(c.hsla)
    expect(Math.abs(back.rgba.r - c.rgba.r)).toBeLessThanOrEqual(1)
    expect(Math.abs(back.rgba.g - c.rgba.g)).toBeLessThanOrEqual(1)
    expect(Math.abs(back.rgba.b - c.rgba.b)).toBeLessThanOrEqual(1)
  })

  it('formats opaque colors as hex and translucent as rgba', () => {
    expect(Color.fromHex('#1a2b3c').toString()).toBe('#1a2b3c')
    expect(new Color(new RGBA(1, 2, 3, 0.5)).toString()).toBe('rgba(1, 2, 3, 0.5)')
  })

  it('formatHexA prints alpha, compact skips opaque alpha', () => {
    expect(Color.Format.CSS.formatHexA(new Color(new RGBA(1, 2, 3, 0.5)))).toBe('#01020380')
    expect(Color.Format.CSS.formatHexA(new Color(new RGBA(1, 2, 3, 1)), true)).toBe('#010203')
  })

  it('lighten increases and darken decreases luminosity', () => {
    const base = new Color(new HSLA(200, 0.5, 0.4, 1))
    expect(base.lighten(0.5).hsla.l).toBeCloseTo(0.6, 3)
    expect(base.darken(0.5).hsla.l).toBeCloseTo(0.2, 3)
  })

  it('transparent scales alpha', () => {
    expect(Color.fromHex('#ffffff').transparent(0.5).rgba.a).toBeCloseTo(0.5, 3)
  })

  it('mix interpolates channels (truncating like VSCode)', () => {
    const mixed = Color.black.mix(Color.white, 0.5)
    expect(mixed.rgba.r).toBe(127)
    expect(mixed.rgba.g).toBe(127)
    expect(mixed.rgba.b).toBe(127)
  })

  it('blend composites over transparent', () => {
    const blended = new Color(new RGBA(255, 0, 0, 0.5)).blend(new Color(new RGBA(0, 0, 255, 1)))
    expect(blended.rgba.b).toBe(127)
  })

  it('makeOpaque blends onto an opaque background', () => {
    const opaque = new Color(new RGBA(255, 255, 255, 0.5)).makeOpaque(Color.black)
    expect(opaque.rgba.a).toBe(1)
    expect(opaque.rgba.r).toBe(127)
  })

  it('parses css rgb()/rgba() and named keywords', () => {
    expect(Color.Format.CSS.parse('rgb(10, 20, 30)')?.rgba).toEqual(new RGBA(10, 20, 30, 1))
    expect(Color.Format.CSS.parse('rgba(10, 20, 30, 0.25)')?.rgba.a).toBeCloseTo(0.25, 3)
    expect(Color.Format.CSS.parse('rebeccapurple')?.rgba).toEqual(new RGBA(102, 51, 153, 1))
    expect(Color.Format.CSS.parse('transparent')?.rgba.a).toBe(0)
    expect(Color.Format.CSS.parse('not-a-color')).toBeNull()
  })

  it('toNumber32Bit packs RGBA channels', () => {
    expect(new Color(new RGBA(0x11, 0x22, 0x33, 1)).toNumber32Bit()).toBe(0x112233ff)
  })

  it('getLighterColor/getDarkerColor keep already-favorable colors', () => {
    const white = Color.white
    const black = Color.black
    const grey = Color.fromHex('#808080')
    expect(Color.getLighterColor(white, black)).toBe(white)
    expect(Color.getDarkerColor(black, white)).toBe(black)
    // Note: VSCode's lighten is a relative l-increment (l + l*factor), so pure
    // black never lightens; use grey for the adjustment assertions.
    expect(Color.getLighterColor(grey, white).isLighterThan(grey)).toBe(true)
    expect(Color.getDarkerColor(grey, black).isDarkerThan(grey)).toBe(true)
  })
})
