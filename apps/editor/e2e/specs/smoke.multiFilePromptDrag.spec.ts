/*---------------------------------------------------------------------------------------------
 *  Regression: dragging multiple files onto the agent prompt input must insert
 *  one `@mention` per file — not a single garbled token.
 *
 *  Two real-world drop shapes are covered:
 *   1. OS file drag — real OS-backed File objects (pulled from an <input
 *      type=file> via setInputFiles) so window.ipc.getPathForFile resolves real
 *      paths, exactly as a Windows Explorer drag would.
 *   2. A CR-only separated `text/uri-list` — the shape that produced the original
 *      bug ("@a\nfile:///…b\nfile:///…c"): parseUriList must split on bare CR.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ECHO_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'echoAgent.cjs')

// The workspace file watcher keeps a handle on the temp dir, so an immediate
// rmdir races with EBUSY on Windows. Best-effort cleanup; the OS reaps tmp.
async function tryCleanup(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* leave it for the OS */
  }
}

async function openSessionWithPrompt(
  page: import('@playwright/test').Page,
  workbench: { waitForRestored(): Promise<void>; openWorkspace(p: string): Promise<void> },
  tmpDir: string,
): Promise<import('@playwright/test').Locator> {
  await workbench.waitForRestored()
  await workbench.openWorkspace(tmpDir)
  await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
    'echo',
    ECHO_AGENT_PATH,
  ] as const)
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.openView'))
  await page.evaluate(() => void window.__E2E__!.runCommand('workbench.action.agent.newSession'))
  await expect
    .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
    .toBe(1)
  const prompt = page.getByTestId('acp-prompt-input')
  await expect(prompt).toBeVisible({ timeout: 10000 })
  return prompt
}

test.describe('@p1 multi-file drag → prompt', () => {
  test('OS file drag inserts one @mention per file (incl. non-ASCII names)', async ({
    page,
    workbench,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-mfp-'))
    const names = ['aaa.txt', 'bbb.txt', 'World负载均衡设计方案.md']
    const files = await Promise.all(
      names.map(async (n) => {
        const p = path.join(tmpDir, n)
        await fs.writeFile(p, 'x')
        return p
      }),
    )

    const prompt = await openSessionWithPrompt(page, workbench, tmpDir)

    await page.evaluate(() => {
      const input = document.createElement('input')
      input.type = 'file'
      input.multiple = true
      input.id = '__diag_file_input__'
      input.style.cssText = 'position:fixed;left:-9999px'
      document.body.appendChild(input)
    })
    await page.setInputFiles('#__diag_file_input__', files)

    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#__diag_file_input__')!
      const target = document.querySelector<HTMLElement>('[data-testid="acp-prompt-input"]')!
      const dt = new DataTransfer()
      for (const f of Array.from(input.files ?? [])) dt.items.add(f)
      const fire = (type: string): void => {
        const r = target.getBoundingClientRect()
        target.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
            dataTransfer: dt,
          }),
        )
      }
      fire('dragenter')
      fire('dragover')
      fire('drop')
      input.remove()
    })

    await page.waitForTimeout(400)
    const value = await prompt.inputValue()
    expect((value.match(/@/g) ?? []).length).toBe(3)
    expect(value).not.toContain('file:///')

    await tryCleanup(tmpDir)
  })

  test('a CR-separated text/uri-list inserts one @mention per file', async ({
    page,
    workbench,
  }) => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ue2-mfpcr-'))
    const prompt = await openSessionWithPrompt(page, workbench, tmpDir)

    const root = tmpDir.replace(/\\/g, '/')
    await page.evaluate((rootDir) => {
      const target = document.querySelector<HTMLElement>('[data-testid="acp-prompt-input"]')!
      const dt = new DataTransfer()
      // Bare CR between entries — the shape that collapsed into one bad mention.
      const uriList = ['package.json', 'test.ent', 'World负载均衡设计方案.md']
        .map((n) => `file:///${rootDir}/${n}`)
        .join('\r')
      dt.setData('text/uri-list', uriList)
      const fire = (type: string): void => {
        const r = target.getBoundingClientRect()
        target.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: r.left + r.width / 2,
            clientY: r.top + r.height / 2,
            dataTransfer: dt,
          }),
        )
      }
      fire('dragenter')
      fire('dragover')
      fire('drop')
    }, root)

    await page.waitForTimeout(400)
    const value = await prompt.inputValue()
    expect((value.match(/@/g) ?? []).length).toBe(3)
    expect(value).not.toContain('file:///')

    await tryCleanup(tmpDir)
  })
})
