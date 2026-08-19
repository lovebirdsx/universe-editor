import type { IEnvironmentSnapshotService } from '../../../../../shared/ipc/environmentSnapshotService.js'

/**
 * Shared IEnvironmentSnapshotService stub for AcpSessionService tests — no
 * builtin skills root by default, so `_builtinAgentDirs` injects nothing.
 * Pass a root to exercise the builtin agent skills injection paths.
 */
export function stubEnvSnapshotService(
  builtinAgentSkillsRoot?: string,
): IEnvironmentSnapshotService {
  return {
    _serviceBrand: undefined,
    getSnapshot: async () => ({
      userHome: '/home/user',
      cwd: '/cwd',
      execPath: '/exec',
      userDataDir: '/data',
      appResourcesPath: undefined,
      env: {},
      ...(builtinAgentSkillsRoot !== undefined ? { builtinAgentSkillsRoot } : {}),
    }),
  }
}
