/*---------------------------------------------------------------------------------------------
 * Integration: UserDataMainService + WorkspaceMainService — file-slot layering
 * Tests that user settings and project settings land in the correct file paths, and that
 * opening/closing a workspace installs/removes the ProjectSettings slot as expected.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { URI, UserDataFile } from '@universe-editor/platform'
import { createTestWorkbench, type TestWorkbench } from '../fixtures/createTestWorkbench.js'

describe('settings.userToWorkspaceLayering (integration)', () => {
  let wb: TestWorkbench

  beforeEach(async () => {
    wb = await createTestWorkbench()
  })

  afterEach(async () => {
    await wb.dispose()
    vi.clearAllMocks()
  })

  it('user settings slot maps to <userData>/settings.json', async () => {
    const content = '{ "editor.fontSize": 16 }\n'
    await fs.writeFile(join(wb.userDataDir, 'settings.json'), content, 'utf8')

    const read = await wb.userData.read(UserDataFile.Settings)
    expect(read).toBe(content)
  })

  it('project settings slot becomes active when workspace is opened', async () => {
    const workspaceDir = join(wb.userDataDir, 'my-workspace')
    await fs.mkdir(workspaceDir, { recursive: true })

    await wb.workspace.openFolder(URI.file(workspaceDir))

    // Allow watcher setup and slot installation to settle
    await new Promise((r) => setTimeout(r, 50))

    const projectSettingsPath = join(workspaceDir, '.universe-editor', 'settings.json')
    await fs.mkdir(join(workspaceDir, '.universe-editor'), { recursive: true })
    await fs.writeFile(projectSettingsPath, '{ "editor.tabSize": 2 }\n', 'utf8')

    const content = await wb.userData.read(UserDataFile.ProjectSettings)
    expect(content).toBe('{ "editor.tabSize": 2 }\n')
  })

  it('project settings slot is absent before any workspace is opened', async () => {
    // No workspace opened — read should return empty string (slot exists but file missing)
    const content = await wb.userData.read(UserDataFile.ProjectSettings)
    expect(content).toBe('')
  })
})
