/*---------------------------------------------------------------------------------------------
 *  AI settings smoke (P1).
 *
 *  Covers what the single-layer `providers[]` refactor and its visual editor can
 *  silently get wrong:
 *    - a non-empty `protocolMap` is stamped straight into metadata (no network),
 *      even with a baseUrl that points nowhere
 *    - model ids are three-segment `providerId/protocol/channelModel`, and the
 *      same channel model under two protocols is two distinct entries
 *    - `extends` inherits the parent's protocolMap, and an unknown `extends`
 *      surfaces as a visible provider issue (never silently dropped)
 *    - per-model config persists into the top-level `modelSettings` section
 *    - the object model-ref form `{ id, ref }` the declaration editor writes
 *      keeps the wire name in the id while reading metadata from the knowledge
 *      base — the whole point of a renamed gateway model
 *    - a declared `pricingSource` produces a real rate, and its absence produces
 *      no rate at all rather than a cross-provider guess
 *    - a `defaultProtocol` outside the protocol map is reported but not fatal
 *--------------------------------------------------------------------------------------------*/

import { test, expect } from '../fixtures/sharedApp.js'

const PARENT_ID = 'e2e-aisettings-parent'
const CHILD_ID = 'e2e-aisettings-child'
const KNOWLEDGE_ID = 'e2e-aisettings-knowledge'
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
            { id: child, extends: parent, baseUrl: 'http://192.0.2.30:9080/v1' },
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

  // The user `models` layer merges over built-in knowledge per key and per
  // field: overridden fields win, untouched fields keep their built-in value.
  test('user model knowledge merges into resolved metadata', async ({ page }) => {
    try {
      await page.evaluate(
        ({ id, baseUrl }) =>
          window.__E2E__!.aiSetProviders([
            {
              id,
              baseUrl,
              apiKey: 'k',
              defaultProtocol: 'anthropic-messages',
              protocolMap: { 'anthropic-messages': ['claude-sonnet-5'] },
            },
          ]),
        { id: KNOWLEDGE_ID, baseUrl: UNREACHABLE_URL },
      )

      await page.evaluate((entries) => window.__E2E__!.aiSetModelKnowledge(entries), {
        'claude-sonnet-5': { name: 'House Sonnet', maxInputTokens: 1 },
      })

      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              window.__E2E__!.aiGetModels().then((models) => {
                const hit = models.find((m) => m.id === id)
                return hit === undefined
                  ? null
                  : {
                      name: hit.name,
                      maxInputTokens: hit.maxInputTokens,
                      vendor: hit.vendor,
                      maxOutputTokens: hit.maxOutputTokens,
                    }
              }),
            `${KNOWLEDGE_ID}/anthropic-messages/claude-sonnet-5`,
          ),
        )
        .toEqual({
          name: 'House Sonnet',
          maxInputTokens: 1,
          // Merge semantics: fields the user did not touch must still come
          // from the built-in knowledge, not from an empty user entry.
          vendor: 'anthropic',
          maxOutputTokens: 64000,
        })
    } finally {
      // Clear the knowledge layer too: aiSetProviders([]) leaves the top-level
      // `models` in place, so the shared worker would otherwise keep the
      // overridden built-in key and pollute later specs.
      await page.evaluate(() => window.__E2E__!.aiSetModelKnowledge({}))
      await page.evaluate(() => window.__E2E__!.aiSetProviders([]))
    }
  })

  // The object ref is what the model-declaration editor writes when a gateway
  // renames a known model: the wire name stays the id (and the third id segment),
  // while `ref` decides where the metadata comes from.
  test('an object model ref reads metadata from ref and keeps the wire name as the id', async ({
    page,
  }) => {
    try {
      await page.evaluate(
        ({ id, baseUrl }) =>
          window.__E2E__!.aiSetProviders([
            {
              id,
              baseUrl,
              protocolMap: {
                'anthropic-messages': [{ id: 'house-sonnet', ref: 'claude-sonnet-5' }],
              },
            },
          ]),
        { id: PARENT_ID, baseUrl: UNREACHABLE_URL },
      )

      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              window.__E2E__!.aiGetModels().then((models) => {
                const hit = models.find((m) => m.providerId === id)
                return hit === undefined
                  ? null
                  : {
                      id: hit.id,
                      channelModel: hit.channelModel,
                      family: hit.family,
                      maxInputTokens: hit.maxInputTokens,
                    }
              }),
            PARENT_ID,
          ),
        )
        .toEqual({
          id: `${PARENT_ID}/anthropic-messages/house-sonnet`,
          channelModel: 'house-sonnet',
          family: 'claude-sonnet',
          maxInputTokens: 200000,
        })
    } finally {
      await page.evaluate(() => window.__E2E__!.aiSetProviders([]))
    }
  })

  // The catalog source is a pure table lookup, so this asserts offline. It also
  // pins the deliberate asymmetry: no declared source means no rate at all, and
  // a catalog lookup keys on the wire name — a renamed model resolves nothing.
  test('a catalog pricing source produces a rate, and no source produces none', async ({
    page,
  }) => {
    const PRICED_ID = 'e2e-aisettings-priced'
    try {
      await page.evaluate(
        ({ priced, plain, baseUrl }) =>
          window.__E2E__!.aiSetProviders([
            {
              id: priced,
              baseUrl,
              protocolMap: {
                'anthropic-messages': [
                  'claude-sonnet-5',
                  { id: 'house-sonnet', ref: 'claude-sonnet-5' },
                ],
              },
              pricingSource: { id: 'catalog', options: { vendor: 'anthropic' } },
            },
            { id: plain, baseUrl, protocolMap: { 'anthropic-messages': ['claude-sonnet-5'] } },
          ]),
        { priced: PRICED_ID, plain: PARENT_ID, baseUrl: UNREACHABLE_URL },
      )

      await expect
        .poll(() =>
          page.evaluate(
            ({ priced, plain }) =>
              window.__E2E__!.aiGetModels().then((models) => {
                const rate = (id: string) => {
                  const hit = models.find((m) => m.id === id)
                  return hit === undefined ? 'absent' : (hit.pricingOrigin ?? 'none')
                }
                return {
                  catalogHit: rate(`${priced}/anthropic-messages/claude-sonnet-5`),
                  renamed: rate(`${priced}/anthropic-messages/house-sonnet`),
                  noSource: rate(`${plain}/anthropic-messages/claude-sonnet-5`),
                }
              }),
            { priced: PRICED_ID, plain: PARENT_ID },
          ),
        )
        .toEqual({ catalogHit: 'catalog', renamed: 'none', noSource: 'none' })

      const priced = await page.evaluate(
        (id) => window.__E2E__!.aiGetModels().then((ms) => ms.find((m) => m.id === id)),
        `${PRICED_ID}/anthropic-messages/claude-sonnet-5`,
      )
      expect(priced?.pricing).toMatchObject({ input: 3, output: 15 })
    } finally {
      await page.evaluate(() => window.__E2E__!.aiSetProviders([]))
    }
  })

  test('a defaultProtocol outside the protocol map is reported but not fatal', async ({ page }) => {
    try {
      await page.evaluate(
        ({ id, baseUrl }) =>
          window.__E2E__!.aiSetProviders([
            {
              id,
              baseUrl,
              defaultProtocol: 'ollama',
              protocolMap: { 'openai-chat': ['m-a'] },
            },
          ]),
        { id: PARENT_ID, baseUrl: UNREACHABLE_URL },
      )

      await expect
        .poll(() =>
          page.evaluate(
            (id) =>
              window.__E2E__!.aiGetProviderIssues().then((issues) => {
                const hit = issues.find(
                  (i) => i.providerId === id && i.reason === 'unknown-default-protocol',
                )
                return hit === undefined ? null : hit.fatal
              }),
            PARENT_ID,
          ),
        )
        .toBe(false)

      // Non-fatal means the provider still serves its declared models.
      expect(
        await page.evaluate(
          (id) =>
            window
              .__E2E__!.aiGetModels()
              .then((models) => models.filter((m) => m.providerId === id).map((m) => m.id)),
          PARENT_ID,
        ),
      ).toEqual([`${PARENT_ID}/openai-chat/m-a`])
    } finally {
      await page.evaluate(() => window.__E2E__!.aiSetProviders([]))
    }
  })
})
