/*---------------------------------------------------------------------------------------------
 *  AskUserQuestion smoke test (@p1).
 *
 *  全链路：注入一个会在每次 prompt 时通过 ACP `extMethod` 发起 AskUserQuestion 的
 *  stdio agent，断言 pendingQuestion 在客户端出现（QuestionCard 的数据源），作答后
 *  问题被清除、且答案经 extMethod 回灌到 agent（agent 把答案 echo 回消息流）。
 *
 *  注意: askAgent.cjs 是源码（不经过构建），spec 直接拿源码绝对路径喂给探针。
 *--------------------------------------------------------------------------------------------*/

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../fixtures/sharedApp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ASK_AGENT_PATH = resolve(__dirname, '..', '..', 'src', 'test-fixtures', 'askAgent.cjs')

test.describe('@p1 askUserQuestion', () => {
  test('agent extMethod surfaces a question, answer round-trips back', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    await page.evaluate(([id, p]) => window.__E2E__!.installAcpEchoAgent(id, p), [
      'ask',
      ASK_AGENT_PATH,
    ] as const)

    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.agent.newSession')
    })
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpSessionCount()), { timeout: 10000 })
      .toBe(1)

    // Fire-and-forget the prompt: it only resolves once the question is answered.
    await page.evaluate(() => {
      void window.__E2E__!.sendAcpPrompt('hi')
    })

    // The agent's AskUserQuestion should surface as a pending question.
    await expect
      .poll(
        () => page.evaluate(() => window.__E2E__!.getAcpPendingQuestion()?.questions[0]?.header),
        {
          timeout: 5000,
        },
      )
      .toBe('Color')

    // Answer it.
    await page.evaluate(() => {
      window.__E2E__!.resolveAcpQuestion({ 'Pick a color?': 'Blue' })
    })

    // Card cleared.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpPendingQuestion()))
      .toBeUndefined()

    // Answer round-tripped back to the agent, which echoes it into the message stream.
    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getAcpMessages()), { timeout: 5000 })
      .toEqual(expect.arrayContaining([{ role: 'agent', text: 'you picked: Blue' }]))
  })
})
