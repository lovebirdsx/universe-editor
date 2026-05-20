/*---------------------------------------------------------------------------------------------
 *  Tests for FileEditorStatusContribution — verifies that cursor / language /
 *  encoding entries appear when a FileEditorInput is active, update on cursor
 *  movement, and disappear when the active editor switches to something else.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  IEditorService,
  IFileService,
  IStatusBarService,
  InstantiationService,
  ServiceCollection,
  URI,
  observableValue,
  type IEditorInput,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { FileEditorInput } from '../../services/editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../services/editor/FileEditorRegistry.js'
import { StatusBarService } from '../../services/statusbar/StatusBarService.js'
import { FileEditorStatusContribution } from '../FileEditorStatusContribution.js'

interface FakeMonaco {
  position: { lineNumber: number; column: number }
  emitter: Emitter<{ position: { lineNumber: number; column: number } }>
  getPosition(): { lineNumber: number; column: number }
  onDidChangeCursorPosition: (
    cb: (e: { position: { lineNumber: number; column: number } }) => void,
  ) => { dispose(): void }
}

function makeFakeMonaco(): FakeMonaco {
  const emitter = new Emitter<{ position: { lineNumber: number; column: number } }>()
  const m: FakeMonaco = {
    position: { lineNumber: 1, column: 1 },
    emitter,
    getPosition() {
      return m.position
    },
    onDidChangeCursorPosition: (cb) => emitter.event(cb),
  }
  return m
}

function makeFileService(): IFileServiceType {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists() {
      return false
    },
    async stat() {
      throw new Error('not used')
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
  }
}

function setup(initialActive: IEditorInput | undefined = undefined) {
  FileEditorRegistry._resetForTests()
  const services = new ServiceCollection()
  const fileService = makeFileService()
  services.set(IFileService, fileService)
  const statusBar = new StatusBarService()
  services.set(IStatusBarService, statusBar)
  const active = observableValue<IEditorInput | undefined>('active', initialActive)
  const editorService = {
    _serviceBrand: undefined,
    openEditor() {},
    closeEditor() {},
    closeAllEditors() {},
    openEditors: observableValue<readonly IEditorInput[]>('open', []),
    activeEditorId: observableValue<string | undefined>('id', undefined),
    activeEditor: active,
  } as unknown as IEditorService
  services.set(IEditorService, editorService)
  const inst = new InstantiationService(services)
  const contrib = inst.createInstance(FileEditorStatusContribution)
  return { statusBar, active, fileService, inst, contrib }
}

describe('FileEditorStatusContribution', () => {
  beforeEach(() => FileEditorRegistry._resetForTests())
  afterEach(() => FileEditorRegistry._resetForTests())

  it('registers three entries when a FileEditorInput becomes active', () => {
    const { statusBar, active, inst } = setup()
    expect(statusBar.entries.get()).toHaveLength(0)
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/a.json'))
    active.set(input, undefined)
    const texts = statusBar.entries.get().map((e) => e.entry.text)
    expect(texts).toContain('Ln 1, Col 1')
    expect(texts).toContain('JSON')
    expect(texts).toContain('UTF-8')
  })

  it('switching to a non-file editor disposes all entries', () => {
    const { statusBar, active, inst } = setup()
    const fileInput = inst.createInstance(FileEditorInput, URI.file('/ws/a.txt'))
    active.set(fileInput, undefined)
    expect(statusBar.entries.get()).toHaveLength(3)
    active.set(undefined, undefined)
    expect(statusBar.entries.get()).toHaveLength(0)
  })

  it('updates the cursor entry when the Monaco editor moves the caret', () => {
    const { statusBar, active, inst } = setup()
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/a.txt'))
    const monaco = makeFakeMonaco()
    FileEditorRegistry.register(
      input,
      monaco as unknown as Parameters<typeof FileEditorRegistry.register>[1],
    )
    active.set(input, undefined)
    monaco.position = { lineNumber: 12, column: 34 }
    monaco.emitter.fire({ position: monaco.position })
    const cursor = statusBar.entries.get().find((e) => e.entry.tooltip === 'Cursor Position')
      ?.entry.text
    expect(cursor).toBe('Ln 12, Col 34')
  })

  it('language entry reflects the input language id', () => {
    const { statusBar, active, inst } = setup()
    const input = inst.createInstance(FileEditorInput, URI.file('/ws/a.md'))
    active.set(input, undefined)
    const lang = statusBar.entries.get().find((e) => e.entry.tooltip === 'Editor Language')
      ?.entry.text
    expect(lang).toBe('Markdown')
  })
})
