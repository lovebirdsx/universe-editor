import type { IWindowRenderCrashInfo, IWindowsService } from '@universe-editor/platform'

/**
 * Shared IWindowsService stub for AcpSessionService tests — no crash by
 * default, so `shouldSkipAutoResume` never fires. Pass a crash record (or an
 * Error to make the query reject) to exercise the OOM auto-resume guard.
 */
export function stubWindowsService(crash?: IWindowRenderCrashInfo | null | Error): IWindowsService {
  return {
    _serviceBrand: undefined,
    onDidChangeWindows: () => ({ dispose: () => {} }),
    getWindows: async () => [],
    isCurrentWindowFirst: async () => true,
    getCurrentWindowId: async () => 1,
    getFocusedWindowId: async () => 1,
    onDidChangeFocusedWindow: () => ({ dispose: () => {} }),
    getLastRenderCrash:
      crash instanceof Error ? async () => Promise.reject(crash) : async () => crash ?? null,
    focusWindow: async () => {},
    openWindow: async () => {},
    quit: async () => {},
  }
}
