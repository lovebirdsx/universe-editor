import { describe, expect, it } from 'vitest'
import {
  isMobileDirectoryListing,
  isMobileNewSessionOptions,
  isMobilePromptRefSuggestionsResult,
  isMobilePushBranchPreview,
  isMobilePushBranchResult,
  isMobileRewindPreview,
  isMobileRewindResult,
  isMobileSessionHistoryEntry,
  isMobileSessionHistoryList,
  isMobileSessionRef,
  isMobileSessionRefResult,
  isMobileSessionSettings,
  isMobileSideTaskList,
  isMobileSideTaskSummary,
  isResolvePromptRefResult,
  isSendableMobilePromptRef,
} from '../commandResults.js'

describe('command result guards', () => {
  it('accepts a complete session ref and rejects malformed halves', () => {
    expect(isMobileSessionRef({ windowId: 1, localId: 's1' })).toBe(true)
    expect(isMobileSessionRef({ windowId: 1, localId: 's1', durableId: 'durable-1' })).toBe(true)
    expect(isMobileSessionRef({ windowId: -1, localId: 's1' })).toBe(false)
    expect(isMobileSessionRef({ windowId: 1, localId: '' })).toBe(false)
    expect(isMobileSessionRef({ windowId: 1, localId: 's1', durableId: '' })).toBe(false)
    expect(isMobileSessionRef({ windowId: 1.5, localId: 's1' })).toBe(false)
    expect(isMobileSessionRefResult({ ref: { windowId: 1, localId: 's1' } })).toBe(true)
    expect(isMobileSessionRefResult({ ref: null })).toBe(false)
    expect(isMobileSessionRefResult('nope')).toBe(false)
  })

  it('validates directory listings and their canonical relative paths', () => {
    expect(
      isMobileDirectoryListing({
        relativePath: '',
        entries: [{ name: 'packages', relativePath: 'packages' }],
      }),
    ).toBe(true)
    expect(
      isMobileDirectoryListing({
        relativePath: 'packages',
        parentRelativePath: '',
        entries: [],
        truncated: true,
      }),
    ).toBe(true)
    expect(
      isMobileDirectoryListing({
        relativePath: '',
        entries: [{ name: 'a/b', relativePath: 'a/b' }],
      }),
    ).toBe(false)
    expect(
      isMobileDirectoryListing({
        relativePath: '',
        entries: [{ name: 'a', relativePath: '../a' }],
      }),
    ).toBe(false)
    expect(isMobileDirectoryListing({ relativePath: 'a/../b', entries: [] })).toBe(false)
    expect(isMobileDirectoryListing({ relativePath: '', parentRelativePath: 1, entries: [] })).toBe(
      false,
    )
    expect(isMobileDirectoryListing({ relativePath: '', entries: [], truncated: 'yes' })).toBe(
      false,
    )
    expect(isMobileDirectoryListing({ relativePath: '', entries: 'nope' })).toBe(false)
  })

  it('validates new-session options and their canonical relative paths', () => {
    expect(isMobileNewSessionOptions({ projectRoots: [] })).toBe(true)
    expect(
      isMobileNewSessionOptions({
        lastRelativePath: 'packages/demo',
        projectRoots: ['packages/demo'],
      }),
    ).toBe(true)
    expect(isMobileNewSessionOptions({ lastRelativePath: '', projectRoots: [] })).toBe(false)
    expect(isMobileNewSessionOptions({ lastRelativePath: '../a', projectRoots: [] })).toBe(false)
    expect(isMobileNewSessionOptions({ lastRelativePath: 'a\\b', projectRoots: [] })).toBe(false)
    expect(isMobileNewSessionOptions({})).toBe(false)
    expect(isMobileNewSessionOptions({ projectRoots: 'nope' })).toBe(false)
    expect(isMobileNewSessionOptions({ projectRoots: [''] })).toBe(false)
    expect(isMobileNewSessionOptions({ projectRoots: ['../a'] })).toBe(false)
    expect(isMobileNewSessionOptions({ projectRoots: ['a\\b'] })).toBe(false)
    expect(
      isMobileNewSessionOptions({
        projectRoots: Array.from({ length: 51 }, (_, index) => `a/${index}`),
      }),
    ).toBe(false)
  })

  it('accepts a rewind preview and rejects wrong types', () => {
    expect(isMobileRewindPreview({ canRewind: true, filesChanged: 0 })).toBe(true)
    expect(
      isMobileRewindPreview({
        canRewind: false,
        error: 'no checkpoint',
        filesChanged: 2,
        insertions: 1,
        deletions: 3,
      }),
    ).toBe(true)
    expect(isMobileRewindPreview({ canRewind: 'yes', filesChanged: 1 })).toBe(false)
    expect(isMobileRewindPreview({ canRewind: true, filesChanged: -1 })).toBe(false)
    expect(isMobileRewindPreview({ canRewind: true, filesChanged: 1, error: 1 })).toBe(false)
    expect(
      isMobileRewindPreview({ canRewind: true, filesChanged: 1, insertions: Number.NaN }),
    ).toBe(false)
  })

  it('accepts a rewind result and rejects wrong types', () => {
    expect(isMobileRewindResult({ canRewind: true })).toBe(true)
    expect(isMobileRewindResult({ canRewind: true, text: 'original' })).toBe(true)
    expect(isMobileRewindResult({ canRewind: false, error: 'locked' })).toBe(true)
    expect(isMobileRewindResult({ canRewind: 1 })).toBe(false)
    expect(isMobileRewindResult({ canRewind: true, text: 3 })).toBe(false)
  })

  it('validates push-branch previews and results', () => {
    const preview = {
      source: {
        worktreeName: 'feature',
        branch: 'feature',
        head: 'abc',
        dirty: false,
        changedFileCount: 0,
        untrackedCount: 0,
        isMainWorktree: false,
      },
      remote: { name: 'origin', branch: 'feature', exists: false, ahead: 0, behind: 0 },
      blockers: [],
      warnings: [],
      expectation: {
        branch: 'feature',
        head: 'abc',
        remote: 'origin',
        remoteBranch: 'feature',
      },
    }
    expect(isMobilePushBranchPreview(preview)).toBe(true)
    expect(
      isMobilePushBranchPreview({ ...preview, source: { ...preview.source, branch: '' } }),
    ).toBe(false)
    expect(
      isMobilePushBranchPreview({ ...preview, remote: { ...preview.remote, exists: 'no' } }),
    ).toBe(false)
    expect(isMobilePushBranchPreview({ ...preview, blockers: 'none' })).toBe(false)

    const result = {
      branch: 'feature',
      remote: 'origin',
      remoteBranch: 'feature',
      head: 'abc',
      published: true,
    }
    expect(isMobilePushBranchResult(result)).toBe(true)
    expect(isMobilePushBranchResult({ ...result, published: 'yes' })).toBe(false)
    expect(isMobilePushBranchResult({ ...result, remote: '' })).toBe(false)
  })

  it('validates side-task rows and lists', () => {
    const row = { id: 'side-1', title: 'Side', lastUsedAt: 1, live: true }
    expect(isMobileSideTaskSummary(row)).toBe(true)
    expect(isMobileSideTaskSummary({ ...row, id: '' })).toBe(false)
    expect(isMobileSideTaskSummary({ ...row, title: '' })).toBe(true)
    expect(isMobileSideTaskSummary({ ...row, title: 3 })).toBe(false)
    expect(isMobileSideTaskSummary({ ...row, lastUsedAt: Number.NaN })).toBe(false)
    expect(isMobileSideTaskSummary({ ...row, live: 'yes' })).toBe(false)
    expect(isMobileSideTaskList([row])).toBe(true)
    expect(isMobileSideTaskList([])).toBe(true)
    expect(isMobileSideTaskList([row, { id: '' }])).toBe(false)
    expect(isMobileSideTaskList('nope')).toBe(false)
  })

  it('validates session history rows and lists', () => {
    const row = {
      durableId: 'durable-1',
      windowId: 1,
      agentId: 'echo',
      agentName: 'Echo',
      title: 'Session',
      firstPrompt: 'Fix tests',
      workspaceName: 'demo',
      createdAt: 1,
      lastUsedAt: 2,
      pinned: true,
    }
    expect(isMobileSessionHistoryEntry(row)).toBe(true)
    const closedRow: Record<string, unknown> = {
      ...row,
      folder: 'file:///workspace/closed',
      authority: 'devhost',
    }
    delete closedRow.windowId
    expect(isMobileSessionHistoryEntry(closedRow)).toBe(true)
    expect(isMobileSessionHistoryEntry({ ...row, durableId: '' })).toBe(false)
    expect(isMobileSessionHistoryEntry({ ...row, windowId: -1 })).toBe(false)
    expect(isMobileSessionHistoryEntry({ ...row, title: 1 })).toBe(false)
    expect(isMobileSessionHistoryEntry({ ...row, firstPrompt: 1 })).toBe(false)
    expect(isMobileSessionHistoryEntry({ ...row, lastUsedAt: Number.NaN })).toBe(false)
    expect(isMobileSessionHistoryEntry({ ...row, pinned: 'yes' })).toBe(false)
    expect(isMobileSessionHistoryList([row])).toBe(true)
    expect(isMobileSessionHistoryList([])).toBe(true)
    expect(isMobileSessionHistoryList([row, { durableId: 'x' }])).toBe(false)
    expect(isMobileSessionHistoryList('nope')).toBe(false)
  })

  it('validates prompt-ref suggestion lists', () => {
    expect(
      isMobilePromptRefSuggestionsResult({
        entries: [{ kind: 'file', label: 'src/a.ts', uri: 'file:///w/src/a.ts' }],
      }),
    ).toBe(true)
    expect(
      isMobilePromptRefSuggestionsResult({
        entries: [
          {
            kind: 'symbol',
            label: 'fn',
            uri: 'file:///w/a.ts',
            line: 3,
            column: 1,
            symbolKind: 11,
          },
          { kind: 'docs', label: 'Guide', uri: 'file:///docs', dirPath: '/docs/zh-CN' },
        ],
      }),
    ).toBe(true)
    expect(
      isMobilePromptRefSuggestionsResult({
        entries: [{ kind: 'docs', label: 'Guide', uri: 'file:///docs' }],
      }),
    ).toBe(false)
    expect(
      isMobilePromptRefSuggestionsResult({
        entries: [{ kind: 'folder', label: 'src', uri: 'file:///w/src' }],
      }),
    ).toBe(false)
    expect(isMobilePromptRefSuggestionsResult({ entries: 'nope' })).toBe(false)
    expect(isMobilePromptRefSuggestionsResult({ entries: [{ kind: 'file', label: '' }] })).toBe(
      false,
    )
    expect(
      isMobilePromptRefSuggestionsResult({
        entries: [{ kind: 'file', label: 'a', uri: 'u', line: -1 }],
      }),
    ).toBe(false)
    expect(
      isMobilePromptRefSuggestionsResult({
        entries: [{ kind: 'file', label: 'a', uri: 'u', line: 0 }],
      }),
    ).toBe(false)
    expect(
      isMobilePromptRefSuggestionsResult({
        entries: [{ kind: 'file', label: 'a'.repeat(513), uri: 'u' }],
      }),
    ).toBe(false)
    expect(
      isMobilePromptRefSuggestionsResult({
        entries: Array.from({ length: 51 }, () => ({
          kind: 'file',
          label: 'a',
          uri: 'u',
        })),
      }),
    ).toBe(false)
  })

  it('validates commit and chatContext suggestions with their extra fields', () => {
    const hash = 'a'.repeat(40)
    expect(
      isMobilePromptRefSuggestionsResult({
        entries: [
          { kind: 'commit', label: 'Git Commit…', uri: '' },
          { kind: 'chatContext', label: 'Perforce CL', uri: '', chatContextHandle: 3 },
          {
            kind: 'commit',
            label: 'a1b2c3d subject',
            uri: 'file:///repo',
            commitHash: hash,
            text: 'subject',
          },
          { kind: 'chatContext', label: 'CL 1', uri: '', text: 'line1\nline2' },
        ],
      }),
    ).toBe(true)
    expect(
      isMobilePromptRefSuggestionsResult({
        entries: [{ kind: 'chatContext', label: 'CL', uri: 'file:///repo' }],
      }),
    ).toBe(false)
    expect(
      isMobilePromptRefSuggestionsResult({
        entries: [{ kind: 'chatContext', label: 'CL', uri: '', chatContextHandle: 0 }],
      }),
    ).toBe(false)
    expect(
      isMobilePromptRefSuggestionsResult({
        entries: [
          { kind: 'commit', label: 'a', uri: 'file:///repo', commitHash: 'not-hex', text: 's' },
        ],
      }),
    ).toBe(false)
    expect(
      isMobilePromptRefSuggestionsResult({
        entries: [{ kind: 'chatContext', label: 'CL', uri: '', text: 'a\u0000b' }],
      }),
    ).toBe(false)
  })

  it('validates resolve results and requires final commit/chatContext fields', () => {
    const hash = 'a'.repeat(40)
    expect(
      isResolvePromptRefResult(
        {
          kind: 'commit',
          entries: [
            {
              kind: 'commit',
              label: 'a1b2c3d s',
              uri: 'file:///repo',
              commitHash: hash,
              text: 's',
            },
          ],
        },
        'commit',
      ),
    ).toBe(true)
    expect(
      isResolvePromptRefResult(
        {
          kind: 'commit',
          entries: [{ kind: 'commit', label: 'a1b2c3d s', uri: 'file:///repo' }],
        },
        'commit',
      ),
    ).toBe(false)
    expect(isResolvePromptRefResult({ kind: 'chatContext' }, 'chatContext')).toBe(true)
    expect(
      isResolvePromptRefResult(
        {
          kind: 'chatContext',
          entry: { kind: 'chatContext', label: 'CL', uri: '', text: 'body' },
        },
        'chatContext',
      ),
    ).toBe(true)
    expect(
      isResolvePromptRefResult(
        {
          kind: 'chatContext',
          entry: { kind: 'chatContext', label: 'CL', uri: 'file:///w', text: 'body' },
        },
        'chatContext',
      ),
    ).toBe(false)
    expect(
      isResolvePromptRefResult(
        {
          kind: 'chatContext',
          entry: { kind: 'chatContext', label: 'CL', uri: '', chatContextHandle: 3, text: 'body' },
        },
        'chatContext',
      ),
    ).toBe(false)
    expect(isResolvePromptRefResult({ kind: 'commit', entries: [] }, 'chatContext')).toBe(false)
  })

  it('validates sendable refs used by draft restore and send', () => {
    const hash = 'a'.repeat(40)
    expect(
      isSendableMobilePromptRef({
        kind: 'commit',
        label: 'a1b2c3d s',
        uri: 'file:///repo',
        commitHash: hash,
        text: 's',
        start: 0,
        end: 9,
      }),
    ).toBe(true)
    expect(
      isSendableMobilePromptRef({
        kind: 'chatContext',
        label: 'CL',
        uri: '',
        text: 'body',
        start: 0,
        end: 3,
      }),
    ).toBe(true)
    expect(
      isSendableMobilePromptRef({
        kind: 'commit',
        label: 'x',
        uri: 'file:///repo',
        start: 0,
        end: 2,
      }),
    ).toBe(false)
    expect(
      isSendableMobilePromptRef({ kind: 'chatContext', label: 'CL', uri: '', start: 0, end: 3 }),
    ).toBe(false)
    expect(
      isSendableMobilePromptRef({
        kind: 'chatContext',
        label: 'CL',
        uri: '',
        chatContextHandle: 3,
        text: 'body',
        start: 0,
        end: 3,
      }),
    ).toBe(false)
    expect(
      isSendableMobilePromptRef({
        kind: 'commit',
        label: 'a1b2c3d s',
        uri: 'file:///repo',
        commitHash: hash,
        text: 's',
        description: 'bad\u0000description',
        start: 0,
        end: 9,
      }),
    ).toBe(false)
    expect(
      isSendableMobilePromptRef({
        kind: 'file',
        label: 'a',
        uri: 'file:///w/a',
        text: 'x',
        start: 0,
        end: 2,
      }),
    ).toBe(false)
    expect(
      isSendableMobilePromptRef({ kind: 'file', label: 'a', uri: 'file:///w/a', start: 0, end: 0 }),
    ).toBe(false)
  })
})

