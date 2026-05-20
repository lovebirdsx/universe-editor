import { bench, describe } from 'vitest'
import { EditorGroupModel, EditorInput, URI } from '@universe-editor/platform'

// Minimal EditorInput for benchmarking — no file system or Monaco deps
class TestInput extends EditorInput {
  static count = 0
  override readonly typeId = 'bench.testInput'
  override readonly resource: URI

  constructor() {
    super()
    this.resource = URI.file(`/bench/file-${TestInput.count++}.ts`)
  }
  override getName(): string {
    return this.resource.path
  }
}

function makeGroup(): EditorGroupModel {
  return new EditorGroupModel()
}

function makeInputs(count: number): TestInput[] {
  return Array.from({ length: count }, () => new TestInput())
}

describe('editorGroups layout', () => {
  bench('open 5 editors in a group', () => {
    const group = makeGroup()
    const inputs = makeInputs(5)
    for (const input of inputs) {
      group.openEditor(input, { activate: true, pinned: true })
    }
    group.dispose()
    for (const i of inputs) i.dispose()
  })

  bench('open 5 editors x 6 groups (30 editors total)', () => {
    const groups = Array.from({ length: 6 }, makeGroup)
    const inputs = makeInputs(30)
    let idx = 0
    for (const group of groups) {
      for (let i = 0; i < 5; i++) {
        group.openEditor(inputs[idx++]!, { activate: true, pinned: true })
      }
    }
    for (const g of groups) g.dispose()
    for (const i of inputs) i.dispose()
  })

  bench('close all editors in a group of 20', () => {
    const group = makeGroup()
    const inputs = makeInputs(20)
    for (const input of inputs) {
      group.openEditor(input, { activate: true, pinned: true })
    }
    // Close all
    for (const input of inputs) {
      group.closeEditor(input)
    }
    group.dispose()
    for (const i of inputs) i.dispose()
  })
})
