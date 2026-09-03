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

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'

const STATE_PATH = process.env.UNIVERSE_P4_FAKE_STATE
if (!STATE_PATH) {
  process.stderr.write('fake-p4: UNIVERSE_P4_FAKE_STATE not set\n')
  process.exit(1)
}

/**
 * @typedef {{ rev: number, content: string, revisions?: Record<string, string>,
 *   haveRev?: number, haveContent?: string, headAction?: string,
 *   clobber?: boolean, refused?: boolean }} DepotFile
 *   `rev`/`content` are the depot HEAD (matching the pre-existing revision-history
 *   seeds); `haveRev`/`haveContent`, when present, are what the client has synced —
 *   absent means have == head. Two independent sync-refusal faults, matching the
 *   two real client configurations: `clobber` is a `noallwrite` client, where a
 *   plain `p4 sync` (no `-f`) fails with "can't clobber writable file" and aborts
 *   the WHOLE run (exit 1); `refused` is an `allwrite noclobber` client, where
 *   sync skips just that file with "can't update modified file" on **stdout**,
 *   exits **0**, and carries on with the rest (§13).
 * @typedef {{ action: string, change: string, rev: number,
 *   unresolved?: boolean, resolveOutcome?: 'merge' | 'conflict' }} OpenedEntry
 *   `unresolved` is the internal needs-resolve flag — real `p4 opened` NEVER
 *   emits it (§11.5), so only `fstat` / `fstat -Ru` surface it as a bare key;
 *   `resolveOutcome` decides what `p4 resolve -am` does: 'merge' lands it,
 *   'conflict' leaves it open with `resolve skipped`.
 * @typedef {{ user: string, client: string, action: string, rev: number }} OthersEntry
 * @typedef {{
 *   port?: string, user: string, client: string, clientRoot: string,
 *   depotPrefix: string,
 *   files: Record<string, DepotFile>,
 *   opened: Record<string, OpenedEntry>,
 *   openedByOthers?: Record<string, OthersEntry>,
 *   ignored?: string[],
 *   changelists?: Record<string, { description: string }>,
 *   changeMeta?: Record<string, { user: string, time: string, desc: string, rev?: number }>,
 *   annotateCl?: string,
 *   shelved?: Record<string, Record<string, { action: string, rev: number, content?: string }>>,
 *   unshelveRefuse?: string[],
 *   nextChange?: number,
 * }} State
 */

/** @returns {State} */
function loadState() {
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  // Default the changelist/shelf model so seeds written before it existed still load.
  state.changelists ??= {}
  state.shelved ??= {}
  state.submitted ??= {}
  state.nextChange ??= 1000
  state.openedByOthers ??= {}
  state.ignored ??= []
  return state
}

/** @param {State} state */
function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
}

const toPosix = (p) => p.split(sep).join('/')

/** Posix form with a lower-cased Windows drive letter, so path comparisons are
 *  case-insensitive on the drive the way real p4 is on Windows. Mirrors the
 *  extension's `norm` (pathUtil.ts) — the SCM view keys default-changelist paths
 *  through it (lower-cased drive), so a straight case-sensitive string compare
 *  against on-disk paths (upper-cased drive) would spuriously miss. */
function normPath(p) {
  let s = toPosix(p).replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s[0].toLowerCase() + s.slice(1)
  return s
}

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
function clientSyntaxFor(clientName, state, depotFile) {
  const rel = depotFile.slice(state.depotPrefix.length + 1)
  return `//${clientName}/${rel}`
}

