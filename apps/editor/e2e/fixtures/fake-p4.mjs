#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Fake `p4` CLI for e2e / manual testing of the Perforce extension.
 *
 *  This machine (and CI) has the `p4` client but no reachable `p4d` server, so
 *  the extension's discovery (`p4 info`) fails and the whole provider stays
 *  disabled — nothing p4-related can be exercised end-to-end. This script stands
 *  in for `p4`: it speaks just enough of the CLI (the subcommands + `-Mj`/`-ztag`
 *  output modes the extension actually consumes) and keeps a small depot model on
 *  disk so behaviour is *real*, not canned:
 *
 *    - `reconcile -n` walks the client root and diffs each file against its
 *      have-revision content, so "edit a file → it shows up in Changes to
 *      Reconcile" is driven by the actual filesystem, exactly like real p4.
 *    - mutating commands (`edit`/`add`/`delete`/`reconcile`/`revert`) update the
 *      opened set in the state file, so a follow-up `opened` reflects them.
 *
 *  The extension points at this via `UNIVERSE_P4_PATH` (p4Service resolves a
 *  `.mjs` override to `process.execPath <script>`). State lives at the path in
 *  `UNIVERSE_P4_FAKE_STATE`; the harness seeds it before launch.
 *
 *  Deliberately dependency-free and pure Node so it runs under Electron-as-node
 *  in the extension host with no build step.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const STATE_PATH = process.env.UNIVERSE_P4_FAKE_STATE
if (!STATE_PATH) {
  process.stderr.write('fake-p4: UNIVERSE_P4_FAKE_STATE not set\n')
  process.exit(1)
}

/**
 * @typedef {{ rev: number, content: string }} DepotFile
 * @typedef {{ action: string, change: string, rev: number }} OpenedEntry
 * @typedef {{
 *   port?: string, user: string, client: string, clientRoot: string,
 *   depotPrefix: string,
 *   files: Record<string, DepotFile>,
 *   opened: Record<string, OpenedEntry>,
 *   changelists?: Record<string, { description: string }>,
 *   shelved?: Record<string, Record<string, { action: string, rev: number }>>,
 *   nextChange?: number,
 * }} State
 */

/** @returns {State} */
function loadState() {
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  // Default the changelist/shelf model so seeds written before it existed still load.
  state.changelists ??= {}
  state.shelved ??= {}
  state.nextChange ??= 1000
  return state
}

/** @param {State} state */
function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

const toPosix = (p) => p.split(sep).join('/')

/** clientFile (abs, OS path) → depotFile (//depot/...) */
function depotOf(state, clientFile) {
  const rel = toPosix(relative(state.clientRoot, clientFile))
  return `${state.depotPrefix}/${rel}`
}

/** depotFile (//depot/...) → clientFile (abs, OS path) */
function clientOf(state, depotFile) {
  const rel = depotFile.slice(state.depotPrefix.length + 1)
  return join(state.clientRoot, rel)
}

/** depotFile (//depot/...) → clientFile in CLIENT SYNTAX (`//clientName/rel`).
 *  Real `p4 opened` / `reconcile -n` report `clientFile` in client syntax, not a
 *  local path (only `fstat` gives a local path). Mirroring that here guards the
 *  extension's client→local conversion end-to-end. */
function clientSyntaxOf(state, depotFile) {
  const rel = depotFile.slice(state.depotPrefix.length + 1)
  return `//${state.client}/${rel}`
}

/** Any file arg (local OS path, depot syntax `//depot/…`, or client syntax
 *  `//clientName/…`) → its depotFile key. Client syntax is rooted at the client
 *  root, so its tail equals the depot tail; depot syntax is returned as-is; a
 *  local path is mapped through the client root. */
function toDepotFile(state, f) {
  if (f.startsWith(`${state.depotPrefix}/`)) return f
  if (f.startsWith(`//${state.client}/`)) {
    const rel = f.slice(`//${state.client}/`.length)
    return `${state.depotPrefix}/${rel}`
  }
  if (f.startsWith('//')) return f // some other depot/client spec: best-effort
  return depotOf(state, f)
}

/** Every file on disk under the client root (abs OS paths), skipping VCS/state dirs. */
function walkDisk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name === '.git' || e.name === '.p4fake' || e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) walkDisk(full, out)
    else if (e.isFile()) out.push(full)
  }
  return out
}

// --- argv parsing: strip global flags, then command + rest ---------------------

