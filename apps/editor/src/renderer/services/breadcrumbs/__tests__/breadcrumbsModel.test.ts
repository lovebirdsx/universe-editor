/*---------------------------------------------------------------------------------------------
 *  Tests for services/breadcrumbs/breadcrumbsModel.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI, type IUriIdentityService, type IWorkspace } from '@universe-editor/platform'
import {
  buildBreadcrumbEntries,
  buildFileBreadcrumbSegments,
  buildSymbolBreadcrumbSegments,
} from '../breadcrumbsModel.js'
import type { OutlineModel } from '../../languageFeatures/editorOutlineTracker.js'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'

const uriIdentity = {
  isEqual: (a: URI, b: URI) => a.toString() === b.toString(),
  relativePath: (from: URI, to: URI) => {
    const base = from.path.replace(/\/+$/, '')
    if (to.path === base) return ''
    if (!to.path.startsWith(`${base}/`)) return null
    return to.path.slice(base.length + 1)
  },
} as unknown as IUriIdentityService

function workspace(folder: URI): IWorkspace {
  return { folder } as IWorkspace
}

function symbol(name: string, children: monaco.languages.DocumentSymbol[] = []) {
  const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 10, endColumn: 1 }
  return {
    name,
    detail: '',
    kind: 14 as monaco.languages.SymbolKind,
    tags: [],
    range,
    selectionRange: range,
    children,
  }
}

describe('buildFileBreadcrumbSegments', () => {
  it('renders workspace-relative segments without a workspace root segment', () => {
    const folder = URI.file('/ws')
    const segments = buildFileBreadcrumbSegments(
      URI.file('/ws/src/components/a.ts'),
      workspace(folder),
      uriIdentity,
      'on',
    )
    expect(segments.map((s) => [s.kind, s.label])).toEqual([
      ['folder', 'src'],
      ['folder', 'components'],
      ['file', 'a.ts'],
    ])
    expect(segments[0]!.uri.toString()).toBe('file:///ws/src')
    expect(segments[2]!.uri.toString()).toBe('file:///ws/src/components/a.ts')
  })

  it('shows no path for the workspace folder itself', () => {
    const folder = URI.file('/ws')
    expect(buildFileBreadcrumbSegments(folder, workspace(folder), uriIdentity, 'on')).toEqual([])
  })

  it('falls back to the absolute path outside the workspace', () => {
    const segments = buildFileBreadcrumbSegments(
      URI.file('/tmp/a.ts'),
      workspace(URI.file('/ws')),
      uriIdentity,
      'on',
    )
    expect(segments.map((s) => [s.kind, s.label])).toEqual([
      ['root', '/'],
      ['folder', 'tmp'],
      ['file', 'a.ts'],
    ])
    expect(segments[0]!.uri.toString()).toBe('file:///')
  })

  it('uses an absolute path when there is no workspace', () => {
    const segments = buildFileBreadcrumbSegments(URI.file('/tmp/dir/a.ts'), null, uriIdentity, 'on')
    expect(segments.map((s) => s.label)).toEqual(['/', 'tmp', 'dir', 'a.ts'])
  })

  it('recognises a Windows drive root', () => {
    const segments = buildFileBreadcrumbSegments(
      URI.parse('file:///C:/Users/a.ts'),
      null,
      uriIdentity,
      'on',
    )
    expect(segments[0]!.label).toBe('C:\\')
    expect(segments[0]!.uri.path).toBe('/C:/')
    expect(segments.map((s) => s.label)).toEqual(['C:\\', 'Users', 'a.ts'])
  })

  it('preserves the remote scheme and authority', () => {
    const folder = URI.parse('vscode-remote://ssh-remote+host/ws')
    const check = {
      isEqual: uriIdentity.isEqual,
      relativePath: (from: URI, to: URI) => {
        const base = from.path.replace(/\/+$/, '')
        if (to.path === base) return ''
        if (!to.path.startsWith(`${base}/`)) return null
        return to.path.slice(base.length + 1)
      },
    } as unknown as IUriIdentityService
    const segments = buildFileBreadcrumbSegments(
      URI.parse('vscode-remote://ssh-remote+host/ws/src/a.ts'),
      workspace(folder),
      check,
      'on',
    )
    expect(segments.map((s) => s.label)).toEqual(['src', 'a.ts'])
    expect(segments[1]!.uri.scheme).toBe('vscode-remote')
    expect(segments[1]!.uri.authority).toBe('ssh-remote+host')
    expect(segments[1]!.uri.toString()).toBe('vscode-remote://ssh-remote+host/ws/src/a.ts')
  })

  it('honours off and last modes', () => {
    const folder = URI.file('/ws')
    const resource = URI.file('/ws/src/a.ts')
    expect(buildFileBreadcrumbSegments(resource, workspace(folder), uriIdentity, 'off')).toEqual([])
    expect(
      buildFileBreadcrumbSegments(resource, workspace(folder), uriIdentity, 'last').map(
        (s) => s.label,
      ),
    ).toEqual(['a.ts'])
  })
})

describe('buildSymbolBreadcrumbSegments', () => {
  const child = symbol('child', [symbol('## Child')])
  const root = symbol('root', [child])
  const outline: OutlineModel = {
    uri: 'file:///ws/a.md',
    roots: [root],
    languageId: 'markdown',
    version: 1,
  }
  const active = child.children[0]!

  it('renders the active symbol ancestry', () => {
    const segments = buildSymbolBreadcrumbSegments(outline, active, 'on')
    expect(segments.map((s) => s.label)).toEqual(['root', 'child', 'Child'])
    expect(segments.every((s) => s.kind === 'symbol')).toBe(true)
  })

  it('strips markdown heading markup for display', () => {
    expect(buildSymbolBreadcrumbSegments(outline, active, 'on')[2]!.label).toBe('Child')
  })

  it('honours off and last modes', () => {
    expect(buildSymbolBreadcrumbSegments(outline, active, 'off')).toEqual([])
    expect(buildSymbolBreadcrumbSegments(outline, active, 'last').map((s) => s.label)).toEqual([
      'Child',
    ])
  })

  it('returns nothing without an active symbol', () => {
    expect(buildSymbolBreadcrumbSegments(outline, undefined, 'on')).toEqual([])
  })
})

describe('buildBreadcrumbEntries', () => {
  it('assigns contiguous indices across file and symbol segments', () => {
    const fileSegments = buildFileBreadcrumbSegments(
      URI.file('/ws/src/a.ts'),
      workspace(URI.file('/ws')),
      uriIdentity,
      'on',
    )
    const outline: OutlineModel = {
      uri: 'file:///ws/src/a.ts',
      roots: [symbol('root')],
      languageId: 'typescript',
      version: 1,
    }
    const symbolSegments = buildSymbolBreadcrumbSegments(outline, outline.roots[0], 'on')
    const entries = buildBreadcrumbEntries(fileSegments, symbolSegments)
    expect(entries.map((e) => e.index)).toEqual([0, 1, 2])
    expect(entries.map((e) => e.kind)).toEqual(['file', 'file', 'symbol'])
  })
})
