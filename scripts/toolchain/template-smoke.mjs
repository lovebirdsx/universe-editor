#!/usr/bin/env node
/*
 * Template anti-rot smoke: pack the toolchain the same way npm publish does
 * (pnpm pack — which also exercises workspace:/catalog: protocol rewriting),
 * scaffold both templates from the tarball, install them against the tarballs,
 * run their unit tests, build, and `uex package` each into a VSIX that
 * readVsixManifest round-trips.
 *
 * Any drift between the SDK, the templates, and the CLI fails loudly here
 * instead of in a third-party author's terminal.
 *
 * Deliberately NOT a registry check: every @universe-editor/* the scaffolded
 * project asks for is repointed at a local tarball, and the install tree is
 * asserted to hold no registry copy of any of them. Registry visibility is the
 * publish pipeline's business — resolving from the registry here means an E404
 * before a fresh version replicates, and a stale copy after (false green).
 *
 * Usage: node scripts/toolchain/template-smoke.mjs [--keep]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkTempDir } from '../lib/temp-root.mjs'
import { SDK_PACKAGE_SHORT_NAMES } from '../lib/sdk-packages.mjs'
import { computeSdkClosure, findNonLocalSdkInstalls, localizeSdkDeps, sdkDepNames } from './lib.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const keep = process.argv.includes('--keep')

// One truth source: the publish set is the pack set. A hand-kept copy here once
// drifted (missing e2e-contract/e2e-harness), silently sending the smoke back
// to the registry — where it reds on every release that bumps those versions.
const PACKAGES = SDK_PACKAGE_SHORT_NAMES

function die(msg) {
  console.error(`error: ${msg}`)
  process.exit(1)
}

function ok(msg) {
  console.log(`✓ ${msg}`)
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    stdio: opts.stdio ?? 'inherit',
    shell: opts.shell ?? false,
    encoding: 'utf8',
  })
  if (res.status !== 0) {
    die(`${cmd} ${args.join(' ')} failed (exit ${res.status})${opts.cwd ? ` in ${opts.cwd}` : ''}`)
  }
  return res.stdout ?? ''
}

// npm/pnpm CLIs are .cmd on Windows — spawn through the shell (CVE-2024-27980).
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function assertDist(pkg) {
  if (!existsSync(path.join(repoRoot, 'packages', pkg, 'dist', 'index.js'))) {
    die(`packages/${pkg}/dist is missing — build first: pnpm build --filter=@universe-editor/${pkg}...`)
  }
}

/** pnpm pack <pkg> into destDir; returns the tarball path. */
function pack(pkg, destDir) {
  run(pnpmCmd, ['pack', '--pack-destination', destDir], {
    cwd: path.join(repoRoot, 'packages', pkg),
    stdio: 'pipe',
    shell: true,
  })
  const own = readdirSync(destDir)
    .filter((f) => f.endsWith('.tgz'))
    .find((f) => f.includes(pkg))
  if (!own) die(`pnpm pack for ${pkg} produced no recognizable tarball in ${destDir}`)
  return path.join(destDir, own)
}

/** Every SDK package must install from a local tarball — a registry copy of the same version is false green. */
function assertLocalSdkInstall(projectDir, closure, manifests) {
  const expected = new Map(
    closure.map((short) => [`@universe-editor/${short}`, manifests.get(short).version]),
  )
  for (const [name, version] of expected) {
    const installed = path.join(projectDir, 'node_modules', ...name.split('/'), 'package.json')
    if (!existsSync(installed)) die(`${name} not installed at ${installed}`)
    const actual = JSON.parse(readFileSync(installed, 'utf8')).version
    if (actual !== version) {
      die(`${name} installed as ${actual}, local version is ${version} — npm resolved a registry copy`)
    }
  }
  // The lockfile covers nested copies and provenance, which the hoisted path above cannot see.
  const lockPath = path.join(projectDir, 'package-lock.json')
  if (!existsSync(lockPath)) die(`no ${lockPath} — cannot prove the SDK install stayed off the registry`)
  const { packages = {} } = JSON.parse(readFileSync(lockPath, 'utf8'))
  for (const issue of findNonLocalSdkInstalls(packages, expected)) die(issue)
  ok(`${closure.length} SDK packages resolved from local tarballs (no registry copies)`)
}

