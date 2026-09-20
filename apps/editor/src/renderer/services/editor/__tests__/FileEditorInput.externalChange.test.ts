/*---------------------------------------------------------------------------------------------
 *  Tests for FileEditorInput.checkExternalChange — silent reload for clean
 *  buffers, confirm prompt for dirty ones.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IDialogService,
  type IFileService as IFileServiceType,
  type IFileStat,
} from '@universe-editor/platform'
import { FileEditorInput } from '../FileEditorInput.js'
import { MAX_EXTERNAL_RELOAD_BYTES } from '../../files/externalReload.js'
import { readHeapFlowTotals } from '../../memory/heapFlowCounters.js'
import { MonacoModelRegistry } from '../../../workbench/editor/monaco/MonacoModelRegistry.js'

interface FsState {
  text: string
  mtime: number
}

function makeFs(initial: Record<string, FsState>): IFileServiceType & {
  state: Record<string, FsState>
  reads: number
} {
  const state = { ...initial }
  const fs = {
    _serviceBrand: undefined,
    state,
    reads: 0,
    async readFile() {
      throw new Error('not implemented')
    },
    async readFileHead() {
      throw new Error('not implemented')
    },
    async readFileText(resource: URI) {
      fs.reads++
      const s = state[resource.toString()]
      if (!s) throw new Error('ENOENT')
      return s.text
    },
    async writeFile(resource: URI, content: Uint8Array | string) {
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content)
      const prev = state[resource.toString()]
      state[resource.toString()] = { text, mtime: (prev?.mtime ?? 0) + 1 }
    },
    async exists(resource: URI) {
      return state[resource.toString()] !== undefined
    },
    async stat(resource: URI): Promise<IFileStat> {
      const s = state[resource.toString()]
      if (!s) throw new Error('ENOENT')
      return {
        resource,
        isFile: true,
        isDirectory: false,
        size: s.text.length,
        mtime: s.mtime,
      }
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async copy() {},
    async listRecursive() {
      return []
    },
  }
  return fs as IFileServiceType & { state: Record<string, FsState>; reads: number }
}

interface ConfirmCall {
  message: string
  result: boolean
}

function makeDialog(answers: boolean[]): IDialogService & { calls: ConfirmCall[] } {
  const calls: ConfirmCall[] = []
  const queue = [...answers]
  return {
    _serviceBrand: undefined,
    calls,
    async confirm(opts: { message: string }) {
      const result = queue.shift() ?? false
      calls.push({ message: opts.message, result })
      return { confirmed: result }
    },
    async prompt() {
      return null
    },
    async showMessageBox() {
      return { response: 0 }
    },
  } as unknown as IDialogService & { calls: ConfirmCall[] }
}

/** 只在测试释放时才答复的对话框——用户可以在丢弃确认框挂着时继续输入的那个窗口。 */
function makeGatedDialog(): IDialogService & {
  calls: number
  answer(result: boolean): void
} {
  let release: ((result: boolean) => void) | undefined
  const gate = new Promise<boolean>((r) => {
    release = r
  })
  const dialog = {
    _serviceBrand: undefined,
    calls: 0,
    answer(result: boolean) {
      release?.(result)
    },
    async confirm() {
      dialog.calls++
      return { confirmed: await gate }
    },
    async prompt() {
      return null
    },
    async showMessageBox() {
      return { response: 0 }
    },
  }
  return dialog as unknown as IDialogService & { calls: number; answer(result: boolean): void }
}