function clientSyntaxOf(state, depotFile) {
  return clientSyntaxFor(state.client, state, depotFile)
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

/** Head revision of a depot file — `entry.rev` IS head (see the State typedef). */
const headRevOf = (known) => known.rev

/** Revision the client has synced; defaults to head (a seeded file is current). */
const haveRevOf = (known) => known.haveRev ?? known.rev

/** Content at the synced revision; defaults to head content. */
const haveContentOf = (known) => known.haveContent ?? known.content

/** Filespec revision suffix (`#head`/`#N`/`@cl`/`@date`) → target revision, or
 *  undefined when unparseable. `@cl`/`@date` resolve to head — the fake has no
 *  CL/date content model to resolve against — EXCEPT a numeric `@<cl>` whose
 *  `changeMeta` entry carries a `rev`: that is the revision the changelist
 *  produced, which is what a real `sync @<cl>` would land on. */
function syncTargetRev(spec, headRev, state, depotFile) {
  if (!spec || spec === '#head') return headRev
  const hash = /^#(\d+)$/.exec(spec)
  if (hash) return Number(hash[1])
  const atCl = /^@(\d+)$/.exec(spec)
  if (atCl) {
    const rev = state.changeMeta?.[atCl[1]]?.rev
    if (typeof rev === 'number') return rev
    // A submitted change seeded with a file set but no meta `rev` still names
    // the revision it created for this file (`describe -s` source).
    const sub = state.submitted?.[atCl[1]]?.[depotFile]
    if (sub) return sub.rev
    return headRev
  }
  if (spec.startsWith('@')) return headRev
  return undefined
}

/** Content at a given revision: the explicit `revisions` history, or the entry's
 *  own head/have contents. Unknown revisions fall back to head content. */
function contentAt(known, rev) {
  const hist = known.revisions?.[String(rev)]
  if (hist !== undefined) return hist
  if (rev === known.rev) return known.content
  if (rev === known.haveRev) return known.haveContent ?? known.content
  return known.content
}

/** True when a depot file falls under the given `opened` filespecs (`//...`,
 *  `<dir>/...`, or explicit paths). No specs = whole client. */
function openedInScope(state, scopes, depotFile) {
  if (scopes.length === 0) return true
  if (scopes.some((f) => f === '//...' || f === `${state.depotPrefix}/...`)) return true
  const abs = normPath(clientOf(state, depotFile))
  const dirScopes = scopes
    .filter((f) => f.endsWith('/...'))
    .map((f) => normPath(f.slice(0, -'/...'.length)))
  if (dirScopes.length > 0) return dirScopes.some((s) => abs === s || abs.startsWith(`${s}/`))
  return scopes.some((f) => toDepotFile(state, f) === depotFile || normPath(f) === abs)
}

/** Write a sync plan's content to disk and advance the client's have state. */
function writeSync(state, p) {
  const known = state.files[p.depotFile]
  mkdirSync(dirname(p.local), { recursive: true })
  writeFileSync(p.local, p.toWrite)
  if (p.toRev === known.rev) {
    // Synced to head: back to the plain current-file shape.
    delete known.haveRev
    delete known.haveContent
  } else {
    known.haveRev = p.toRev
    known.haveContent = p.toWrite
  }
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
let hadClientGlobal = false // whether a `-c <client>` global was passed
const argfileArgs = [] // args from `-x <file>`, appended after the command-line args
const WITH_VALUE = new Set(['-p', '-u', '-c', '-C', '-d', '-H', '-L', '-z', '-Q'])
for (; i < argv.length; i++) {
  const a = argv[i]
  if (a === '-Mj') mode = 'mj'
  else if (a === '-ztag') mode = 'ztag'
  else if (a === '-G') mode = 'marshal'
  else if (a === '-x') {
    // `-x <argfile>`: p4 reads extra args from a UTF-8 file (one per line) and
    // appends them AFTER the command-line arguments — the extension's escape
    // hatch for non-ASCII args (a Chinese depot path) that Windows argv would
    // mangle via the ANSI code page.
    const lines = readFileSync(argv[++i], 'utf8').split(/\r?\n/)
    for (const line of lines) if (line !== '') argfileArgs.push(line)
  } else if (WITH_VALUE.has(a)) {
    if (a === '-c') hadClientGlobal = true
    i++ // skip the flag's value
  } else if (a.startsWith('-'))
    continue // other global flag, no value
  else break
}
const command = argv[i]
const rest = [...argv.slice(i + 1), ...argfileArgs]

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
      if (diskContent !== haveContentOf(known)) {
        results.push({
          depotFile,
          clientFile: clientSyntaxOf(state, depotFile),
          action: 'edit',
          rev: String(haveRevOf(known)),
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
        rev: String(haveRevOf(known)),
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
    .map((f) => normPath(f.slice(0, -'/...'.length)))
  if (dirScopes.length > 0) {
    return discovered.filter((d) => {
      const abs = normPath(clientOf(state, d.depotFile))
      return dirScopes.some((s) => abs === s || abs.startsWith(`${s}/`))
    })
  }
  return discovered.filter((d) => {
    const abs = normPath(clientOf(state, d.depotFile))
    return files.some((f) => normPath(f) === abs || toDepotFile(state, f) === d.depotFile)
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
      // §5 (PROBE-FINDINGS): `-Mj` collapses to a `{"data":…}` blob, so
      // `execRecords` must actually take its `-ztag` fallback; in `-ztag` only
      // `client` is lowercase — every other field is capitalized, which is what
      // `parseClientsList` reads.
      const plain = `Client ${state.client} 2026/08/11 root ${state.clientRoot} 'Created by ${state.user}. '`
      if (mode === 'mj') {
        emitMj([{ data: plain, level: 0 }])
      } else if (mode === 'ztag') {
        emitZtag([
          {
            client: state.client,
            Update: '2026/08/11 10:00:00',
            Access: '2026/08/11 10:00:00',
            Owner: state.user,
            Options: 'noallwrite noclobber nocompress unlocked nomodtime rmdir',
            SubmitOptions: 'submitunchanged',
            LineEnd: 'local',
            Root: state.clientRoot,
            Host: 'DESKTOP-TEST',
            Type: 'writeable',
            Description: `Created by ${state.user}. `,
          },
        ])
      } else {
        process.stdout.write(`${plain}\n`)
      }
      return 0
    }

    case 'opened': {
      const all = rest.includes('-a')
      const max = argAfter(rest, '-m')
      const scopes = rest.filter((a, idx) => {
        if (a.startsWith('-')) return false
        const prev = rest[idx - 1]
        return prev !== '-m' && prev !== '-c'
      })
      const records = []
      for (const [depotFile, o] of Object.entries(state.opened)) {
        if (!openedInScope(state, scopes, depotFile)) continue
        records.push({
          depotFile,
          clientFile: clientSyntaxOf(state, depotFile),
          change: o.change,
          action: o.action,
          rev: String(o.rev),
          // §11.5: real `opened` never carries `unresolved` — only fstat does.
          // §4 (PROBE-FINDINGS): only `-a` carries `user`/`client`.
          ...(all ? { user: state.user, client: state.client } : {}),
        })
      }
      if (all) {
        for (const [depotFile, o] of Object.entries(state.openedByOthers)) {
          if (!openedInScope(state, scopes, depotFile)) continue
          records.push({
            depotFile,
            // §4: the OTHER client's client-syntax path — translating it with our
            // own clientRoot would manufacture a local path that doesn't exist.
            clientFile: clientSyntaxFor(o.client, state, depotFile),
            action: o.action,
            rev: String(o.rev),
            // §4: a literal `none` string for open-for-add (no have revision).
            haveRev: o.action === 'add' ? 'none' : String(o.rev),
            change: 'default', // §4: 'default', not a number
            type: 'binary', // §4 verbatim
            user: o.user,
            client: o.client,
          })
        }
      }
      const limited = max !== undefined ? records.slice(0, Number(max)) : records
      emit(limited)
      return 0
    }

    case 'changes': {
      // Submitted history (`changes -s submitted [-l] [-m N] <scope>` for the
      // graph, and `changes -l <file>` for blame): newest-first by change id,
      // truncated by `-m`. The blame pass carries no `-s`, so its lone file arg
      // routes it here too — sorting/truncation are harmless to it (a single
      // seeded changeMeta entry). `-s pending` (or bare `changes`) stays the
      // pending-changelist query below.
      const status = argAfter(rest, '-s')
      // Every non-flag filespec, not just the first: merged (multi-select) history
      // passes N of them and real `p4 changes` answers their UNION.
      const files = rest.filter((a, idx) => {
        if (a.startsWith('-')) return false
        const prev = rest[idx - 1]
        return prev !== '-s' && prev !== '-c' && prev !== '-m'
      })
      if (status === 'submitted' || files.length > 0) {
        const max = argAfter(rest, '-m')
        const entries = Object.entries(state.changeMeta ?? {})
          .map(([id, m]) => ({ id: Number(id), m }))
          .sort((a, b) => b.id - a.id)
        // A file/dir scope limits the listing to changes that touched it — real
        // `p4 changes <filespec…>` answers per depot path, so a scoped graph
        // (file/folder/merged history) must not show unrelated changes. A change
        // seeded without a file set (the annotate-only seeds) can't be
        // filtered, so it stays — blame's `changes -l <file>` relies on that.
        const scoped =
          files.length > 0
            ? entries.filter(({ id }) => {
                const touched = state.submitted?.[String(id)]
                if (!touched || Object.keys(touched).length === 0) return true
                return Object.keys(touched).some((depotFile) =>
                  openedInScope(state, files, depotFile),
                )
              })
            : entries
        const limited = max !== undefined ? scoped.slice(0, Number(max)) : scoped
        emit(
          limited.map(({ id, m }) => ({
            change: String(id),
            time: m.time,
            user: m.user,
            client: state.client,
            status: 'submitted',
            changeType: 'public',
            desc: m.desc,
          })),
        )
        return 0
      }
      // Pending changelists this client owns. The default changelist is never
      // listed by p4; report each numbered changelist we've created.
      //
      // A changelist holding shelved files carries a *bare* `shelved` key (empty
      // value) and omits it otherwise — verified against P4D 2024.2. The extension
      // filters on it to avoid one `describe -S -s` per pending changelist, so
      // emitting it is required for that path to be exercised faithfully.
      emit(
        Object.entries(state.changelists).map(([id, cl]) => ({
          change: id,
          desc: cl.description,
          status: 'pending',
          client: state.client,
          user: state.user,
          ...(Object.keys(state.shelved[id] ?? {}).length > 0 ? { shelved: '' } : {}),
        })),
      )
      return 0
    }

    case 'describe': {
      // Shelved / submitted file probe (`describe -S -s <cl>`): report the change
      // as parallel depotFile/rev/action keys, matching real `-Mj describe -S`.
      // `status` (submitted|pending) is what tells the extension whether `rev` is
      // the pre-edit base (pending shelf) or the change that contains the edit
      // (submitted → base is rev-1). A submitted change takes precedence.
      const clId = argAfter(rest, '-s')
      const submitted = clId ? state.submitted?.[clId] : undefined
      const files = submitted ?? (clId ? state.shelved[clId] : undefined)
      if (!files || Object.keys(files).length === 0) {
        // No seeded file set: fall back to changeMeta so the graph's details
        // panel still renders the change header (author/date/description)
        // for a submitted cl seeded only via the annotate/changeMeta seed.
        const meta = clId ? state.changeMeta?.[clId] : undefined
        if (meta) {
          emit([
            {
              change: clId,
              status: 'submitted',
              user: meta.user,
              time: meta.time,
              desc: meta.desc,
              client: state.client,
            },
          ])
        } else {
          emit([])
        }
        return 0
      }
      const record = { change: clId, status: submitted ? 'submitted' : 'pending' }
      Object.entries(files).forEach(([depotFile, s], idx) => {
        record[`depotFile${idx}`] = depotFile
        record[`rev${idx}`] = String(s.rev)
        record[`action${idx}`] = s.action
      })
      emit([record])
      return 0
    }

    case 'annotate': {
      // `annotate -c -q <file>` (ztag): one record per source line of the
      // have-revision content, tagged with the changelist that last touched it
      // (`lower`). The cl comes from `state.annotateCl`, falling back to the
      // first seeded `changeMeta` id; without either the records carry no
      // `lower`, which is how unannotated (locally new) lines surface.
      const file = rest.filter((a) => !a.startsWith('-'))[0]
      if (!file) return 1
      const depotFile = toDepotFile(state, file)
      const known = state.files[depotFile]
      if (!known) {
        process.stderr.write(`${file} - no such file(s).\n`)
        return 1
      }
      const cl = state.annotateCl ?? Object.keys(state.changeMeta ?? {})[0]
      const records = known.content.split('\n').map((data) => ({
        data,
        ...(cl !== undefined ? { lower: cl } : {}),
      }))
      emit(records)
      return 0
    }

    case 'where': {
      const files = rest.filter((a) => !a.startsWith('-'))
      const records = []
      for (const file of files) {
        const depotFile = toDepotFile(state, file)
        if (!depotFile.startsWith(`${state.depotPrefix}/`)) continue
        records.push({
          depotFile,
          clientFile: clientSyntaxOf(state, depotFile),
          path: clientOf(state, depotFile),
        })
      }
      emit(records)
      return 0
    }

    case 'ignores': {
      // `p4 ignores -i <path…>` is a pure ignore-rule evaluator: it echoes each
      // input path a rule excludes as `<abs path> ignored` (plain text — no
      // -Mj/-ztag structure) and prints nothing for the rest. Rules are seeded
      // as client-root-relative paths / directory prefixes; a path matches when
      // it equals an entry or sits under a directory entry.
      if (rest.includes('-i')) {
        const rules = state.ignored ?? []
        const paths = rest.filter((a) => !a.startsWith('-'))
        for (const abs of paths) {
          const rel = toPosix(relative(state.clientRoot, abs))
          const hit = rules.some((entry) => {
            const e = toPosix(entry).replace(/\/+$/, '')
            return rel === e || rel.startsWith(`${e}/`)
          })
          if (hit) process.stdout.write(`${abs} ignored\n`)
        }
        return 0
      }
      // listing mode (no -i): nothing to report.
      return 0
    }

    case 'fstat': {
      // §11.5 (PROBE-FINDINGS): the unresolved signal lives HERE on real
      // servers — `opened` never carries it. `-Ru` lists only the opened files
      // with an unresolved integration record, over the given scope, each
      // carrying a bare `unresolved` key. With none, real p4 prints
      // "<scope> - file(s) not opened on this client." exit 0 (§7): a data
      // blob under -Mj (which makes the extension's execRecords fall back to
      // -ztag) and a plain non-tagged line under -ztag that parses to zero
      // records — never a phantom record.
      if (rest.includes('-Ru')) {
        const scopes = rest.filter((a) => !a.startsWith('-'))
        const records = []
        for (const [depotFile, o] of Object.entries(state.opened)) {
          if (!o.unresolved) continue
          if (!openedInScope(state, scopes, depotFile)) continue
          records.push({
            depotFile,
            // §3 (PROBE-FINDINGS): fstat's `clientFile` is a LOCAL path — the
            // one command whose clientFile differs from opened/reconcile's
            // client syntax.
            clientFile: clientOf(state, depotFile),
            action: o.action,
            rev: String(o.rev),
            unresolved: '',
          })
        }
        if (records.length === 0) {
          const scope = scopes[0] ?? '//...'
          if (mode === 'ztag') {
            process.stdout.write(`${scope} - file(s) not opened on this client.\n`)
          } else {
            emitMj([{ data: `${scope} - file(s) not opened on this client.\n` }])
          }
          return 0
        }
        emit(records)
        return 0
      }
      // Per-file metadata. The diff baseline (BaselineProvider) reads `depotFile`
      // + `haveRev` from here, then `print`s that revision. Args are file paths
      // (local, depot, or client syntax); `-T clientFile,headAction` (the
      // checkIgnore depot filter) selects fields and its value is not a path.
      const files = rest.filter((a, idx) => {
        if (a.startsWith('-')) return false
        if (rest[idx - 1] === '-T') return false
        return true
      })
      const records = []
      let missing = 0
      for (const f of files) {
        const depotFile = toDepotFile(state, f)
        const known = state.files[depotFile]
        if (!known) {
          // Real p4 reports every unmatched spec and exits non-zero even when it
          // answered for the other args. checkIgnore's depot filter feeds it a
          // batch that is mostly local-only files, so this is its NORMAL result —
          // modelling it as a silent `return 0` would let a regression that
          // early-returns on the exit code sail through the e2e.
          process.stderr.write(`${f} - no such file(s).\n`)
          missing++
          continue
        }
        records.push({
          depotFile,
          // §3 (PROBE-FINDINGS): fstat's `clientFile` is a LOCAL path — the one
          // command whose clientFile differs from opened/reconcile's client syntax.
          clientFile: clientOf(state, depotFile),
          haveRev: String(haveRevOf(known)),
          headRev: String(headRevOf(known)),
          // A head revision always carries the action that produced it. The
          // checkIgnore depot filter reads exactly this field to tell "the rules
          // match it but it's controlled" from "purely local".
          headAction: known.headAction ?? 'edit',
          // §11.4: a real fstat of an unresolved file carries the bare key too.
          ...(state.opened[depotFile]?.unresolved ? { unresolved: '' } : {}),
        })
      }
      emit(records)
      return missing > 0 ? 1 : 0
    }

    case 'print': {
      // `print -q <depotFile>#<rev>`: emit the have-revision content (plain stdout,
      // no -Mj wrapper — the extension reads exec().stdout directly).
      const spec = rest.filter((a) => !a.startsWith('-'))[0]
      if (!spec) return 1
      const shelfChange = /@=(\d+)$/.exec(spec)?.[1]
      const depotFile = spec.replace(/(?:#.*|@=.*)$/, '')
      // Client-view filter: real p4 resolves a depot spec against the current
      // client's view when bound to one (`-c`). A file outside the view prints
      // empty — the out-of-workspace Swarm diff bug. printRevision fixes it by
      // dropping `-c` (no client → no view to filter against), so this guard only
      // bites when the caller still passed a client global.
      if (hadClientGlobal && !depotFile.startsWith(`${state.depotPrefix}/`)) {
        process.stderr.write(`${spec} - file(s) not in client view.\n`)
        return 1
      }
      const shelved = shelfChange ? state.shelved[shelfChange]?.[depotFile] : undefined
      // Binary files (e.g. xlsx) are seeded as `contentBase64` so the raw bytes
      // survive JSON + are emitted to stdout as a Buffer (never utf8-encoded).
      if (shelved?.contentBase64 !== undefined) {
        process.stdout.write(Buffer.from(shelved.contentBase64, 'base64'))
        return 0
      }
      if (shelved?.content !== undefined) {
        process.stdout.write(shelved.content)
        return 0
      }
      const known = state.files[depotFile]
      if (!known) {
        process.stderr.write(`${spec} - no such file(s).\n`)
        return 1
      }
      // A specific `#<rev>` reads that revision's historical content when the file
      // models a revision history (`revisions: {17: '…', 18: '…'}`) or a synced
      // revision below head (`haveRev`); otherwise the single head content. Lets a
      // submitted-change diff show base (#rev-1) vs the edit (#rev / shelf).
      const askedRev = /#(\d+)$/.exec(spec)?.[1]
      if (askedRev) {
        const hist =
          known.revisions?.[askedRev] ??
          (askedRev === String(known.haveRev) ? known.haveContent : undefined)
        if (hist !== undefined) {
          process.stdout.write(hist)
          return 0
        }
      }
      if (known.contentBase64 !== undefined) {
        process.stdout.write(Buffer.from(known.contentBase64, 'base64'))
        return 0
      }
      process.stdout.write(known.content)
      return 0
    }

    case 'sync': {
      // §1/§2 (PROBE-FINDINGS): `sync -n` records carry `clientFile` as a LOCAL
      // path (the opposite of opened/reconcile — do NOT client-syntax it), and
      // "file(s) up-to-date." arrives on **stderr with exit 0**, never non-zero.
      // A real sync prints one plain line per file, `<depot>#<rev> - <verb> as
      // <local>`; `-f` forces it over unchanged/writable/open files.
      const dryRun = rest.includes('-n')
      const force = rest.includes('-f')
      const max = argAfter(rest, '-m')
      const targets = rest.filter((a, idx) => {
        if (a.startsWith('-')) return false
        const prev = rest[idx - 1]
        return prev !== '-m' && prev !== '-c'
      })
      const scopes = targets.map((t) => t.replace(/[#@].*$/, ''))
      const inScope = (depotFile) => {
        if (scopes.length === 0) return true
        if (scopes.some((f) => f === '//...' || f === `${state.depotPrefix}/...`)) return true
        const abs = normPath(clientOf(state, depotFile))
        const dirScopes = scopes
          .filter((f) => f.endsWith('/...'))
          .map((f) => normPath(f.slice(0, -'/...'.length)))
        if (dirScopes.length > 0) return dirScopes.some((s) => abs === s || abs.startsWith(`${s}/`))
        return scopes.some((f) => toDepotFile(state, f) === depotFile || normPath(f) === abs)
      }
      const specTarget = targets.find((t) => /[#@]/.test(t))
      const spec = specTarget ? /[#@].*$/.exec(specTarget)[0] : '#head'
      const plans = []
      for (const [depotFile, known] of Object.entries(state.files)) {
        if (!inScope(depotFile)) continue
        const toRev = syncTargetRev(spec, headRevOf(known), state, depotFile)
        if (toRev === undefined) continue
        const haveRev = haveRevOf(known)
        const local = clientOf(state, depotFile)
        let action
        if (!existsSync(local)) action = 'added'
        else if (toRev > haveRev) action = 'updated'
        else if (toRev < haveRev && force) action = 'updated'
        else if (toRev === haveRev && force) action = 'refreshing'
        else continue
        plans.push({ depotFile, local, toRev, action, toWrite: contentAt(known, toRev) })
      }
      // §13: on an `allwrite noclobber` client p4 refuses each locally-modified
      // file individually — a plain line on stdout, exit 0, and the run continues.
      // `-f` overrides the refusal. Split here so both the dry run and the real
      // sync report the same set (the editor parses the plain lines out of both).
      const refusedPlans = force
        ? []
        : plans.filter((p) => state.files[p.depotFile].refused === true)
      const activePlans = force
        ? plans
        : plans.filter((p) => state.files[p.depotFile].refused !== true)
      const refusalLines = refusedPlans.map(
        (p) => `${p.depotFile}#${p.toRev} - can't update modified file ${p.local}`,
      )
      if (dryRun) {
        if (plans.length === 0) {
          const scope = targets.length > 0 ? scopes[0] : '//...'
          process.stderr.write(`${scope} - file(s) up-to-date.\n`)
          return 0
        }
        const listed = max !== undefined ? activePlans.slice(0, Number(max)) : activePlans
        const totalSize = activePlans.reduce((n, p) => n + p.toWrite.length, 0)
        const change = Math.max(...Object.keys(state.changeMeta ?? {}).map(Number), 0)
        // §12.3.0 (PROBE-FINDINGS) measured shape: `totalFileSize` /
        // `totalFileCount` / `change` ride in the FIRST file record only, as
        // ONE grand total across all filespecs — and `totalFileCount` is the
        // UNTRUNCATED total, never the `-m`-capped `listed` count. It counts the
        // refused files too: they are part of what the sync would act on.
        emit(
          listed.map((p, i) => ({
            depotFile: p.depotFile,
            clientFile: p.local, // §1: local path
            rev: String(p.toRev),
            action: p.action,
            ...(i === 0
              ? {
                  totalFileSize: String(totalSize),
                  totalFileCount: String(plans.length),
                  change: String(change),
                }
              : {}),
          })),
        )
        // The plain refusal lines ride alongside the structured records, exactly
        // as the real server prints them — `-ztag` gives them no key prefix.
        if (refusalLines.length > 0) process.stdout.write(refusalLines.join('\n') + '\n')
        return 0
      }
      // Real sync. The clobber fault aborts the whole run like real p4 (exit 1);
      // `-f` overrides it.
      const clobber = plans.find((p) => state.files[p.depotFile].clobber === true)
      if (clobber && !force) {
        process.stderr.write(
          `${clobber.depotFile} - can't clobber writable file ${clobber.local}\n`,
        )
        return 1
      }
      const lines = []
      for (const p of plans) {
        const opened = state.opened[p.depotFile]
        const known = state.files[p.depotFile]
        if (known.refused === true && !force) {
          // §13: skipped, not applied — the file keeps its have revision and
          // its local content, and the run walks on to the next file.
          lines.push(`${p.depotFile}#${p.toRev} - can't update modified file ${p.local}`)
          continue
        }
        if (opened) {
          // §11.3: a sync never rewrites an opened file. When it is behind, the
          // have revision is bumped to the target and a resolve is scheduled in
          // place — the opened record advances to the head rev and becomes
          // unresolved, `resolve -n` then reports `merging`. A forced sync over
          // an already-bumped file has nothing left to do (the real server
          // answers `file(s) up-to-date.` exit 0 — the old fake-only
          // "updates + needs-resolve" model never happens).
          if (p.toRev <= haveRevOf(known)) continue
          opened.rev = p.toRev
          opened.unresolved = true
          opened.resolveOutcome = 'merge'
          if (p.toRev === known.rev) {
            delete known.haveRev
            delete known.haveContent
          } else {
            known.haveRev = p.toRev
            known.haveContent = contentAt(known, p.toRev)
          }
          lines.push(`${p.depotFile}#${p.toRev} - is opened and not being changed`)
          lines.push(`... ${p.depotFile} - must resolve #${p.toRev} before submitting`)
          continue
        }
        writeSync(state, p)
        const verb =
          p.action === 'added'
            ? 'added as'
            : p.action === 'refreshing'
              ? 'refreshing'
              : 'updated as'
        lines.push(`${p.depotFile}#${p.toRev} - ${verb} ${p.local}`)
      }
      if (lines.length === 0) {
        // §11.1/§11.3: an all-up-to-date sync reports on stderr with exit 0.
        const scope = targets.length > 0 ? scopes[0] : '//...'
        process.stderr.write(`${scope} - file(s) up-to-date.\n`)
      } else {
        process.stdout.write(lines.join('\n') + '\n')
      }
      saveState(state)
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
      // Real reconcile: open each discovered target for its action, into the
      // changelist named by `-c` (default when absent).
      const into = argAfter(rest, '-c') ?? 'default'
      for (const t of targets) {
        state.opened[t.depotFile] = {
          action: t.action,
          change: into,
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

    case 'clean': {
      // `clean -a -e -d <targets>`: discard working-tree drift for not-opened
      // files — delete disk-adds, restore disk-deletes, revert disk-edits to the
      // have revision. Mirrors real `p4 clean` on the reconcile candidates.
      const discovered = computeReconcile(state)
      const targets = targetsFromArgs(state, rest, discovered)
      const records = []
      for (const t of targets) {
        const abs = clientOf(state, t.depotFile)
        if (t.action === 'add') {
          // Added on disk, not in depot → remove it.
          try {
            rmSync(abs)
          } catch {
            /* already gone */
          }
        } else {
          // Edited or deleted on disk → rewrite have-revision content back.
          const known = state.files[t.depotFile]
          if (known) {
            mkdirSync(dirname(abs), { recursive: true })
            writeFileSync(abs, known.content)
          }
        }
        records.push({ depotFile: t.depotFile, clientFile: t.clientFile, action: t.action })
      }
      saveState(state)
      emit(records)
      return 0
    }

    case 'change': {
      // `change -i` (create/update from a spec on stdin), `change -o <id>` (emit a
      // spec), or `change -d <id>` (delete an empty pending changelist).
      if (rest.includes('-d')) {
        const clId = argAfter(rest, '-d')
        if (clId && state.changelists[clId]) {
          // Real p4 refuses if files are still open in it.
          const hasOpen = Object.values(state.opened).some((o) => o.change === clId)
          if (hasOpen) {
            process.stderr.write(
              `Change ${clId} has ${Object.keys(state.opened).length} open file(s) and can't be deleted.\n`,
            )
            return 1
          }
          delete state.changelists[clId]
          delete state.shelved[clId]
          saveState(state)
          process.stdout.write(`Change ${clId} deleted.\n`)
        }
        return 0
      }
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

    case 'resolve': {
      // §6 (PROBE-FINDINGS): "no file(s) to resolve." on **stdout with exit 0**.
      // `-am` exits 0 even when files are left unresolved — the silent-failure
      // trap this fixture must reproduce — with a transcript that mixes landed
      // (`- copy from`) and skipped (`resolve skipped`) lines.
      const dryRun = rest.includes('-n')
      const acceptYours = rest.includes('-ay')
      const acceptTheirs = rest.includes('-at')
      const cl = argAfter(rest, '-c')
      const files = rest.filter((a, idx) => {
        if (a.startsWith('-')) return false
        const prev = rest[idx - 1]
        return prev !== '-c'
      })
      const pending = Object.entries(state.opened).filter(([depotFile, o]) => {
        if (!o.unresolved) return false
        if (cl !== undefined && o.change !== cl) return false
        // A bare `//...` filespec means the whole client view, like real p4
        // (`resolve -n //...` lists every needs-resolve file).
        if (files.some((f) => f === '//...' || f === `${state.depotPrefix}/...`)) return true
        return files.length === 0 || files.some((f) => toDepotFile(state, f) === depotFile)
      })
      if (pending.length === 0) {
        process.stdout.write(`${files[0] ?? '//...'} - no file(s) to resolve.\n`)
        return 0
      }
      const lines = []
      for (const [depotFile, o] of pending) {
        const known = state.files[depotFile]
        // A needs-resolve entry can be open-for-add (no depot revision yet).
        const headRev = known ? headRevOf(known) : o.rev
        const local = clientOf(state, depotFile)
        lines.push(`${toPosix(local)} - merging ${depotFile}#${headRev}`)
        if (dryRun) continue // predict only, touch nothing
        if (o.resolveOutcome === 'conflict' && !acceptYours && !acceptTheirs) {
          // -am leaves genuine conflicts open — and still exits 0.
          lines.push('Diff chunks: 0 yours + 0 theirs + 0 both + 2 conflicting')
          lines.push(`${depotFile} - resolve skipped.`)
          continue
        }
        // Landed (auto-merge, or -ay/-at picking a side): the merged content is
        // the incoming head — the fake has no 3-way merge engine.
        if (acceptTheirs && known) writeFileSync(local, contentAt(known, headRev))
        else if (known && !acceptYours) writeFileSync(local, contentAt(known, headRev))
        delete o.unresolved
        delete o.resolveOutcome
        lines.push('Diff chunks: 2 yours + 3 theirs + 0 both + 0 conflicting')
        // §11.4: the landed line differs by strategy on the real server —
        // `-am` auto-merge reports `- merge from`, accepting a side reports
        // `- ignored` (yours) / `- copy from` (theirs).
        lines.push(
          acceptYours
            ? `${depotFile} - ignored ${depotFile}`
            : acceptTheirs
              ? `${depotFile} - copy from ${depotFile}`
              : `${depotFile} - merge from ${depotFile}`,
        )
      }
      saveState(state)
      process.stdout.write(lines.join('\n') + '\n')
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
        if (o.change === clId) {
          // Snapshot the current working-tree content so a shelved diff has real
          // content (real p4 stores the shelved file revision server-side).
          let content
          try {
            content = readFileSync(clientOf(state, depotFile), 'utf8')
          } catch {
            content = undefined
          }
          state.shelved[clId][depotFile] = {
            action: o.action,
            rev: o.rev,
            ...(content !== undefined ? { content } : {}),
          }
        }
      }
      saveState(state)
      return 0
    }

    case 'unshelve': {
      // Restore a shelf (`unshelve -s <src> [-f] [file...]`): real p4 copies the
      // shelved revisions over the local files and opens them in the default
      // changelist. With trailing file args it only unshelves those files.
      // Fault injection: state.unshelveRefuse lists depotFiles p4 must refuse
      // (already open / stale base) — each is rejected with a stderr reason and
      // exit 1, which is exactly how the extension's per-file retry decides what
      // lands in `skipped`.
      const src = argAfter(rest, '-s')
      if (!src) return 1
      // A submitted change has no shelf — real p4 refuses with "already
      // committed" (the approved-review Apply-to-Local case, which the
      // extension answers with the print fallback).
      if (state.submitted?.[src]) {
        process.stderr.write(`Change ${src} is already committed.\n`)
        return 1
      }
      const shelf = state.shelved[src]
      if (!shelf) {
        process.stderr.write(`Change ${src} - no shelved files.\n`)
        return 1
      }
      const refuse = new Set(state.unshelveRefuse ?? [])
      // Trailing file args (no leading '-'), excluding the `-s` value.
      const files = rest.filter((a) => !a.startsWith('-') && a !== src)
      const entries =
        files.length > 0
          ? files.map((f) => toDepotFile(state, f)).filter((f) => shelf[f])
          : Object.keys(shelf)
      if (entries.length === 0) {
        process.stderr.write(`Change ${src} - no such file(s).\n`)
        return 1
      }
      const refused = entries.filter((f) => refuse.has(f))
      if (refused.length > 0) {
        for (const f of refused) {
          process.stderr.write(`${f} - already opened on this client; unshelve refused.\n`)
        }
        return 1
      }
      const records = []
      for (const depotFile of entries) {
        const s = shelf[depotFile]
        if (s.content !== undefined) {
          const abs = clientOf(state, depotFile)
          mkdirSync(dirname(abs), { recursive: true })
          writeFileSync(abs, s.content)
        }
        state.opened[depotFile] = { action: s.action, change: 'default', rev: s.rev }
        records.push({
          depotFile,
          clientFile: clientSyntaxOf(state, depotFile),
          action: s.action,
          change: 'default',
        })
      }
      saveState(state)
      emit(records)
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

// The consumer may die mid-read (watchdog kill); a broken pipe must not surface
// as a crash — just stop.
process.stdout.on('error', () => process.exit(process.exitCode ?? 0))

try {
  // NOT process.exit(main()): on POSIX, pipe writes are asynchronous, and exit()
  // discards whatever stdout hasn't flushed yet — a >64KB `print` payload gets
  // silently truncated under CI load (Windows pipe writes are synchronous, so the
  // bug never reproduces locally). Setting exitCode lets the process drain stdout
  // and exit naturally once the event loop empties (no other live handles here:
  // stdin is read via readFileSync(0), no timers/servers).
  process.exitCode = main()
} catch (err) {
  process.stderr.write(`fake-p4: ${err instanceof Error ? err.stack : String(err)}\n`)
  process.exitCode = 1
}