async function main() {
  for (const pkg of PACKAGES) assertDist(pkg)
  const manifests = new Map(
    PACKAGES.map((pkg) => [
      pkg,
      JSON.parse(readFileSync(path.join(repoRoot, 'packages', pkg, 'package.json'), 'utf8')),
    ]),
  )

  const tmp = mkTempDir('ue-toolchain-smoke-')
  console.log(`smoke workspace: ${tmp}`)
  try {
    const tarballDir = path.join(tmp, 'tarballs')
    const tarballs = {}
    for (const pkg of PACKAGES) {
      tarballs[pkg] = pack(pkg, tarballDir)
    }
    ok(`packed ${PACKAGES.length} tarballs (workspace:/catalog: rewrite exercised)`)

    // The create-extension tarball must expose its bin wiring.
    const toolsDir = path.join(tmp, 'tools')
    run(npmCmd, ['install', '--prefix', toolsDir, tarballs['create-extension']], { shell: true })
    const createPkg = JSON.parse(
      readFileSync(
        path.join(toolsDir, 'node_modules', '@universe-editor', 'create-extension', 'package.json'),
        'utf8',
      ),
    )
    if (!createPkg.bin?.['create-extension']) {
      die('create-extension tarball lost its bin mapping')
    }
    ok('create-extension tarball installed with bin wiring intact')

    // The scaffolder is not a consumer dependency, but a runtime @universe-editor/*
    // dep of its own would still come off the registry — same trap, same rule.
    const createLockPath = path.join(toolsDir, 'package-lock.json')
    if (!existsSync(createLockPath)) {
      die(`no ${createLockPath} — cannot prove the scaffolder install stayed off the registry`)
    }
    const { packages: createLockPackages = {} } = JSON.parse(readFileSync(createLockPath, 'utf8'))
    const createExpected = new Map([['@universe-editor/create-extension', createPkg.version]])
    for (const issue of findNonLocalSdkInstalls(createLockPackages, createExpected)) {
      die(`scaffolder tree: ${issue}`)
    }

    const createCli = path.join(
      toolsDir, 'node_modules', '@universe-editor', 'create-extension', 'dist', 'cli.js',
    )

    // readVsixManifest comes from the repo build — the same validation truth
    // the host uses, so this also proves CLI output and host input can't drift.
    const { readVsixManifest } = await import(
      pathToFileURL(path.join(repoRoot, 'packages', 'extension-packaging', 'dist', 'index.js')).href
    )

    for (const template of ['basic', 'webview']) {
      const name = `smoke-${template}`
      const projectDir = path.join(tmp, name)
      run(process.execPath, [
        createCli, projectDir,
        '--name', name,
        '--publisher', 'smoke',
        '--display-name', 'Smoke',
        '--description', 'template smoke',
        '--template', template,
      ])
      ok(`scaffolded ${template}`)

      // Point the generated project at the local tarballs instead of the
      // (possibly not-yet-published) registry versions: on the registry a fresh
      // version is an E404 until it replicates, and a stale copy after —
      // silently smoking an older codec (false green). The set is computed from
      // what the scaffold actually asks for (declared + transitive), so a new
      // SDK dependency can never be forgotten here the way e2e-harness once was.
      const pkgPath = path.join(projectDir, 'package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      const { closure, errors } = computeSdkClosure({
        roots: sdkDepNames(pkg, { includeDev: true }),
        manifests,
        sdkOrder: PACKAGES,
      })
      for (const error of errors) die(error)
      const { added, rewritten, missing } = localizeSdkDeps(pkg, closure, tarballs)
      if (missing.length > 0) die(`${template}: no local tarball for ${missing.join(', ')}`)
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
      ok(`${template}: localized ${rewritten.length} declared + ${added.length} transitive SDK deps`)

      run(npmCmd, ['install'], { cwd: projectDir, shell: true })
      assertLocalSdkInstall(projectDir, closure, manifests)
      run(npmCmd, ['test'], { cwd: projectDir, shell: true })
      ok(`${template} unit tests passed`)
      run(npmCmd, ['run', 'build'], { cwd: projectDir, shell: true })
      if (!existsSync(path.join(projectDir, 'dist', 'extension.js'))) {
        die(`${template}: build produced no dist/extension.js`)
      }
      ok(`${template} built`)

      run(
        process.execPath,
        [path.join(projectDir, 'node_modules', '@universe-editor', 'uex', 'dist', 'cli.js'), 'package'],
        { cwd: projectDir },
      )
      const vsixName = `smoke.${name}-0.0.1.vsix`
      const vsixPath = path.join(projectDir, vsixName)
      if (!existsSync(vsixPath)) die(`${template}: expected ${vsixName} to be created`)

      const manifest = readVsixManifest(vsixPath)
      if (manifest.publisher !== 'smoke' || manifest.name !== name || manifest.version !== '0.0.1') {
        die(`${template}: VSIX manifest mismatch: ${manifest.publisher}.${manifest.name}@${manifest.version}`)
      }
      ok(`${template} packaged and round-trips readVsixManifest`)
    }

    console.log('\ntemplate smoke passed (basic + webview)')
  } finally {
    if (keep) {
      console.log(`kept smoke workspace: ${tmp}`)
    } else {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)))