describe('isMobileSessionSettings', () => {
  const settings = {
    canEdit: true,
    subagentModel: { supported: true, current: 'opus', candidates: ['sonnet', 'opus'] },
    mcp: {
      pool: [
        { name: 'shared', transport: 'stdio', defaultDisabled: false },
        { name: 'docs', transport: 'http', defaultDisabled: true },
      ],
      selection: null,
      enabled: ['shared'],
      live: [{ name: 'shared', status: 'connected', transport: 'stdio' }],
    },
  }

  it('accepts a full payload and a null selection', () => {
    expect(isMobileSessionSettings(settings)).toBe(true)
    expect(
      isMobileSessionSettings({
        ...settings,
        subagentModel: { supported: false, current: null, candidates: [] },
      }),
    ).toBe(true)
    expect(
      isMobileSessionSettings({
        ...settings,
        mcp: {
          ...settings.mcp,
          selection: ['shared', 'docs'],
          live: [{ name: 'shared', status: 'failed' }],
        },
      }),
    ).toBe(true)
  })

  it('rejects malformed subagent fields', () => {
    expect(isMobileSessionSettings(null)).toBe(false)
    expect(isMobileSessionSettings({ ...settings, canEdit: 'yes' })).toBe(false)
    expect(isMobileSessionSettings({ ...settings, subagentModel: null })).toBe(false)
    expect(
      isMobileSessionSettings({
        ...settings,
        subagentModel: { supported: true, current: '', candidates: [] },
      }),
    ).toBe(false)
    expect(
      isMobileSessionSettings({
        ...settings,
        subagentModel: { supported: true, current: null, candidates: [3] },
      }),
    ).toBe(false)
    expect(
      isMobileSessionSettings({
        ...settings,
        subagentModel: { supported: true, current: null, candidates: new Array(65).fill('m') },
      }),
    ).toBe(false)
  })

  it('rejects malformed MCP fields', () => {
    expect(isMobileSessionSettings({ ...settings, mcp: null })).toBe(false)
    expect(
      isMobileSessionSettings({
        ...settings,
        mcp: {
          ...settings.mcp,
          pool: [{ name: 'shared', transport: 'websocket', defaultDisabled: false }],
        },
      }),
    ).toBe(false)
    expect(
      isMobileSessionSettings({
        ...settings,
        mcp: { ...settings.mcp, pool: [{ name: '', transport: 'stdio', defaultDisabled: false }] },
      }),
    ).toBe(false)
    expect(
      isMobileSessionSettings({ ...settings, mcp: { ...settings.mcp, selection: [''] } }),
    ).toBe(false)
    expect(isMobileSessionSettings({ ...settings, mcp: { ...settings.mcp, enabled: 'all' } })).toBe(
      false,
    )
    expect(
      isMobileSessionSettings({
        ...settings,
        mcp: { ...settings.mcp, live: [{ name: 'shared' }] },
      }),
    ).toBe(false)
    expect(
      isMobileSessionSettings({
        ...settings,
        mcp: { ...settings.mcp, live: [{ name: 'shared', status: 'ok', transport: 'ws' }] },
      }),
    ).toBe(false)
    expect(
      isMobileSessionSettings({
        ...settings,
        mcp: {
          ...settings.mcp,
          pool: Array.from({ length: 101 }, (_, index) => ({
            name: `s${index}`,
            transport: 'stdio',
            defaultDisabled: false,
          })),
        },
      }),
    ).toBe(false)
  })
})
