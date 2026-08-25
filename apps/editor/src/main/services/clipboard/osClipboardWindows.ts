/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Windows OS clipboard backend. Electron's `clipboard.writeBuffer('CF_HDROP', …)`
 *  cannot be used: it goes through RegisterClipboardFormat(name), which yields a
 *  new 0xC000+ format id rather than the predefined 15, so Explorer never sees
 *  the file list. Instead we spawn Windows PowerShell 5.1 (powershell.exe) with
 *  System.Windows.Forms to write a real CF_HDROP DataObject.
 *
 *  - The script templates are STATIC: user data (the path list + drop effect)
 *    travels in a separate payload JSON file, never inside the script text.
 *  - Scripts are written to disk as UTF-8 with BOM: PS 5.1 decodes BOM-less
 *    files as ANSI, which would corrupt non-ASCII paths.
 *  - Results are read from an output file written by the script — never from
 *    stdout, whose [Console]::OutputEncoding OEM codepage would garble text.
 *  - powershell.exe (5.1) is required, not pwsh 7: pwsh removed -STA, and
 *    Windows.Forms.Clipboard is unusable under MTA.
 *  - CF_HDROP itself is ANSI (DROPFILES): characters outside the system
 *    codepage become '?'. This is an OS limit (Explorer's own cut/copy behaves
 *    the same), not something we can work around.
 *
 *  Cut semantics: CF_HDROP carries no action bit, so the DataObject also gets
 *  a 'Preferred DropEffect' stream (DWORD: 1=copy, 2=move) — Explorer honors
 *  it on paste, and our read script recovers isCut from it (missing = copy).
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { clipboard } from 'electron'
import type { ILogger } from '@universe-editor/platform'
import type { IOsClipboardBackend, IOsClipboardReadResult } from './osClipboardBackend.js'

const PS_SPAWN_TIMEOUT_MS = 10_000

export const DROP_EFFECT_COPY = 1
export const DROP_EFFECT_MOVE = 2

/**
 * Writes the CF_HDROP + text + Preferred DropEffect DataObject. Params:
 * JsonPath (payload JSON: {paths, dropEffect}), OutPath (result file: 'ok' on
 * success, exception type name on failure). The path list never appears in
 * this text.
 */
export const FILE_DROP_WRITE_SCRIPT = `param(
  [Parameter(Mandatory = $true)][string]$JsonPath,
  [Parameter(Mandatory = $true)][string]$OutPath
)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  $payload = Get-Content -Raw -Encoding UTF8 $JsonPath | ConvertFrom-Json
  $paths = @($payload.paths)
  $files = New-Object System.Collections.Specialized.StringCollection
  foreach ($p in $paths) { [void]$files.Add([string]$p) }
  $data = New-Object System.Windows.Forms.DataObject
  $data.SetFileDropList($files)
  $data.SetText([string]::Join([char]10, $paths))
  $stream = New-Object System.IO.MemoryStream
  $bytes = [BitConverter]::GetBytes([int]$payload.dropEffect)
  $stream.Write($bytes, 0, 4)
  [void]$stream.Seek(0, [System.IO.SeekOrigin]::Begin)
  $data.SetData('Preferred DropEffect', $stream)
  [System.Windows.Forms.Clipboard]::SetDataObject($data, $true)
  [IO.File]::WriteAllText($OutPath, 'ok', (New-Object Text.UTF8Encoding($false)))
}
catch {
  [IO.File]::WriteAllText($OutPath, $_.Exception.GetType().FullName, (New-Object Text.UTF8Encoding($false)))
  exit 1
}
`

/** Reads CF_HDROP + Preferred DropEffect into {paths, isCut} JSON at OutPath. Exit 1 on failure. */
export const FILE_DROP_READ_SCRIPT = `param(
  [Parameter(Mandatory = $true)][string]$OutPath
)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  $data = [System.Windows.Forms.Clipboard]::GetDataObject()
  $paths = @()
  $isCut = $false
  if ($data.GetDataPresent([System.Windows.Forms.DataFormats]::FileDrop)) {
    $paths = @($data.GetFileDropList())
    if ($data.GetDataPresent('Preferred DropEffect')) {
      $effectStream = $data.GetData('Preferred DropEffect')
      if ($effectStream -is [System.IO.Stream]) {
        if ($effectStream.CanSeek) { [void]$effectStream.Seek(0, [System.IO.SeekOrigin]::Begin) }
        $ms = New-Object System.IO.MemoryStream
        $effectStream.CopyTo($ms)
        $effectBytes = $ms.ToArray()
        if ($effectBytes.Length -ge 4) {
          $isCut = ([BitConverter]::ToInt32($effectBytes, 0) -eq 2)
        }
      }
    }
  }
  $result = @{ paths = $paths; isCut = $isCut }
  [IO.File]::WriteAllText($OutPath, (ConvertTo-Json -InputObject $result -Compress), (New-Object Text.UTF8Encoding($false)))
}
catch {
  [IO.File]::WriteAllText($OutPath, '{"paths":[],"isCut":false}', (New-Object Text.UTF8Encoding($false)))
  exit 1
}
`

export interface FileDropReadResult {
  readonly paths: string[]
  readonly isCut: boolean
}

