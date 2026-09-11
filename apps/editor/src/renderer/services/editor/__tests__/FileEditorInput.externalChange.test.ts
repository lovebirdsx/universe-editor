/*---------------------------------------------------------------------------------------------
 *  Tests for FileEditorInput.checkExternalChange — silent reload for clean
 *  buffers, confirm prompt for dirty ones.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
