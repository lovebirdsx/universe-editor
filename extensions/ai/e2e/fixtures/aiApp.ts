/*---------------------------------------------------------------------------------------------
 *  Launch helper for AI extension specs. These specs self-launch (each seeds its
 *  own userData with aiSettings.json + a real git repo), so instead of a Playwright
 *  fixture they call launchAiApp() directly. Activates git + ai only (P2 minimal
 *  set): git provides the SCM source control the commit button lives in; ai
 *  contributes ai.generateCommitMessage and the AI model plumbing.
 *--------------------------------------------------------------------------------------------*/

import type { ElectronApplication } from '@playwright/test'
import { launchApp, resolveEditorBuild, type LaunchAppOptions } from '@universe-editor/e2e-harness'

const { appRoot, mainEntry } = resolveEditorBuild()

export const AI_E2E_EXTENSIONS = ['@universe-editor/git', '@universe-editor/ai']

export function launchAiApp(
  options: Omit<LaunchAppOptions, 'appRoot' | 'mainEntry'>,
): Promise<ElectronApplication> {
  return launchApp({ appRoot, mainEntry, extensions: AI_E2E_EXTENSIONS, ...options })
}
