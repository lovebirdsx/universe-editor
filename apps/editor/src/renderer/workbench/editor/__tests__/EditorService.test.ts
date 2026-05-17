/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/editor/EditorService.ts
 *
 *  核心场景：Explorer 点击文件后，EditorService.openEditor 收到的是 FileEditorInput
 *  （EditorInput 子类）。旧代码会把它包进 LegacyEditorInput，导致
 *  FileEditor 组件的 `resolve()` 调用失败、Monaco 拿到错误 URI、内容为空。
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, afterEach } from 'vitest'
import {
  EditorInput,
  IFileService,
  InstantiationService,
  ServiceCollection,
  URI,
  type IFileService as IFileServiceType,
} from '@universe-editor/platform'
import { EditorService } from '../EditorService.js'
import { EditorGroupsService } from '../EditorGroupsService.js'
import { FileEditorInput } from '../FileEditorInput.js'

function makeFs(): IFileServiceType {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileText() {
      return 'hello'
    },
    async writeFile() {},
    async exists() {
      return true
    },
    async stat() {
      return { mtime: 1 } as Awaited<ReturnType<IFileServiceType['stat']>>
    },
    async list() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
  } as unknown as IFileServiceType
}

function makeEnv() {
  const services = new ServiceCollection()
  services.set(IFileService, makeFs())
  const inst = new InstantiationService(services)
  const groupsService = new EditorGroupsService()
  const editorService = new EditorService(groupsService)
  return { inst, groupsService, editorService }
}

afterEach(() => {
  // EditorGroupModel assigns monotonically-increasing IDs; reset is handled by
  // test isolation (fresh EditorGroupsService per test), no shared state to clear.
})

describe('EditorService.openEditor with FileEditorInput', () => {
  it('Bug-1 复现: 无 editor 时打开文件，editor 被加入 group 并成为 active', () => {
    const { inst, groupsService, editorService } = makeEnv()
    const resource = URI.file('/ws/main.ts')
    const input = inst.createInstance(FileEditorInput, resource)

    expect(groupsService.activeGroup.editors).toHaveLength(0)
    editorService.openEditor(input, { pinned: true })
    expect(groupsService.activeGroup.editors).toHaveLength(1)
    expect(groupsService.activeGroup.activeEditor).toBeTruthy()

    input.dispose()
  })

  it('Bug-2 复现: group 中存储的是原始 FileEditorInput，而非 LegacyEditorInput 包装', () => {
    const { inst, groupsService, editorService } = makeEnv()
    const resource = URI.file('/ws/main.ts')
    const input = inst.createInstance(FileEditorInput, resource)

    editorService.openEditor(input, { pinned: true })

    const stored = groupsService.activeGroup.activeEditor!
    // 修复前：stored 是 LegacyEditorInput，resource 为 legacy-input:///... 且无 resolve()
    // 修复后：stored 就是原始 FileEditorInput
    expect(stored).toBeInstanceOf(FileEditorInput)
    expect(stored.resource?.toString()).toBe(resource.toString())
    // FileEditorInput 具有 resolve 方法，LegacyEditorInput 没有
    expect(typeof (stored as FileEditorInput).resolve).toBe('function')

    input.dispose()
  })

  it('已有 editor 时再打开同一文件，不重复添加、直接激活已有 tab', () => {
    const { inst, groupsService, editorService } = makeEnv()
    const resource = URI.file('/ws/utils.ts')
    const input1 = inst.createInstance(FileEditorInput, resource)
    const input2 = inst.createInstance(FileEditorInput, resource)

    editorService.openEditor(input1, { pinned: true })
    editorService.openEditor(input2, { pinned: true })

    // 同一 URI → 同一 id，不应重复
    expect(groupsService.activeGroup.editors).toHaveLength(1)

    input1.dispose()
    input2.dispose()
  })

  it('打开两个不同文件，group 中有两个独立 FileEditorInput', () => {
    const { inst, groupsService, editorService } = makeEnv()
    const r1 = URI.file('/ws/a.ts')
    const r2 = URI.file('/ws/b.ts')
    const input1 = inst.createInstance(FileEditorInput, r1)
    const input2 = inst.createInstance(FileEditorInput, r2)

    editorService.openEditor(input1, { pinned: true })
    editorService.openEditor(input2, { pinned: true })

    const editors = groupsService.activeGroup.editors
    expect(editors).toHaveLength(2)
    // 两个 editor 都是真实的 FileEditorInput
    for (const e of editors) {
      expect(e).toBeInstanceOf(EditorInput) // 基类检查
      expect(e).toBeInstanceOf(FileEditorInput)
    }
    // 第二个打开的文件应当是 active
    expect(groupsService.activeGroup.activeEditor?.resource?.toString()).toBe(r2.toString())

    input1.dispose()
    input2.dispose()
  })

  it('存储在 group 中的 FileEditorInput 的 resource 是真实文件 URI，而非 legacy-input scheme', () => {
    const { inst, groupsService, editorService } = makeEnv()
    const resource = URI.file('/ws/config.json')
    const input = inst.createInstance(FileEditorInput, resource)

    editorService.openEditor(input, { pinned: true })

    const stored = groupsService.activeGroup.activeEditor!
    expect(stored.resource?.scheme).not.toBe('legacy-input')
    expect(stored.resource?.scheme).toBe('file')

    input.dispose()
  })
})
