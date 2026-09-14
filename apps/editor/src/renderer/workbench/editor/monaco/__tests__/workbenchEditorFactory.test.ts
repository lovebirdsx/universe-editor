/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Guards the workbench's editor-overlay contract:
 *
 * 1. Every editor built through `createWorkbenchEditor` gets
 *    `fixedOverflowWidgets: true` — without it monaco positions its content
 *    widgets `absolute` inside the editor subtree and the workbench's
 *    `.editorContent { overflow: auto }` slices hover bubbles off at the
 *    editor-group border.
 * 2. No bare `monacoNs.editor.create(...)` call survives anywhere in the
 *    renderer — a new editor added without the flag silently regresses to the
 *    clipped behaviour, and nothing else would catch it. See `maskNonCode` for
 *    what a text scan can and cannot see.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createWorkbenchEditor } from '../workbenchEditorFactory.js'

type MonacoNamespace = Parameters<typeof createWorkbenchEditor>[0]
type EditorOptions = Parameters<typeof createWorkbenchEditor>[2]

const container = { tagName: 'DIV' } as unknown as HTMLElement

function stubMonaco(): { monacoNs: MonacoNamespace; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn(() => ({ id: 'editor' }))
  return { monacoNs: { editor: { create } } as unknown as MonacoNamespace, create }
}

function optionsOf(create: ReturnType<typeof vi.fn>, index = 0): EditorOptions {
  return create.mock.calls[index]![1] as EditorOptions
}

describe('createWorkbenchEditor', () => {
  it('turns fixedOverflowWidgets on for every editor', () => {
    const { monacoNs, create } = stubMonaco()

    createWorkbenchEditor(monacoNs, container, { automaticLayout: true, readOnly: true })

    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]![0]).toBe(container)
    expect(optionsOf(create)).toMatchObject({
      automaticLayout: true,
      readOnly: true,
      fixedOverflowWidgets: true,
    })
  })

  it('wins over a caller that passes fixedOverflowWidgets: false', () => {
    const { monacoNs, create } = stubMonaco()

    createWorkbenchEditor(monacoNs, container, { fixedOverflowWidgets: false })

    expect(optionsOf(create).fixedOverflowWidgets).toBe(true)
  })

  it('does not mutate the caller options object', () => {
    const { monacoNs } = stubMonaco()
    const options: EditorOptions = { automaticLayout: true }

    createWorkbenchEditor(monacoNs, container, options)

    expect(options).not.toHaveProperty('fixedOverflowWidgets')
  })

  it('passes overrides through untouched', () => {
    const { monacoNs, create } = stubMonaco()
    const overrides = { layoutService: { marker: true } }

    createWorkbenchEditor(monacoNs, container, {}, overrides)

    expect(create.mock.calls[0]![2]).toBe(overrides)
  })

  it('leaves overrides undefined when the caller never opted in', () => {
    const { monacoNs, create } = stubMonaco()

    createWorkbenchEditor(monacoNs, container, {})

    expect(create.mock.calls[0]![2]).toBeUndefined()
  })

  it('hands back the instance monaco created', () => {
    const { monacoNs, create } = stubMonaco()

    expect(createWorkbenchEditor(monacoNs, container, {})).toBe(create.mock.results[0]!.value)
  })
})

const rendererRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
const factoryFile = 'workbench/editor/monaco/workbenchEditorFactory.ts'

// Hosts that must build their editor through the factory. Diff editors are
// deliberately absent: monaco forces fixedOverflowWidgets onto a diff editor's
// inner editors, so `createDiffEditor` sites have nothing to gain here.
const EDITOR_HOSTS = [
  'workbench/editor/FileEditor.tsx',
  'workbench/editor/MergeEditor.tsx',
  'workbench/agents/PromptMonacoEditor.tsx',
  'workbench/panel/output/LogOutputView.tsx',
]

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__') yield* walk(path)
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      yield path
    }
  }
}

// `MonacoLoader.ts` documents the ordering constraint with the literal text
// "editor.create()" in a comment, so strip comments before matching — and strip
// string/template bodies in the same pass: this repo has globs that are not
// valid comments in disguise (`'**/*'`, `'./icons/*.svg'`, `"e.g. **/*.ts"`), and
// a masker that only knows comments would let one of them open a phantom block
// comment swallowing the code after it. Blanking strings also stops a string
// that merely mentions `editor.create(` from turning into a false positive.
//
// Known limits, deliberately not chased: regex literals are not tracked (telling
// `/` division from a regex needs parser context; an escaped `:\/\/` never opens
// a comment anyway), `${…}` inside a template is blanked along with it, and an
// aliased or computed call (`const { create } = ns.editor`, `ns.editor['create']`)
// is invisible to a text scan. The point is to catch the shape people actually
// write, not to be a parser.
function maskNonCode(source: string): string {
  const out: string[] = []
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out.push(source[k] === '\n' ? '\n' : ' ')
  }
  let i = 0
  while (i < source.length) {
    const char = source[i]!
    const next = source[i + 1]
    if (char === '/' && next === '/') {
      const start = i
      while (i < source.length && source[i] !== '\n') i++
      blank(start, i)
    } else if (char === '/' && next === '*') {
      const start = i
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++
      i = Math.min(i + 2, source.length)
      blank(start, i)
    } else if (char === "'" || char === '"' || char === '`') {
      const start = i
      i++
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2
          continue
        }
        const closing = source[i] === char
        i++
        if (closing) break
      }
      blank(start, i)
    } else {
      out.push(char)
      i++
    }
  }
  return out.join('')
}

describe('every renderer editor goes through the factory', () => {
  const files = [...walk(rendererRoot)].map((path) => ({
    rel: relative(rendererRoot, path).split(sep).join('/'),
    source: readFileSync(path, 'utf8'),
  }))

  it('has exactly one bare editor.create call site — the factory itself', () => {
    const offenders = files
      .filter(({ source }) => /\.editor\.create\s*\(/.test(maskNonCode(source)))
      .map(({ rel }) => rel)
      .filter((rel) => rel !== factoryFile)

    expect(
      offenders,
      'route new editor instances through createWorkbenchEditor() — a bare ' +
        'editor.create() loses fixedOverflowWidgets and its overlays get clipped',
    ).toEqual([])
  })

  it.each(EDITOR_HOSTS)('%s imports the factory', (host) => {
    const file = files.find(({ rel }) => rel === host)
    expect(file, `${host} not found`).toBeDefined()
    expect(file!.source).toMatch(/from '.*workbenchEditorFactory\.js'/)
    expect(file!.source).toMatch(/createWorkbenchEditor\(/)
  })
})
