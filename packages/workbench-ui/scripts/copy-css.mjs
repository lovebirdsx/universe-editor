import { readdir, copyFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

async function copyDir(src, dest) {
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath)
    } else if (entry.name.endsWith('.css')) {
      await mkdir(dirname(destPath), { recursive: true })
      await copyFile(srcPath, destPath)
    }
  }
}

await copyDir('src', 'dist')
