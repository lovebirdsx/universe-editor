import { URI } from '@universe-editor/platform'
import type {
  P4GraphChangeDetailsDto,
  ShowCommitChangesPayload,
} from '@universe-editor/extensions-common'

const OPEN_FILE_DIFF_COMMAND = 'perforce-graph.openFileDiff'

export function buildChangePayload(details: P4GraphChangeDetailsDto): ShowCommitChangesPayload {
  const subject = details.body.split('\n', 1)[0]?.trim() ?? ''
  const base = `Changelist ${details.id}`
  return {
    providerId: 'perforce',
    title: subject ? `${base} — ${subject}` : base,
    subtitle: `${details.author} · ${new Date(details.date * 1000).toLocaleString()}`,
    commitRef: String(details.id),
    openExternalCommand: OPEN_FILE_DIFF_COMMAND,
    files: details.files.map((f) => ({
      path: f.path,
      oldPath: f.oldPath,
      status: f.status,
      resourceUri: f.localPath !== null ? URI.file(f.localPath).toString() : null,
      args: {
        depotFile: f.depotFile,
        status: f.status,
        rev: f.rev,
        ...(f.localPath !== null ? { localPath: f.localPath } : {}),
      },
    })),
    metadata: { author: details.author, authorDate: details.date, message: details.body },
  }
}
