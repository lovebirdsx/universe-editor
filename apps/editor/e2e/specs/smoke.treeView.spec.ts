/*---------------------------------------------------------------------------------------------
 *  Smoke spec: extension-contributed tree views end-to-end.
 *
 *  Installs a minimal `.vsix` declaring `contributes.viewsContainers.activitybar`
 *  + `contributes.views` + a `view/item/context` menu, then drives the view like
 *  a user: open the container from the activity bar (which mounts the view and
 *  fires the `onView:` activation), assert the pulled roots render, expand a
 *  collapsed node (lazy `extHostTreeViews.$getChildren` pull), click a leaf with
 *  a command (renderer → host command routing), and confirm the provider's
 *  `onDidChangeTreeData` refresh re-pulls and re-renders. The second test opens
 *  the row context menu and checks the `view`/`viewItem`-gated contribution.
 *
 *  The extension talks to the host bridge global directly (same object the api
 *  package delegates to) so the vsix needs no bundled node_modules.
 *
 *  @p1 (extension host is a child process, slower than the core workbench path).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import AdmZip from 'adm-zip'
import { test, expect } from '../fixtures/electronApp.js'

const CONTAINER_ID = 'e2eTree'
const VIEW_ID = 'e2eTree.view'

async function makeTreeViewVsix(dir: string): Promise<string> {
  const manifest = {
    name: 'e2e-tree-view',
    publisher: 'universe',
    version: '1.0.0',
    engines: { universe: '*' },
    main: 'dist/extension.js',
    activationEvents: [`onView:${VIEW_ID}`, 'onCommand:e2eTree.rename'],
    contributes: {
      viewsContainers: {
        activitybar: [{ id: CONTAINER_ID, title: 'E2E Tree', icon: '$(folder)' }],
      },
      views: {
        [CONTAINER_ID]: [{ id: VIEW_ID, name: 'E2E Tree View' }],
      },
      commands: [{ command: 'e2eTree.rename', title: 'Rename Node' }],
      menus: {
        'view/item/context': [
          {
            command: 'e2eTree.rename',
            when: `view == '${VIEW_ID}' && viewItem == 'special'`,
            group: '1_modification',
          },
        ],
      },
    },
  }

  // The tree: roots [parent(collapsed), leaf(command)]; parent's child is
  // [child(contextValue 'special')]. The ping/rename command handlers flip a
  // flag and fire onDidChangeTreeData, so the re-pulled labels prove the whole
  // round trip (click → host command → $refresh → renderer re-pull).
  const source = `
    const bridge = globalThis['__universeExtensionHostBridge__']
    exports.activate = (context) => {
      let pinged = false
      let renamed = false
      let fireChange = undefined
      const provider = {
        onDidChangeTreeData: (listener) => {
          fireChange = listener
          return { dispose() {} }
        },
        getChildren: (el) => {
          if (el === undefined) return [{ name: 'parent' }, { name: 'leaf' }]
          if (el.name === 'parent') return [{ name: 'child' }]
          return []
        },
        getTreeItem: (el) => {
          if (el.name === 'parent') {
            return { label: pinged ? 'parent-pinged' : 'parent', collapsibleState: 1 }
          }
          if (el.name === 'leaf') {
            return {
              label: 'leaf',
              collapsibleState: 0,
              command: { command: 'e2eTree.ping', title: 'Ping' },
            }
          }
          return {
            label: renamed ? 'child-renamed' : 'child',
            collapsibleState: 0,
            contextValue: 'special',
          }
        },
      }
      context.subscriptions.push(bridge.registerTreeDataProvider(${JSON.stringify(VIEW_ID)}, provider))
      context.subscriptions.push(
        bridge.registerCommand('e2eTree.ping', () => {
          pinged = true
          fireChange && fireChange()
        }),
        bridge.registerCommand('e2eTree.rename', () => {
          renamed = true
          fireChange && fireChange()
        }),
      )
    }
    exports.deactivate = () => {}
  `

  const zip = new AdmZip()
  zip.addFile('extension/package.json', Buffer.from(JSON.stringify(manifest)))
  zip.addFile('extension/dist/extension.js', Buffer.from(source))
  const vsixPath = path.join(dir, 'e2e-tree-view.vsix')
  await fs.writeFile(vsixPath, zip.toBuffer())
  return vsixPath
}

test.describe('@p1 extension tree view', () => {
  test('renders the tree, expands lazily, runs item commands and refreshes @regression', async ({
    workbench,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-treeview-'))
    const vsixPath = await makeTreeViewVsix(tmpDir)

    await workbench.waitForRestored()

    const installedId = await workbench.page.evaluate(
      (p) => window.__E2E__!.installVsixExtension(p),
      vsixPath,
    )
    expect(installedId).toBe('universe.e2e-tree-view')

    // The contributed container appears in the activity bar after the install's
    // contribution re-translation; clicking it reveals (and mounts) the view,
    // which fires the onView: activation for the extension.
    const containerItem = workbench.page.locator(`[data-testid="activitybar-item-${CONTAINER_ID}"]`)
    await expect(containerItem).toHaveCount(1, { timeout: 15000 })
    await containerItem.click()

    // The view mounts and pulls the roots over extHostTreeViews.$getChildren.
    const view = workbench.page.locator(`[data-testid="extension-tree-view-${VIEW_ID}"]`)
    await expect(view).toHaveCount(1, { timeout: 15000 })
    const rows = view.locator('[data-testid="extension-tree-item"]')
    await expect.poll(() => rows.allTextContents(), { timeout: 15000 }).toEqual(['parent', 'leaf'])

    // Expanding 'parent' lazily pulls its child.
    await view.getByText('parent', { exact: true }).click()
    await expect
      .poll(() => rows.allTextContents(), { timeout: 15000 })
      .toEqual(['parent', 'child', 'leaf'])

    // Clicking the command leaf routes e2eTree.ping to the host; the handler
    // fires onDidChangeTreeData and the refreshed root label comes back.
    await view.getByText('leaf', { exact: true }).click()
    await expect
      .poll(async () => (await rows.allTextContents()).includes('parent-pinged'), {
        timeout: 15000,
      })
      .toBe(true)

    await workbench.page.evaluate((id) => window.__E2E__!.uninstallExtension(id), installedId)
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test('row context menu honours view/viewItem when-clauses @regression', async ({ workbench }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-treeview-menu-'))
    const vsixPath = await makeTreeViewVsix(tmpDir)

    await workbench.waitForRestored()

    const installedId = await workbench.page.evaluate(
      (p) => window.__E2E__!.installVsixExtension(p),
      vsixPath,
    )

    const containerItem = workbench.page.locator(`[data-testid="activitybar-item-${CONTAINER_ID}"]`)
    await expect(containerItem).toHaveCount(1, { timeout: 15000 })
    await containerItem.click()

    const view = workbench.page.locator(`[data-testid="extension-tree-view-${VIEW_ID}"]`)
    const rows = view.locator('[data-testid="extension-tree-item"]')
    await expect.poll(() => rows.allTextContents(), { timeout: 15000 }).toEqual(['parent', 'leaf'])
    await view.getByText('parent', { exact: true }).click()
    await expect
      .poll(() => rows.allTextContents(), { timeout: 15000 })
      .toEqual(['parent', 'child', 'leaf'])

    // The 'child' row carries contextValue 'special' → the gated item shows.
    await view.getByText('child', { exact: true }).click({ button: 'right' })
    const renameItem = workbench.page.getByRole('menuitem', { name: 'Rename Node' })
    await expect(renameItem).toHaveCount(1, { timeout: 10000 })

    // Invoking it activates the extension on its onCommand event, flips the
    // provider state and refreshes; re-expanding shows the renamed child.
    await renameItem.click()
    await view.getByText('parent', { exact: true }).click()
    await expect
      .poll(async () => (await rows.allTextContents()).includes('child-renamed'), {
        timeout: 15000,
      })
      .toBe(true)

    // The un-gated 'leaf' row (no contextValue) must NOT offer the item.
    await view.getByText('leaf', { exact: true }).click({ button: 'right' })
    await expect
      .poll(async () => workbench.page.getByRole('menuitem', { name: 'Rename Node' }).count(), {
        timeout: 5000,
      })
      .toBe(0)
    await workbench.page.keyboard.press('Escape')

    await workbench.page.evaluate((id) => window.__E2E__!.uninstallExtension(id), installedId)
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
