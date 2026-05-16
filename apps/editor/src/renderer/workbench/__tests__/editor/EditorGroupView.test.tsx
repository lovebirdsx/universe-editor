/*---------------------------------------------------------------------------------------------
 *  Tests for EditorGroupView.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { EditorInput, EditorRegistry, URI } from '@universe-editor/platform'
import { EditorGroupView } from '../../editor/EditorGroupView.js'
import { EditorGroupsService } from '../../editor/EditorGroupsService.js'

class FakeEditor extends EditorInput {
  constructor(private readonly _name: string) {
    super()
  }
  get typeId() {
    return 'fake'
  }
  get resource() {
    return URI.file(`D:/${this._name}.txt`)
  }
  getName() {
    return this._name
  }
}

function FakeComponent({ input }: { input: { label: string } }) {
  return <div data-testid="fake-editor">{input.label}</div>
}

const map = new Map<string, React.ComponentType<{ input: { label: string } }>>([
  ['fake', FakeComponent],
])

describe('EditorGroupView', () => {
  it('renders fallback when group has no editors', () => {
    const svc = new EditorGroupsService()
    render(
      <EditorGroupView
        group={svc.activeGroup}
        groupsService={svc}
        componentMap={map as never}
        fallback={<span>welcome-fallback</span>}
      />,
    )
    expect(screen.getByText('welcome-fallback')).toBeTruthy()
  })

  it('renders one tab per editor', () => {
    const svc = new EditorGroupsService()
    svc.activeGroup.openEditor(new FakeEditor('a'))
    svc.activeGroup.openEditor(new FakeEditor('b'))
    render(
      <EditorGroupView group={svc.activeGroup} groupsService={svc} componentMap={map as never} />,
    )
    expect(screen.getAllByRole('tab').length).toBe(2)
  })

  it('clicking a tab activates that editor', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    const b = new FakeEditor('b')
    svc.activeGroup.openEditor(a)
    svc.activeGroup.openEditor(b)
    render(
      <EditorGroupView group={svc.activeGroup} groupsService={svc} componentMap={map as never} />,
    )
    const tabs = screen.getAllByRole('tab')
    fireEvent.click(tabs[0]!)
    expect(svc.activeGroup.activeEditor).toBe(a)
  })

  it('mousedown on a non-active group activates it', () => {
    const svc = new EditorGroupsService()
    const second = svc.addGroup(svc.activeGroup, 3 /* Right */)
    // svc.activeGroup is still the first group
    const onChange = vi.fn()
    svc.onDidActiveGroupChange(onChange)
    const { container } = render(
      <EditorGroupView group={second} groupsService={svc} componentMap={map as never} />,
    )
    fireEvent.mouseDown(container.firstElementChild!)
    expect(svc.activeGroup).toBe(second)
    expect(onChange).toHaveBeenCalledOnce()
  })

  it('active editor renders via componentMap', () => {
    const svc = new EditorGroupsService()
    const a = new FakeEditor('a')
    const reg = EditorRegistry.registerEditorProvider({ typeId: 'fake', componentKey: 'fake' })
    try {
      svc.activeGroup.openEditor(a)
      render(
        <EditorGroupView group={svc.activeGroup} groupsService={svc} componentMap={map as never} />,
      )
      expect(screen.getByTestId('fake-editor').textContent).toBe('a')
    } finally {
      reg.dispose()
    }
  })
})
