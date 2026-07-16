/*---------------------------------------------------------------------------------------------
 *  Perforce "collect changes" smoke (@p1).
 *
 *  Repro + guard for "I edited a file but it never showed up in Changes to
 *  Reconcile". The extension has no server push and p4 only tracks opened files,
 *  so a workspace file watch must drive a reconcile-discovery refresh whenever the
 *  disk changes — from the editor or an external tool.
 *
 *  Backed by the fake p4 (fixtures/fake-p4.mjs): a real on-disk depot model whose
 *  `reconcile -n` diffs the workspace against have-revision content, so the whole
 *  flow is exercised without a live p4d. See fixtures/perforceApp.ts.
 *--------------------------------------------------------------------------------------------*/

import { writeFileSync } from 'node:fs'
import { test, expect, DEFAULT_SEEDS } from '../fixtures/perforceApp.js'
import { evaluateWhenRestored } from '../pages/WorkbenchPO.js'

const tracked = DEFAULT_SEEDS[0]!.relPath

test.describe('@p1 perforce collect changes', () => {
  test('an edited-but-unopened file appears in Changes to Reconcile @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    // Cold boot + host relaunch on workspace open + reconcile scan; give headroom
    // like the other extension-host smokes.
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)

    // Open the fake Perforce workspace; wait for the provider to register.
    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)

    // Reveal the SCM view.
    await workbench.runCommand('workbench.view.scm')

    // Edit a tracked file on disk out-of-band (mimics an external tool / a save).
    // The workspace watcher must run reconcile discovery and surface it in the
    // "Changes to Reconcile" group without any manual refresh.
    writeFileSync(perforce.file(tracked), 'edited on disk\n', 'utf8')

    const group = page.locator('[role="treeitem"]', { hasText: 'Changes to Reconcile' })
    await expect(group).toBeVisible({ timeout: 30_000 })

    const row = page.locator('[role="treeitem"]', { hasText: tracked })
    await expect(row).toBeVisible({ timeout: 30_000 })

    // Revert the edit back to the have-revision content. The incremental watcher
    // re-reconciles just this path and, finding it clean, drops it from the group.
    writeFileSync(perforce.file(tracked), DEFAULT_SEEDS[0]!.content, 'utf8')
    await expect(row).toBeHidden({ timeout: 30_000 })
  })

  // Repro for "clicking a CHANGELIST/reconcile diff shows the edit as a full delete,
  // and opening the source in the diff editor throws a `//` URI error". Root cause:
  // `p4 opened`/`reconcile -n` report `clientFile` in CLIENT SYNTAX (`//client/rel`),
  // not a local path — so readFile('//client/…') failed (empty modified side = looks
  // deleted) and the `//` path broke the file: URI. The fake p4 now emits client
  // syntax too, so this guards the client→local translation end-to-end.
  test('clicking a reconcile row opens a real diff, not a phantom delete @regression', async ({
    page,
    workbench,
    perforce,
  }) => {
    test.setTimeout(120_000)
    await evaluateWhenRestored(page)

    await workbench.openWorkspace(perforce.openDir)
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
        timeout: 60_000,
        message: 'perforce extension should register a source control for the workspace',
      })
      .toBeGreaterThan(0)

    await workbench.runCommand('workbench.view.scm')

    const editedContent = 'line one\nEDITED line two\nline three\n'
    writeFileSync(perforce.file(tracked), editedContent, 'utf8')

    const row = page.locator('[role="treeitem"]', { hasText: tracked })
    await expect(row).toBeVisible({ timeout: 30_000 })

    // Click the row → the extension's perforce.openChange opens a diff of the file's
    // have-revision (left) against the working-tree content (right).
    await row.click()

    // The diff's modified side must be the real on-disk edit — NOT empty (which is
    // what a client-syntax readFile failure produced, rendering as a full delete).
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getActiveDiffContent()?.modified), {
        timeout: 30_000,
        message: 'diff modified side should hold the working-tree content',
      })
      .toBe(editedContent)

    const diff = await page.evaluate(() => window.__E2E__!.getActiveDiffContent())
    // Left = have revision (the seeded content), right = the edit. If clientFile were
    // still client syntax, modified would be '' and this would look like a delete.
    expect(diff?.original).toBe(DEFAULT_SEEDS[0]!.content)
    expect(diff?.modified).toBe(editedContent)
  })

  // Reproduces the reported bug: opening a DEEP subdirectory of a large p4 client
  // (client root is far above the opened folder). The watcher used to watch the
  // whole client root recursively — which fails/degrades on big trees so a nested
  // edit was never seen. It must watch the opened folder instead.
  test.describe('opening a nested subdirectory', () => {
    test.use({
      openSubdir: 'Source/Client/TypeScript',
      p4Seeds: {
        files: [
          { relPath: 'Source/Client/TypeScript/gulpfile.ts', content: 'export const x = 1\n' },
          // A file outside the opened folder to prove scope narrowing doesn't break.
          { relPath: 'Source/Server/readme.md', content: '# server\n' },
        ],
      },
    })

    test('a nested edit still appears in Changes to Reconcile @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await evaluateWhenRestored(page)

      await workbench.openWorkspace(perforce.openDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'perforce extension should register a source control for the nested folder',
        })
        .toBeGreaterThan(0)

      await workbench.runCommand('workbench.view.scm')

      // Edit the deeply-nested file — the exact failing case from the report.
      writeFileSync(
        perforce.file('Source/Client/TypeScript/gulpfile.ts'),
        'export const x = 2\n',
        'utf8',
      )

      const group = page.locator('[role="treeitem"]', { hasText: 'Changes to Reconcile' })
      await expect(group).toBeVisible({ timeout: 30_000 })
      const row = page.locator('[role="treeitem"]', { hasText: 'gulpfile.ts' })
      await expect(row).toBeVisible({ timeout: 30_000 })
    })
  })

  // Layout regression: the SCM tree is a flex column (so the virtualized
  // scroller can size itself). If the row elements don't opt out of flex
  // shrinking, a group with more rows than fit the viewport gets its rows
  // squashed on top of each other (reported: "all rows collapsed into one").
  // Guard it by seeding many reconcile rows and asserting they stack with real,
  // non-overlapping vertical positions.
  test.describe('many reconcile rows layout', () => {
    const manyFiles = Array.from({ length: 40 }, (_, i) => ({
      relPath: `dir${i % 5}/file${i}.txt`,
      content: `seed ${i}\n`,
    }))
    test.use({ p4Seeds: { files: manyFiles } })

    test('rows do not collapse on top of each other @regression', async ({
      page,
      workbench,
      perforce,
    }) => {
      test.setTimeout(120_000)
      await evaluateWhenRestored(page)

      await workbench.openWorkspace(perforce.openDir)
      await expect
        .poll(() => page.evaluate(() => window.__E2E__!.getScmSourceControlCount()), {
          timeout: 60_000,
          message: 'perforce extension should register a source control for the workspace',
        })
        .toBeGreaterThan(0)

      await workbench.runCommand('workbench.view.scm')

      // Edit every seeded file on disk so they all surface in Changes to Reconcile.
      for (const f of manyFiles) writeFileSync(perforce.file(f.relPath), `edited ${f.relPath}\n`)

      const group = page.locator('[role="treeitem"]', { hasText: 'Changes to Reconcile' })
      await expect(group).toBeVisible({ timeout: 30_000 })

      // Wait until a good number of rows have surfaced.
      const rows = page.locator('[role="treeitem"]')
      await expect
        .poll(() => rows.count(), { timeout: 30_000, message: 'reconcile rows should render' })
        .toBeGreaterThan(10)

      // Collect the vertical box of every visible row and assert they don't
      // overlap: sorted by top, each row starts at or below the previous row's
      // bottom (small negative epsilon for sub-pixel rounding), and each row has
      // a real height. A collapsed layout would show near-identical tops.
      const boxes = await rows.evaluateAll((els) =>
        els
          .map((el) => {
            const r = el.getBoundingClientRect()
            return { top: r.top, bottom: r.bottom, height: r.height }
          })
          .filter((b) => b.height > 0)
          .sort((a, b) => a.top - b.top),
      )
      expect(boxes.length).toBeGreaterThan(10)
      for (const b of boxes) expect(b.height).toBeGreaterThanOrEqual(14)
      for (let i = 1; i < boxes.length; i++) {
        expect(boxes[i]!.top).toBeGreaterThanOrEqual(boxes[i - 1]!.bottom - 1)
      }
    })
  })
})
