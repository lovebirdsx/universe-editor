/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  monacoKeybindingDecoder — decode Monaco's numeric keybinding encoding
 *  (KeyMod | KeyCode, with two chords packed into a single i32) into the
 *  platform-neutral string format used by KeybindingsRegistry, e.g.
 *  'ctrl+shift+k' or ['ctrl+k', 'ctrl+s'].
 *
 *  Encoding reference (monaco-editor 0.52, vs/base/common/keybindings.js):
 *    firstChord  = keybinding & 0x0000FFFF
 *    secondChord = (keybinding & 0xFFFF0000) >>> 16
 *  Per chord, low 8 bits are KeyCode and bits 8..11 are modifier flags:
 *    CtrlCmd = 0x0800  Shift = 0x0400  Alt = 0x0200  WinCtrl = 0x0100
 *  On Windows/Linux, CtrlCmd → ctrl, WinCtrl → meta.
 *--------------------------------------------------------------------------------------------*/

import { normalizeKeybindingString } from '@universe-editor/platform'

const MASK_KEYCODE = 0x00ff
export const MASK_CTRLCMD = 0x0800
const MASK_SHIFT = 0x0400
const MASK_ALT = 0x0200
const MASK_WINCTRL = 0x0100

// Monaco KeyCode enum → platform-neutral key token. Numeric values lifted from
// monaco-editor/esm/vs/editor/common/standalone/standaloneEnums.js. Missing /
// non-textual keys (modifiers themselves, IME composition, media keys, etc.)
// are intentionally absent — a numeric keybinding that maps to one of those
// is reported as unsupported and skipped by the bridge.
const KEYCODE_TO_TOKEN: Readonly<Record<number, string>> = {
  1: 'backspace',
  2: 'tab',
  3: 'enter',
  7: 'pausebreak',
  8: 'capslock',
  9: 'escape',
  10: 'space',
  11: 'pageup',
  12: 'pagedown',
  13: 'end',
  14: 'home',
  15: 'arrowleft',
  16: 'arrowup',
  17: 'arrowright',
  18: 'arrowdown',
  19: 'insert',
  20: 'delete',
  21: '0',
  22: '1',
  23: '2',
  24: '3',
  25: '4',
  26: '5',
  27: '6',
  28: '7',
  29: '8',
  30: '9',
  31: 'a',
  32: 'b',
  33: 'c',
  34: 'd',
  35: 'e',
  36: 'f',
  37: 'g',
  38: 'h',
  39: 'i',
  40: 'j',
  41: 'k',
  42: 'l',
  43: 'm',
  44: 'n',
  45: 'o',
  46: 'p',
  47: 'q',
  48: 'r',
  49: 's',
  50: 't',
  51: 'u',
  52: 'v',
  53: 'w',
  54: 'x',
  55: 'y',
  56: 'z',
  58: 'contextmenu',
  59: 'f1',
  60: 'f2',
  61: 'f3',
  62: 'f4',
  63: 'f5',
  64: 'f6',
  65: 'f7',
  66: 'f8',
  67: 'f9',
  68: 'f10',
  69: 'f11',
  70: 'f12',
  71: 'f13',
  72: 'f14',
  73: 'f15',
  74: 'f16',
  75: 'f17',
  76: 'f18',
  77: 'f19',
  78: 'f20',
  79: 'f21',
  80: 'f22',
  81: 'f23',
  82: 'f24',
  83: 'numlock',
  84: 'scrolllock',
  85: ';',
  86: '=',
  87: ',',
  88: '-',
  89: '.',
  90: '/',
  91: '`',
  92: '[',
  93: '\\',
  94: ']',
  95: "'",
  98: 'numpad0',
  99: 'numpad1',
  100: 'numpad2',
  101: 'numpad3',
  102: 'numpad4',
  103: 'numpad5',
  104: 'numpad6',
  105: 'numpad7',
  106: 'numpad8',
  107: 'numpad9',
  108: 'numpad_multiply',
  109: 'numpad_add',
  111: 'numpad_subtract',
  112: 'numpad_decimal',
  113: 'numpad_divide',
}

// Reverse of KEYCODE_TO_TOKEN, derived from the single source above so callers
// that need to *encode* a key (e.g. the core-command side-table in
// monacoActionsBridge) don't re-hardcode keycode magic numbers.
export const TOKEN_TO_KEYCODE: Readonly<Record<string, number>> = Object.fromEntries(
  Object.entries(KEYCODE_TO_TOKEN).map(([code, token]) => [token, Number(code)]),
)

