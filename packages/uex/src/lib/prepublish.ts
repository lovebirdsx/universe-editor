/**
 * Runs the extension's `universe:prepublish` npm script before packaging —
 * the same hook vsce fires as `vscode:prepublish`. Authors put their build
 * there so `uex package` can never ship a stale `dist/`.
 */
import { spawnSync } from 'node:child_process'
import { UexError } from '../errors.js'

export interface PrepublishRunner {
  (command: string, cwd: string): number
}

/** Default runner: spawnSync through the shell so `npm.cmd` works on Windows
 *  (CVE-2024-27980 rejects spawning .cmd directly). The command string is a
 *  constant — never interpolate user input into it. */
const defaultRunner: PrepublishRunner = (command, cwd) =>
  spawnSync(command, { cwd, shell: true, stdio: 'inherit' }).status ?? 1

/**
 * Execute `universe:prepublish` when the manifest declares it. Returns whether
 * a script ran; throws UexError when it ran and failed.
 */
export async function runPrepublishScript(
  extensionDir: string,
  scripts: Record<string, string> | undefined,
  runner: PrepublishRunner = defaultRunner,
): Promise<boolean> {
  if (!scripts || !('universe:prepublish' in scripts)) return false
  const status = runner('npm run universe:prepublish', extensionDir)
  if (status !== 0) {
    throw new UexError('universe:prepublish failed', ['fix the build error above and retry'])
  }
  return true
}
