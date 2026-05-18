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

const MASK_KEYCODE = 0x00ff
const MASK_CTRLCMD = 0x0800
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
