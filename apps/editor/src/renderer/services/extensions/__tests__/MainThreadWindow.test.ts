/*---------------------------------------------------------------------------------------------
 *  Tests for MainThreadWindow: bridging the host's window.* RPC to the editor's
 *  notification / quick-input / status-bar services.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  ProgressLocation,
  Severity,
  StatusBarAlignment,
  type IConfirmResult,
  type IDialogService,
  type IFileDialogService,
  type INotificationService,
  type IOpenerService,
  type IProgress,
  type IProgressOptions,
  type IProgressService,
  type IProgressStep,
  type IQuickInputService,
  type IStatusBarService,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
  URI,
  REMOTE_SCHEME,
} from '@universe-editor/platform'
import type { IExtHostWindow } from '@universe-editor/extensions-common'
import { E2E_PROBE_ENABLED_KEY } from '../../../../shared/e2e/contract.js'
import { MainThreadWindow } from '../MainThreadWindow.js'

function fakeNotification(): {
  service: INotificationService
  notify: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
} {
  const notify = vi.fn()
  const prompt = vi.fn().mockResolvedValue(undefined)
  return { service: { notify, prompt } as unknown as INotificationService, notify, prompt }
}

function fakeDialog(result: Partial<IConfirmResult> = {}): {
  service: IDialogService
  confirm: ReturnType<typeof vi.fn>
} {
  const confirm = vi
    .fn()
    .mockResolvedValue({ confirmed: false, choice: 'cancel' as const, ...result })
  return { service: { confirm } as unknown as IDialogService, confirm }
}

function fakeStatusBar(): {
  service: IStatusBarService
  entries: Map<number, IStatusBarEntry>
  disposed: number[]
} {
  const entries = new Map<number, IStatusBarEntry>()
  const disposed: number[] = []
  let nextId = 0
  const service = {
    addEntry(entry: IStatusBarEntry): IStatusBarEntryAccessor {
      const id = nextId++
      entries.set(id, entry)
      return {
        update: (e: IStatusBarEntry) => entries.set(id, e),
        dispose: () => {
          entries.delete(id)
          disposed.push(id)
        },
      }
    },
  } as unknown as IStatusBarService
  return { service, entries, disposed }
}

const noopExtHostWindow: IExtHostWindow = {
  $acceptProgressCanceled: () => Promise.resolve(),
  $acceptWindowState: () => Promise.resolve(),
}

function fakeExtHostWindow(): {
  extHostWindow: IExtHostWindow
  acceptWindowState: ReturnType<typeof vi.fn>
} {
  const acceptWindowState = vi.fn().mockResolvedValue(undefined)
  return {
    extHostWindow: {
      $acceptProgressCanceled: () => Promise.resolve(),
      $acceptWindowState: acceptWindowState,
    },
    acceptWindowState,
  }
}

function makeWindow(
  overrides: Partial<{
    notification: INotificationService
    quickInput: IQuickInputService
    statusBar: IStatusBarService
    dialog: IDialogService
    opener: IOpenerService
    progress: IProgressService
    fileDialogs: IFileDialogService
    extHostWindow: IExtHostWindow
    authority: string
  }> = {},
): MainThreadWindow {
  return new MainThreadWindow(
    overrides.notification ?? ({} as INotificationService),
    overrides.quickInput ?? ({} as IQuickInputService),
    overrides.statusBar ?? ({} as IStatusBarService),
    overrides.dialog ?? ({} as IDialogService),
    overrides.opener ?? ({} as IOpenerService),
    overrides.progress ?? ({} as IProgressService),
    overrides.fileDialogs ?? ({} as IFileDialogService),
    overrides.extHostWindow ?? noopExtHostWindow,
    overrides.authority,
  )
}

describe('MainThreadWindow', () => {
  it('shows a plain notification and resolves undefined when no items', async () => {
    const notif = fakeNotification()
    const dialog = fakeDialog()
    const mt = makeWindow({ notification: notif.service, dialog: dialog.service })
    await expect(mt.$showMessage('warning', 'heads up', [])).resolves.toBeUndefined()
    expect(notif.notify).toHaveBeenCalledWith({ severity: Severity.Warning, message: 'heads up' })
    expect(dialog.confirm).not.toHaveBeenCalled()
  })

  it('resolves to the primary item label when confirmed', async () => {
    const notif = fakeNotification()
    const dialog = fakeDialog({ confirmed: true, choice: 'primary', choiceIndex: 0 })
    const mt = makeWindow({ notification: notif.service, dialog: dialog.service })
    await expect(mt.$showMessage('error', 'pick one', ['Yes', 'No'])).resolves.toBe('Yes')
    expect(dialog.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'pick one', type: 'error', buttons: ['Yes', 'No'] }),
    )
  })

  // Guard for the "View Diff did nothing" bug: a two-item message used to be
  // mapped onto the primary/cancel pair, and the dialog's cancel resolve carries
  // no choiceIndex, so clicking the second item dropped the pick entirely.
  // choiceIndex now reports the clicked button, so items[1] resolves correctly.
  it('resolves to the second item label via choiceIndex:1', async () => {
    const dialog = fakeDialog({ choiceIndex: 1 })
    const mt = makeWindow({ dialog: dialog.service })
    await expect(mt.$showMessage('warning', 'pick one', ['Yes', 'No'])).resolves.toBe('No')
  })

  it('resolves to the third item label via choiceIndex:2', async () => {
    const dialog = fakeDialog({ choiceIndex: 2 })
    const mt = makeWindow({ dialog: dialog.service })
    await expect(mt.$showMessage('info', 'pick one', ['A', 'B', 'C'])).resolves.toBe('C')
  })

  // Guard for the lifted N-button cap: the old primary/secondary/cancel shape
  // silently dropped items beyond the third, so a fourth pick was unreachable.
  it('resolves to the fourth item label via choiceIndex:3', async () => {
    const dialog = fakeDialog({ choiceIndex: 3 })
    const mt = makeWindow({ dialog: dialog.service })
    await expect(mt.$showMessage('info', 'pick one', ['A', 'B', 'C', 'D'])).resolves.toBe('D')
  })

  it('resolves to undefined when dialog is dismissed', async () => {
    const dialog = fakeDialog({ confirmed: false, choice: 'cancel' })
    const mt = makeWindow({ dialog: dialog.service })
    await expect(mt.$showMessage('warning', 'confirm?', ['Do it'])).resolves.toBeUndefined()
  })

  it('maps quick pick selection back to its index', async () => {
    const pick = vi.fn().mockResolvedValue({ id: '1', label: 'second' })
    const mt = makeWindow({ quickInput: { pick } as unknown as IQuickInputService })
    await expect(mt.$showQuickPick(['first', 'second'], { placeHolder: 'choose' })).resolves.toBe(1)
    expect(pick).toHaveBeenCalledWith(
      [
        { id: '0', label: 'first' },
        { id: '1', label: 'second' },
      ],
      { placeholder: 'choose' },
    )
  })

  it('passes $(icon) text through untouched and tracks the entry by handle', async () => {
    const sb = fakeStatusBar()
    const mt = makeWindow({ statusBar: sb.service })

    await mt.$setStatusBarEntry(7, {
      text: '$(git-branch) main $(edit) 3',
      alignment: 1,
      priority: 100,
      command: 'git.checkout',
    })
    const [entry] = [...sb.entries.values()]
    expect(entry?.text).toBe('$(git-branch) main $(edit) 3')
    expect(entry?.icon).toBeUndefined()
    expect(entry?.alignment).toBe(StatusBarAlignment.Right)
    expect(entry?.command).toBe('git.checkout')

    // Update in place, then dispose.
    await mt.$setStatusBarEntry(7, { text: 'dev', alignment: 0, priority: 100 })
    expect([...sb.entries.values()][0]?.text).toBe('dev')

    await mt.$disposeStatusBarEntry(7)
    expect(sb.entries.size).toBe(0)
  })

  it('reads and writes clipboard text through navigator.clipboard', async () => {
    const readText = vi.fn().mockResolvedValue('clip-text')
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { readText, writeText } })
    try {
      const mt = makeWindow()
      await expect(mt.$clipboardReadText()).resolves.toBe('clip-text')
      await mt.$clipboardWriteText('hello')
      expect(writeText).toHaveBeenCalledWith('hello')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('$openExternal delegates to the opener service and returns its result', async () => {
    const open = vi.fn().mockResolvedValue(true)
    const mt = makeWindow({ opener: { open } as unknown as IOpenerService })
    await expect(mt.$openExternal('https://example.com')).resolves.toBe(true)
    expect(open).toHaveBeenCalledWith('https://example.com')
  })
})

describe('MainThreadWindow progress', () => {
  interface FakeProgressRun {
    options: IProgressOptions
    progress: IProgress<IProgressStep>
    taskPromise: Promise<unknown>
    cancel: () => void
    cancelSubDisposed: () => boolean
  }

  function fakeProgress(): { service: IProgressService; runs: FakeProgressRun[] } {
    const runs: FakeProgressRun[] = []
    const service = {
      withProgress<R>(
        options: IProgressOptions,
        task: (progress: IProgress<IProgressStep>, token: unknown) => Promise<R>,
      ): Promise<R> {
        const progress: IProgress<IProgressStep> = { report: () => undefined }
        let cancelListener: (() => void) | undefined
        let cancelSubDisposed = false
        const token = {
          isCancellationRequested: false,
          onCancellationRequested: (listener: () => void) => {
            cancelListener = listener
            return {
              dispose: () => {
                cancelSubDisposed = true
              },
            }
          },
        }
        const run: FakeProgressRun = {
          options,
          progress,
          taskPromise: undefined as unknown as Promise<unknown>,
          cancel: () => cancelListener?.(),
          cancelSubDisposed: () => cancelSubDisposed,
        }
        runs.push(run)
        run.taskPromise = task(progress, token)
        return run.taskPromise as Promise<R>
      },
    } as unknown as IProgressService
    return { service, runs }
  }

  it('holds the progress open until $endProgress and forwards reports', async () => {
    const progress = fakeProgress()
    const mt = makeWindow({ progress: progress.service })

    await mt.$startProgress(1, { location: 15, title: 'Indexing', cancellable: true })
    expect(progress.runs).toHaveLength(1)
    const run = progress.runs[0]!
    expect(run.options.location).toBe(ProgressLocation.Notification)
    expect(run.options.title).toBe('Indexing')
    expect(run.options.cancellable).toBe(true)

    const reported: IProgressStep[] = []
    vi.spyOn(run.progress, 'report').mockImplementation((step) => reported.push(step))
    await mt.$reportProgress(1, { message: 'half', increment: 50 })
    expect(reported).toEqual([{ message: 'half', increment: 50 }])

    let settled = false
    void run.taskPromise.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await mt.$endProgress(1)
    await run.taskPromise
    expect(settled).toBe(true)
  })

  it('maps unknown locations to the Window status-bar spinner', async () => {
    const progress = fakeProgress()
    const mt = makeWindow({ progress: progress.service })
    await mt.$startProgress(1, { location: 1 })
    expect(progress.runs[0]?.options.location).toBe(ProgressLocation.Window)
    await mt.$endProgress(1)
  })

  it('pushes a user cancel back to the host', async () => {
    const progress = fakeProgress()
    const cancelPush = vi.fn().mockResolvedValue(undefined)
    const mt = makeWindow({
      progress: progress.service,
      extHostWindow: {
        $acceptProgressCanceled: cancelPush,
        $acceptWindowState: () => Promise.resolve(),
      },
    })
    await mt.$startProgress(3, { location: 15, cancellable: true })
    progress.runs[0]!.cancel()
    expect(cancelPush).toHaveBeenCalledWith(3)
    await mt.$endProgress(3)
  })

  it('dispose settles every held-open progress', async () => {
    const progress = fakeProgress()
    const mt = makeWindow({ progress: progress.service })
    await mt.$startProgress(1, { location: 10 })
    await mt.$startProgress(2, { location: 10 })
    mt.dispose()
    await expect(progress.runs[0]!.taskPromise).resolves.toBeUndefined()
    await expect(progress.runs[1]!.taskPromise).resolves.toBeUndefined()
  })

  it('disposes the cancel subscription when the progress ends', async () => {
    const progress = fakeProgress()
    const mt = makeWindow({ progress: progress.service })
    await mt.$startProgress(1, { location: 15, cancellable: true })
    expect(progress.runs[0]!.cancelSubDisposed()).toBe(false)

    await mt.$endProgress(1)
    expect(progress.runs[0]!.cancelSubDisposed()).toBe(true)
  })

  it('disposes the cancel subscription on teardown', async () => {
    const progress = fakeProgress()
    const mt = makeWindow({ progress: progress.service })
    await mt.$startProgress(1, { location: 15, cancellable: true })
    mt.dispose()
    expect(progress.runs[0]!.cancelSubDisposed()).toBe(true)
  })
})

describe('MainThreadWindow file dialogs', () => {
  function fakeFileDialogs(
    open: URI[] | undefined,
    save: URI | undefined,
  ): {
    service: IFileDialogService
    showOpenDialog: ReturnType<typeof vi.fn>
    showSaveDialog: ReturnType<typeof vi.fn>
  } {
    const showOpenDialog = vi.fn().mockResolvedValue(open)
    const showSaveDialog = vi.fn().mockResolvedValue(save)
    return {
      service: { showOpenDialog, showSaveDialog } as unknown as IFileDialogService,
      showOpenDialog,
      showSaveDialog,
    }
  }

  it('returns the picked fsPaths', async () => {
    const dialogs = fakeFileDialogs([URI.file('/ws/a.ts')], undefined)
    const mt = makeWindow({ fileDialogs: dialogs.service })
    await expect(
      mt.$showOpenDialog({ title: 'Open', defaultUri: '/ws', canSelectFiles: true }),
    ).resolves.toEqual([URI.file('/ws/a.ts').fsPath])
    expect(dialogs.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Open',
        canSelectFiles: true,
        canSelectFolders: false,
        defaultUri: expect.objectContaining({ scheme: 'file' }),
      }),
    )
  })

  it('passes canSelectMany and filters through to the dialog service', async () => {
    const dialogs = fakeFileDialogs([URI.file('/ws/a.png'), URI.file('/ws/b.png')], undefined)
    const mt = makeWindow({ fileDialogs: dialogs.service })
    await expect(
      mt.$showOpenDialog({
        title: 'Pick Images',
        canSelectFiles: true,
        canSelectMany: true,
        filters: { Images: ['png', 'jpg'], 'All Files': ['*'] },
      }),
    ).resolves.toEqual([URI.file('/ws/a.png').fsPath, URI.file('/ws/b.png').fsPath])
    expect(dialogs.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        canSelectMany: true,
        filters: [
          { name: 'Images', extensions: ['png', 'jpg'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      }),
    )
  })

  it('omits canSelectMany and filters when the extension did not set them', async () => {
    const dialogs = fakeFileDialogs([URI.file('/ws/a.ts')], undefined)
    const mt = makeWindow({ fileDialogs: dialogs.service })
    await mt.$showOpenDialog({ title: 'Open', canSelectFiles: true })
    const call = dialogs.showOpenDialog.mock.calls[0]![0] as Record<string, unknown>
    expect('canSelectMany' in call).toBe(false)
    expect('filters' in call).toBe(false)
  })

  it('resolves undefined when the open dialog is cancelled', async () => {
    const dialogs = fakeFileDialogs(undefined, undefined)
    const mt = makeWindow({ fileDialogs: dialogs.service })
    await expect(mt.$showOpenDialog({})).resolves.toBeUndefined()
    await expect(mt.$showSaveDialog({})).resolves.toBeUndefined()
  })

  it('maps saveLabel to the dialog openLabel and returns the fsPath', async () => {
    const dialogs = fakeFileDialogs(undefined, URI.file('/ws/out.txt'))
    const mt = makeWindow({ fileDialogs: dialogs.service })
    await expect(mt.$showSaveDialog({ saveLabel: 'Save', title: 'Save As' })).resolves.toBe(
      URI.file('/ws/out.txt').fsPath,
    )
    expect(dialogs.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({ openLabel: 'Save', title: 'Save As' }),
    )
  })

  it('passes save dialog filters through to the dialog service', async () => {
    const dialogs = fakeFileDialogs(undefined, URI.file('/ws/out.png'))
    const mt = makeWindow({ fileDialogs: dialogs.service })
    await mt.$showSaveDialog({
      title: 'Export',
      filters: { Images: ['png', 'jpg'], 'All Files': ['*'] },
    })
    expect(dialogs.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: [
          { name: 'Images', extensions: ['png', 'jpg'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      }),
    )
  })

  // The host sends `defaultUri` as a bare path on its own filesystem. Under a
  // remote workspace that is the remote host's path, so resolving it with
  // `URI.file` would point the dialog at the client's disk (and force the native
  // dialog, which can't browse a remote host at all).
  it('re-attaches the remote authority to the dialog default location', async () => {
    const authority = 'ssh+devbox'
    const picked = URI.from({
      scheme: REMOTE_SCHEME,
      authority,
      path: '/home/user/repo/a.ts',
    })
    const dialogs = fakeFileDialogs([picked], picked)
    const mt = makeWindow({ fileDialogs: dialogs.service, authority })

    await expect(
      mt.$showOpenDialog({ title: 'Open', defaultUri: '/home/user/repo', canSelectFiles: true }),
    ).resolves.toEqual(['/home/user/repo/a.ts'])
    expect(dialogs.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultUri: expect.objectContaining({ scheme: REMOTE_SCHEME, authority }),
      }),
    )

    await mt.$showSaveDialog({ defaultUri: '/home/user/repo/out.txt' })
    expect(dialogs.showSaveDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultUri: expect.objectContaining({ scheme: REMOTE_SCHEME, authority }),
      }),
    )
  })
})

describe('MainThreadWindow window state', () => {
  it('seeds the current focus state once on seedWindowState', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { extHostWindow, acceptWindowState } = fakeExtHostWindow()
    const mt = makeWindow({ extHostWindow })
    await mt.seedWindowState()
    expect(acceptWindowState).toHaveBeenCalledTimes(1)
    expect(acceptWindowState).toHaveBeenCalledWith({ focused: true })
  })

  it('pushes not-focused on window blur', () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { extHostWindow, acceptWindowState } = fakeExtHostWindow()
    makeWindow({ extHostWindow })
    acceptWindowState.mockClear()
    hasFocus.mockReturnValue(false)
    window.dispatchEvent(new Event('blur'))
    expect(acceptWindowState).toHaveBeenCalledWith({ focused: false })
  })

  it('treats a hidden document as not focused even while focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const { extHostWindow, acceptWindowState } = fakeExtHostWindow()
    makeWindow({ extHostWindow })
    acceptWindowState.mockClear()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(acceptWindowState).toHaveBeenCalledWith({ focused: false })
  })

  it('synthesizes focused = hasFocus && not hidden', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    const { extHostWindow, acceptWindowState } = fakeExtHostWindow()
    const mt = makeWindow({ extHostWindow })
    await mt.seedWindowState()
    expect(acceptWindowState).toHaveBeenCalledWith({ focused: false })

    acceptWindowState.mockClear()
    hasFocus.mockReturnValue(true)
    window.dispatchEvent(new Event('focus'))
    expect(acceptWindowState).toHaveBeenCalledWith({ focused: true })
  })

  it('does not push when the synthesized value is unchanged', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const { extHostWindow, acceptWindowState } = fakeExtHostWindow()
    makeWindow({ extHostWindow })
    acceptWindowState.mockClear()
    window.dispatchEvent(new Event('blur'))
    expect(acceptWindowState).not.toHaveBeenCalled()
  })

  it('reports focused under E2E even when the document lacks real focus', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    Object.defineProperty(window, E2E_PROBE_ENABLED_KEY, { value: true, configurable: true })
    try {
      const { extHostWindow, acceptWindowState } = fakeExtHostWindow()
      const mt = makeWindow({ extHostWindow })
      await mt.seedWindowState()
      expect(acceptWindowState).toHaveBeenCalledWith({ focused: true })
    } finally {
      Reflect.deleteProperty(window, E2E_PROBE_ENABLED_KEY)
    }
  })
})
