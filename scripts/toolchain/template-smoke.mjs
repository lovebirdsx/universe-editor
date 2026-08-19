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
 * Usage: node scripts/toolchain/template-smoke.mjs [--keep]
 */
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const keep = process.argv.includes('--keep')

const PACKAGES = ['extension-api', 'extension-manifest', 'extension-packaging', 'uex', 'create-extension']

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
    die(`packages/${pkg}/dist is missing — build first: pnpm --filter @universe-editor/${pkg} build`)
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

async function main() {
  for (const pkg of PACKAGES) assertDist(pkg)

  const tmp = mkdtempSync(path.join(tmpdir(), 'ue-toolchain-smoke-'))
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
      // (possibly not-yet-published) registry versions.
      const pkgPath = path.join(projectDir, 'package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      pkg.devDependencies['@universe-editor/extension-api'] = `file:${tarballs['extension-api']}`
      pkg.devDependencies['@universe-editor/uex'] = `file:${tarballs.uex}`
      writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

      run(npmCmd, ['install'], { cwd: projectDir, shell: true })
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
