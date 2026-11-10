/*---------------------------------------------------------------------------------------------
 *  Cold-launch fixture for Numbered Bookmarks extension specs. Activates only
 *  the bookmarks extension (P2 minimal set); the core suite never needs it, so
 *  keeping it here avoids paying for its gutter decorations everywhere. Each
 *  test gets a fresh Electron instance.
 *--------------------------------------------------------------------------------------------*/

import { createColdAppTest, resolveEditorBuild } from '@universe-editor/e2e-harness'

const { appRoot, mainEntry } = resolveEditorBuild()

export const test = createColdAppTest({
  appRoot,
  mainEntry,
  extensions: ['@universe-editor/numbered-bookmarks'],
})

export { expect, closeApp } from '@universe-editor/e2e-harness'