function decodeChord(chord: number): string | undefined {
  const keyCode = chord & MASK_KEYCODE
  if (keyCode === 0) return undefined
  const token = KEYCODE_TO_TOKEN[keyCode]
  if (token === undefined) return undefined
  // Emit modifiers in the same lexicographic order KeybindingsRegistry's
  // internal normalizeKey() produces, so the decoder's output is already in
  // canonical form. Order: alt → ctrl → meta → shift.
  const parts: string[] = []
  if (chord & MASK_ALT) parts.push('alt')
  if (chord & MASK_CTRLCMD) parts.push('ctrl')
  if (chord & MASK_WINCTRL) parts.push('meta')
  if (chord & MASK_SHIFT) parts.push('shift')
  parts.push(token)
  return parts.join('+')
}

export interface DecodedKeybinding {
  /** Single-stroke key, e.g. 'ctrl+shift+k'. Mutually exclusive with chords. */
  key?: string
  /** Two-stroke chord, e.g. ['ctrl+k', 'ctrl+s']. */
  chords?: readonly [string, string]
}

/**
 * Decode a Monaco numeric keybinding into the platform-neutral string form
 * KeybindingsRegistry accepts. Returns undefined when the binding is empty
 * or references a key code the bridge does not surface (e.g. media keys).
 */
export function decodeMonacoKeybinding(keybinding: number): DecodedKeybinding | undefined {
  if (!keybinding) return undefined
  const firstRaw = keybinding & 0x0000ffff
  const secondRaw = (keybinding >>> 16) & 0x0000ffff
  const first = decodeChord(firstRaw)
  if (first === undefined) return undefined
  if (secondRaw === 0) return { key: first }
  const second = decodeChord(secondRaw)
  if (second === undefined) return undefined
  return { chords: [first, second] }
}

// The decoder emits the long arrow tokens ('arrowleft' …); the registry key
// space — what KeybindingsRegistry and useGlobalKeybindingHandler.buildKeyString
// operate on — uses the short form ('left' …). Mirror that map's only entries.
const DECODER_TOKEN_TO_REGISTRY: Readonly<Record<string, string>> = {
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
}

function chordToRegistryKeyString(chord: string): string {
  const parts = chord.split('+')
  const last = parts.length - 1
  parts[last] = DECODER_TOKEN_TO_REGISTRY[parts[last]!] ?? parts[last]!
  return normalizeKeybindingString(parts.join('+'))
}

// Reverse of DECODER_TOKEN_TO_REGISTRY: registry short form → the decoder token
// that TOKEN_TO_KEYCODE is keyed by, so encoding can resolve 'left' → keycode.
const REGISTRY_TOKEN_TO_DECODER: Readonly<Record<string, string>> = {
  left: 'arrowleft',
  right: 'arrowright',
  up: 'arrowup',
  down: 'arrowdown',
}

function encodeChord(chord: string): number | undefined {
  const parts = normalizeKeybindingString(chord).split('+')
  let mods = 0
  let keyToken: string | undefined
  for (const part of parts) {
    switch (part) {
      case 'ctrl':
        mods |= MASK_CTRLCMD
        break
      case 'shift':
        mods |= MASK_SHIFT
        break
      case 'alt':
        mods |= MASK_ALT
        break
      case 'meta':
        mods |= MASK_WINCTRL
        break
      default:
        if (keyToken !== undefined) return undefined
        keyToken = part
    }
  }
  if (keyToken === undefined) return undefined
  const keyCode = TOKEN_TO_KEYCODE[REGISTRY_TOKEN_TO_DECODER[keyToken] ?? keyToken]
  if (keyCode === undefined) return undefined
  return mods | keyCode
}

/**
 * Inverse of {@link decodedToRegistryKeyString}: encode a registry key-space
 * string (single stroke or space-joined 2-stroke chord) into Monaco's numeric
 * KeyMod | KeyCode form. Returns undefined when any token is not encodable —
 * the caller then falls back to a whole-command unbind. Used to disable one
 * specific Monaco default key (e.g. F3) without touching its siblings (Enter).
 */
export function encodeRegistryKeyToMonaco(key: string): number | undefined {
  const strokes = key.trim().split(/\s+/)
  if (strokes.length === 1) {
    if (strokes[0] === '') return undefined
    return encodeChord(strokes[0]!)
  }
  if (strokes.length === 2) {
    const first = encodeChord(strokes[0]!)
    const second = encodeChord(strokes[1]!)
    if (first === undefined || second === undefined) return undefined
    return (first & 0x0000ffff) | ((second & 0x0000ffff) << 16)
  }
  return undefined
}

/**
 * Convert a {@link DecodedKeybinding} into the registry key-space string used by
 * KeybindingsRegistry — the single shared key space (D7). Chords are joined with
 * a space, matching the `'ctrl+k ctrl+s'` form used elsewhere (user keybindings).
 */
export function decodedToRegistryKeyString(decoded: DecodedKeybinding): string {
  if (decoded.chords) {
    return `${chordToRegistryKeyString(decoded.chords[0])} ${chordToRegistryKeyString(decoded.chords[1])}`
  }
  return chordToRegistryKeyString(decoded.key!)
}
