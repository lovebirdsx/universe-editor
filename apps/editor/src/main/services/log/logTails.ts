/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared session log-tail collector: recursively gathers tail-capped buffers
 *  of the .log files under a session directory (root + window-<id>/ subdirs)
 *  for diagnostics zips and the bug recorder.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export interface SessionLogTail {
  readonly name: string
  readonly content: Buffer
}

export async function collectSessionLogTails(
  sessionDir: string,
  capBytes: number,
): Promise<SessionLogTail[]> {
  const out: SessionLogTail[] = []
  const collectFrom = async (dir: string, prefix: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() && entry.name.startsWith('window-')) {
        await collectFrom(full, `${entry.name}/`)
      } else if (entry.isFile() && entry.name.endsWith('.log')) {
        const buf = await fs.readFile(full).catch(() => null)
        if (buf === null) continue
        out.push({
          name: `${prefix}${entry.name}`,
          content: buf.length > capBytes ? buf.subarray(buf.length - capBytes) : buf,
        })
      }
    }
  }
  await collectFrom(sessionDir, '')
  return out
}
