import type { Plugin } from 'vite'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

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

export function devRuntimeWatchPlugin({ repoRoot }: Options): Plugin {
  const watchers: ChildProcess[] = []

  return {
    name: 'universe-editor:dev-runtime-watch',
    apply: 'serve',

    buildStart() {
      const packages = discoverRuntimePackages(repoRoot)
      for (const pkgDir of packages) {
        const label = pkgLabel(repoRoot, pkgDir)
        console.log(`[dev-runtime] building ${label}...`)
        execFileSync('node', ['esbuild.config.mjs'], { cwd: pkgDir, stdio: 'inherit' })

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
    },

    closeBundle() {
      for (const w of watchers) w.kill()
      watchers.length = 0
    },
  }
}
