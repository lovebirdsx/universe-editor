/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  fake MCP server 的可变状态。单独成文件，避免测试与服务器实现互相 import 循环。
 *--------------------------------------------------------------------------------------------*/

export function createMcpState() {
  return {
    token: 'read-token',
    responseMode: 'json',
    failNextStatus: undefined,
    requests: [],
    toolCalls: [],
    requirements: seedRequirements(),
    comments: new Map(),
    transitions: new Map(),
    commentSeq: 1,
  }
}

function seedRequirements() {
  return [
    {
      id: 'r1',
      boardId: 'board-1',
      project: 'universe-editor',
      title: 'Add widget',
      status: 'planned',
      labels: ['ai-ready'],
      priority: 2,
      effort: 3,
      claimedRunIds: [],
      createdAt: '2026-01-02T00:00:00.000Z',
      url: 'https://tracker.example.com/posts/r1',
      body: '## Body\n\nWidget spec',
      author: { id: 'u1', name: 'alice' },
      assignees: [{ id: 'u2', name: 'bob', role: 'owner' }],
      attachments: [{ name: 'spec.md', url: 'https://tracker.example.com/files/spec.md' }],
      comments: [
        {
          id: 'c1',
          author: { id: 'u1', name: 'alice' },
          body: 'first comment',
          createdAt: '2026-01-02T01:00:00.000Z',
        },
      ],
    },
    {
      id: 'r2',
      boardId: 'board-1',
      project: 'universe-editor',
      title: 'Older planned item',
      status: 'planned',
      labels: ['ai-ready', 'bug'],
      createdAt: '2026-01-01T00:00:00.000Z',
      body: '',
      author: null,
      assignees: [],
      attachments: [],
      comments: [],
    },
    {
      id: 'r3',
      boardId: 'board-1',
      project: 'universe-editor',
      title: 'Done item',
      status: 'done',
      labels: ['ai-ready'],
      createdAt: '2026-01-03T00:00:00.000Z',
      body: '',
      author: null,
      assignees: [],
      attachments: [],
      comments: [],
    },
  ]
}

export function resetMcpState(state, token = state.token) {
  Object.assign(state, createMcpState(), { token })
}
