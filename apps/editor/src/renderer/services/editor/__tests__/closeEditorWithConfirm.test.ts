/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/editor/closeEditorWithConfirm.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  EditorInput,
  URI,
  type IConfirmOptions,
  type IConfirmResult,
  type IDialogService,
  type IEditorGroup,
} from '@universe-editor/platform'
import { closeEditorWithConfirm } from '../closeEditorWithConfirm.js'

class FakeEditorInput extends EditorInput {
  saveImpl = vi.fn(async (): Promise<boolean> => true)

  constructor(
    private readonly _resource: URI,
    private readonly _dirty: boolean,
  ) {
    super()
    if (_dirty) this.setDirty(true)
  }

  override get typeId(): string {
    return 'fake'
  }
  override get resource(): URI {
    return this._resource
  }
  override getName(): string {
    return 'fake.txt'
  }
  override async save(): Promise<boolean> {
    return this.saveImpl()
  }
}

class FakeDialogService implements IDialogService {
  declare readonly _serviceBrand: undefined
  result: IConfirmResult = { confirmed: false, choice: 'cancel' }
  readonly confirmCalls: IConfirmOptions[] = []

  async confirm(opts: IConfirmOptions): Promise<IConfirmResult> {
    this.confirmCalls.push(opts)
    return this.result
  }
  async prompt(): Promise<string | undefined> {
    return undefined
  }
}

function makeGroup(): IEditorGroup & { closed: EditorInput[] } {
  const closed: EditorInput[] = []
  return {
    closeEditor(e: EditorInput) {
      closed.push(e)
      return true
    },
    closed,
  } as unknown as IEditorGroup & { closed: EditorInput[] }
}

describe('closeEditorWithConfirm', () => {
  it('closes immediately when input is clean', async () => {
    const input = new FakeEditorInput(URI.file('/a.txt'), false)
    const group = makeGroup()
    const dialog = new FakeDialogService()
    const ok = await closeEditorWithConfirm(input, group, dialog)
    expect(ok).toBe(true)
    expect(group.closed).toContain(input)
    expect(dialog.confirmCalls).toHaveLength(0)
  })

  it('dirty + primary: saves then closes', async () => {
    const input = new FakeEditorInput(URI.file('/a.txt'), true)
    const group = makeGroup()
    const dialog = new FakeDialogService()
    dialog.result = { confirmed: true, choice: 'primary' }
    const ok = await closeEditorWithConfirm(input, group, dialog)
    expect(ok).toBe(true)
    expect(input.saveImpl).toHaveBeenCalledTimes(1)
    expect(group.closed).toContain(input)
  })

  it("dirty + secondary (don't save): closes without saving", async () => {
    const input = new FakeEditorInput(URI.file('/a.txt'), true)
    const group = makeGroup()
    const dialog = new FakeDialogService()
    dialog.result = { confirmed: false, choice: 'secondary' }
    const ok = await closeEditorWithConfirm(input, group, dialog)
    expect(ok).toBe(true)
    expect(input.saveImpl).not.toHaveBeenCalled()
    expect(group.closed).toContain(input)
  })

  it('dirty + cancel: does not close, returns false', async () => {
    const input = new FakeEditorInput(URI.file('/a.txt'), true)
    const group = makeGroup()
    const dialog = new FakeDialogService()
    dialog.result = { confirmed: false, choice: 'cancel' }
    const ok = await closeEditorWithConfirm(input, group, dialog)
    expect(ok).toBe(false)
    expect(group.closed).not.toContain(input)
  })

  it('save returning false leaves the editor open', async () => {
    const input = new FakeEditorInput(URI.file('/a.txt'), true)
    input.saveImpl.mockResolvedValueOnce(false)
    const group = makeGroup()
    const dialog = new FakeDialogService()
    dialog.result = { confirmed: true, choice: 'primary' }
    const ok = await closeEditorWithConfirm(input, group, dialog)
    expect(ok).toBe(false)
    expect(group.closed).not.toContain(input)
  })
})
