/*---------------------------------------------------------------------------------------------
 *  Tests for the fragment-targeted copy actions (image / resource path /
 *  context text / reference) fed by the chat and prompt context menus.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CommandsRegistry,
  ContextKeyService,
  IEditorGroupsService,
  IEditorResolverService,
  IHostService,
  IWorkspaceService,
  InstantiationService,
  MenuId,
  MenuRegistry,
  ServiceCollection,
  URI,
  observableValue,
  registerAction2,
  type IDisposable,
} from '@universe-editor/platform'
import {
  CopyAcpContextTextAction,
  CopyAcpImageAction,
  CopyAcpReferenceAction,
  CopyAcpResourcePathAction,
  CopyAcpSubAgentTranscriptAction,
  OpenAcpToolCallFileAction,
  OpenAcpToolCallPreviewAction,
} from '../agentTimelineActions.js'
import {
  IAcpSessionService,
  type AcpMessage,
  type AcpToolCall,
  type IAcpSession,
  type TimelineItem,
} from '../../services/acp/session/acpSessionService.js'

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

describe('Card-targeted actions from the timeline menu', () => {
  const SESSION_ID = 's1'

  function makeAgentMessage(id: string): AcpMessage {
    return { id, role: 'agent', text: id, blocks: [], streaming: false }
  }

  function makeSession(items: readonly TimelineItem[]): IAcpSession {
    return {
      id: SESSION_ID,
      timeline: observableValue('t.timeline', items),
    } as unknown as IAcpSession
  }

  function runCardCommand(
    commandId: string,
    items: readonly TimelineItem[],
    arg: unknown,
    extra: {
      groups?: unknown
      resolver?: unknown
      workspace?: unknown
    } = {},
  ): { openedInGroup: unknown[]; resolvedOpens: { resource: unknown; options: unknown }[] } {
    const openedInGroup: unknown[] = []
    const resolvedOpens: { resource: unknown; options: unknown }[] = []
    const group = {
      findEditor: () => undefined,
      openEditor: (input: unknown) => {
        openedInGroup.push(input)
        return Promise.resolve(undefined)
      },
    }
    const services = new ServiceCollection()
    services.set(IAcpSessionService, {
      _serviceBrand: undefined,
      getById: (id: string) => (id === SESSION_ID ? makeSession(items) : undefined),
    } as unknown as IAcpSessionService)
    services.set(
      IEditorGroupsService,
      (extra.groups ?? {
        _serviceBrand: undefined,
        activeGroup: group,
        getGroups: () => [group],
        activateGroup: vi.fn(),
      }) as never,
    )
    services.set(
      IEditorResolverService,
      (extra.resolver ?? {
        _serviceBrand: undefined,
        openEditor: (resource: unknown, options: unknown) => {
          resolvedOpens.push({ resource, options })
          return Promise.resolve(undefined)
        },
      }) as never,
    )
    services.set(
      IWorkspaceService,
      (extra.workspace ?? { _serviceBrand: undefined, current: null }) as never,
    )
    const inst = new InstantiationService(services)
    inst.invokeFunction((accessor) =>
      Promise.resolve(CommandsRegistry.getCommand(commandId)!.handler(accessor, arg)),
    )
    return { openedInGroup, resolvedOpens }
  }

  const taskCall = (children: AcpToolCall['children']): TimelineItem => ({
    kind: 'toolCall',
    id: 'task',
    call: {
      id: 'task',
      title: 'Task: explore',
      kind: 'other',
      status: 'completed',
      text: 'parent output',
      blocks: [],
      diffs: [{ path: '/repo/a.ts', oldText: '', newText: 'x' }],
      ...(children !== undefined ? { children } : {}),
    },
  })

  const childMessage = (
    id: string,
    text: string,
  ): NonNullable<AcpToolCall['children']>[number] => ({
    kind: 'message',
    id,
    message: { id, role: 'agent', text, blocks: [], streaming: false },
  })

  it('copies only the sub-agent transcript, without the parent card', async () => {
    disposables.push(registerAction2(CopyAcpSubAgentTranscriptAction))
    const writeText = stubClipboard()

    runCardCommand(
      CopyAcpSubAgentTranscriptAction.ID,
      [taskCall([childMessage('sm1', 'sub one')])],
      {
        sessionId: SESSION_ID,
        slotKey: 't:task',
      },
    )

    expect(writeText).toHaveBeenCalledWith('sub one')
  })

  it('writes nothing when the card has no sub-agent timeline', async () => {
    disposables.push(registerAction2(CopyAcpSubAgentTranscriptAction))
    const writeText = stubClipboard()

    runCardCommand(CopyAcpSubAgentTranscriptAction.ID, [taskCall([])], {
      sessionId: SESSION_ID,
      slotKey: 't:task',
    })
    // A key that resolves to a plain message is not a transcript either.
    runCardCommand(
      CopyAcpSubAgentTranscriptAction.ID,
      [{ kind: 'message', id: 'a', message: makeAgentMessage('a') }],
      { sessionId: SESSION_ID, slotKey: 'm:a' },
    )

    expect(writeText).not.toHaveBeenCalled()
  })

  it('opens a previewable whole-file write as a preview', () => {
    disposables.push(registerAction2(OpenAcpToolCallPreviewAction))
    const { openedInGroup, resolvedOpens } = runCardCommand(
      OpenAcpToolCallPreviewAction.ID,
      [
        {
          kind: 'toolCall',
          id: 'w',
          call: {
            id: 'w',
            title: 'Write notes.md',
            kind: 'edit',
            status: 'completed',
            text: '',
            blocks: [],
            diffs: [{ path: '/repo/notes.md', oldText: '', newText: '# hi\n' }],
          },
        },
      ],
      { sessionId: SESSION_ID, slotKey: 't:w' },
    )

    expect(openedInGroup).toHaveLength(1)
    expect(resolvedOpens).toHaveLength(0)
  })

  it('opens any other whole-file write in the editor', () => {
    disposables.push(registerAction2(OpenAcpToolCallFileAction))
    const { openedInGroup, resolvedOpens } = runCardCommand(
      OpenAcpToolCallFileAction.ID,
      [
        {
          kind: 'toolCall',
          id: 'w',
          call: {
            id: 'w',
            title: 'Write a.ts',
            kind: 'edit',
            status: 'completed',
            text: '',
            blocks: [],
            diffs: [{ path: '/repo/a.ts', oldText: '', newText: 'export {}\n' }],
          },
        },
      ],
      { sessionId: SESSION_ID, slotKey: 't:w' },
    )

    expect(resolvedOpens).toHaveLength(1)
    expect(resolvedOpens[0]?.options).toEqual({ pinned: true })
    expect(openedInGroup).toHaveLength(0)
  })

  it('ignores a card that is not a whole-file write', () => {
    disposables.push(registerAction2(OpenAcpToolCallPreviewAction))
    const { openedInGroup, resolvedOpens } = runCardCommand(
      OpenAcpToolCallPreviewAction.ID,
      [taskCall([])],
      { sessionId: SESSION_ID, slotKey: 't:task' },
    )

    expect(openedInGroup).toHaveLength(0)
    expect(resolvedOpens).toHaveLength(0)
  })

  it('resolves the path against the workspace folder, not the local filesystem', () => {
    disposables.push(registerAction2(OpenAcpToolCallFileAction))
    const { resolvedOpens } = runCardCommand(
      OpenAcpToolCallFileAction.ID,
      [
        {
          kind: 'toolCall',
          id: 'w',
          call: {
            id: 'w',
            title: 'Write a.ts',
            kind: 'edit',
            status: 'completed',
            text: '',
            blocks: [],
            diffs: [{ path: '/repo/a.ts', oldText: '', newText: 'export {}\n' }],
          },
        },
      ],
      { sessionId: SESSION_ID, slotKey: 't:w' },
      {
        workspace: {
          _serviceBrand: undefined,
          current: { folder: URI.parse('remote-ssh://192.0.2.10/repo'), name: 'repo' },
        } as unknown as IWorkspaceService,
      },
    )

    expect(String(resolvedOpens[0]?.resource)).toBe('remote-ssh://192.0.2.10/repo/a.ts')
  })
})
