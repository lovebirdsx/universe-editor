import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/typescriptApp.js'

const SOURCE = ['class Foo {', '    public get bar(): boolean {', '        ', '    }', '}'].join(
  '\n',
)

test.use({
  workspaceSeeder: {
    seed(dir) {
      writeFileSync(join(dir, 'error.ts'), SOURCE)
    },
  },
})

test('补全后退格并撤销不发送失效的重构位置 @regression', async ({
  page,
  workbench,
  launchWorkspace,
}, testInfo) => {
  test.slow()
  if (!launchWorkspace) throw new Error('workspaceSeeder must provide launchWorkspace')
  const errors: string[] = []
  const steps: unknown[] = []
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  const snapshot = async (step: string) => {
    steps.push(
      await page.evaluate(
        (name) => ({
          step: name,
          text: window.__E2E__!.getActiveEditorText(),
          cursor: window.__E2E__!.getActiveEditorCursor(),
        }),
        step,
      ),
    )
  }
  try {
    await workbench.waitForRestored()
    await workbench.waitForBootstrapFocusSettled()
    await page.evaluate(
      (path) => window.__E2E__!.openFileUri(path),
      launchWorkspace.file('error.ts'),
    )
    const uri = await page.evaluate(() => window.__E2E__!.getActiveEditorUri())
    if (!uri) throw new Error('error.ts 未打开')
    await expect
      .poll(
        async () => {
          const debug = await page.evaluate(
            (u) => window.__E2E__!.getSemanticTokenDebug(u, 1, 7),
            uri,
          )
          return (debug.directTokenCount ?? 0) > 0
        },
        { timeout: 30000 },
      )
      .toBe(true)
    await workbench.focusActiveEditorGroup()
    expect(await page.evaluate(() => window.__E2E__!.setActiveEditorCursor(3, 9))).toBe(true)
    await snapshot('初始')
    // 这些间隔是用户提供的复现条件，不是服务初始化等待。
    await page.keyboard.type('r')
    await page.waitForTimeout(200)
    await page.keyboard.type('e')
    await page.waitForTimeout(200)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(200)
    await snapshot('Tab')
    expect(await page.evaluate(() => window.__E2E__!.getActiveEditorText())).toContain(
      'removeEventListener',
    )
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(500)
    await page.keyboard.press('Backspace')
    await page.waitForTimeout(500)
    await snapshot('两次退格')
    expect(
      (await page.evaluate(() => window.__E2E__!.getActiveEditorText()))?.split('\n')[2]?.trim(),
    ).toBe('removeEventListen')
    await page.keyboard.press('ControlOrMeta+z')
    await page.waitForTimeout(500)
    await snapshot('第一次撤销')
    expect(
      (await page.evaluate(() => window.__E2E__!.getActiveEditorText()))?.split('\n')[2]?.trim(),
    ).toBe('removeEventListener')
    await page.keyboard.press('ControlOrMeta+z')
    await page.waitForTimeout(500)
    await snapshot('第二次撤销')
    expect(
      (await page.evaluate(() => window.__E2E__!.getActiveEditorText()))?.split('\n')[2]?.trim(),
    ).toBe('re')
    const cursor = await page.evaluate(() => window.__E2E__!.getActiveEditorCursor())
    if (!cursor) throw new Error('撤销后光标丢失')
    await page.evaluate(
      ({ u, position }) =>
        window.__E2E__!.getCodeActions(u, {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: position.column,
          endColumn: position.column,
        }),
      { u: uri, position: cursor },
    )
    const observed = await page.evaluate(() => ({
      notifications: window.__E2E__!.getNotifications(),
      unhandled: window.__E2E__!.getExtHostUnhandledRejections(),
      output: window
        .__E2E__!.getOutputChannelNames()
        .map((name) => ({ name, text: window.__E2E__!.getOutputChannelContent(name) })),
    }))
    await testInfo.attach('全部错误通道', {
      body: JSON.stringify(observed, null, 2),
      contentType: 'application/json',
    })
    expect(JSON.stringify({ errors, ...observed })).not.toMatch(
      /TypeScript Server Error|isVariableDeclaration|getFunctionInfo/,
    )
  } finally {
    await testInfo.attach('操作与错误', {
      body: JSON.stringify({ steps, errors }, null, 2),
      contentType: 'application/json',
    })
    const output = await page
      .evaluate(() => window.__E2E__!.getOutputChannelContent('TypeScript'))
      .catch(() => '')
    await testInfo.attach('TypeScript', { body: output, contentType: 'text/plain' })
    const logRoot = launchWorkspace.file('.log')
    if (existsSync(logRoot)) {
      for (const directory of readdirSync(logRoot)) {
        const logPath = join(logRoot, directory, 'tsserver.log')
        if (existsSync(logPath))
          await testInfo.attach(directory, {
            body: readFileSync(logPath),
            contentType: 'text/plain',
          })
      }
    }
  }
})
