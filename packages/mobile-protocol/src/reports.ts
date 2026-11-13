/**
 * Trigger-run report served over the gateway's authenticated HTTP API. The
 * phone addresses a session, never a path: main resolves the run id from the
 * live session's automation metadata and reads `<runDir>/report.md`.
 */
export const MOBILE_SESSION_REPORT_PATH = '/api/sessions/report'
export const MAX_SESSION_REPORT_BYTES = 512 * 1024
export const MOBILE_SESSION_REPORT_MIME = 'text/markdown; charset=utf-8'
