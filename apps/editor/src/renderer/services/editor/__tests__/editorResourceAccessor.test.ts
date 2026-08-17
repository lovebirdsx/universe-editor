import { describe, it, expect } from 'vitest'
import {
  URI,
  type ICommandService,
  type IFileService,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { getOriginalResource } from '../editorResourceAccessor.js'
import { DiffEditorInput } from '../DiffEditorInput.js'
import { FileEditorInput } from '../FileEditorInput.js'
import { MergeEditorInput } from '../MergeEditorInput.js'
import { SettingsEditorInput } from '../SettingsEditorInput.js'
import { WebviewDiffInput } from '../WebviewDiffInput.js'

const fileService = {} as IFileService
const commandService = {} as ICommandService
const workspaceService = { current: null } as IWorkspaceService

describe('getOriginalResource', () => {
  it('returns the resource of a file editor', () => {
    const uri = URI.file('/ws/a.ts')
    expect(getOriginalResource(new FileEditorInput(uri, fileService))?.toString()).toBe(
      uri.toString(),
    )
  })

  it('resolves a same-file diff to the file itself (timeline stays on the file)', () => {
    const uri = URI.file('/ws/a.ts')
    expect(getOriginalResource(new DiffEditorInput(uri, 'base', 'current'))?.toString()).toBe(
      uri.toString(),
    )
  })

  it('resolves a cross-file diff to the modified (right-hand) side', () => {
    const left = URI.file('/ws/a.ts')
    const right = URI.file('/ws/b.ts')
    expect(getOriginalResource(new DiffEditorInput(left, 'A', 'B', right))?.toString()).toBe(
      right.toString(),
    )
  })

  it('resolves a webview diff to the modified (right-hand) side', () => {
    const left = URI.file('/ws/a.xlsx')
    const right = URI.file('/ws/b.xlsx')
    const input = new WebviewDiffInput(
      'universe.excel',
      left,
      right,
      new Uint8Array(),
      new Uint8Array(),
      't',
    )
    expect(getOriginalResource(input)?.toString()).toBe(right.toString())
  })

  it('resolves a merge editor to the conflicted file', () => {
    const input = new MergeEditorInput(
      {
        path: '/ws/a.ts',
        base: '',
        current: '',
        incoming: '',
        merged: '',
        currentLabel: 'HEAD',
        incomingLabel: 'theirs',
      },
      fileService,
      commandService,
      workspaceService,
    )
    expect(getOriginalResource(input)?.toString()).toBe(URI.file('/ws/a.ts').toString())
  })

  it('returns undefined for editors with no backing file', () => {
    expect(getOriginalResource(new SettingsEditorInput())).toBeUndefined()
    expect(getOriginalResource(undefined)).toBeUndefined()
  })
})
