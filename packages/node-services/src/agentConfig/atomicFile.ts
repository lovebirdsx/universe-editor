/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared atomic-write helper for the agent-config stores. Writes to a temp file
 *  then renames so a concurrent reader / `fs.watch` never observes a half-written
 *  file.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export async function writeFileAtomic(path: string, text: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, path)
}
