import type {
  GitGraphCommitDetailsDto,
  GitGraphFileChangeDto,
  ShowCommitChangesPayload,
} from '@universe-editor/extensions-common'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const OPEN_FILE_DIFF_COMMAND = 'git-graph.openFileDiff'

/** Join a repo root (bare fs path) with a repo-relative posix path into the
 *  same bare absolute path the provider host produces via `path.join`. */
function joinFsPath(root: string, rel: string): string {
  const base = root.endsWith('/') || root.endsWith('\\') ? root.slice(0, -1) : root
  return `${base}/${rel}`
}

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
      resourcePath: joinFsPath(root, f.path),
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
      resourcePath: joinFsPath(root, f.path),
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