const argv = process.argv.slice(2)
let mode = 'plain' // 'plain' | 'mj' | 'ztag'
let i = 0
const WITH_VALUE = new Set(['-p', '-u', '-c', '-C', '-d', '-H', '-L', '-z', '-Q'])
for (; i < argv.length; i++) {
  const a = argv[i]
  if (a === '-Mj') mode = 'mj'
  else if (a === '-ztag') mode = 'ztag'
  else if (a === '-G') mode = 'marshal'
  else if (WITH_VALUE.has(a))
    i++ // skip the flag's value
  else if (a.startsWith('-'))
    continue // other global flag, no value
  else break
}
const command = argv[i]
const rest = argv.slice(i + 1)

// --- output helpers ------------------------------------------------------------

function emitMj(records) {
  for (const r of records) process.stdout.write(JSON.stringify(r) + '\n')
}

function emitZtag(records) {
  const blocks = records.map((r) =>
    Object.entries(r)
      .map(([k, v]) => `... ${k} ${v}`)
      .join('\n'),
  )
  process.stdout.write(blocks.join('\n\n') + (blocks.length ? '\n\n' : ''))
}

/** Emit records honoring the requested structured mode; falls back to -Mj shape. */
function emit(records) {
  if (mode === 'ztag') emitZtag(records)
  else emitMj(records)
}

/** Value following a flag in an arg list (e.g. `-c` → the changelist id), or
 *  undefined if the flag is absent / has no following token. */
function argAfter(args, flag) {
  const idx = args.indexOf(flag)
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined
}

/** Read all of stdin synchronously (for spec-fed commands like `change -i`). */
function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

// --- reconcile discovery: diff disk vs have-revision ---------------------------

/** @returns {{depotFile:string, clientFile:string, action:string, rev?:string}[]} */
function computeReconcile(state) {
  const results = []
  const opened = new Set(Object.keys(state.opened))
  const onDisk = new Map() // depotFile -> clientFile
  for (const abs of walkDisk(state.clientRoot)) {
    onDisk.set(depotOf(state, abs), abs)
  }
  // edits + adds
  for (const [depotFile, clientFile] of onDisk) {
    if (opened.has(depotFile)) continue
    const known = state.files[depotFile]
    if (!known) {
      results.push({ depotFile, clientFile: clientSyntaxOf(state, depotFile), action: 'add' })
    } else {
      const diskContent = readFileSync(clientFile, 'utf8')
      if (diskContent !== known.content) {
        results.push({
          depotFile,
          clientFile: clientSyntaxOf(state, depotFile),
          action: 'edit',
          rev: String(known.rev),
        })
      }
    }
  }
  // deletes: in depot, not opened, missing on disk
  for (const [depotFile, known] of Object.entries(state.files)) {
    if (opened.has(depotFile)) continue
    if (!onDisk.has(depotFile)) {
      results.push({
        depotFile,
        clientFile: clientSyntaxOf(state, depotFile),
        action: 'delete',
        rev: String(known.rev),
      })
    }
  }
  return results
}

/** Resolve command file args (paths or wildcards) to depotFiles on disk. Honors
 *  three forms: bare `//...` / `//depot/...` (whole client), a directory-scoped
 *  `<path>/...` (only files under that dir — mirrors real p4 and the extension's
 *  narrowed reconcile scope), or explicit file paths. */
function targetsFromArgs(state, args, discovered) {
  const files = args.filter((a) => !a.startsWith('-'))
  if (files.length === 0) return discovered
  const wholeClient = files.some((f) => f === '//...' || f === `${state.depotPrefix}/...`)
  if (wholeClient) return discovered
  // Directory-scoped wildcards: `<something>/...` → prefix match on clientFile.
  const dirScopes = files
    .filter((f) => f.endsWith('/...'))
    .map((f) => toPosix(f.slice(0, -'/...'.length)))
  if (dirScopes.length > 0) {
    return discovered.filter((d) => {
      const abs = toPosix(clientOf(state, d.depotFile))
      return dirScopes.some((s) => abs === s || abs.startsWith(`${s}/`))
    })
  }
  return discovered.filter((d) => {
    const abs = clientOf(state, d.depotFile)
    return files.some((f) => toPosix(f) === toPosix(abs) || f === d.depotFile)
  })
}

// --- command dispatch ----------------------------------------------------------

