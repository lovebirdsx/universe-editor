/*---------------------------------------------------------------------------------------------
 *  Error sink smoke (P1).
 *
 *  验证结构化错误收集链路：renderer 未捕获异常 → onUnexpectedError →
 *  TelemetryClientService（同指纹聚合）→ IPC → main ErrorSinkMainService →
 *  <userData>/logs/<session>/errors.jsonl（5s 批量 flush，故用 poll 等待）。
 *--------------------------------------------------------------------------------------------*/

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electronApp.js'

function errorsJsonlContains(userData: string, needle: string): boolean {
  let sessions: string[]
  try {
    sessions = readdirSync(join(userData, 'logs'))
  } catch {
    return false
  }
  for (const session of sessions) {
    try {
      if (readFileSync(join(userData, 'logs', session, 'errors.jsonl'), 'utf8').includes(needle)) {
        return true
      }
    } catch {
      // Session dir without an errors.jsonl yet — keep looking.
    }
  }
  return false
}

test.describe('@p1 error sink', () => {
  test('uncaught renderer errors land in errors.jsonl', async ({ electronApp, page }) => {
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('e2e-error-sink-smoke')
      }, 0)
    })
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    await expect
      .poll(() => errorsJsonlContains(userData, 'e2e-error-sink-smoke'), { timeout: 15000 })
      .toBe(true)
  })

  test('workbench.action.exportDiagnostics writes a diagnostics zip', async ({
    electronApp,
    workbench,
  }) => {
    await workbench.runCommand('workbench.action.exportDiagnostics')
    const userData = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    await expect
      .poll(
        () => {
          try {
            return readdirSync(join(userData, 'diagnostics')).filter((f) => f.endsWith('.zip'))
              .length
          } catch {
            return 0
          }
        },
        { timeout: 10000 },
      )
      .toBe(1)
  })
})
