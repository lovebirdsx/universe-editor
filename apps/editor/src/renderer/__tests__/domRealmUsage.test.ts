/*---------------------------------------------------------------------------------------------
 *  Cross-realm guard.
 *
 *  Auxiliary editor windows are separate DOM realms rendered by the main renderer:
 *  `el instanceof HTMLElement` (and every sibling constructor) is false for their
 *  elements, which silently breaks focus, click-outside and drag handling. Use the
 *  shape checks from `packages/workbench-ui/src/dom/domRealm.ts` instead.
 *
 *  A text scan cannot see dynamic access (`(doc.defaultView as any).HTMLElement`),
 *  but it catches the mistake at the point it is usually written.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..')
const SCAN_ROOTS = [
  join(repoRoot, 'packages', 'workbench-ui', 'src'),
  join(repoRoot, 'apps', 'editor', 'src', 'renderer'),
]

const DOM_CONSTRUCTORS = new Set([
  'HTMLElement',
  'SVGElement',
  'Element',
  'Node',
  'Document',
  'DocumentFragment',
  'ShadowRoot',
  'Text',
  'Comment',
  'Range',
  'Selection',
  'DOMRect',
  'Event',
  'CustomEvent',
  'UIEvent',
  'KeyboardEvent',
  'MouseEvent',
  'PointerEvent',
  'FocusEvent',
  'DragEvent',
  'InputEvent',
  'CompositionEvent',
  'WheelEvent',
  'TouchEvent',
  'SubmitEvent',
  'AnimationEvent',
  'TransitionEvent',
  'MessageEvent',
  'ErrorEvent',
  'StorageEvent',
  'PopStateEvent',
  'HashChangeEvent',
  'BeforeUnloadEvent',
  'Window',
])

/** Catches every concrete HTML/SVG element constructor without listing them all. */
const DOM_ELEMENT_CONSTRUCTOR = /^(?:HTML|SVG|MathML)[A-Za-z]*Element$/

const INSTANCEOF = /\binstanceof\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'e2e' || name === 'node_modules' || name === 'dist') {
        continue
      }
      yield* sourceFiles(path)
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      yield path
    }
  }
}

/** Comment-only lines; enough for doc comments and line comments in this repo. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart()
  return trimmed.startsWith('*') || trimmed.startsWith('//')
}

/** Drop trailing line/block comments without truncating strings that contain `//`. */
function codeOf(line: string): string {
  let out = ''
  let quote: string | undefined
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!
    if (quote !== undefined) {
      out += char
      if (char === '\\') {
        out += line[++index] ?? ''
      } else if (char === quote) {
        quote = undefined
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      continue
    }
    if (char === '/' && line[index + 1] === '/') break
    if (char === '/' && line[index + 1] === '*') {
      const end = line.indexOf('*/', index + 2)
      if (end === -1) break
      index = end + 1
      continue
    }
    out += char
  }
  return out
}

function isDomConstructor(name: string): boolean {
  return DOM_CONSTRUCTORS.has(name) || DOM_ELEMENT_CONSTRUCTOR.test(name)
}

function violationsIn(file: string): string[] {
  const found: string[] = []
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (isCommentLine(line)) continue
    for (const match of codeOf(line).matchAll(INSTANCEOF)) {
      const lastSegment = match[1]!.split('.').at(-1)!
      if (!isDomConstructor(lastSegment)) continue
      found.push(`${file.split(sep).slice(-4).join('/')}:${index + 1} ${match[0]}`)
    }
  }
  return found
}

describe('DOM realm guard', () => {
  it('does not use realm-local DOM constructors in production code', () => {
    const violations = SCAN_ROOTS.flatMap((root) => [...sourceFiles(root)]).flatMap(violationsIn)
    expect(violations).toEqual([])
  })
})
