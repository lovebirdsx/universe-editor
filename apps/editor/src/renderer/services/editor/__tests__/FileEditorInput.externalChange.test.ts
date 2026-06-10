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
import { MonacoModelRegistry } from '../../../workbench/editor/monaco/MonacoModelRegistry.js'

interface FsState {
  text: string
  mtime: number
}

function makeFs(initial: Record<string, FsState>): IFileServiceType & {
  state: Record<string, FsState>
} {
  const state = { ...initial }
  return {
    _serviceBrand: undefined,
    state,
    async readFile() {
      throw new Error('not implemented')
    },
    async readFileText(resource: URI) {
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
  } as IFileServiceType & { state: Record<string, FsState> }
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
})