function main() {
  const state = loadState()

  switch (command) {
    case 'info': {
      emit([
        {
          userName: state.user,
          clientName: state.client,
          clientRoot: state.clientRoot,
          serverAddress: state.port ?? 'localhost:1666',
        },
      ])
      return 0
    }

    case 'clients': {
      emit([{ client: state.client, Root: state.clientRoot }])
      return 0
    }

    case 'opened': {
      const records = Object.entries(state.opened).map(([depotFile, o]) => ({
        depotFile,
        clientFile: clientSyntaxOf(state, depotFile),
        change: o.change,
        action: o.action,
        rev: String(o.rev),
      }))
      emit(records)
      return 0
    }

    case 'changes': {
      // Pending changelists this client owns. The default changelist is never
      // listed by p4; report each numbered changelist we've created.
      emit(
        Object.entries(state.changelists).map(([id, cl]) => ({
          change: id,
          desc: cl.description,
          status: 'pending',
          client: state.client,
          user: state.user,
        })),
      )
      return 0
    }

    case 'describe': {
      // Shelved-file probe (`describe -S -s <cl>`): report the shelf as parallel
      // depotFile/rev/action keys, matching real `-Mj describe -S`.
      const clId = argAfter(rest, '-s')
      const shelf = clId ? state.shelved[clId] : undefined
      if (!shelf || Object.keys(shelf).length === 0) {
        emit([])
        return 0
      }
      const record = { change: clId }
      Object.entries(shelf).forEach(([depotFile, s], idx) => {
        record[`depotFile${idx}`] = depotFile
        record[`rev${idx}`] = String(s.rev)
        record[`action${idx}`] = s.action
      })
      emit([record])
      return 0
    }

    case 'fstat': {
      // Per-file metadata. The diff baseline (BaselineProvider) reads `depotFile`
      // + `haveRev` from here, then `print`s that revision. Args are file paths
      // (local, depot, or client syntax).
      const files = rest.filter((a) => !a.startsWith('-'))
      const records = []
      for (const f of files) {
        const depotFile = toDepotFile(state, f)
        const known = state.files[depotFile]
        if (!known) continue
        records.push({
          depotFile,
          clientFile: clientSyntaxOf(state, depotFile),
          haveRev: String(known.rev),
          headRev: String(known.rev),
        })
      }
      emit(records)
      return 0
    }

    case 'print': {
      // `print -q <depotFile>#<rev>`: emit the have-revision content (plain stdout,
      // no -Mj wrapper — the extension reads exec().stdout directly).
      const spec = rest.filter((a) => !a.startsWith('-'))[0]
      if (!spec) return 1
      const depotFile = spec.replace(/#.*$/, '')
      const known = state.files[depotFile]
      if (!known) {
        process.stderr.write(`${spec} - no such file(s).\n`)
        return 1
      }
      process.stdout.write(known.content)
      return 0
    }

    case 'reconcile': {
      const dryRun = rest.includes('-n')
      const discovered = computeReconcile(state)
      const targets = targetsFromArgs(state, rest, discovered)
      if (dryRun) {
        if (targets.length === 0) {
          process.stderr.write('//... - no file(s) to reconcile.\n')
          return 1
        }
        emit(
          targets.map((t) => ({
            depotFile: t.depotFile,
            clientFile: t.clientFile,
            action: t.action,
            ...(t.rev ? { rev: t.rev } : {}),
          })),
        )
        return 0
      }
      // Real reconcile: open each discovered target for its action.
      for (const t of targets) {
        state.opened[t.depotFile] = {
          action: t.action,
          change: 'default',
          rev: t.rev ? Number(t.rev) : 1,
        }
      }
      saveState(state)
      emit(
        targets.map((t) => ({
          depotFile: t.depotFile,
          clientFile: t.clientFile,
          action: t.action,
        })),
      )
      return 0
    }

    case 'edit':
    case 'add':
    case 'delete': {
      const files = rest.filter((a) => !a.startsWith('-'))
      const records = []
      for (const f of files) {
        const abs = f.startsWith('//') ? clientOf(state, f) : f
        const depotFile = f.startsWith('//') ? f : depotOf(state, abs)
        const known = state.files[depotFile]
        state.opened[depotFile] = {
          action: command,
          change: 'default',
          rev: known ? known.rev : 1,
        }
        records.push({
          depotFile,
          clientFile: toPosix(abs),
          action: command,
          ...(known ? { rev: String(known.rev) } : {}),
        })
      }
      saveState(state)
      emit(records)
      return 0
    }

    case 'revert': {
      const files = rest.filter((a) => !a.startsWith('-'))
      const records = []
      for (const f of files) {
        const depotFile = f.startsWith('//') ? f : depotOf(state, f)
        if (state.opened[depotFile]) {
          delete state.opened[depotFile]
          records.push({
            depotFile,
            clientFile: toPosix(clientOf(state, depotFile)),
            action: 'reverted',
          })
        }
      }
      saveState(state)
      emit(records)
      return 0
    }

    case 'change': {
      // `change -i` (create/update from a spec on stdin) or `change -o <id>` (emit a
      // spec). Only the Description field is meaningful in the fake.
      if (rest.includes('-o')) {
        const clId = rest.filter((a) => !a.startsWith('-'))[0]
        const desc = clId && state.changelists[clId] ? state.changelists[clId].description : ''
        process.stdout.write(
          `Change: ${clId ?? 'new'}\nClient: ${state.client}\nUser: ${state.user}\nStatus: pending\nDescription:\n\t${desc}\n`,
        )
        return 0
      }
      // `change -i`: allocate (or update) a numbered changelist from the spec.
      const spec = readStdin()
      const descMatch = /Description:\s*\n((?:[ \t].*\n?)*)/.exec(spec)
      const description = descMatch
        ? descMatch[1]
            .split('\n')
            .map((l) => l.replace(/^\t/, ''))
            .join('\n')
            .trim()
        : ''
      const changeField = /^Change:\s*(\S+)/m.exec(spec)?.[1]
      const id = changeField && changeField !== 'new' ? changeField : String(state.nextChange++)
      state.changelists[id] = { description }
      saveState(state)
      process.stdout.write(`Change ${id} created.\n`)
      return 0
    }

    case 'reopen': {
      // Move files into a changelist (`reopen -c <id|default> <file...>`).
      const target = argAfter(rest, '-c') ?? 'default'
      const files = rest.filter((a) => !a.startsWith('-') && a !== target)
      const records = []
      for (const f of files) {
        const depotFile = f.startsWith('//') ? toDepotFile(state, f) : depotOf(state, f)
        if (state.opened[depotFile]) {
          state.opened[depotFile].change = target === 'default' ? 'default' : target
          records.push({ depotFile, action: state.opened[depotFile].action, change: target })
        }
      }
      saveState(state)
      emit(records)
      return 0
    }

    case 'shelve': {
      // `shelve -r -c <id>` archives the changelist's opened files; `shelve -d -c <id>
      // [file]` removes the shelf (whole CL or a single depot file).
      const clId = argAfter(rest, '-c')
      if (!clId) return 1
      if (rest.includes('-d')) {
        const only = rest.filter((a) => !a.startsWith('-') && a !== clId)
        if (state.shelved[clId]) {
          if (only.length > 0)
            for (const f of only) delete state.shelved[clId][toDepotFile(state, f)]
          else delete state.shelved[clId]
        }
        saveState(state)
        return 0
      }
      state.shelved[clId] ??= {}
      for (const [depotFile, o] of Object.entries(state.opened)) {
        if (o.change === clId) state.shelved[clId][depotFile] = { action: o.action, rev: o.rev }
      }
      saveState(state)
      return 0
    }

    case 'unshelve': {
      // Restore a shelf (`unshelve -s <src> [-c <dst>] [-f] [file...]`). The fake
      // just needs to succeed so the extension's refresh + toasts flow; it doesn't
      // rewrite disk content.
      const src = argAfter(rest, '-s')
      if (!src) return 1
      return 0
    }

    case 'login': {
      // `p4 login -s` (session check) succeeds with no output = logged in.
      // `p4 login -p` intentionally emits nothing here: Swarm auth reads the
      // cached ticket via `p4 tickets`, not by re-running login.
      return 0
    }
    case 'tickets': {
      // `p4 tickets` prints the on-disk P4TICKETS entries (never re-auths).
      // Line format: `serverAddress (user) TICKETVALUE`.
      const port = state.port ?? 'fake:1666'
      process.stdout.write(`${port} (${state.user}) FAKE0SWARM0TICKET0DEADBEEF\n`)
      return 0
    }
    case 'logout':
    case 'set': {
      return 0
    }

    default: {
      // Unknown command: succeed with no output so unrelated probes don't crash.
      process.stderr.write(`fake-p4: unhandled command '${command ?? ''}'\n`)
      return 0
    }
  }
}

try {
  process.exit(main())
} catch (err) {
  process.stderr.write(`fake-p4: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exit(1)
}
