/*---------------------------------------------------------------------------------------------
 *  Tests for the fragment-targeted copy actions (image / resource path /
 *  context text / reference) fed by the chat and prompt context menus.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  IHostService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import {
  CopyAcpContextTextAction,
  CopyAcpImageAction,
  CopyAcpReferenceAction,
  CopyAcpResourcePathAction,
} from '../agentTimelineActions.js'

const disposables: IDisposable[] = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.dispose()
  vi.unstubAllGlobals()
})

function makeHostService() {
  const writeClipboardImage = vi.fn().mockResolvedValue(undefined)
  const mock = { _serviceBrand: undefined, writeClipboardImage } as never
  return { mock, writeClipboardImage }
}

function stubClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  return writeText
}

function runCommand(commandId: string, host: ReturnType<typeof makeHostService>, arg?: unknown) {
  const services = new ServiceCollection()
  services.set(IHostService, host.mock)
  const inst = new InstantiationService(services)
  return inst.invokeFunction((accessor) =>
    Promise.resolve(CommandsRegistry.getCommand(commandId)!.handler(accessor, arg)),
  )
}

describe('CopyAcpImageAction', () => {
  it('registers into both the chat and prompt context menus', () => {
    disposables.push(registerAction2(CopyAcpImageAction))
    expect(
      MenuRegistry.getMenuItems(MenuId.AcpChatContext).some(
        (i) => 'command' in i && i.command === CopyAcpImageAction.ID,
      ),
    ).toBe(true)
    expect(
      MenuRegistry.getMenuItems(MenuId.AcpPromptContext).some(
        (i) => 'command' in i && i.command === CopyAcpImageAction.ID,
      ),
    ).toBe(true)
  })

  it('writes a PNG data-uri image to the clipboard as raw base64', async () => {
    disposables.push(registerAction2(CopyAcpImageAction))
    const host = makeHostService()
    const writeText = stubClipboard()

    await runCommand(CopyAcpImageAction.ID, host, {
      sessionId: 's1',
      target: { kind: 'image', src: 'data:image/png;base64,QUJD' },
    })

    expect(host.writeClipboardImage).toHaveBeenCalledWith('QUJD')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('ignores non-image targets', async () => {
    disposables.push(registerAction2(CopyAcpImageAction))
    const host = makeHostService()

    await runCommand(CopyAcpImageAction.ID, host, {
      sessionId: 's1',
      target: { kind: 'path', uri: 'file:///w/src/a.ts' },
    })
    await runCommand(CopyAcpImageAction.ID, host, { sessionId: 's1' })

    expect(host.writeClipboardImage).not.toHaveBeenCalled()
  })

  it('stays silent when the image cannot be converted', async () => {
    disposables.push(registerAction2(CopyAcpImageAction))
    const host = makeHostService()
    host.writeClipboardImage.mockRejectedValueOnce(new Error('nope'))

    await expect(
      runCommand(CopyAcpImageAction.ID, host, {
        sessionId: 's1',
        target: { kind: 'image', src: 'data:image/png;base64,QUJD' },
      }),
    ).resolves.toBeUndefined()
  })
})

describe('CopyAcpResourcePathAction', () => {
  it('copies the fsPath of a file: URI', async () => {
    disposables.push(registerAction2(CopyAcpResourcePathAction))
    const writeText = stubClipboard()

    await runCommand(CopyAcpResourcePathAction.ID, makeHostService(), {
      sessionId: 's1',
      target: { kind: 'path', uri: 'file:///w/src/a.ts' },
    })

    expect(writeText).toHaveBeenCalledWith(URI.parse('file:///w/src/a.ts').fsPath)
    expect(writeText).not.toHaveBeenCalledWith('file:///w/src/a.ts')
  })

  it('copies the raw string for non-file URIs', async () => {
    disposables.push(registerAction2(CopyAcpResourcePathAction))
    const writeText = stubClipboard()

    await runCommand(CopyAcpResourcePathAction.ID, makeHostService(), {
      sessionId: 's1',
      target: { kind: 'path', uri: 'https://example.com/spec' },
    })

    expect(writeText).toHaveBeenCalledWith('https://example.com/spec')
  })

  it('ignores non-path targets', async () => {
    disposables.push(registerAction2(CopyAcpResourcePathAction))
    const writeText = stubClipboard()

    await runCommand(CopyAcpResourcePathAction.ID, makeHostService(), {
      sessionId: 's1',
      target: { kind: 'text', text: 'hello' },
    })

    expect(writeText).not.toHaveBeenCalled()
  })
})

describe('CopyAcpContextTextAction', () => {
  it('gates its AcpPromptContext entry on acpPromptContextChipText', () => {
    disposables.push(registerAction2(CopyAcpContextTextAction))
    const cks = new ContextKeyService()
    disposables.push(cks)
    const key = cks.createKey<boolean>('acpPromptContextChipText', false)
    const visible = (): boolean =>
      MenuRegistry.getMenuItems(MenuId.AcpPromptContext, cks).some(
        (i) => 'command' in i && i.command === CopyAcpContextTextAction.ID,
      )

    expect(visible()).toBe(false)
    key.set(true)
    expect(visible()).toBe(true)
  })

  it('copies the chip text verbatim', async () => {
    disposables.push(registerAction2(CopyAcpContextTextAction))
    const writeText = stubClipboard()

    await runCommand(CopyAcpContextTextAction.ID, makeHostService(), {
      sessionId: 's1',
      target: { kind: 'text', text: 'const x = 1' },
    })

    expect(writeText).toHaveBeenCalledWith('const x = 1')
  })

  it('ignores non-text targets', async () => {
    disposables.push(registerAction2(CopyAcpContextTextAction))
    const writeText = stubClipboard()

    await runCommand(CopyAcpContextTextAction.ID, makeHostService(), {
      sessionId: 's1',
      target: { kind: 'image', src: 'data:image/png;base64,QUJD' },
    })

    expect(writeText).not.toHaveBeenCalled()
  })
})

describe('CopyAcpReferenceAction', () => {
  it('registers into the prompt context menu', () => {
    disposables.push(registerAction2(CopyAcpReferenceAction))
    expect(
      MenuRegistry.getMenuItems(MenuId.AcpPromptContext).some(
        (i) => 'command' in i && i.command === CopyAcpReferenceAction.ID,
      ),
    ).toBe(true)
  })

  it('copies the reference text verbatim', async () => {
    disposables.push(registerAction2(CopyAcpReferenceAction))
    const writeText = stubClipboard()

    await runCommand(CopyAcpReferenceAction.ID, makeHostService(), {
      sessionId: 's1',
      target: { kind: 'text', text: '@src/a.ts' },
    })

    expect(writeText).toHaveBeenCalledWith('@src/a.ts')
  })
})
