/*---------------------------------------------------------------------------------------------
 *  `workspace.findFiles` end-to-end smoke.
 *
 *  The unit suites pin the engine's include / cap / ignore decisions in isolation.
 *  This spec pins the assembled chain an extension actually calls:
 *
 *    fixture dev extension (real `@universe-editor/extension-api` inside the
 *    extension host) → host findFiles bridge → renderer MainThreadFs (path
 *    policy + cap) → main-side FileSearchService (rg walk, include filter inline)
 *
 *  The workspace is synthetic and seeded per test (`workspaceSeeder`) — nothing
 *  here depends on any real folder on the machine. The fixture extension runs a
 *  fixed battery of queries and returns the resulting paths, so assertions are
 *  exact path sets, not counts.
 *
 *  @p1 — the extension host boots a child process (same bar as smoke.extensions).
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path'
import * as fs from 'node:fs'
import { createColdAppTest, mkTempDir } from '@universe-editor/e2e-harness'
import { expect } from '../fixtures/electronApp.js'

const COMMAND_ID = 'e2eFindFiles.run'

/** The real API package a fixture extension would `require('@universe-editor/extension-api')`. */
const API_MODULE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'extension-api',
  'dist',
  'index.js',
)

/**
 * The fixture extension: an unpacked CommonJS directory (the shape an extension
 * author iterates on) whose activate() registers one command. The command runs
 * the query battery against whatever workspace is open and RETURNS the paths —
 * the spec reads them off the `runCommand` result, so there is no artifact to
 * poll for. `context.subscriptions` carries the registration.
 */
function extensionSource(): string {
  return `
const { pathToFileURL } = require('node:url')

const API_MODULE = ${JSON.stringify(API_MODULE_PATH)}

const loadApi = () => import(pathToFileURL(API_MODULE).href)

async function runBattery() {
  const vscode = await loadApi()
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
  if (!folder) throw new Error('findFiles battery: no workspace folder open')
  const root = String(folder.uri.fsPath).replace(/\\\\/g, '/')
  const rel = (fsPath) => {
    const p = String(fsPath).replace(/\\\\/g, '/')
    return p.startsWith(root + '/') ? p.slice(root.length + 1) : p
  }
  const cases = []
  const record = async (label, pending) => {
    const uris = await pending
    cases.push({
      label,
      paths: uris.map((u) => rel(u.fsPath)),
      absolutes: uris.map((u) => String(u.fsPath)),
      uris: uris.map((u) => String(u.toString())),
    })
  }
  // exclude: null = "no exclusion at all"; what survives is then decided by the
  // include glob and the .gitignore, which is exactly the join being pinned.
  await record('include-json', vscode.workspace.findFiles('*.json', null))
  await record('include-cap-2', vscode.workspace.findFiles('*.json', null, 2))
  await record('brace-case', vscode.workspace.findFiles('**/*.{ts,tsx}', null))
  await record('exclude-glob', vscode.workspace.findFiles('*.json', 'excluded/**'))
  await record(
    'relative-pattern',
    vscode.workspace.findFiles(new vscode.RelativePattern(root + '/src', '*.ts'), null),
  )
  await record('zero-max', vscode.workspace.findFiles('*.json', null, 0))
  // Lands in extensionHost.log; when an assertion fails this line says which
  // query returned what without re-running.
  console.info(
    '[e2e-findfiles] battery done: ' +
      cases.map((c) => c.label + '=' + c.paths.length).join(' ') +
      ' root=' +
      root +
      ' uri0=' +
      (cases[0]?.uris[0] ?? ''),
  )
  return { cases }
}

// Use exports.activate = ..., NOT module.exports = { async activate() {} }:
// Node's CJS-to-ESM lexer reads that literal's key as "async", leaving
// mod.activate undefined — the host then logs "activated" without ever calling
// activate, and the command silently never registers.
exports.activate = async function (context) {
  const vscode = await loadApi()
  context.subscriptions.push(vscode.commands.registerCommand(${JSON.stringify(COMMAND_ID)}, runBattery))
}
`
}

function makeFixtureExtensionDir(): string {
  const dir = fs.realpathSync.native(mkTempDir('ue2-findfiles-ext-'))
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'e2e-find-files',
      publisher: 'universe',
      version: '1.0.0',
      engines: { universe: '*' },
      main: 'dist/extension.js',
      // The translator fires `onCommand:<id>` on first invocation; the manifest
      // must declare it or activate() never runs.
      activationEvents: [`onCommand:${COMMAND_ID}`],
      contributes: {
        commands: [{ command: COMMAND_ID, title: 'E2E: findFiles battery' }],
      },
    }),
  )
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'dist', 'extension.js'), extensionSource())
  return dir
}

const fixtureExtensionDir = makeFixtureExtensionDir()

export const test = createColdAppTest({
  appRoot: path.resolve(import.meta.dirname, '..', '..'),
  mainEntry: path.resolve(import.meta.dirname, '..', '..', 'out', 'main', 'index.js'),
  extensions: [],
  extraArgs: [`--extension-development-path=${fixtureExtensionDir}`],
})

