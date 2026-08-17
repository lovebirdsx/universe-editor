/*---------------------------------------------------------------------------------------------
 *  Smoke: the real PDF extension renders a `.pdf` in its webview custom editor.
 *
 *  Loads the extension straight off disk (no vsix install — see fixtures/pdfApp.ts)
 *  so this exercises the SHIPPED extension end-to-end: activation on
 *  `onCustomEditor:pdf.view`, the custom-editor binding for `*.pdf`, and the
 *  pdf.js viewer HTML mounting inside the sandboxed webview iframe.
 *
 *  @p1 (extension host is a child process, slower than the core workbench path).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { test, expect } from '../fixtures/pdfApp.js'

function escapePdfString(text: string): string {
  return text.replace(/[()\\]/g, '\\$&')
}

// Tiny but structurally valid single-page PDF (Catalog/Pages/Page + one
// Helvetica Type1 text) so pdf.js parses it and each rewrite is a real
// document re-open, not an error path. Offsets are real byte positions;
// pdf.js's xref recovery tolerates any residual drift.
function makeMinimalPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 100 700 Td (${escapePdfString(text)}) Tj ET`
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let i = 0; i < bodies.length; i++) {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${bodies[i]}\nendobj\n`
  }

  const xrefOffset = pdf.length
  let xref = `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  xref += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(pdf + xref, 'ascii')
}

test.describe('@p1 pdf viewer', () => {
  test('opens a .pdf in the PDF extension webview custom editor', async ({ workbench }) => {
    // Cold extension host + webview mount; give it room on a loaded CI runner.
    test.slow()
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-pdf-'))
    const docPath = path.join(tmpDir, 'sample.pdf')
    // Minimal binary-ish PDF body — rendered as text this would be garbage; the
    // custom editor must claim it and render the pdf.js viewer instead.
    await fs.writeFile(docPath, '%PDF-1.4\n\x00\x01\x02 binary body\n%%EOF\n')

    await workbench.waitForRestored()

    // Open the pdf; the custom-editor binding registers async once the host
    // reports its contributions, so poll until the active editor is the custom
    // editor (not the fallback text editor).
    await workbench.page.evaluate((p) => window.__E2E__!.openFileUri(p), docPath)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 15000,
      })
      .toBe('customEditor')

    // The pdf.js viewer HTML mounted inside the sandboxed iframe: its outer
    // container (#outerContainer) is a stable structural marker of the viewer.
    const frame = workbench.page.frameLocator('[data-testid="webview-frame"]')
    await expect(frame.locator('#outerContainer')).toBeAttached({ timeout: 15000 })

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

  test('reloads the preview when the pdf changes on disk', async ({ workbench }) => {
    test.slow()
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-pdf-watch-'))
    const docPath = path.join(tmpDir, 'watched.pdf')
    await fs.writeFile(docPath, makeMinimalPdf('first'))

    await workbench.waitForRestored()
    await workbench.page.evaluate((p) => window.__E2E__!.openFileUri(p), docPath)
    await expect
      .poll(() => workbench.page.evaluate(() => window.__E2E__!.getActiveEditorTypeId()), {
        timeout: 15000,
      })
      .toBe('customEditor')

    // The watched file sits in a tmp dir OUTSIDE the workspace, so this also
    // exercises the out-of-workspace watch. The extension reloads by posting
    // `{action:'reload'}` to the webview (pdf.js's own message hook re-opens the
    // document); a full html re-send doesn't reach the frame once pdf.js is
    // running, so count `PDFViewerApplication.open` calls as the reload signal.
    const frame = workbench.page.frameLocator('[data-testid="webview-frame"]')
    await expect(frame.locator('#outerContainer')).toBeAttached({ timeout: 15000 })

    // #outerContainer is static viewer.html markup — it attaches long before
    // pdf.js finishes booting, so it does not mean `PDFViewerApplication` is in
    // place. `pdfDocument` only becomes non-null once the initial open has
    // landed, so waiting on it both guarantees `app.open` exists for the hook
    // below and rules out the initial open being counted as a reload.
    await expect
      .poll(
        () =>
          workbench.page.evaluate(() => {
            const f = document.querySelector<HTMLIFrameElement>('[data-testid="webview-frame"]')
            const w = f?.contentWindow as unknown as Record<string, unknown> | undefined
            const app = w?.['PDFViewerApplication'] as { pdfDocument?: unknown } | undefined
            return app?.pdfDocument != null
          }),
        { timeout: 15000 },
      )
      .toBe(true)

    // Install the open counter. A missing `open` here is a bug (the poll above
    // guarantees it), so fail loudly instead of silently skipping.
    await workbench.page.evaluate(() => {
      const f = document.querySelector<HTMLIFrameElement>('[data-testid="webview-frame"]')
      const w = f?.contentWindow as unknown as Record<string, unknown> | undefined
      const app = w?.['PDFViewerApplication'] as { open?: (...a: unknown[]) => unknown } | undefined
      if (!app?.open) throw new Error('PDFViewerApplication.open missing after pdfDocument ready')
      const orig = app.open.bind(app)
      ;(w as Record<string, unknown>)['__openCount'] = 0
      app.open = (...a: unknown[]) => {
        ;(w as Record<string, unknown>)['__openCount'] =
          ((w as Record<string, unknown>)['__openCount'] as number) + 1
        return orig(...a)
      }
    })

    // The watcher subscription arms asynchronously (exthost → main → watcher
    // utility process), so a single write can land inside that arm window and be
    // lost for good. Rewrite fresh (distinct) content on every poll tick until
    // one lands after arming and produces a counted re-open.
    let writeSeq = 0
    await expect
      .poll(
        async () => {
          await fs.writeFile(docPath, makeMinimalPdf(`reload ${++writeSeq}`))
          return workbench.page.evaluate(() => {
            const f = document.querySelector<HTMLIFrameElement>('[data-testid="webview-frame"]')
            const w = f?.contentWindow as unknown as Record<string, unknown> | undefined
            return w?.['__openCount'] ?? 0
          })
        },
        { timeout: 20000, intervals: [500, 1000, 1000, 2000] },
      )
      .toBeGreaterThanOrEqual(1)

    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })
})
