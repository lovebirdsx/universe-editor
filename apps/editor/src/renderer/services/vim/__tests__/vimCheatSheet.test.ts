import { describe, expect, it } from 'vitest'
import type { IQuickPickItem, QuickPickInput } from '@universe-editor/platform'
import type { IVimKeymapEntry, VimSurfaceKind } from '@universe-editor/workbench-ui'
import { buildVimCheatSheetItems, vimSurfaceLabel } from '../vimCheatSheet.js'

const keymaps = new Map<VimSurfaceKind, readonly IVimKeymapEntry[]>([
  ['editor', [{ id: 'q', keys: ['space', 'q'], command: 'workbench.action.closeActiveEditor' }]],
  ['list', [{ id: 'j', keys: ['j'], command: 'list.focusDown', when: 'listFocus' }]],
])

function build(activeKind: VimSurfaceKind | undefined): QuickPickInput[] {
  return buildVimCheatSheetItems({
    activeKind,
    keymaps,
    editorHelp: [{ group: 'Motion', keys: 'w', description: 'Next word' }],
    resolveTitle: (command) => `T:${command}`,
  })
}

const surfaceSeparators = (items: QuickPickInput[]) =>
  items.filter((item) => 'type' in item && /^sep:[a-zA-Z]+$/.test(item.id)).map((item) => item.id)

describe('buildVimCheatSheetItems', () => {
  it('never emits two dividers in a row, so the surface name survives quick pick collapsing', () => {
    const items = build('editor')
    const collapsed = items.some((item, i) => 'type' in item && 'type' in (items[i + 1] ?? {}))
    expect(collapsed).toBe(false)
    const first = items[0] as { label: string }
    expect(first.label).toMatch(/^Editor \(current\) · Motion$/)
  })

  it('groups by surface and starts with the active one', () => {
    expect(surfaceSeparators(build('list'))).toEqual(['sep:list', 'sep:editor'])
    expect(surfaceSeparators(build(undefined))).toEqual(['sep:editor', 'sep:list'])
  })

  it('skips surfaces with no keys', () => {
    expect(surfaceSeparators(build(undefined))).not.toContain('sep:menu')
  })

  it('puts editor kernel help ahead of the workbench commands', () => {
    const ids = build('editor').map((item) => item.id)
    expect(ids.indexOf('editor:core:0')).toBeGreaterThan(-1)
    expect(ids.indexOf('editor:core:0')).toBeLessThan(ids.indexOf('editor:q'))
  })

  it('formats keys and titles and keeps command id and when searchable', () => {
    const items = build(undefined)
    const row = items.find((item) => item.id === 'list:j') as IQuickPickItem
    expect(row.label).toBe('j')
    expect(row.description).toBe('T:list.focusDown')
    expect(row.keywords).toEqual(['list.focusDown', 'listFocus'])
    const leader = items.find((item) => item.id === 'editor:q') as IQuickPickItem
    expect(leader.label).toBe('<Space>q')
  })

  it('marks only the active surface section as current', () => {
    const labels = (items: QuickPickInput[]) =>
      items
        .filter((item) => 'type' in item && /^sep:[a-zA-Z]+$/.test(item.id))
        .map((item) => (item as { label: string }).label)
    const active = labels(build('list'))
    expect(active[0]).toMatch(/\(current\)$/)
    expect(active.filter((label) => label.includes('(current)'))).toHaveLength(1)
    expect(labels(build(undefined)).some((label) => label.includes('(current)'))).toBe(false)
  })

  it('does not reorder or mark anything for a surface it does not list (webview)', () => {
    expect(surfaceSeparators(build('webview'))).toEqual(['sep:editor', 'sep:list'])
    expect(vimSurfaceLabel('webview')).toBe('Webviews')
    const marked = build('webview').some(
      (item) => 'label' in item && String(item.label).includes('(current)'),
    )
    expect(marked).toBe(false)
  })

  it('adds a Workbench Commands divider only when the editor has both core help and keymap', () => {
    const ids = build('editor').map((item) => item.id)
    expect(ids).toContain('sep:editor:workbench')
    expect(ids).toContain('sep:editor')
    expect(build('list').map((item) => item.id)).not.toContain('sep:list:workbench')
  })
})
