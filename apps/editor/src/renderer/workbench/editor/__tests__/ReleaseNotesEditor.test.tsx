/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  ReleaseNotesEditor — the only place that grants release notes their `doc:` /
 *  `command:` links. These tests pin the navigation contract: bundled docs open in the
 *  editor, a doc this install doesn't bundle falls back to the note's OWN version on
 *  GitHub (never main, never the running release), commands run only from the
 *  allowlist, and every other protocol is refused instead of falling through to the
 *  file opener or window.open.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import {
  IConfigurationService,
  IEditorResolverService,
  IEditorService,
  INotificationService,
  IOpenerService,
  InstantiationService,
  ServiceCollection,
  Severity,
  type IEditorGroup,
  type IEditorService as IEditorServiceType,
  type INotificationService as INotificationServiceType,
  type IOpenerOptions,
  type IOpenerService as IOpenerServiceType,
} from '@universe-editor/platform'
import type { IEditorInput } from '@universe-editor/platform'
import { ReleaseNotesInput } from '../../../services/editor/ReleaseNotesInput.js'
import { DocEditorInput } from '../../../services/editor/DocEditorInput.js'
import { initUserDocsForTests } from '../../../services/editor/docRegistry.js'
import type { IReleaseNote } from '../../../../shared/ipc/releaseNotesService.js'
import { ServicesContext } from '../../useService.js'
import { EditorGroupContext } from '../EditorGroupContext.js'
import { ReleaseNotesEditor } from '../ReleaseNotesEditor.js'

vi.mock('../monaco/MonacoLoader.js', () => ({
  MonacoLoader: { ensureInitialized: () => new Promise(() => {}) },
}))

const NOTE: IReleaseNote = {
  version: '0.12.0',
  date: '2026-03-04',
  title: '更快的启动',
  summary: '一句话摘要。',
  body: [
    '## 本次重点',
    '',
    '- 见 [界面导览](doc:getting-started/x)',
    '- 打开 [设置](command:workbench.action.openSettings)',
    '- 缺失的 [旧文档](doc:removed/page)',
    '- 越权的 [命令](command:workbench.action.terminal.new)',
    '- 危险的 [链接](file:///etc/passwd)',
    '- 外部的 [主页](https://example.com/)',
    '- 路径 `apps/editor/src/main.ts` 与裸路径 apps/editor/e2e/playwright.config.ts',
  ].join('\n'),
}

function makeResolver(): IEditorResolverService {
  return {
    _serviceBrand: undefined,
    resolveEditor: async () => undefined,
    registerEditor: () => ({ dispose: () => {} }),
  } as unknown as IEditorResolverService
}

function makeConfig(): IConfigurationService {
  return {
    _serviceBrand: undefined,
    getValue: () => undefined,
    onDidChangeConfiguration: () => ({ dispose: () => {} }),
  } as unknown as IConfigurationService
}

interface Harness {
  readonly container: HTMLElement
  readonly opened: IEditorInput[]
  readonly openerCalls: { target: string; options?: IOpenerOptions }[]
  readonly notices: {
    severity: Severity
    message: string
    actions: { label: string; run: () => void }[]
  }[]
}

function renderEditor(notes: readonly IReleaseNote[] = [NOTE]): Harness {
  const opened: IEditorInput[] = []
  const group = {
    get activeEditor() {
      return opened[opened.length - 1]
    },
    indexOf: () => -1,
    closeEditor: () => true,
    openEditor(input: IEditorInput) {
      opened.push(input)
    },
  } as unknown as IEditorGroup

  const openerCalls: Harness['openerCalls'] = []
  const opener = {
    _serviceBrand: undefined,
    registerOpener: () => ({ dispose: () => {} }),
    open: async (target: unknown, options?: IOpenerOptions) => {
      openerCalls.push({ target: String(target), ...(options ? { options } : {}) })
      return true
    },
  } as unknown as IOpenerServiceType

  const notices: Harness['notices'] = []
  const notifications = {
    _serviceBrand: undefined,
    notify: (opts: {
      severity: Severity
      message: string
      actions?: { label: string; run: () => void }[]
    }) => {
      notices.push({ severity: opts.severity, message: opts.message, actions: opts.actions ?? [] })
      return {
        id: 'n1',
        progress: {},
        updateMessage: () => {},
        updateSeverity: () => {},
        dispose: () => {},
      }
    },
  } as unknown as INotificationServiceType

  const editorService = {
    _serviceBrand: undefined,
    openEditor: (input: IEditorInput) => {
      opened.push(input)
      return Promise.resolve(undefined)
    },
  } as unknown as IEditorServiceType

  const services = new ServiceCollection()
  services.set(IEditorResolverService, makeResolver())
  services.set(IConfigurationService, makeConfig())
  services.set(IEditorService, editorService)
  services.set(IOpenerService, opener)
  services.set(INotificationService, notifications)
  const inst = new InstantiationService(services)

  const container = document.createElement('div')
  document.body.appendChild(container)
  render(
    <ServicesContext.Provider value={inst}>
      <EditorGroupContext.Provider value={group}>
        <ReleaseNotesEditor input={new ReleaseNotesInput(notes, '更新说明', 'all')} />
      </EditorGroupContext.Provider>
    </ServicesContext.Provider>,
    { container },
  )
  return { container, opened, openerCalls, notices }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ReleaseNotesEditor — rendering', () => {
  it('renders one section per version with its header', () => {
    renderEditor()
    const section = screen.getByTestId('release-note-version')
    expect(section.getAttribute('data-version')).toBe('0.12.0')
    expect(screen.getByText('0.12.0')).toBeTruthy()
    expect(screen.getByText('更快的启动')).toBeTruthy()
    expect(screen.getByText('2026-03-04')).toBeTruthy()
    expect(screen.getByText('一句话摘要。')).toBeTruthy()
  })

  it('renders the body markdown through the shared view', () => {
    renderEditor()
    expect(screen.getByText('本次重点').tagName).toBe('H2')
  })

  it('shows the empty message when the list has no notes', () => {
    const harness = renderEditor([])
    expect(screen.queryByTestId('release-note-version')).toBeNull()
    expect(harness.container.textContent).toContain('No release notes are available')
  })
})