interface FindFilesCase {
  readonly label: string
  readonly paths: readonly string[]
  readonly absolutes: readonly string[]
  readonly uris: readonly string[]
}

interface FindFilesReport {
  readonly cases: readonly FindFilesCase[]
}

/** The three `.json` files the include glob matches; `ignored/hidden.json` is
 *  `.gitignore`d and `gen/*.log` does not match — neither may appear. */
const JSON_MATCHES = ['docs/readme.json', 'excluded/skip.json', 'keep/tsconfig.json']

const sortPaths = (paths: readonly string[]): string[] => [...paths].sort()

test.describe('@p1 workspace.findFiles', () => {
  test.use({
    workspaceSeeder: {
      seed(dir: string) {
        const write = (rel: string, content = ''): void => {
          const file = path.join(dir, rel)
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, content)
        }
        write('.gitignore', 'ignored/\n')
        write('src/a.ts')
        write('src/b.tsx')
        // Case-sensitivity probe: extension include semantics are case-sensitive,
        // so `*.ts` / `{ts,tsx}` must not match this one.
        write('src/D.TS')
        write('keep/tsconfig.json')
        write('docs/readme.json')
        write('excluded/skip.json')
        write('ignored/hidden.json')
        // A wall of unrelated entries: if the include filter ran after the cap,
        // these `.log` files would eat the two allowed results.
        for (let d = 0; d < 5; d++) {
          for (let f = 0; f < 8; f++) write(`gen/d${d}/f${f}.log`)
        }
      },
    },
  })

  test('the extension-facing chain honours include, cap, exclude and ignore semantics', async ({
    workbench,
    launchWorkspace,
  }) => {
    if (!launchWorkspace) throw new Error('workspaceSeeder did not take effect')
    await workbench.waitForRestored()

    // The contributions arrive with the host connection's first scan, which races
    // the workbench restore (same wait smoke.extensionDev does). Invoking before the
    // bootstrap proxy is registered would just log "command not found".
    await expect
      .poll(() => workbench.page.evaluate((id) => window.__E2E__!.hasCommand(id), COMMAND_ID), {
        timeout: 20_000,
      })
      .toBe(true)

    // The command routes to the host, activates the fixture extension on the way
    // (onCommand) and resolves with the battery report. A missing api dist or a
    // rejected path policy surfaces here as a rejection, not an empty report.
    const report = (await workbench.page.evaluate(
      (id) => window.__E2E__!.runCommand(id),
      COMMAND_ID,
    )) as FindFilesReport | undefined
    if (!report) throw new Error('findFiles battery returned no report')
    const cases = report.cases
    const caseOf = (label: string): FindFilesCase => {
      const found = cases.find((c) => c.label === label)
      if (!found) throw new Error(`missing case ${label}: ${JSON.stringify(cases)}`)
      return found
    }

    // Include filtering + ignore semantics in one query: only the include's
    // matches come back, and the `.gitignore`d one stays gone even though it
    // matches — the include glob must not resurrect ignored files.
    expect(sortPaths(caseOf('include-json').paths)).toEqual(sortPaths(JSON_MATCHES))
    // The returned paths are absolute and inside the seeded workspace root.
    const absolute = caseOf('include-json').absolutes[0]
    expect(absolute).toBeTruthy()
    // URI.fsPath folds the drive letter to lowercase and uses forward slashes;
    // the fixture dir is a native Windows path. Fold both before the prefix check.
    const normalize = (p: string): string => p.replace(/\\/g, '/').toLowerCase()
    expect(normalize(absolute!).startsWith(normalize(launchWorkspace.dir))).toBe(true)
    expect(absolute!.endsWith('.json')).toBe(true)
    // The URI string an extension receives is a well-formed file URL — this is
    // what every downstream URI.join / parse sees. (Keep the case as-is: the
    // extension-api owns this form; vscode-uri consumers may re-normalize it.)
    expect(caseOf('include-json').uris.every((u) => u.startsWith('file:///'))).toBe(true)

    // The cap counts matches, not scanned entries: with 40 unrelated `.log`
    // files seeded, a cap-before-filter bug would return two of those instead.
    const capped = caseOf('include-cap-2').paths
    expect(capped).toHaveLength(2)
    for (const p of capped) expect(JSON_MATCHES).toContain(p)

    // Brace alternation, case-sensitive: `src/D.TS` must not match.
    expect(sortPaths(caseOf('brace-case').paths)).toEqual(['src/a.ts', 'src/b.tsx'])

    // A string exclude prunes during the walk — `excluded/skip.json` is a match
    // for the include and is removed by the exclude alone.
    expect(sortPaths(caseOf('exclude-glob').paths)).toEqual(
      sortPaths(['docs/readme.json', 'keep/tsconfig.json']),
    )

    // A RelativePattern include roots the walk at its base folder.
    expect(caseOf('relative-pattern').paths).toEqual(['src/a.ts'])

    // maxResults 0 = "no results wanted": an empty list, not a full page.
    expect(caseOf('zero-max').paths).toEqual([])
  })
})
