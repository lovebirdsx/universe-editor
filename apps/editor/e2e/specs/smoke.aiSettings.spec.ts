/*---------------------------------------------------------------------------------------------
 *  AI settings smoke (P1).
 *
 *  Covers the four things the single-layer `providers[]` refactor can silently
 *  get wrong:
 *    - a non-empty `protocolMap` is stamped straight into metadata (no network),
 *      even with a baseUrl that points nowhere
 *    - model ids are three-segment `providerId/protocol/channelModel`, and the
 *      same channel model under two protocols is two distinct entries
 *    - `extends` inherits the parent's protocolMap, and an unknown `extends`
 *      surfaces as a visible provider issue (never silently dropped)
 *    - per-model config persists into the top-level `modelSettings` section
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

const PARENT_ID = 'e2e-aisettings-parent'
const CHILD_ID = 'e2e-aisettings-child'
// Port 1 on loopback is reserved and unreachable — proving declared models never
// touch the network (a discover path would hang until the metadata timeout and
// then return nothing).
const UNREACHABLE_URL = 'http://127.0.0.1:1/v1'

test.describe('@p1 ai settings', () => {
  test('declared protocolMap stamps models without network', async ({ page }) => {
    try {
      await page.evaluate(
        ({ id, baseUrl }) =>
          window.__E2E__!.aiSetProviders([
            {
              id,
              baseUrl,
              protocolMap: {
                'openai-chat': ['m-a', 'm-b'],
                'anthropic-messages': ['m-a'],
              },
            },
          ]),
        { id: PARENT_ID, baseUrl: UNREACHABLE_URL },
      )

      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              window.__E2E__!.aiGetModels().then((models) =>
                models
                  .filter((m) => m.providerId === id)
                  .map((m) => m.id)
                  .sort(),
              ),
            PARENT_ID,
          ),
        )
        .toEqual([
          `${PARENT_ID}/anthropic-messages/m-a`,
          `${PARENT_ID}/openai-chat/m-a`,
          `${PARENT_ID}/openai-chat/m-b`,
        ])

      const models = await page.evaluate(
        (id) => window.__E2E__!.aiGetModels().then((ms) => ms.filter((m) => m.providerId === id)),
        PARENT_ID,
      )
      const chatA = models.find((m) => m.id === `${PARENT_ID}/openai-chat/m-a`)
      const chatB = models.find((m) => m.id === `${PARENT_ID}/openai-chat/m-b`)
      const anthA = models.find((m) => m.id === `${PARENT_ID}/anthropic-messages/m-a`)
      expect(chatA).toMatchObject({
        providerId: PARENT_ID,
        protocol: 'openai-chat',
        channelModel: 'm-a',
      })
      expect(chatB).toMatchObject({
        providerId: PARENT_ID,
        protocol: 'openai-chat',
        channelModel: 'm-b',
      })
      expect(anthA).toMatchObject({
        providerId: PARENT_ID,
        protocol: 'anthropic-messages',
        channelModel: 'm-a',
      })
      // Same channel model under two protocols = two distinct entries.
      expect(chatA?.id).not.toBe(anthA?.id)
    } finally {
      await page.evaluate(() => window.__E2E__!.aiSetProviders([]))
    }
  })

  test('extends inherits and unknown-extends surfaces an issue', async ({ page }) => {
    try {
      await page.evaluate(
        ({ parent, child, baseUrl }) =>
          window.__E2E__!.aiSetProviders([
            { id: parent, baseUrl, protocolMap: { 'openai-chat': ['m-a'] } },
            { id: child, extends: parent, baseUrl: 'http://10.0.0.1:9080/v1' },
          ]),
        { parent: PARENT_ID, child: CHILD_ID, baseUrl: UNREACHABLE_URL },
      )

      await expect
        .poll(() =>
          page.evaluate(
            (child) =>
              window
                .__E2E__!.aiGetModels()
                .then((models) => models.filter((m) => m.providerId === child).map((m) => m.id)),
            CHILD_ID,
          ),
        )
        .toEqual([`${CHILD_ID}/openai-chat/m-a`])

      // Repoint `extends` at a missing id: the child must be skipped AND reported.
      await page.evaluate(
        ({ parent, child, baseUrl }) =>
          window.__E2E__!.aiSetProviders([
            { id: parent, baseUrl, protocolMap: { 'openai-chat': ['m-a'] } },
            { id: child, extends: 'e2e-aisettings-missing' },
          ]),
        { parent: PARENT_ID, child: CHILD_ID, baseUrl: UNREACHABLE_URL },
      )

      await expect
        .poll(() =>
          page.evaluate(
            (child) =>
              window.__E2E__!.aiGetProviderIssues().then((issues) => {
                const hit = issues.find(
                  (i) => i.providerId === child && i.reason === 'unknown-extends',
                )
                return hit === undefined ? null : { reason: hit.reason, fatal: hit.fatal }
              }),
            CHILD_ID,
          ),
        )
        .toEqual({ reason: 'unknown-extends', fatal: true })

      await expect
        .poll(() =>
          page.evaluate(
            (child) =>
              window
                .__E2E__!.aiGetModels()
                .then((models) => models.filter((m) => m.providerId === child).length),
            CHILD_ID,
          ),
        )
        .toBe(0)
    } finally {
      await page.evaluate(() => window.__E2E__!.aiSetProviders([]))
    }
  })

  test('per-model config round-trips through top-level modelSettings', async ({ page }) => {
    const modelId = `${PARENT_ID}/openai-chat/m-a`
    try {
      await page.evaluate(
        ({ id, baseUrl }) =>
          window.__E2E__!.aiSetProviders([
            { id, baseUrl, protocolMap: { 'openai-chat': ['m-a'] } },
          ]),
        { id: PARENT_ID, baseUrl: UNREACHABLE_URL },
      )

      await page.evaluate(
        ({ modelId }) => window.__E2E__!.aiSetModelConfiguration(modelId, { temperature: 0.3 }),
        { modelId },
      )

      await expect
        .poll(() => page.evaluate((mid) => window.__E2E__!.aiGetModelConfiguration(mid), modelId))
        .toEqual({ temperature: 0.3 })
    } finally {
      // Clear the per-model config too: updateProviders([]) leaves modelSettings
      // in place, so the shared worker instance would otherwise keep a stale key.
      await page.evaluate((mid) => window.__E2E__!.aiSetModelConfiguration(mid, {}), modelId)
      await page.evaluate(() => window.__E2E__!.aiSetProviders([]))
    }
  })
})