describe('FileEditorInput.checkExternalChange', () => {
  const uri = URI.file('/tmp/ext.txt')
  let fs: ReturnType<typeof makeFs>
  let inst: InstantiationService

  beforeEach(() => {
    fs = makeFs({ [uri.toString()]: { text: 'one', mtime: 100 } })
    const services = new ServiceCollection()
    services.set(IFileService, fs)
    inst = new InstantiationService(services)
  })

  afterEach(() => {
    MonacoModelRegistry._resetForTests()
  })

  it('returns unchanged when mtime did not move', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const dialog = makeDialog([])
    const out = await input.checkExternalChange(dialog)
    expect(out).toBe('unchanged')
    expect(dialog.calls).toHaveLength(0)
    input.dispose()
  })

  it('silently reloads a clean buffer when the file changed', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(input.resource, input.backupContent)
    // External edit
    fs.state[uri.toString()] = { text: 'TWO', mtime: 200 }
    const dialog = makeDialog([])
    const out = await input.checkExternalChange(dialog)
    expect(out).toBe('reloaded')
    expect(model.getValue()).toBe('TWO')
    expect(input.backupContent).toBe('TWO')
    expect(input.lastKnownMtime).toBe(200)
    expect(dialog.calls).toHaveLength(0)
    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  it('prompts when buffer is dirty and reloads on confirm', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(input.resource, input.backupContent)
    model.setValue('LOCAL')
    input.setDirty(true)
    fs.state[uri.toString()] = { text: 'EXTERNAL', mtime: 200 }
    const dialog = makeDialog([true])
    const out = await input.checkExternalChange(dialog)
    expect(out).toBe('reloaded')
    expect(dialog.calls).toHaveLength(1)
    expect(model.getValue()).toBe('EXTERNAL')
    expect(input.isDirty).toBe(false)
    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  it('keeps local changes when the user declines the prompt', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(input.resource, input.backupContent)
    model.setValue('LOCAL')
    input.setDirty(true)
    fs.state[uri.toString()] = { text: 'EXTERNAL', mtime: 200 }
    const dialog = makeDialog([false])
    const out = await input.checkExternalChange(dialog)
    expect(out).toBe('kept')
    expect(model.getValue()).toBe('LOCAL')
    expect(input.isDirty).toBe(true)
    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  it('returns "gone" when the file no longer exists', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    delete fs.state[uri.toString()]
    const dialog = makeDialog([])
    const out = await input.checkExternalChange(dialog)
    expect(out).toBe('gone')
    expect(dialog.calls).toHaveLength(0)
    input.dispose()
  })

  it('force reloads a clean buffer even when mtime is unchanged', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(input.resource, input.backupContent)
    // Content changed but mtime did not move (atomic same-tick self-write).
    fs.state[uri.toString()] = { text: 'TWO', mtime: 100 }
    const dialog = makeDialog([])
    const out = await input.checkExternalChange(dialog, true)
    expect(out).toBe('reloaded')
    expect(model.getValue()).toBe('TWO')
    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  it('force is a no-op when disk content already matches the buffer', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    MonacoModelRegistry.acquire(input.resource, input.backupContent)
    const dialog = makeDialog([])
    const out = await input.checkExternalChange(dialog, true)
    expect(out).toBe('unchanged')
    expect(dialog.calls).toHaveLength(0)
    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  // Regression (OOM): the reload path compared mtime and then read the whole file, so
  // a file rewritten every second (a build product, a log an agent appends to) cost a
  // whole-file read plus its ~47MB wire frame every second until the renderer heap was
  // gone. Over the ceiling the read is refused, and the buffer is deliberately left
  // stale rather than being read "just this once" per batch.
  it('refuses to reload a file over the ceiling, and stops re-checking it', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(input.resource, input.backupContent)
    fs.state[uri.toString()] = {
      text: 'x'.repeat(MAX_EXTERNAL_RELOAD_BYTES + 1),
      mtime: 200,
    }
    const dialog = makeDialog([])

    expect(await input.checkExternalChange(dialog)).toBe('too-large')
    expect(fs.reads).toBe(1) // resolve()'s read, and nothing since
    expect(model.getValue()).toBe('one')
    expect(input.backupContent).toBe('one')
    expect(dialog.calls).toHaveLength(0)

    // The mtime is taken as known: without it every later batch re-enters the same
    // branch and the file never goes quiet.
    expect(input.lastKnownMtime).toBe(200)
    expect(await input.checkExternalChange(dialog)).toBe('unchanged')
    expect(fs.reads).toBe(1)

    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  it('resumes reloading once the file is back under the ceiling', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(input.resource, input.backupContent)
    fs.state[uri.toString()] = {
      text: 'x'.repeat(MAX_EXTERNAL_RELOAD_BYTES + 1),
      mtime: 200,
    }
    const dialog = makeDialog([])
    expect(await input.checkExternalChange(dialog)).toBe('too-large')

    // Shrunk again: the next write moves mtime past the known one and the gate opens.
    fs.state[uri.toString()] = { text: 'small again', mtime: 300 }
    expect(await input.checkExternalChange(dialog)).toBe('reloaded')
    expect(model.getValue()).toBe('small again')
    expect(input.lastKnownMtime).toBe(300)

    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  // A dirty buffer still has to be asked — someone else's write is about to lose to
  // the user's unsaved edits, and asking needs no file content. Only a confirmed
  // discard pays for the read, and that read is one user action, not a per-batch loop.
  it('still asks a dirty buffer over the ceiling, and reads only on confirm', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(input.resource, input.backupContent)
    model.setValue('LOCAL')
    input.setDirty(true)
    const huge = 'x'.repeat(MAX_EXTERNAL_RELOAD_BYTES + 1)
    fs.state[uri.toString()] = { text: huge, mtime: 200 }

    const decline = makeDialog([false])
    expect(await input.checkExternalChange(decline)).toBe('kept')
    expect(decline.calls).toHaveLength(1)
    expect(fs.reads).toBe(1)
    expect(model.getValue()).toBe('LOCAL')
    expect(input.isDirty).toBe(true)

    // Declining takes the mtime as known: the rest of that same write's batches must
    // not re-ask, or a file being rewritten every second is a modal every second.
    expect(await input.checkExternalChange(decline)).toBe('unchanged')
    expect(decline.calls).toHaveLength(1)
    expect(fs.reads).toBe(1)

    // A new write moves mtime and the question is asked again.
    fs.state[uri.toString()] = { text: huge, mtime: 300 }
    const accept = makeDialog([true])
    expect(await input.checkExternalChange(accept)).toBe('reloaded')
    expect(accept.calls).toHaveLength(1)
    expect(fs.reads).toBe(2)
    expect(model.getValue()).toBe(huge)
    expect(input.isDirty).toBe(false)

    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })
})

/** 把每次读盘都挂住直到测试释放，并报告第一次读已上路——重载不得写进去的那个窗口。 */
function gateReads(fs: ReturnType<typeof makeFs>): {
  release(): void
  started: Promise<void>
} {
  let release: (() => void) | undefined
  const gate = new Promise<void>((r) => {
    release = r
  })
  let readStarted: (() => void) | undefined
  const started = new Promise<void>((r) => {
    readStarted = r
  })
  const original = fs.readFileText.bind(fs)
  fs.readFileText = async (resource: URI) => {
    readStarted?.()
    await gate
    return original(resource)
  }
  return { release: () => release?.(), started }
}

// 回归（OOM 的「写入侧」）：盘上行尾混写而缓冲区只有一种行尾，逐字节比对让每次重载看起来都像
// 整篇重写，并每次都往扩展宿主推一份近全文 didChange。
describe('FileEditorInput.checkExternalChange line endings', () => {
  const uri = URI.file('/tmp/eol.txt')
  let fs: ReturnType<typeof makeFs>
  let inst: InstantiationService

  beforeEach(() => {
    fs = makeFs({ [uri.toString()]: { text: 'one\r\ntwo\r\n', mtime: 100 } })
    const services = new ServiceCollection()
    services.set(IFileService, fs)
    inst = new InstantiationService(services)
  })

  afterEach(() => {
    MonacoModelRegistry._resetForTests()
  })

  it('reloads a mixed-EOL disk text without rewriting the buffer', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(input.resource, input.backupContent)
    const versionBefore = model.getVersionId()
    fs.state[uri.toString()] = { text: 'one\r\ntwo\n', mtime: 200 }

    const dialog = makeDialog([])
    expect(await input.checkExternalChange(dialog)).toBe('reloaded')
    // Same text, different line endings: the buffer must come out untouched —
    // a version bump here is the near-full-text edit that fed the OOM.
    expect(model.getVersionId()).toBe(versionBefore)
    expect(model.getValue()).toBe('one\r\ntwo\r\n')
    expect(input.backupContent).toBe('one\r\ntwo\r\n')

    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  it('force treats an EOL-only difference as unchanged', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(input.resource, input.backupContent)
    const versionBefore = model.getVersionId()
    // An atomic self-write changed the endings but not the text, and left the
    // mtime where it was — the exact case `force` exists for.
    fs.state[uri.toString()] = { text: 'one\ntwo\n', mtime: 100 }

    const dialog = makeDialog([])
    expect(await input.checkExternalChange(dialog, true)).toBe('unchanged')
    expect(model.getVersionId()).toBe(versionBefore)
    expect(dialog.calls).toHaveLength(0)

    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })
})

describe('FileEditorInput.checkExternalChange concurrent edits', () => {
  const uri = URI.file('/tmp/race.txt')
  let fs: ReturnType<typeof makeFs>
  let inst: InstantiationService

  beforeEach(() => {
    fs = makeFs({ [uri.toString()]: { text: 'DISK ONE', mtime: 100 } })
    const services = new ServiceCollection()
    services.set(IFileService, fs)
    inst = new InstantiationService(services)
  })

  afterEach(() => {
    MonacoModelRegistry._resetForTests()
  })

  it('does not overwrite an edit made while the disk read is in flight', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(input.resource, input.backupContent)

    const { release, started } = gateReads(fs)
    fs.state[uri.toString()] = { text: 'DISK TWO', mtime: 200 }
    const pending = input.checkExternalChange(makeDialog([]))
    await started
    // The dirty flag is pushed by the mounted editor, so it can still say clean
    // while the user is already typing — the model version is what must decide.
    model.setValue('USER TYPED')
    release()

    expect(await pending).toBe('kept')
    expect(model.getValue()).toBe('USER TYPED')
    // Nothing was applied, so the change stays pending: recording the mtime here
    // would silently drop the external write for good.
    expect(input.lastKnownMtime).toBe(100)
    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  it('does not apply a confirmed discard over an edit made while the prompt was up', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    const model = MonacoModelRegistry.acquire(input.resource, input.backupContent)
    model.setValue('LOCAL')
    input.setDirty(true)

    fs.state[uri.toString()] = { text: 'DISK TWO', mtime: 200 }
    const dialog = makeGatedDialog()
    const pending = input.checkExternalChange(dialog)
    await vi.waitFor(() => expect(dialog.calls).toBe(1))
    model.setValue('LOCAL AND STILL TYPING')
    dialog.answer(true)

    expect(await pending).toBe('kept')
    expect(model.getValue()).toBe('LOCAL AND STILL TYPING')
    expect(input.isDirty).toBe(true)
    expect(input.lastKnownMtime).toBe(100)
    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  it('leaves a buffer that was replaced during the read alone', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    MonacoModelRegistry.acquire(input.resource, input.backupContent)

    const { release, started } = gateReads(fs)
    fs.state[uri.toString()] = { text: 'DISK TWO', mtime: 200 }
    const pending = input.checkExternalChange(makeDialog([]))
    await started
    // Close + reopen the file while the read is in flight: the registry hands out
    // a different model, and the disk text must not be pushed into it.
    MonacoModelRegistry.release(input.resource)
    const replacement = MonacoModelRegistry.acquire(input.resource, 'DISK TWO')
    release()

    expect(await pending).toBe('kept')
    expect(replacement.getValue()).toBe('DISK TWO')
    expect(input.lastKnownMtime).toBe(100)
    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  it('does not touch a model disposed during the read', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    MonacoModelRegistry.acquire(input.resource, input.backupContent)

    const { release, started } = gateReads(fs)
    fs.state[uri.toString()] = { text: 'DISK TWO', mtime: 200 }
    const pending = input.checkExternalChange(makeDialog([]))
    await started
    MonacoModelRegistry.forceDispose(input.resource)
    release()

    await expect(pending).resolves.toBe('reloaded')
    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })

  // 重载读盘是那次 OOM 的读侧，也正是产生反复出现的 ~9.7MB `readFileText` 响应的调用点。
  // 它必须出现在堆报告里，所以每次重载读盘都走带计数的那一个入口。
  it('counts the reload read in the heap flow counters', async () => {
    const input = inst.createInstance(FileEditorInput, uri)
    await input.resolve()
    MonacoModelRegistry.acquire(input.resource, input.backupContent)
    fs.state[uri.toString()] = { text: 'DISK TWO', mtime: 200 }
    const before = readHeapFlowTotals().find((f) => f.name === 'extreload')?.chars ?? 0

    expect(await input.checkExternalChange(makeDialog([]))).toBe('reloaded')

    const after = readHeapFlowTotals().find((f) => f.name === 'extreload')?.chars ?? 0
    expect(after - before).toBe('DISK TWO'.length)
    MonacoModelRegistry.release(input.resource)
    input.dispose()
  })
})
