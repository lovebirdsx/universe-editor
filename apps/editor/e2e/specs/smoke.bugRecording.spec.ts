/*---------------------------------------------------------------------------------------------
 *  Bug recording smoke (P1).
 *
 *  What this guards, in the order a user hits it:
 *    - the recording is a real state machine (idle → recording → idle) and the
 *      status bar surfaces it, so a user cannot forget a recording is running
 *    - the bundle actually contains the four things an AI needs to reason about a
 *      reproduction: the readable timeline, the machine-readable event stream,
 *      screenshots, and environment info
 *    - the step stream really flows: a failed command and a manual marker must be
 *      visible in events.jsonl, since silent event loss would make every bundle
 *      look complete while being useless
 *    - redaction masks the userData path AND leaves every JSONL line parseable
 *      (the trap: the redactor's default length cap would truncate whole lines)
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { test, expect } from '../fixtures/electronApp.js'
import type { E2EBugRecordingResult } from '@universe-editor/e2e-contract'

function readBundle(zipPath: string): {
  entries: string[]
  text(name: string): string
} {
  expect(fs.existsSync(zipPath)).toBe(true)
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries().map((e) => e.entryName)
  return {
    entries,
    text: (name) => {
      const entry = zip.getEntry(name)
      expect(entry, `missing ${name} in bundle (has: ${entries.join(', ')})`).toBeTruthy()
      return entry!.getData().toString('utf8')
    },
  }
}

function eventKinds(jsonl: string): string[] {
  return jsonl
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { kind: string }).kind)
}

test.describe('@p1 bug recording', () => {
  test('records a session and exports a self-contained evidence bundle', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    const started = await page.evaluate(() => window.__E2E__!.startBugRecording())
    expect(started.state).toBe('recording')
    expect(started.startedAt).toBeGreaterThan(0)

    // The user must be able to see a recording is live — this entry is also the
    // click target that stops it.
    await expect(workbench.statusBar.entry('bugRecording')).toBeAttached()

    // A failing command and a manual marker: both trigger a screenshot, so this
    // also exercises the capture path.
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.thisCommandDoesNotExist')
    })
    await page.evaluate(() => window.__E2E__!.markBugRecordingStep())

    const result: E2EBugRecordingResult = await page.evaluate(() =>
      window.__E2E__!.stopBugRecording(false),
    )

    await expect
      .poll(() => page.evaluate(() => window.__E2E__!.getBugRecordingStatus().state))
      .toBe('idle')
    await expect(workbench.statusBar.entry('bugRecording')).not.toBeAttached()

    expect(result.eventCount).toBeGreaterThan(0)
    expect(result.zipSizeBytes).toBeGreaterThan(0)

    const bundle = readBundle(result.zipPath)
    expect(bundle.entries).toContain('timeline.md')
    expect(bundle.entries).toContain('events.jsonl')
    expect(bundle.entries).toContain('environment.md')
    expect(bundle.entries).toContain('redaction.md')

    const kinds = eventKinds(bundle.text('events.jsonl'))
    expect(kinds).toContain('commandError')
    expect(kinds).toContain('marker')

    // Screenshots are the one thing that can legitimately be absent (a headless
    // capture failure should not fail the bundle), but the count and the packed
    // files must agree — a timeline referencing a missing file is the bug this
    // asserts against.
    const shots = bundle.entries.filter((name) => name.startsWith('screenshots/'))
    expect(shots).toHaveLength(result.screenshotCount)
    const referenced = bundle
      .text('events.jsonl')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { kind: string; file?: string })
      .filter((event) => event.kind === 'screenshot')
      .map((event) => `screenshots/${event.file!.split('/').pop()!}`)
    for (const ref of referenced) expect(shots).toContain(ref)
    // The recording-start trigger always fires, so an empty bundle means the
    // capture path is broken rather than merely throttled.
    expect(shots.length).toBeGreaterThanOrEqual(1)

    const timeline = bundle.text('timeline.md')
    expect(timeline).toContain('# Bug 录制报告')
    expect(timeline).toContain('workbench.action.thisCommandDoesNotExist')
    expect(bundle.text('redaction.md')).toContain('未脱敏')
  })

  test('redaction masks local paths and keeps every JSONL line parseable', async ({
    page,
    workbench,
  }) => {
    await workbench.waitForRestored()

    await page.evaluate(() => window.__E2E__!.startBugRecording())
    await page.evaluate(() => {
      void window.__E2E__!.runCommand('workbench.action.anotherMissingCommand')
    })
    const result: E2EBugRecordingResult = await page.evaluate(() =>
      window.__E2E__!.stopBugRecording(true),
    )

    const bundle = readBundle(result.zipPath)
    const jsonl = bundle.text('events.jsonl')

    // The whole point of the per-line redaction: a truncating redactor would
    // leave half-written JSON here.
    for (const line of jsonl.split('\n').filter((l) => l.trim().length > 0)) {
      expect(() => JSON.parse(line)).not.toThrow()
    }

    expect(bundle.text('redaction.md')).toContain('已脱敏')

    // The bundle lands inside userData, so its own path is a live sample of the
    // paths redaction is supposed to mask.
    const userDataDir = path.dirname(path.dirname(result.zipPath)).replace(/\\/g, '/')
    expect(jsonl.replace(/\\\\/g, '/')).not.toContain(userDataDir)
    expect(bundle.text('environment.md').replace(/\\/g, '/')).not.toContain(userDataDir)
  })
})