describe('ReleaseNotesEditor — restricted navigation', () => {
  it('opens a bundled doc as a DocEditorInput', () => {
    initUserDocsForTests({ 'zh-CN': { 'getting-started/x': '# X\n' }, 'en-US': {} })
    const harness = renderEditor()
    screen.getByRole('link', { name: '界面导览' }).click()
    expect(harness.opened).toHaveLength(1)
    expect(harness.opened[0]).toBeInstanceOf(DocEditorInput)
    expect((harness.opened[0] as DocEditorInput).docId).toBe('getting-started/x')
    expect(harness.openerCalls).toEqual([])
  })

  it('falls back to the note’s own version on GitHub for a doc this install lacks', () => {
    initUserDocsForTests({ 'zh-CN': {}, 'en-US': {} })
    const harness = renderEditor()
    screen.getByRole('link', { name: '旧文档' }).click()
    expect(harness.opened).toEqual([])
    expect(harness.notices).toHaveLength(1)
    expect(harness.notices[0]?.message).toContain('removed/page')

    harness.notices[0]?.actions[0]?.run()
    expect(harness.openerCalls[0]?.target).toBe(
      'https://github.com/lovebirdsx/universe-editor/blob/v0.12.0/docs/user/zh-CN/removed/page.md',
    )
  })

  it('runs an allowlisted command through the opener with an explicit whitelist', () => {
    const harness = renderEditor()
    screen.getByRole('link', { name: '设置' }).click()
    expect(harness.openerCalls).toHaveLength(1)
    expect(harness.openerCalls[0]?.target).toBe('command:workbench.action.openSettings')
    expect(harness.openerCalls[0]?.options?.allowCommands).toEqual([
      'workbench.action.openSettings',
    ])
    expect(harness.notices).toEqual([])
  })

  it('refuses a command outside the allowlist without executing anything', () => {
    const harness = renderEditor()
    screen.getByRole('link', { name: '命令' }).click()
    expect(harness.openerCalls).toEqual([])
    expect(harness.notices).toHaveLength(1)
    expect(harness.notices[0]?.message).toContain('允许清单')
  })

  it('never routes a non-http protocol to the file opener or window.open', () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    const harness = renderEditor()
    screen.getByRole('link', { name: '链接' }).click()
    expect(harness.openerCalls).toEqual([])
    expect(windowOpen).not.toHaveBeenCalled()
    expect(harness.notices).toHaveLength(1)
    expect(harness.notices[0]?.message).toContain('不允许的链接协议')
    windowOpen.mockRestore()
  })

  it('opens an external http(s) link through the opener, not window.open', () => {
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    const harness = renderEditor()
    screen.getByRole('link', { name: '主页' }).click()
    expect(harness.openerCalls[0]?.target).toBe('https://example.com/')
    expect(windowOpen).not.toHaveBeenCalled()
    windowOpen.mockRestore()
  })

  it('never turns a file path into an uncontrolled link', () => {
    // The renderer's file-path links resolve through the file opener/search, which is a
    // navigation surface the release-notes policy does not grant. With a link handler
    // installed they must stay plain text — no anchor, and no side effect if clicked.
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
    const harness = renderEditor()
    expect(screen.queryAllByTestId('md-filepath')).toEqual([])
    expect(harness.opened).toEqual([])
    expect(harness.openerCalls).toEqual([])
    expect(harness.notices).toEqual([])
    expect(windowOpen).not.toHaveBeenCalled()
    expect(harness.container.textContent).toContain('apps/editor/src/main.ts')
    windowOpen.mockRestore()
  })
})

describe('ReleaseNotesInput — persisted state', () => {
  it('round-trips a schema-2 payload', () => {
    const input = new ReleaseNotesInput([NOTE], '更新说明', 'whatsNew')
    const revived = ReleaseNotesInput.deserialize(JSON.parse(JSON.stringify(input.serialize())))
    expect(revived?.notes).toEqual([NOTE])
    expect(revived?.id).toBe('release-notes:whatsNew')
  })

  it('degrades a pre-schema-2 tab to one opaque note instead of going blank', () => {
    const revived = ReleaseNotesInput.deserialize({
      markdown: '## 0.1.0\n\n- 旧内容\n',
      title: '更新说明',
      key: 'all',
    })
    expect(revived?.notes).toEqual([
      { version: '', title: '', summary: '', body: '## 0.1.0\n\n- 旧内容\n' },
    ])
    expect(revived?.id).toBe('release-notes:all')
  })

  it('drops malformed entries and refuses a payload with no recognizable shape', () => {
    const revived = ReleaseNotesInput.deserialize({
      schema: 2,
      notes: [{ version: '0.1.0', title: '', summary: '', body: 'x' }, { version: 1 }],
      title: 't',
      key: 'all',
    })
    expect(revived?.notes).toHaveLength(1)
    expect(ReleaseNotesInput.deserialize({ key: 'all' })).toBeNull()
    expect(ReleaseNotesInput.deserialize(null)).toBeNull()
  })
})
