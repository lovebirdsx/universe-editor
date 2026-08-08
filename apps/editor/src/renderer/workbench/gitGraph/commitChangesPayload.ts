import { URI } from '@universe-editor/platform'
import type {
  GitGraphCommitDetailsDto,
  GitGraphFileChangeDto,
  ShowCommitChangesPayload,
} from '@universe-editor/extensions-common'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const OPEN_FILE_DIFF_COMMAND = 'git-graph.openFileDiff'

export function buildCommitPayload(
  root: string,
  details: GitGraphCommitDetailsDto,
): ShowCommitChangesPayload {
  const fromHash = details.parents[0] ?? EMPTY_TREE
  const subject = details.body.split('\n', 1)[0] ?? ''
  return {
    providerId: 'git',
    title: `${details.hash.slice(0, 7)} — ${subject}`,
    subtitle: `${details.author} · ${new Date(details.authorDate * 1000).toLocaleString()}`,
    commitRef: details.hash,
    openExternalCommand: OPEN_FILE_DIFF_COMMAND,
    files: details.files.map((f) => ({
      path: f.path,
      oldPath: f.oldPath,
      status: f.status,
      resourceUri: URI.joinPath(URI.file(root), f.path).toString(),
      args: {
        root,
        fromHash,
        toHash: details.hash,
        path: f.path,
        ...(f.oldPath !== null ? { oldPath: f.oldPath } : {}),
        status: f.status,
      },
    })),
    metadata: {
      author: details.author,
      authorDate: details.authorDate,
      message: details.body,
      parents: details.parents,
    },
  }
}

export function buildComparePayload(
  root: string,
  from: string,
  to: string,
  files: GitGraphFileChangeDto[],
): ShowCommitChangesPayload {
  return {
    providerId: 'git',
    title: `${from.slice(0, 7)} ↔ ${to.slice(0, 7)}`,
    commitRef: `${from}..${to}`,
    openExternalCommand: OPEN_FILE_DIFF_COMMAND,
    files: files.map((f) => ({
      path: f.path,
      oldPath: f.oldPath,
      status: f.status,
      resourceUri: URI.joinPath(URI.file(root), f.path).toString(),
      args: {
        root,
        fromHash: from,
        toHash: to,
        path: f.path,
        ...(f.oldPath !== null ? { oldPath: f.oldPath } : {}),
        status: f.status,
      },
    })),
    metadata: { compareRefs: { from, to } },
  }
}