/** Serializes the write payload ({paths, dropEffect}) for the write script. Pure JSON — no script content. */
export function buildFileDropPayloadJson(paths: readonly string[], isCut: boolean): string {
  return JSON.stringify({ paths, dropEffect: isCut ? DROP_EFFECT_MOVE : DROP_EFFECT_COPY })
}

/** Parses the read script's {paths, isCut} result. Undefined for malformed input. */
export function parseFileDropResultJson(json: string): FileDropReadResult | undefined {
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const payload = parsed as { paths?: unknown; isCut?: unknown }
    if (!Array.isArray(payload.paths)) return undefined
    return {
      paths: payload.paths.filter((entry): entry is string => typeof entry === 'string'),
      isCut: payload.isCut === true,
    }
  } catch {
    return undefined
  }
}

export class OsClipboardWindowsBackend implements IOsClipboardBackend {
  private _seq = 0
  private _scripts: { write: string; read: string } | null = null

  constructor(
    private readonly _tempDir: string,
    private readonly _logger?: ILogger,
  ) {}

  private async _ensureScripts(): Promise<{ write: string; read: string }> {
    if (this._scripts) return this._scripts
    const write = join(this._tempDir, 'ue-fileclipboard-write.ps1')
    const read = join(this._tempDir, 'ue-fileclipboard-read.ps1')
    // BOM required: PS 5.1 decodes BOM-less .ps1 files as ANSI.
    await fs.writeFile(write, '﻿' + FILE_DROP_WRITE_SCRIPT, 'utf8')
    await fs.writeFile(read, '﻿' + FILE_DROP_READ_SCRIPT, 'utf8')
    this._scripts = { write, read }
    return this._scripts
  }

  private _runPowerShell(args: readonly string[], timeoutMs: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', ...args],
        { windowsHide: true },
      )
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`powershell timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (stderr) this._logger?.debug(`[fileClipboard] powershell stderr: ${stderr.trim()}`)
        resolve(code ?? 1)
      })
    })
  }

  private async _withTempFiles<T>(
    run: (jsonPath: string, outPath: string) => Promise<T>,
  ): Promise<T> {
    const name = `ue-fileclipboard-${process.pid}-${++this._seq}`
    const jsonPath = join(this._tempDir, `${name}.json`)
    const outPath = join(this._tempDir, `${name}.out.txt`)
    try {
      return await run(jsonPath, outPath)
    } finally {
      await fs.rm(jsonPath, { force: true }).catch(() => undefined)
      await fs.rm(outPath, { force: true }).catch(() => undefined)
    }
  }

  async writeFiles(
    paths: readonly string[],
    isCut: boolean,
  ): Promise<{ ok: boolean; signature: string }> {
    const signature = paths.join('\n')
    if (paths.length === 0) return { ok: true, signature }
    return this._withTempFiles(async (jsonPath, outPath) => {
      await fs.writeFile(jsonPath, buildFileDropPayloadJson(paths, isCut), 'utf8')
      try {
        const { write } = await this._ensureScripts()
        const exitCode = await this._runPowerShell(
          ['-File', write, '-JsonPath', jsonPath, '-OutPath', outPath],
          PS_SPAWN_TIMEOUT_MS,
        )
        const result = await fs.readFile(outPath, 'utf8').catch(() => '')
        if (exitCode === 0 && result.trim() === 'ok') {
          return { ok: true, signature }
        }
        this._logger?.warn(
          `[fileClipboard] PowerShell CF_HDROP write failed (exit=${exitCode}, result=${result.trim() || 'none'}) — degrading to clipboard text`,
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this._logger?.warn(
          `[fileClipboard] PowerShell CF_HDROP write unavailable (${message}) — degrading to clipboard text`,
        )
      }
      clipboard.writeText(signature)
      return { ok: false, signature }
    })
  }

  async readFiles(): Promise<IOsClipboardReadResult | undefined> {
    return this._withTempFiles(async (jsonPath, outPath) => {
      void jsonPath
      try {
        const { read } = await this._ensureScripts()
        const exitCode = await this._runPowerShell(
          ['-File', read, '-OutPath', outPath],
          PS_SPAWN_TIMEOUT_MS,
        )
        const json = exitCode === 0 ? await fs.readFile(outPath, 'utf8').catch(() => '') : ''
        const result = parseFileDropResultJson(json)
        if (!result || result.paths.length === 0) return undefined
        return { paths: result.paths, isCut: result.isCut, signature: result.paths.join('\n') }
      } catch {
        return undefined
      }
    })
  }

  async clear(): Promise<void> {
    try {
      const { write } = await this._ensureScripts()
      // Reuse the write script with an empty list: a DataObject with an empty
      // FileDropList still displaces the previous CF_HDROP content.
      await this._withTempFiles(async (jsonPath, outPath) => {
        await fs.writeFile(jsonPath, buildFileDropPayloadJson([], false), 'utf8')
        try {
          await this._runPowerShell(
            ['-File', write, '-JsonPath', jsonPath, '-OutPath', outPath],
            PS_SPAWN_TIMEOUT_MS,
          )
        } catch {
          clipboard.clear()
        }
      })
    } catch {
      clipboard.clear()
    }
  }
}
