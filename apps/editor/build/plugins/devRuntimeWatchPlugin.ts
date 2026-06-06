import type { Plugin } from 'vite'
import { spawn, type ChildProcess } from 'node:child_process'
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

function runPnpm(args: string[], cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn('pnpm', args, { cwd, stdio: 'inherit', shell: true })
    p.on('error', rej)
    p.on('exit', (code) =>
      code === 0
        ? res()
        : rej(new Error(`[dev-runtime] pnpm ${args.join(' ')} failed (exit ${code})`)),
    )
  })
}

export function devRuntimeWatchPlugin({ repoRoot }: Options): Plugin {
  const watchers: ChildProcess[] = []

  return {
    name: 'universe-editor:dev-runtime-watch',
    apply(config) {
      return config.mode === 'development'
    },

    async buildStart() {
      if (watchers.length > 0) return

      const packages = discoverRuntimePackages(repoRoot)
      if (packages.length === 0) return

      const labels = packages.map((pkgDir) => pkgLabel(repoRoot, pkgDir))
      console.log(`[dev-runtime] building ${labels.join(', ')} (with dependencies)...`)

      // ext:build runs via turbo with dependsOn:["^build"], so platform /
      // extension-api / extensions-common dist are built before extension-host
      // and extensions bundle them. Blocks here so artifacts exist before the
      // main process spawns the extension host.
      await runPnpm(['run', 'ext:build'], repoRoot)

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
    },
  }
}
