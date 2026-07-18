/*---------------------------------------------------------------------------------------------
 *  Fixture + launch helper for core specs that need the git SCM provider to set up
 *  their scenario (dirty-diff quick-diff gutter, keybinding-reload sentinel). The
 *  behaviour under test is core — the git extension is only activated so a real
 *  SourceControl / quick-diff exists. Everything else stays off (P2 minimal set).
 *
 *  `test` is a Playwright fixture for specs that just need a git-enabled window;
 *  `launchCoreGitApp` is for specs that self-launch (they seed their own userData
 *  + git repo before opening the window).
 *--------------------------------------------------------------------------------------------*/

import type { ElectronApplication } from '@playwright/test'
import { createColdAppTest, launchApp, type LaunchAppOptions } from '@universe-editor/e2e-harness'
import { APP_ROOT, MAIN_ENTRY } from './electronApp.js'

const CORE_GIT_EXTENSIONS = ['@universe-editor/git']

export const test = createColdAppTest({
  appRoot: APP_ROOT,
  mainEntry: MAIN_ENTRY,
  extensions: CORE_GIT_EXTENSIONS,
})

export function launchCoreGitApp(
  options: Omit<LaunchAppOptions, 'appRoot' | 'mainEntry'>,
): Promise<ElectronApplication> {
  return launchApp({
    appRoot: APP_ROOT,
    mainEntry: MAIN_ENTRY,
    extensions: CORE_GIT_EXTENSIONS,
    ...options,
  })
}

export { expect, closeApp } from '@universe-editor/e2e-harness'
