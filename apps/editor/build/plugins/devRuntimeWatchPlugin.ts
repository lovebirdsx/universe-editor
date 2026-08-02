import type { Plugin } from 'vite'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

interface Options {
  repoRoot: string
}

function discoverRuntimePackages(repoRoot: string): string[] {
  const pkgs: string[] = []

  const extHostDir = resolve(repoRoot, 'packages/extension-host')
  if (existsSync(resolve(extHostDir, 'esbuild.config.mjs'))) {
    pkgs.push(extHostDir)
  }

  const extensionsRoot = resolve(repoRoot, 'extensions')
  if (existsSync(extensionsRoot)) {
    for (const entry of readdirSync(extensionsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const d = resolve(extensionsRoot, entry.name)
        if (existsSync(resolve(d, 'esbuild.config.mjs'))) {
          pkgs.push(d)
        }
      }
    }
  }

  return pkgs
}

function pkgLabel(repoRoot: string, pkgDir: string): string {
  const rel = pkgDir.startsWith(repoRoot)
    ? pkgDir.slice(repoRoot.length).replace(/^[\\/]/, '')
    : pkgDir
  return rel.replace(/\\/g, '/')
}

// esbuild.config.mjs output convention: extension-host emits dist/bootstrap.js,
// extensions emit dist/extension.js.
function runtimeArtifact(pkgDir: string): string {
  return pkgDir.endsWith('extension-host')
    ? resolve(pkgDir, 'dist/bootstrap.js')
    : resolve(pkgDir, 'dist/extension.js')
}

function runExtBuild(repoRoot: string): Promise<void> {
  return new Promise((res, rej) => {
    // Spawn turbo's shim directly: `pnpm run ext:build` would add a full pnpm
    // process boot (~0.7s on Windows) to the dev startup critical path. The
    // filter set must stay in sync with the root package.json `ext:build` script.
    const turbo = join(repoRoot, 'node_modules', '.bin', 'turbo')
    const p = spawn(
      turbo,
      [
        'run',
        'build',
        '--filter=@universe-editor/extension-host',
        '--filter=@universe-editor/extension-packaging',
        '--filter=./extensions/*',
      ],
      { cwd: repoRoot, stdio: 'inherit', shell: true },
    )
    p.on('error', rej)
    p.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`[dev-runtime] turbo build failed (exit ${code})`)),
    )
  })
}

export function devRuntimeWatchPlugin({ repoRoot }: Options): Plugin {
  const watchers: ChildProcess[] = []
  // Runs alongside the main-process bundle instead of blocking its buildStart.
  let extBuild: Promise<void> | null = null
  let artifactsReady = false

  return {
    name: 'universe-editor:dev-runtime-watch',
    apply(config) {
      return config.mode === 'development'
    },

    buildStart() {
      if (extBuild) return

      const packages = discoverRuntimePackages(repoRoot)
      if (packages.length === 0) return

      const labels = packages.map((pkgDir) => pkgLabel(repoRoot, pkgDir))

      // ext:build runs via turbo with dependsOn:["^build"], so platform /
      // extension-api / extensions-common dist are built before extension-host
      // and extensions bundle them. Watchers start only after it completes
      // (their esbuild bundles read upstream dist).
      extBuild = runExtBuild(repoRoot).then(() => {
        for (let i = 0; i < packages.length; i++) {
          const pkgDir = packages[i]!
          const label = labels[i]!
          const watcher = spawn('node', ['esbuild.config.mjs', '--watch'], {
            cwd: pkgDir,
            stdio: 'pipe',
          })
          watcher.stdout?.on('data', (d: Buffer) =>
            process.stdout.write(`[dev-runtime:${label}] ${d}`),
          )
          watcher.stderr?.on('data', (d: Buffer) =>
            process.stderr.write(`[dev-runtime:${label}] ${d}`),
          )
          watchers.push(watcher)
        }
      })

      // The extension host is spawned lazily (Eventually phase, after first
      // paint), so with dist already on disk the refresh may finish entirely in
      // the background. Only missing artifacts (fresh clone / after clean) make
      // closeBundle below hold electron back until the build lands.
      artifactsReady = packages.every((pkgDir) => existsSync(runtimeArtifact(pkgDir)))
      if (artifactsReady) {
        console.log(`[dev-runtime] refreshing ${labels.join(', ')} in background...`)
        extBuild.catch((err) => console.error('[dev-runtime] background ext:build failed:', err))
      } else {
        console.log(`[dev-runtime] building ${labels.join(', ')} (missing dist, will gate)...`)
      }
    },

    // electron-vite spawns electron only after the main bundle's closeBundle.
    // Gate it on the runtime build solely when artifacts were missing at start.
    async closeBundle() {
      if (!artifactsReady) await extBuild
    },
  }
}
