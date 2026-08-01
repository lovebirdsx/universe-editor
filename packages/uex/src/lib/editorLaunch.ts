/**
 * Builds the editor argv and launches it detached (the `code .` model: uex
 * returns immediately, the editor outlives it). Args are passed as an array
 * without a shell — the install path contains spaces ("Universe Editor.exe").
 */
import { spawn } from 'node:child_process'

export interface EditorLaunchOptions {
  readonly extensionPath: string
  readonly inspectPort?: number | undefined
  readonly userDataDir?: string | undefined
}

export function buildEditorArgs(opts: EditorLaunchOptions): string[] {
  const args = [`--extension-development-path=${opts.extensionPath}`]
  if (opts.inspectPort !== undefined) {
    args.push(`--inspect-extensions=${opts.inspectPort}`)
  }
  if (opts.userDataDir !== undefined) {
    args.push(`--user-data-dir=${opts.userDataDir}`)
  }
  return args
}

export function launchEditor(exePath: string, args: readonly string[]): void {
  const child = spawn(exePath, args as string[], { stdio: 'ignore', detached: true })
  child.unref()
}
