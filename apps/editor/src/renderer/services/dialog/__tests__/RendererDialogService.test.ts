/*---------------------------------------------------------------------------------------------
 *  RendererDialogService — 队列决议按 entry 身份，而不是队头。
 *
 *  同一对话框可能回报两次（按钮 Enter + 背景 Enter、IME、双击）；每次调用都
 *  盲移队头会把第一个结果错答给下一个对话框。
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { IConfirmResult } from '@universe-editor/platform'
import { RendererDialogService } from '../RendererDialogService.js'
import {
  registerWorkbenchDocument,
  setActiveWorkbenchDocument,
} from '../../windows/workbenchDocuments.js'

function withDocument(): { dispose(): void } {
  // Node 环境：服务只按活动 workbench document 落 stamp，注册表条目就够了。
  return registerWorkbenchDocument({ body: {} } as unknown as Document)
}

const FIRST: IConfirmResult = {
  confirmed: true,
  choice: 'primary',
  neverAskAgain: false,
}
const SECOND: IConfirmResult = {
  confirmed: false,
  choice: 'cancel',
  neverAskAgain: false,
}

describe('RendererDialogService', () => {
  it('ignores a duplicate resolution and keeps the next dialog queued', async () => {
    const registration = withDocument()
    const svc = new RendererDialogService()
    const first = svc.confirm({ message: 'first' })
    const second = svc.confirm({ message: 'second' })
    const [entry1, entry2] = svc.queue
    expect(entry1).toBeDefined()
    expect(entry2).toBeDefined()

    svc._resolveEntry(entry1!, FIRST)
    svc._resolveEntry(entry1!, SECOND)

    await expect(first).resolves.toBe(FIRST)
    expect(svc.queue).toEqual([entry2])

    svc._resolveEntry(entry2!, SECOND)
    await expect(second).resolves.toBe(SECOND)
    expect(svc.queue).toEqual([])
    svc.dispose()
    registration.dispose()
  })

  it('ignores a resolution for an entry that is no longer queued', async () => {
    const registration = withDocument()
    const svc = new RendererDialogService()
    const first = svc.confirm({ message: 'first' })
    const stale = svc.queue[0]!
    svc._resolveEntry(stale, FIRST)
    // 已销毁对话框的迟到回报不能决议此刻恰好位于队头的新 entry。
    const second = svc.prompt({ title: 'second' })
    svc._resolveEntry(stale, 'stale')
    expect(svc.queue).toHaveLength(1)

    await expect(first).resolves.toBe(FIRST)
    svc._resolveEntry(svc.queue[0]!, 'fresh')
    await expect(second).resolves.toBe('fresh')
    svc.dispose()
    registration.dispose()
  })

  it('assigns a fresh monotonic id to every enqueued entry', async () => {
    const registration = withDocument()
    const svc = new RendererDialogService()
    const first = svc.confirm({ message: 'first' })
    const second = svc.prompt({ title: 'second' })
    const [firstEntry, secondEntry] = svc.queue
    expect(firstEntry!.id).not.toBe(secondEntry!.id)
    expect(secondEntry!.id).toBeGreaterThan(firstEntry!.id)

    svc._resolveEntry(firstEntry!, FIRST)
    const third = svc.confirm({ message: 'third' })
    const thirdEntry = svc.queue[1]!
    expect(thirdEntry.id).toBeGreaterThan(secondEntry!.id)

    svc._resolveEntry(secondEntry!, 'answer')
    svc._resolveEntry(thirdEntry, SECOND)
    await expect(first).resolves.toBe(FIRST)
    await expect(second).resolves.toBe('answer')
    await expect(third).resolves.toBe(SECOND)
    svc.dispose()
    registration.dispose()
  })
})

describe('RendererDialogService — origin window closed', () => {
  it('cancels every queued dialog owned by the closed document', async () => {
    const doc = { body: {} } as unknown as Document
    const registration = registerWorkbenchDocument(doc)
    setActiveWorkbenchDocument(doc)
    const svc = new RendererDialogService()
    const confirmed = svc.confirm({ message: 'confirm' })
    const prompted = svc.prompt({ title: 'prompt' })
    expect(svc.queue).toHaveLength(2)

    registration.dispose()

    await expect(confirmed).resolves.toEqual(SECOND)
    await expect(prompted).resolves.toBeUndefined()
    expect(svc.queue).toEqual([])
    svc.dispose()
  })

  it('echoes checkbox state and returns a fresh result per cancelled entry', async () => {
    const doc = { body: {} } as unknown as Document
    const registration = registerWorkbenchDocument(doc)
    setActiveWorkbenchDocument(doc)
    const svc = new RendererDialogService()
    const withCheckboxes = svc.confirm({
      message: 'checked',
      checkboxes: [{ label: 'a', initiallyChecked: true }, { label: 'b' }],
    })
    const plain = svc.confirm({ message: 'plain' })

    registration.dispose()

    const first = await withCheckboxes
    expect(first).toEqual({
      confirmed: false,
      choice: 'cancel',
      neverAskAgain: false,
      checkboxChecked: [true, false],
    })
    // Callers own the result; a shared constant would let one mutate the next.
    expect(await plain).not.toBe(first)
    svc.dispose()
  })

  it('leaves dialogs owned by other documents queued and resolvable', async () => {
    const main = { body: {} } as unknown as Document
    const aux = { body: {} } as unknown as Document
    const mainRegistration = registerWorkbenchDocument(main)
    const auxRegistration = registerWorkbenchDocument(aux)
    setActiveWorkbenchDocument(main)
    const svc = new RendererDialogService()
    const first = svc.confirm({ message: 'main' })

    setActiveWorkbenchDocument(aux)
    const second = svc.confirm({ message: 'aux' })
    expect(svc.queue).toHaveLength(2)

    auxRegistration.dispose()

    await expect(second).resolves.toEqual(SECOND)
    expect(svc.queue).toHaveLength(1)
    svc._resolveEntry(svc.queue[0]!, FIRST)
    await expect(first).resolves.toBe(FIRST)
    svc.dispose()
    mainRegistration.dispose()
  })
})
