/**
 * Perforce extension entry. Discovers the Perforce client (workspace) for the
 * open folder, surfaces it through the SCM API (default + numbered changelist
 * groups driven by `p4 opened` / `p4 changes`), and wires the read-only Phase-1
 * commands (refresh / login / logout / show output / open change). Mutating
 * operations arrive in later phases.
 *
 * `activate` runs inside the extension host process; as a first-party (trusted)
 * extension it may spawn the `p4` CLI directly, exactly like the git extension
 * spawns `git`. Everything is registered on `context.subscriptions`.
 */
import {
  commands,
  workspace,
  window,
  ProgressLocation,
  FileType,
  RelativePattern,
  type Disposable,
  type ExtensionContext,
} from '@universe-editor/extension-api'
import type {
  P4GraphChangeDto,
  P4GraphHaveChangeOptions,
  P4GraphHaveChangeResult,
  P4GraphLoadOptions,
  P4GraphLoadResult,
  P4GraphChangeDetailsDto,
  P4GraphChangeDetailsOptions,
  P4GraphFileChangeDto,
  P4GraphSyncRequest,
  P4GraphSyncScopeDto,
  P4GraphSyncPoint,
  WorkingTreeChangeDto,
} from '@universe-editor/extensions-common'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConcurrencyGate } from './concurrency.js'
import { resolveP4Command, setP4CommandTimeoutSeconds, type P4Connection } from './p4Service.js'
import { resolveP4deltaCommand } from './p4deltaService.js'
import { PerforceClient, SYNC_POINT_READBACK_SLOW_EXEC, type P4CacheOptions } from './client.js'
import type { SyncPreviewFile } from './syncParser.js'
import { P4CacheDisk } from './p4CacheDisk.js'
import { GraphSyncLedger, NO_REGRESSION } from './graphSyncLedger.js'
import { ExternalSyncPoints, saviorConfigPath } from './graphSyncExternal.js'
import { ClientManager } from './clientManager.js'
import { formatScanElapsed, P4StatusBarController } from './p4StatusBar.js'
import { AutoEditController } from './autoEdit.js'
import { notifyP4Failure, setP4OutputShower, isMissingCli } from './p4Error.js'
import {
  changelistIdFromGroupId,
  RECONCILE_GROUP_ID,
  RESOLVE_GROUP_ID,
  type P4Action,
} from './changelist.js'
import { statusFromAction, displayPath } from './p4GraphParser.js'
import {
  openGraphFileDiff,
  viewCommit as viewChangelist,
  type P4GraphFileDiffRequest,
} from './viewCommit.js'
import { norm, scopeKey, uriToFsPath } from './pathUtil.js'
import {
  noiseCoversTarget,
  planReconcileNoiseOperations,
  resolveReconcileExcludes,
  type ReconcileNoiseConfig,
  type ReconcileNoiseOperation,
} from './reconcileNoise.js'
import {
  classifyRevertTargets,
  formatRevertConfirm,
  knownChangelist,
  revertActionsOf,
  type RevertPlan,
} from './revertPlan.js'
import {
  buildForceGetFilespecs,
  buildScopeFilespec,
  buildSyncFilespecs,
  type SyncScopeTarget,
} from './p4Filespec.js'
import {
  clSpecOf,
  directSyncPoint,
  graphSyncConfirmKind,
  resolveCommonClient,
  syncFloorOf,
} from './graphSync.js'
import {
  effectiveSyncScope,
  forceConfirmMessage,
  scopeTextOf,
  syncPickItems,
  syncPromptOf,
  syncSpecOf,
} from './syncSpec.js'
import { resolveFocusScope } from './focusScope.js'
import { scopeTargets, scopeTargetsWithin } from './scope.js'
import { SCOPE_FILE_NAME } from './scopeConfig.js'
import { registerSwarmCommands } from './swarm/swarmCommands.js'
import { createSwarmLogger } from './swarm/swarmLog.js'
import { createPerforceTimelineCommands, PerforceTimelineProvider } from './timelineProvider.js'
import { switchClient, wireSwitchedClient } from './switchClient.js'
import { localize } from './nls.js'

/** The filesystem path an SCM or Explorer resource argument carries: SCM passes
 *  a bare `{ resourceUri }` string, the Explorer a `{ resource }` UriComponents
 *  (its `fsPath` getter is lost over RPC, so reconstruct from scheme + path). */
function resourcePath(arg: unknown): string | undefined {
  const a = arg as
    | { resourceUri?: string; resource?: { scheme?: string; path?: string } }
    | undefined
  if (a?.resourceUri) return a.resourceUri
  return a?.resource ? uriToFsPath(a.resource) : undefined
}

/** The changelist a group-scoped command targets, from the `scmResourceGroupId`
 *  the host attaches to group actions ('default' or `cl:<n>`). Returns
 *  `undefined` for the non-changelist groups (reconcile drift / resolve /
 *  shelved have no meaningful "whole changelist" to move or revert). */
function groupChangelistId(arg: unknown): string | undefined {
  const id = (arg as { scmResourceGroupId?: string } | undefined)?.scmResourceGroupId
  if (id === undefined || id === RECONCILE_GROUP_ID || id === RESOLVE_GROUP_ID) return undefined
  return changelistIdFromGroupId(id)
}

/** The `perforce.setActiveRepo` handler, exported as a test seam. `root == null`
 *  is on purpose: the renderer→host forwarding crosses a nested args array,
 *  where a sandwiched undefined arrives as null (documented platform
 *  convention, proxyChannel.ts) — null must mean "no selection" like undefined. */
export function handleSetActiveRepo(
  mgr: ClientManager,
  statusBar: P4StatusBarController,
  root: string | null | undefined,
): void {
  // null/undefined — or a root this extension doesn't own (the selection is a
  // git repo in a mixed workspace) — hides the status-bar entries.
  if (root == null || !mgr.has(root)) {
    statusBar.setVisible(false)
    return
  }
  // setActive before setVisible: setVisible(true) re-renders, so the new
  // active client must already be in place or it would paint the old one first.
  mgr.setActive(root)
  statusBar.setVisible(true)
}

/** Resolve the file a file-scoped command acts on: the resource's path when
 *  invoked from the SCM view (`{ resourceUri }`) or the explorer (`{ resource }`
 *  as a `UriComponents`), else the active editor's file (command-palette /
 *  editor-title entry points). */
async function resolveTargetPath(arg: unknown): Promise<string | undefined> {
  const fromResource = resourcePath(arg)
  if (fromResource) return fromResource
  return commands.executeCommand<string | undefined>('_workbench.getActiveEditorFile')
}

/** One entry of a multi-selection argument the host attaches to explorer/SCM
 *  commands, normalized to a filesystem path plus its directory-ness. */
export interface SelectionTarget {
  readonly path: string
  readonly isDirectory: boolean
}

/** Pull the resource entries out of a multi-selection argument (the second arg
 *  the host passes on explorer/SCM commands): each `{ resourceUri }` (SCM) or
 *  `{ resource, isDirectory }` (Explorer). Pure, so the multi-select fan-out is
 *  unit-testable without the command layer. Returns an empty array when the
 *  value isn't a non-empty selection array. */
export function selectionTargets(selection: unknown): SelectionTarget[] {
  if (!Array.isArray(selection)) return []
  return selection
    .map((entry) => {
      const path = resourcePath(entry)
      if (!path) return undefined
      const isDirectory = (entry as { isDirectory?: boolean } | undefined)?.isDirectory === true
      return { path, isDirectory }
    })
    .filter((t): t is SelectionTarget => t !== undefined)
}

/** The plain paths of a multi-selection argument (see {@link selectionTargets}). */
export function selectionPaths(selection: unknown): string[] {
  return selectionTargets(selection).map((t) => t.path)
}

/** 目录 Revert 的目标判定：选区恰好只有那一个目录，或无选区而 primary 是目录。
 *  Explorer 右键目录时菜单期总会把选区物化成 args[1] 且其中包含 primary 自身，
 *  所以「选区为空」在行右键上从不成立——必须先数 selection。但空区右键菜单
 *  （无 args[1]）与右键工作区根行（root 被过滤成空选区）仍会命中空选区形态，
 *  旧宿主同理；调用方须用 `selection[0]?.path ?? resolveTargetPath(args[0])`
 *  兜底取路径。SCM 文件夹行带的是子树文件 selection（会先被
 *  scmResourceGroupId 分支接住），多个目录属于多选合并路径，两者都不在此判定内。 */
export function isRevertDirectoryTarget(
  selection: readonly SelectionTarget[],
  arg0IsDirectory: boolean,
): boolean {
  return selection.length === 0
    ? arg0IsDirectory
    : selection.length === 1 && selection[0]!.isDirectory
}

/** Expand directory entries in a target list to p4's recursive `<dir>/...`
 *  filespec. Pure, so the directory fan-out is unit-testable. */
export function expandDirectoryTargets(
  paths: readonly string[],
  dirPaths: ReadonlySet<string>,
): string[] {
  return paths.map((p) => (dirPaths.has(p) ? `${p.replace(/[/\\]+$/, '')}/...` : p))
}

/** The single sync target behind an Explorer/editor invocation. Directory-ness
 *  decides both the filespec shape and — when the get is refused — how the
 *  collect scope carves around excluded folders, so the two must be derived
 *  from one value rather than read twice. */
export function singleSyncTarget(arg: unknown, path: string): SyncScopeTarget {
  return {
    path,
    isDirectory: (arg as { isDirectory?: boolean } | undefined)?.isDirectory === true,
  }
}

/** Whether a reconcile invocation should fan out over the multi-selection (one
 *  filespec per element) instead of the single primary target. SCM folder rows
 *  must NOT: their `selection` is the subtree's *opened* files, so enumerating
 *  it would silently drop anything p4 hasn't seen — the folder keeps its single
 *  recursive `<dir>/...` filespec. Pure, so the fork is unit-testable. */
export function reconcileUsesSelection(
  selection: readonly SelectionTarget[],
  arg0IsDirectory: boolean,
): boolean {
  return selection.length > 0 && (selection.some((t) => t.isDirectory) || !arg0IsDirectory)
}

/** Resolve every path a file-scoped command should act on. When the host runs
 *  an action on a multi-selection it passes the full selection as the second
 *  argument; otherwise this falls back to the single clicked/active path via
 *  {@link resolveTargetPath}. Directory entries are filtered out — file-level
 *  commands (`p4 edit/add/delete`) can't take bare directory paths; the one
 *  command that does want directories (reconcile) reads the selection via
 *  {@link selectionTargets} directly. */
async function resolveTargetPaths(args: readonly unknown[]): Promise<string[]> {
  const fromSelection = selectionTargets(args[1])
    .filter((t) => !t.isDirectory)
    .map((t) => t.path)
  if (fromSelection.length > 0) return fromSelection
  const single = await resolveTargetPath(args[0])
  return single ? [single] : []
}

async function readFallbackConnection(): Promise<P4Connection> {
  const cfg = workspace.getConfiguration('perforce')
  const port = await cfg.get('port', '')
  const user = await cfg.get('user', '')
  const client = await cfg.get('client', '')
  return {
    ...(port ? { port } : {}),
    ...(user ? { user } : {}),
    ...(client ? { client } : {}),
  }
}

/** Last path segment, for a quick-pick label that isn't a wall of directories. */
function displayName(path: string): string {
  return (
    path
      .replace(/[/\\]+$/, '')
      .split(/[/\\]/)
      .pop() ?? path
  )
}

/** The remedies a refused get offers, in the order they are presented.
 *
 *  Collecting first is the answer that loses nothing (p4 then schedules a
 *  resolve), so it leads; force-get destroys uncollected work and therefore
 *  comes after seeing the diff. Pure so the combinations stay covered by unit
 *  tests rather than by clicking through four kinds of refusal by hand. */
export type RefusedSyncButton = 'collect' | 'diff' | 'force' | 'resolve'

export function refusedSyncButtons(state: {
  refusedModified: number
  refusedOverwrite: number
  mustResolve: number
  /** False once this run already forced — a second force would refuse the same way. */
  allowForce: boolean
}): RefusedSyncButton[] {
  const out: RefusedSyncButton[] = []
  if (state.refusedModified > 0) {
    out.push('collect', 'diff')
    if (state.allowForce) out.push('force')
  } else if (state.refusedOverwrite > 0 && state.allowForce) {
    // An untracked orphan has no local modification to collect or diff — the
    // only remedy that moves it is a force get, so it is the only button.
    out.push('force')
  }
  if (state.mustResolve > 0) out.push('resolve')
  return out
}

/**
 * Confirm a `p4 sync -f`, the one get that destroys local work.
 *
 * A force can carry both destructiveness layers at once — it re-fetches files p4
 * believes are already current, overwriting writable local copies *and* moving
 * files that are not open for edit back or forward in time — so the body spells
 * out both rather than stacking two modals for a single click. Every force path
 * (the picker's forced rows, the post-refusal remedy, the graph rows) asks here,
 * and the remedy passes the very spec and scope the refused run used: a
 * confirmation never widens what the user already agreed to.
 *
 * `scopeText` names what is about to be re-fetched. It matters most when the
 * scope is the entire client (`//...`): seeing that in the dialog is the user's
 * only chance to notice the click re-transfers the world.
 */
async function confirmForceGet(spec: string, scopeText: string): Promise<boolean> {
  const BTN_FORCE = localize('perforce.btn.forceSync', 'Force Get')
  const confirm = await window.showWarningMessage(forceConfirmMessage(spec, scopeText), BTN_FORCE)
  return confirm === BTN_FORCE
}

/**
 * Per-file force-get: let the user check which refused files to overwrite,
 * then run `sync -f` scoped to exactly those files. Replaces the old
 * whole-scope `-f` re-run, which on a wide scope (e.g. `//...` on a game depot)
 * would re-transfer gigabytes for a handful of refused files — and silently
 * overwrite every other locally-modified file in that scope.
 *
 * The two refusal buckets are merged into one picker: `refusedFiles` (locally
 * modified, `labelColor: 'modified'`) and `refusedOverwriteFiles` (untracked
 * orphans, `labelColor: 'orphan'`). All items start checked; the user un-checks
 * what to keep. The title doubles as the confirmation (it spells out that the
 * checked files' local copies will be destroyed), so no second modal follows.
 *
 * Returns the filespecs to sync, or undefined when the user cancelled or
 * unchecked everything. Each filespec is `escapeFilespecPath(depotFile)#rev` —
 * the `#rev` pins the exact revision the run was refused on, so a `-f` sync
 * can never drift to a newer `#head` than the one the user just saw refused.
 */
async function pickForceGetFiles(
  refusedModified: readonly SyncPreviewFile[],
  refusedOverwrite: readonly SyncPreviewFile[],
): Promise<readonly string[] | undefined> {
  // `showQuickPick` returns the same item objects the caller passed in (the
  // wire round-trips an index, not the payload), so the extra `depotFile`/`rev`
  // fields ride along even though `QuickPickItem` doesn't declare them.
  const items = [
    ...refusedModified.map((f) => ({
      label: displayName(f.depotFile),
      description: `${f.depotFile}#${f.rev}`,
      picked: true,
      labelColor: 'modified',
      depotFile: f.depotFile,
      rev: f.rev,
    })),
    ...refusedOverwrite.map((f) => ({
      label: displayName(f.depotFile),
      description: `${f.depotFile}#${f.rev}`,
      picked: true,
      labelColor: 'orphan',
      depotFile: f.depotFile,
      rev: f.rev,
    })),
  ]
  if (items.length === 0) return undefined
  const picked = await window.showQuickPick(items, {
    canPickMany: true,
    title: localize(
      'perforce.sync.forcePickTitle',
      'Force-get overwrites the checked files with the depot version. Uncollected local changes and untracked placeholder files will be lost, and cannot be undone. (Yellow = locally modified, purple = untracked same-name file)',
    ),
    okLabel: localize('perforce.sync.forcePickOk', 'Force Get Selected ({0})'),
  })
  if (picked === undefined || picked.length === 0) return undefined
  return buildForceGetFilespecs(picked)
}

/**
 * The ways P4V lets you name a revision, as a quick-pick — each offered plain
 * and forced. Returns the p4 revision suffix to append to each filespec plus
 * whether this run must force, or undefined when cancelled.
 *
 * The rows come from `syncSpec.ts` (pure, unit-tested); this only drives the
 * dialogs. A forced row asks the same value prompt its plain twin does — the
 * only difference downstream is the confirmation and the `-f`.
 */
async function pickSyncSpec(): Promise<{ spec: string; force: boolean } | undefined> {
  const choice = await window.showQuickPick(syncPickItems(), {
    placeHolder: localize(
      'perforce.syncPick.placeholder',
      'Which revision do you want? (Red rows force-get and overwrite local files.)',
    ),
  })
  if (!choice) return undefined
  const ask = syncPromptOf(choice.kind)
  const spec = syncSpecOf(choice.kind, ask ? await window.showInputBox(ask) : undefined)
  if (spec === undefined) return undefined
  return { spec, force: choice.force }
}

/**
 * Floor between two progress reports during a sync. p4 emits one stdout line
 * per file, so an unthrottled bridge would push thousands of RPC messages at
 * the renderer for updates no eye can follow.
 */
const PROGRESS_REPORT_INTERVAL_MS = 150

/**
 * Where a get is known to have landed without asking p4 — the row's changelist.
 * `directSyncPoint` is the only producer: it decides this against the listing
 * scope the renderer echoed back, and consuming that scope is what the judgment
 * IS, so nothing but the answer needs to travel further.
 */
interface KnownLanding {
  readonly change: string
}

/**
 * The δ engine decision for one session, from the two `perforce.p4delta.*`
 * settings: the executable (plus the env it must carry) to hand the client, or
 * undefined when every scan must run on p4.
 *
 * Read here (not in the client) because this is where workspace configuration
 * lives — the client only ever receives an already admitted executable. Every
 * refusal is a log line and nothing else: the engine is an optimization, so a
 * machine without it must not be interrupted about one, and the native scan is
 * a complete answer either way.
 *
 * `enabled: false` short-circuits before ANY lookup. A resolved path that is
 * not there is refused here too (one `existsSync` — the binary is never
 * version-checked), so the client never gets an executable it would only fail
 * on.
 *
 * The p4-script hedge: δ hands files it cannot digest over to `p4`, and it
 * resolves that `p4` on its own. Under a `UNIVERSE_P4_PATH` script override (the
 * e2e fake, an escape hatch) the engine's own lookup would land on a DIFFERENT
 * p4 than this session's, so the conservative default is to stay native. The
 * exception is a session where δ was named explicitly — `UNIVERSE_P4DELTA_PATH`
 * or `perforce.p4delta.path` — because that is an operator saying "this pair is
 * mine": δ is enabled there and told which p4 to hand off to (`P4_EXE`, from
 * `resolveP4Command` — the script itself, since that is the only form this
 * session's p4 exists in). It maps to the e2e fixture, which fakes both engines
 * over one shared depot state.
 *
 * Exported for the configuration-gate tests; `activate` is the only production
 * caller.
 */
export function resolveP4deltaEngine(
  settings: { readonly enabled: boolean; readonly path: string },
  log: (msg: string) => void,
): { exe: string; extraEnv?: Readonly<Record<string, string>> } | undefined {
  if (!settings.enabled) {
    log('[perforce] p4delta disabled via perforce.p4delta.enabled; using p4')
    return undefined
  }
  const p4 = resolveP4Command()
  const p4IsScript = p4.prefixArgs.length > 0
  // "Named explicitly" is about what the CALLER said, not about what the lookup
  // returned: a path found on PATH is a machine with δ installed, not a
  // configured engine. Empty string is the setting's default (same rule
  // resolveP4deltaCommand uses).
  const deltaNamed = Boolean(process.env.UNIVERSE_P4DELTA_PATH) || settings.path !== ''
  if (p4IsScript && !deltaNamed) {
    log('[perforce] p4delta skipped: p4 resolves to a script override; using p4')
    return undefined
  }
  const exe = resolveP4deltaCommand(settings.path)
  if (exe === undefined) {
    log('[perforce] p4delta not found; using p4')
    return undefined
  }
  if (!existsSync(exe)) {
    // The whole admission test, now that no version gate exists: the file has
    // to be there. A build on this path is taken as able to drive the entire
    // surface this extension uses — a wrong or half-installed binary is left to
    // the client's own failure ladder, which falls back within the round and
    // disarms after three.
    log(`[perforce] p4delta not found at ${exe}; using p4`)
    return undefined
  }
  log(`[perforce] p4delta engine: ${exe}`)
  // Only a script override needs the pointer: a plain `p4` is what δ's own
  // lookup would find too, and forcing `P4_EXE=p4` would make δ require a FILE
  // by that name instead.
  const extraEnv = p4IsScript ? { P4_EXE: p4.prefixArgs[0] ?? p4.command } : undefined
  return { exe, ...(extraEnv !== undefined ? { extraEnv } : {}) }
}

export async function activate(context: ExtensionContext): Promise<void> {
  const root = workspace.rootPath
  if (!root) {
    console.info('[perforce] no workspace folder open; perforce source control disabled')
    return
  }

  const cfg = workspace.getConfiguration('perforce')
  if (!(await cfg.get('enabled', true))) {
    console.error('[perforce] disabled via perforce.enabled')
    return
  }

  const out = window.createOutputChannel('Perforce')
  context.subscriptions.push(out)
  const log = (msg: string): void => out.appendLine(msg)
  setP4OutputShower(() => out.show())

  /** The whole selection sits inside the daily scope's exclusions, so there is
   *  nothing to run p4 on. */
  const notifyAllExcluded = async (): Promise<void> => {
    await window.showInformationMessage(
      localize(
        'perforce.reconcile.allExcluded',
        'The selected paths are outside the workspace scope, or hidden by the exclusions in force.',
      ),
    )
  }

  /** What the scope gate below decided: run the operation (with or without the
   *  override), or do not run it at all. */
  type ScopeGateDecision =
    | {
        readonly ok: true
        readonly override: boolean
        readonly targets: readonly SyncScopeTarget[]
      }
    | { readonly ok: false }

  /**
   * The gate every EXPLICIT operation passes before it reaches p4 or δ: the
   * paths the user named are checked against the daily scope, and anything the
   * scope does not cover whole is put to the user.
   *
   * The three answers are the whole point — a silent trim is exactly what this
   * exists to prevent:
   * - everything covered → run as asked (the common case, no dialog);
   * - something outside → a dialog naming it, offering "obey the daily scope"
   *   (drop the uncovered targets; if that leaves nothing, the operation is NOT
   *   run — an empty range is a different operation, not a smaller one) or "run
   *   them as chosen" (the client's scope override, good for this call only);
   * - the scope is unusable (a config that cannot be resolved) → refused with
   *   the reason: the editor does not know the range, so it cannot say the
   *   targets are safe.
   *
   * The override is the ONLY way past the client's own fail-closed check, and it
   * is never inferred: it is produced here, by a button the user pressed.
   */
  const confirmScopeTargets = async (
    client: PerforceClient,
    targets: readonly SyncScopeTarget[],
    what: string,
  ): Promise<ScopeGateDecision> => {
    if (targets.length === 0) return { ok: true, override: false, targets }
    const check = await client.checkScopeTargets(targets)
    if (check.outside.length === 0) return { ok: true, override: false, targets }
    if (check.state !== 'ready') {
      await window.showWarningMessage(
        localize(
          'perforce.scope.unusable',
          '{0} was not run: the workspace scope is not usable. {1}',
          {
            0: what,
            1:
              check.reason ??
              localize('perforce.scope.unusableReason', 'Open the workspace scope file to fix it.'),
          },
        ),
      )
      return { ok: false }
    }
    const outsideText = scopeTextOf(check.outside.map((t) => t.path))
    const BTN_OBEY = localize('perforce.scope.btn.obey', 'Use the workspace scope')
    const BTN_RUN = localize('perforce.scope.btn.run', 'Run as chosen')
    const picked = await window.showWarningMessage(
      localize(
        'perforce.scope.outsideTargets',
        '{0} includes paths the workspace scope does not cover: {1}. They were named explicitly, so nothing was trimmed silently — choose what to do.',
        { 0: what, 1: outsideText },
      ),
      BTN_OBEY,
      BTN_RUN,
    )
    if (picked === BTN_RUN) {
      log(`[perforce] scope override confirmed for ${what}: ${outsideText}`)
      return { ok: true, override: true, targets }
    }
    if (picked === BTN_OBEY) {
      if (check.inside.length === 0) {
        await notifyAllExcluded()
        return { ok: false }
      }
      log(
        `[perforce] ${what}: narrowed to the workspace scope, dropping ${check.outside.length} target(s)`,
      )
      return { ok: true, override: false, targets: check.inside }
    }
    return { ok: false }
  }

  type NoiseGateDecision =
    | {
        readonly ok: true
        readonly operations: readonly ReconcileNoiseOperation[]
        /** Whether the answer DROPPED targets ("skip them") — the destructive
         *  confirm below must not keep promising to discard them. */
        readonly skipped: boolean
      }
    | { readonly ok: false }

  /**
   * The noise gate — `confirmScopeTargets`' sibling for
   * `perforce.reconcile.excludeFolders`. A target the setting covers is put to
   * the user, never trimmed silently; what comes back is the LIST of operations
   * to run, each carrying its own confirmedTargets (see
   * `planReconcileNoiseOperations`). "Run as chosen" lifts only the rules
   * covering the targets the user actually named, so a parent directory riding
   * along in the same selection keeps the noise over the subtree it shields.
   *
   * {@link confirmScopeTargets} answers about the SCOPE and this one about the
   * SETTING: confirming one never confirms the other.
   */
  const confirmNoiseTargets = async (
    targets: readonly SyncScopeTarget[],
    noise: ReconcileNoiseConfig,
    what: string,
  ): Promise<NoiseGateDecision> => {
    const covered = targets.filter((t) => noiseCoversTarget(noise, t))
    if (covered.length === 0) {
      const plan = planReconcileNoiseOperations(targets, noise)
      return plan === undefined ? { ok: false } : { ok: true, operations: plan, skipped: false }
    }
    const coveredText = scopeTextOf(covered.map((t) => t.path))
    const BTN_SKIP = localize('perforce.noise.btn.skip', 'Skip them')
    const BTN_RUN = localize('perforce.noise.btn.run', 'Run as chosen')
    const picked = await window.showWarningMessage(
      localize(
        'perforce.noise.coveredTargets',
        '{0} includes paths the reconcile exclusions hide: {1}. They were named explicitly, so nothing was trimmed silently — choose what to do.',
        { 0: what, 1: coveredText },
      ),
      BTN_SKIP,
      BTN_RUN,
    )
    if (picked !== BTN_SKIP && picked !== BTN_RUN) return { ok: false }
    if (picked === BTN_RUN) {
      log(`[perforce] reconcile exclusions lifted for ${what}: ${coveredText}`)
      const plan = planReconcileNoiseOperations(targets, noise, covered)
      return plan === undefined ? { ok: false } : { ok: true, operations: plan, skipped: false }
    }
    const coveredKeys = new Set(
      covered.map((t) => `${t.isDirectory ? 'd' : 'f'}:${scopeKey(t.path)}`),
    )
    log(`[perforce] reconcile exclusions hide ${coveredText} — skipped for ${what}`)
    const kept = targets.filter(
      (t) => !coveredKeys.has(`${t.isDirectory ? 'd' : 'f'}:${scopeKey(t.path)}`),
    )
    const plan = planReconcileNoiseOperations(kept, noise)
    if (plan === undefined) {
      await notifyAllExcluded()
      return { ok: false }
    }
    return { ok: true, operations: plan, skipped: true }
  }

  /**
   * Run ONE collect operation — a target group plus the targets the user
   * authorized through the noise gate.
   *
   * The command layer hands over exactly what the user named and what they
   * answered: the raw targets, the targets they answered "run as chosen" for, and
   * the scope override when one was granted. It deliberately builds NO filespec
   * list and carries NO copy of the rules: δ and p4 need different shapes of the
   * same range, the engine that runs is not known until the write starts, and the
   * exclusions in force are the ones in force THEN — a rule set read here would
   * be a frozen reading of a setting the user can still edit while the dialog is
   * up (and it would override the newer reading, which is how a freshly added
   * exclusion used to be ignored by the run it was added for).
   *
   * `overrideScope` is the SCOPE confirmation the user granted: it sets the
   * scope's own exclusions aside (the collect runs as named), while the noise
   * keeps applying — the two confirmations are independent, and a scope
   * override never lifts a noise rule the user did not name.
   */
  const runCollectOperation = async (
    client: PerforceClient,
    op: ReconcileNoiseOperation,
    options?: { readonly overrideScope?: boolean; readonly changelist?: string },
  ): Promise<void> => {
    const runOptions = {
      ...(op.confirmedTargets.length > 0 ? { confirmedTargets: op.confirmedTargets } : {}),
      ...(options?.overrideScope === true ? { overrideScope: true } : {}),
    }
    const range = { targets: op.targets }
    if (options?.changelist !== undefined) {
      await client.reconcileInto(options.changelist, range, runOptions)
      return
    }
    await client.reconcile(range, runOptions)
  }

  /** A gated collect, ready to run: the operations the user's answer left.
   *  Held across a dialog by call sites that create a changelist first (see
   *  `perforce.reconcileIntoNewChangelist`) so the same authorization — never a
   *  frozen rule set — covers the whole gap. */
  interface CollectPlan {
    readonly operations: readonly ReconcileNoiseOperation[]
    /** Whether the gate dropped targets the caller's own display still shows. */
    readonly skipped: boolean
  }

  /**
   * Read the rules in force and gate the targets, without running anything.
   *
   * `explicit` targets are the user's own selection: one the reconcile
   * exclusions cover is put to them (never trimmed silently). A `discovery`
   * range — the daily scope, a drift group's own rows — is pruned silently:
   * those rows are the editor's answer to "what is left to collect", not a
   * selection to interrogate, and a prompt per collect would be noise of its
   * own.
   *
   * The reading here is the GATE's — which targets the setting covers, and what
   * the user answered about them. What the gate produces is the split into
   * groups plus the targets the user authorized; the rules themselves are read
   * again at the write, so a setting edited while the dialog is up is obeyed
   * rather than overridden by the copy this dialog showed.
   */
  const planCollect = async (
    client: PerforceClient,
    targets: readonly SyncScopeTarget[],
    what: string,
    mode: 'explicit' | 'discovery',
  ): Promise<CollectPlan | undefined> => {
    const noise = client.reconcileNoise
    if (mode === 'discovery') {
      const operations = planReconcileNoiseOperations(targets, noise)
      if (operations === undefined) {
        await notifyAllExcluded()
        return undefined
      }
      return { operations, skipped: false }
    }
    const gate = await confirmNoiseTargets(targets, noise, what)
    if (!gate.ok) return undefined
    return { operations: gate.operations, skipped: gate.skipped }
  }

  const runCollectPlan = async (
    client: PerforceClient,
    plan: CollectPlan,
    options?: { readonly overrideScope?: boolean; readonly changelist?: string },
  ): Promise<void> => {
    for (const op of plan.operations) {
      await runCollectOperation(client, op, options)
    }
  }

  /** Gate and run in one step, for the call sites with nothing in between. */
  const runCollect = async (
    client: PerforceClient,
    targets: readonly SyncScopeTarget[],
    what: string,
    mode: 'explicit' | 'discovery',
    options?: { readonly overrideScope?: boolean; readonly changelist?: string },
  ): Promise<void> => {
    const plan = await planCollect(client, targets, what, mode)
    if (plan === undefined) return
    await runCollectPlan(client, plan, options)
  }

  const maxConcurrent = await cfg.get('maxConcurrent', 4)
  const gate = new ConcurrencyGate(maxConcurrent)
  // Bounds "hung forever", not "slow": a p4 stuck on a frozen network drive /
  // half-open gateway TCP holds its gate slot until killed (the poll wedge).
  setP4CommandTimeoutSeconds(await cfg.get('commandTimeout', 600))
  // `maxConcurrent` was read once above; keep the gate's cap in sync so a change
  // applies without a reload (the background reserve is derived from it).
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('perforce.maxConcurrent')) return
      void cfg.get('maxConcurrent', 4).then((n) => gate.setMax(n))
    }),
  )
  const fallback = await readFallbackConnection()

  // Result caching (server round-trips are expensive). Immutable data (submitted
  // changes, specific revisions) can persist across sessions under the extension's
  // globalStoragePath; mutable workspace state uses a short TTL + post-mutation
  // invalidation. All knobs live under `perforce.cache.*`.
  const cacheEnabled = await cfg.get('cache.enabled', true)
  const workspaceTtlMs = await cfg.get('cache.workspaceTtl', 4000)
  const diskLimitMb = await cfg.get('cache.diskLimitMb', 50)
  const disk =
    cacheEnabled && context.globalStoragePath
      ? P4CacheDisk.open(context.globalStoragePath, diskLimitMb * 1024 * 1024, Date.now, log)
      : undefined
  const cacheOptions: P4CacheOptions = {
    enabled: cacheEnabled,
    workspaceTtlMs,
    ...(disk ? { disk } : {}),
  }

  // The graph's sync ledger: which scope each get landed where, so the "Synced"
  // badge costs zero p4 calls instead of one `#have` query per load. Kept out of
  // the cache configuration on purpose — it is a record of what happened, not a
  // cache of what the server said, so `perforce.cache.enabled` must not erase
  // it. Under `globalStoragePath` so every window of this install shares it, and
  // never inside the p4 workspace (that would put editor state in a colleague's
  // sync and per-workspace bookkeeping in a shared tree).
  const ledger = context.globalStoragePath
    ? GraphSyncLedger.open(context.globalStoragePath, log)
    : undefined

  // What the OTHER tools on this machine pulled (the savior helper's own config
  // under the user's home, and UGS's state file inside the workspace). Read-only
  // and independent of `globalStoragePath`: a workspace pulled by one of them
  // must not read as "never synced" just because this editor was not the one
  // that ran the get. See `graphSyncExternal.ts`.
  const externalSyncPoints = ExternalSyncPoints.open(saviorConfigPath(process.env, homedir()), log)

  // The δ engine (`perforce.p4delta.*`): resolved once here and handed to every
  // client built this session, together with the env the engine has to carry
  // (`P4_EXE` when this session's p4 is a script override).
  const resolveP4deltaOptions = async (): Promise<
    { exe: string; extraEnv?: Readonly<Record<string, string>> } | undefined
  > =>
    resolveP4deltaEngine(
      {
        enabled: await cfg.get('p4delta.enabled', true),
        path: await cfg.get('p4delta.path', ''),
      },
      log,
    )

  /** Shared by both client construction points (the initial one below and the
   *  workspace switch command), and refreshed by the config subscription so a
   *  newly built client inherits the current decision. */
  let p4deltaOptions = await resolveP4deltaOptions()

  // Probe for a p4 CLI + a client for this folder. A missing binary or a folder
  // outside any Perforce workspace disables the provider without crashing.
  let client: PerforceClient | undefined
  try {
    client = await PerforceClient.create(root, fallback, gate, cacheOptions, {
      log,
      watchRoot: root,
      // The OPENED folder, which need not be the client root: the daily scope is
      // resolved inside it, and every daily operation is bounded by it.
      workspaceRoot: root,
      createFileSystemWatcher: (glob) => workspace.createFileSystemWatcher(glob),
      ...(p4deltaOptions !== undefined ? { p4delta: p4deltaOptions } : {}),
    })
  } catch (err) {
    if (isMissingCli(err)) {
      console.info('[perforce] p4 CLI not found; perforce source control disabled')
    } else {
      console.error('[perforce] client discovery failed', err)
    }
    return
  }
  if (!client) {
    console.info(`[perforce] no Perforce workspace for ${root}; source control disabled`)
    return
  }

  const mgr = new ClientManager()
  context.subscriptions.push(mgr)
  mgr.add(client)

  // Ignore-rule capability (host addresses this as `<providerId>.checkIgnore`),
  // registered HERE and not with the other runtime commands far below —
  // deliberately, and this ordering is the whole point:
  //
  // `PerforceClient.create` already published the SourceControl, so from that
  // moment the host's `ScmIgnoredResourcesService` routes ignore lookups to
  // `perforce.checkIgnore`. A lookup that lands before the command exists reads
  // `undefined` and the host caches "not ignored" for that whole batch —
  // permanently, since nothing invalidates again until the workspace changes or
  // an ignore-rule file is saved. Registering it with the rest of the commands
  // leaves several `await`s of window for exactly that (the host's batch debounce
  // is only 150ms), so it goes in the first synchronous slot after the manager
  // exists. The other capabilities tolerate the window because their consumers
  // re-query; this one does not.
  context.subscriptions.push(
    commands.registerCommand('perforce.checkIgnore', async (...args: unknown[]) => {
      const paths = Array.isArray(args[0]) ? (args[0] as string[]) : []
      if (paths.length === 0) return []
      // Data query, not command routing: group by the containing client via
      // `resolveContaining` (no active fallback), dropping paths outside every
      // root — mirrors git's `if (!repo) continue`.
      const byClient = new Map<PerforceClient, string[]>()
      for (const p of paths) {
        const owner = mgr.resolveContaining(p)
        if (!owner) continue
        const list = byClient.get(owner)
        if (list) list.push(p)
        else byClient.set(owner, [p])
      }
      const ignored: string[] = []
      for (const [owner, list] of byClient) {
        ignored.push(...(await owner.checkIgnore(list)))
      }
      return ignored
    }),
  )

  // Timeline — per-file revision history (p4 filelog) for the Explorer Timeline
  // view, the Perforce counterpart of the git extension's provider.
  const timelineProvider = new PerforceTimelineProvider(mgr, log)
  context.subscriptions.push(timelineProvider.trackClient(client))
  context.subscriptions.push(workspace.registerTimelineProvider(['file'], timelineProvider))
  // The sync runner forwards to `runSync` (declared below) for its progress
  // bar / cancellation / refusal remedies. The lambda only runs when the
  // command fires, so the later declaration is never a TDZ problem.
  context.subscriptions.push(
    ...createPerforceTimelineCommands(mgr, log, (target, spec, targets) =>
      runSync(target, spec, {
        scope: targets.map((t) => buildScopeFilespec(t.path, t.isDirectory)),
        scopeTargets: targets,
        ledgerScope: targets,
      }),
    ),
  )

  const statusBar = new P4StatusBarController(mgr)
  context.subscriptions.push(statusBar)
  statusBar.refresh()

  // Reconcile scope: the workspace focus folders when focus is enabled and
  // non-empty, else the opened folder — so a huge depot is never walked as
  // `//...`. This bounds the Explorer working-tree hint channel
  // (`checkWorkingTree`); SCM operations stay whole-client.
  //
  // Focus entries are split by what they resolve to ON DISK: a directory joins
  // the recursive scan scope, a single file joins a per-file narrow query scope
  // (`setReconcileScope`'s second bucket) that is re-verified fresh every
  // session and never checkpointed. Treating a file as a directory would build
  // the filespec `<file>/...` — a no-such-file p4 answers as clean (exit 0,
  // empty) — and checkpointing that empty answer would pin the file's drift
  // verdict forever. `scopeApplySeq` makes a later config apply win over an
  // earlier one still awaiting its stats (the stat round-trips are async, so
  // two rapid config events could otherwise resolve out of order).
  let scopeApplySeq = 0
  const applyReconcileScope = async (target: PerforceClient): Promise<void> => {
    const seq = ++scopeApplySeq
    const scopeCfg = workspace.getConfiguration('workspace')
    const enabled = await scopeCfg.get('focusEnabled', false)
    const folders = await scopeCfg.get<Record<string, unknown>>('focusFolders', {})
    const { dirs, files } = await resolveFocusScope({ enabled, folders }, root, async (p) => {
      try {
        const s = await workspace.fs.stat(p)
        return { isDirectory: s.type === FileType.Directory }
      } catch {
        return undefined // missing / unreadable — kept in `files` (see resolveFocusScope)
      }
    })
    // A later apply already superseded this one; drop the stale resolution.
    if (seq !== scopeApplySeq) return
    // `scoped` is true whenever ANY focus entry survived — dirs or files. Only
    // then does the scope narrow; with zero surviving entries (focus disabled
    // or every entry dropped) fall back to the opened folder so the hint
    // channel keeps its old whole-folder behaviour. Critically, a focus of ONLY
    // files yields dirs=[] files=[…]: the client must see that narrow file-only
    // scope (`_isInReconcileScope` then matches by `isScopeFile`), not the whole
    // root — passing `root` here would defeat the very narrowing the user asked
    // for and re-walk the depot the focus was meant to avoid.
    const scoped = dirs.length > 0 || files.length > 0
    target.setReconcileScope(scoped ? dirs : root, scoped ? files : [])
    // NOTHING else follows the focus. The default get's range is the DAILY scope
    // (opened folder ∩ `.p4delta-scope`), resolved by `PerforceClient.refreshScope`
    // — the user's get must not follow what they happen to be looking at, and a
    // focus folder outside the declared scope must not silently widen it.
    log(
      `[perforce] reconcile focus: ${dirs.length} dirs, ${files.length} files` +
        (dirs.length === 0 && files.length === 0 ? ' (<opened folder>)' : ''),
    )
  }
  const applyReconcileScopeAll = async (): Promise<void> => {
    for (const c of mgr.all) await applyReconcileScope(c)
  }
  await applyReconcileScope(client)
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration('workspace.focusEnabled') &&
        !e.affectsConfiguration('workspace.focusFolders')
      ) {
        return
      }
      void applyReconcileScopeAll()
    }),
  )

  /**
   * Reconcile noise (`perforce.reconcile.excludeFolders`): folders the reconcile
   * machinery hides — automatic discovery, the uncollected-change hint, narrow
   * queries, and the unopened half of a collect / clean. Applied before the
   * first refresh so the scan the refresh tail schedules already honors it.
   *
   * Deliberately NOT a scope source: the daily scope (`.p4delta-scope`) remains
   * the only one, a get runs with noise applied by nobody, and editing this
   * setting does not invalidate a pending get preview. `noiseApplySeq` makes a
   * later config apply win over an earlier one still awaiting its stats — the
   * stat round-trips are async, so two rapid edits could otherwise land out of
   * order and leave the client hiding the wrong folders.
   */
  let noiseApplySeq = 0
  const applyReconcileExcludes = async (target: PerforceClient): Promise<void> => {
    const seq = ++noiseApplySeq
    const values = await cfg.get<string[]>('reconcile.excludeFolders', [])
    const noise = await resolveReconcileExcludes(values, root, async (p) => {
      try {
        const s = await workspace.fs.stat(p)
        return { isDirectory: s.type === FileType.Directory }
      } catch {
        return undefined // gone / unreadable — resolved as a folder (the setting names folders)
      }
    })
    if (seq !== noiseApplySeq) return
    target.setReconcileExcludes(noise)
    log(
      `[perforce] reconcile exclusions: ${noise.dirs.length} dir(s), ${noise.files.length} file(s)` +
        (noise.dirs.length === 0 && noise.files.length === 0 ? ' (<none>)' : ''),
    )
  }
  const applyReconcileExcludesAll = async (): Promise<void> => {
    for (const c of mgr.all) await applyReconcileExcludes(c)
  }
  await applyReconcileExcludes(client)
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      // The exact key, deliberately: `affectsConfiguration` in this host is an
      // exact match, so a section name (`perforce.reconcile`) would subscribe to
      // nothing at all.
      if (!e.affectsConfiguration('perforce.reconcile.excludeFolders')) return
      void applyReconcileExcludesAll()
    }),
  )

  /**
   * Parallel sync transfer (`p4 sync --parallel=threads=N`). Hot-applied like
   * `maxConcurrent` — a mid-edit change reaches the next sync without a reload.
   */
  const applySyncParallelThreads = async (target: PerforceClient): Promise<void> => {
    target.setSyncParallelThreads(await cfg.get('syncParallelThreads', 4))
  }
  for (const c of mgr.all) await applySyncParallelThreads(c)
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('perforce.syncParallelThreads')) return
      void (async () => {
        for (const c of mgr.all) await applySyncParallelThreads(c)
      })()
    }),
  )

  /**
   * Background reconcile scan: the per-directory batch ceiling that drives the
   * adaptive split. Applied before the first refresh so the scan the refresh
   * tail schedules already sees the configured ceiling.
   */
  const applyReconcileScanOptions = async (target: PerforceClient): Promise<void> => {
    const maxBatchDurationMs = await cfg.get('reconcileScan.maxBatchDurationMs', 10_000)
    target.setReconcileScanOptions({ maxBatchDurationMs })
  }
  const applyReconcileScanOptionsAll = async (): Promise<void> => {
    for (const c of mgr.all) await applyReconcileScanOptions(c)
  }
  await applyReconcileScanOptions(client)
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('perforce.reconcileScan')) return
      void applyReconcileScanOptionsAll()
    }),
  )

  /**
   * The δ engine: re-resolve both settings on any `perforce.p4delta.*` change
   * and hot-swap every live client, so turning the engine off (or pointing it at
   * another executable) applies to the next scan without a reload. A path that
   * no longer resolves is a log line and a switch to native — never an error
   * toast, and never a scan that silently reports nothing (the client falls
   * back within the round).
   */
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('perforce.p4delta')) return
      void (async () => {
        p4deltaOptions = await resolveP4deltaOptions()
        for (const c of mgr.all) {
          c.setP4delta(p4deltaOptions?.exe, p4deltaOptions?.extraEnv)
        }
      })()
    }),
  )

  /** Cap on rows in the "Changes" group (`perforce.reconcileLimit`). */
  const applyReconcileLimit = async (target: PerforceClient): Promise<void> => {
    target.setReconcileLimit(await cfg.get('reconcileLimit', 10_000))
  }
  await applyReconcileLimit(client)
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('perforce.reconcileLimit')) return
      void (async () => {
        for (const c of mgr.all) await applyReconcileLimit(c)
      })()
    }),
  )

  /**
   * The daily scope: the opened workspace ∩ the `.p4delta-scope` config that
   * `p4delta` resolves, read from the client so there is exactly ONE
   * implementation of the rules (config syntax, lookup chain, depot mapping).
   *
   * Applied before the first refresh, because everything the refresh tail
   * schedules — the background scan, the on-demand hint, the default get — is
   * bounded by it, and a client whose first round ran without a resolved scope
   * would answer from the wrong range. The exclusions the command layer
   * pre-checks against (`reconcileExcludeDirs`) come from the same resolution.
   */
  const applyDailyScope = async (target: PerforceClient): Promise<void> => {
    // `blocked` means the range is UNKNOWN, and everything the client answers
    // from an unknown range reads as "nothing to report" (no drift rows, no
    // hints, no collect). The notice therefore has to fire whenever the scope
    // BECOMES unusable — not only at activation: a `.p4delta-scope` edited into
    // a broken state changes the state mid-session, and a user never told would
    // read the resulting silence as "my workspace is clean". The client owns the
    // transition (it is the only place that knows the state changed, and it
    // re-arms the notice on recovery), this layer owns the wording.
    target.setScopeNoticeHandler((reason) => {
      log(`[perforce] scope: blocked — ${reason ?? 'unknown reason'}`)
      void window.showWarningMessage(
        localize(
          'perforce.scope.blockedNotice',
          'The workspace scope could not be resolved, so daily Perforce operations (discovery, collect, clean) are suspended: {0}',
          { 0: reason ?? '' },
        ).trim(),
      )
    })
    const state = await target.refreshScope()
    log(
      `[perforce] scope: ${state}` +
        (state === 'ready'
          ? ` — ${target.reconcileExcludeDirs.length} excluded dir(s), ${target.reconcileExcludeFiles.length} excluded file(s)`
          : target.scopeUnusableReason !== undefined
            ? ` — ${target.scopeUnusableReason}`
            : ''),
    )
  }
  await applyDailyScope(client)

  /**
   * Watch the ONE fixed location the config lives in, per client: `<client
   * root>/.p4delta-scope`. There is no lookup chain any more — the config
   * belongs to the client root and nowhere else — but the watcher still covers
   * creation, modification and deletion, because the editor has to notice a
   * config that appears where there was none and one removed while a range was
   * in force.
   *
   * `invalidateScope` drops the drift rows and the scan checkpoints of the old
   * range and re-arms the scan, so the next operation re-resolves — including
   * the background scan, which must not wait for a focus change to notice the
   * config moved.
   */
  const scopeWatchers: Disposable[] = []
  for (const c of mgr.all) {
    const watcher = workspace.createFileSystemWatcher(new RelativePattern(c.root, SCOPE_FILE_NAME))
    const onScopeFileEvent = (kind: string): void => {
      log(
        `[perforce] scope: ${SCOPE_FILE_NAME} ${kind} under ${c.root}; re-resolving the daily scope`,
      )
      for (const other of mgr.all) other.invalidateScope()
    }
    scopeWatchers.push(
      watcher,
      watcher.onDidCreate(() => onScopeFileEvent('created')),
      watcher.onDidChange(() => onScopeFileEvent('changed')),
      watcher.onDidDelete(() => onScopeFileEvent('deleted')),
    )
  }
  context.subscriptions.push(...scopeWatchers)

  /**
   * Opened-by-others awareness: how often the client may ask "who has what
   * open". It reads the server's open table rather than walking the client
   * view, but it is still a scope-wide background scan, so the interval is a
   * real floor too.
   *
   * Applied **before** the first refresh: the refresh tail schedules the scan
   * and reads these options, so configuring them afterwards would let the very
   * first scan silently skip on a workspace the user has auto-check enabled for.
   */
  const applyOpenedByOthersOptions = async (target: PerforceClient): Promise<void> => {
    const autoCheck = await cfg.get('openedByOthers.autoCheck', true)
    const intervalSec = await cfg.get('openedByOthers.intervalSec', 300)
    target.setOpenedByOthersOptions({ autoCheck, intervalMs: intervalSec * 1000 })
  }
  const applyOpenedByOthersOptionsAll = async (): Promise<void> => {
    for (const c of mgr.all) await applyOpenedByOthersOptions(c)
  }
  await applyOpenedByOthersOptions(client)
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('perforce.openedByOthers')) return
      void applyOpenedByOthersOptionsAll()
    }),
  )

  void client.refresh()

  // Low-frequency background polling (opt-in; server has no FS watcher).
  const refreshInterval = await cfg.get('refreshInterval', 0)
  client.startPolling(refreshInterval)

  // Auto-checkout on edit (opt-in). Disabled config → no subscription.
  const autoEdit = new AutoEditController(mgr, log)
  context.subscriptions.push(autoEdit)
  void autoEdit.start(cfg)

  /**
   * Open the local-vs-have diff for a file a get refused, so the user can see
   * the uncollected work before deciding whether to collect it or discard it.
   * With several refusals, pick one first — a burst of diff tabs helps nobody.
   *
   * The diff goes straight to the client that ran the get. Routing back through
   * `perforce.openChange` would re-resolve the client from the path, and that
   * lookup falls back to the active repository when no root matches — command
   * semantics, wrong for a file we already know the owner of.
   */
  const openRefusedDiff = async (
    target: PerforceClient,
    refused: readonly SyncPreviewFile[],
  ): Promise<void> => {
    // A file outside the client view has no local path, so there is nothing to
    // diff against. Practically unreachable (p4 only refuses files it mapped), but
    // a button that silently does nothing reads as a broken editor — say so.
    const withLocal = refused.filter(
      (f): f is SyncPreviewFile & { clientFile: string } =>
        f.clientFile !== undefined && f.clientFile !== '',
    )
    const first = withLocal[0]
    if (!first) {
      log(`[perforce] view diff: none of the ${refused.length} refused file(s) have a local path`)
      await window.showWarningMessage(
        localize(
          'perforce.sync.refusedNoLocalPath',
          'Cannot show the differences: the skipped file(s) are not mapped into this workspace.',
        ),
      )
      return
    }
    if (withLocal.length === 1) {
      log(`[perforce] view diff: opening the single refused file ${first.clientFile}`)
      await target.openChange(first.clientFile, false, false)
      return
    }
    const choice = await window.showQuickPick(
      withLocal.map((f) => ({
        id: f.depotFile,
        label: displayName(f.clientFile ?? f.depotFile),
        description: `#${f.rev}`,
        detail: f.depotFile,
      })),
      {
        placeHolder: localize(
          'perforce.sync.refusedPickDiff',
          'Pick a file to see its uncollected local changes',
        ),
      },
    )
    if (!choice) return
    const local = withLocal.find((f) => f.depotFile === choice.id)?.clientFile
    if (local) {
      log(`[perforce] view diff: opening the picked refused file ${local}`)
      await target.openChange(local, false, false)
    }
  }

  /**
   * Write down where a get landed, for the graph's local-sync-point badge.
   *
   * The recorded changelist is READ BACK from p4 (`readGraphSyncPoint`), not
   * taken from the request. Recording `@4521` outright would claim the scope is
   * at 4521 even when 4521 never touched it — the Explorer's "Get Revision…"
   * picks a target with no regard to what it changed, and a get to an unrelated
   * changelist still moves every file to that moment.
   *
   * A get started from a graph row is the one case where the target IS the
   * answer: that row exists because its changelist touched something in the
   * scope the listing was filtered by, so a get covering that scope must land on
   * it. `knownLanding` carries that proof (`directSyncPoint` made it, from the
   * listing scope the renderer echoed back) and skips the read-back entirely.
   *
   * Awaited on purpose: the renderer re-reads the ledger as soon as the sync
   * command resolves (`getThenRevalidate`), so the entry has to be on disk by
   * then or the badge it just earned is missed. The read-back's tight timeout
   * bounds that tail — a wedged p4 costs a few seconds and one missing entry,
   * never a failed get.
   *
   * That window is only wide enough for a file scope, though: the read-back's
   * cost is the scope's WIDTH (measured 12.8s for a mid subtree, 27.3s for a
   * workspace root — the full table is on `SYNC_POINT_READBACK_EXEC`). So a
   * timeout is not the end of the question, it is the signal to ask it again
   * under the wide budget with nobody waiting — the `timedOut` branch below. A
   * timeout that is NOT retried leaves the badge answering with whatever older
   * record covers the scope, which reads to the user as "my get didn't update
   * the graph" (the real-machine report this branch exists for).
   */
  const recordSyncPoint = async (
    target: PerforceClient,
    spec: string,
    scope: readonly SyncScopeTarget[],
    outcome: { complete: boolean },
    /** Where the get is known to have landed without asking p4 (see
     *  `directSyncPoint`). Present = that answer is recorded as-is. */
    knownLanding?: KnownLanding,
  ): Promise<void> => {
    if (!ledger || scope.length === 0) return
    const filespecs = buildSyncFilespecs(scope)
    if (filespecs.length === 0) return
    // The moment the get finished. `at` says when the ANSWER was established, not
    // when it was written: the read-back below can land tens of seconds later
    // under the slow budget, and the ledger drops any write older than the record
    // it would replace — so a late-landing answer cannot move the badge backwards.
    const at = Date.now()
    // An EMPTY answer is a real one — "nothing of this scope is synced", which is
    // where a get that landed the scope before its first change, or back before
    // the file existed, really ends up. It is written as a tombstone for the same
    // reason a query's empty answer is: an older, wider record must not keep
    // claiming this scope sits at a changelist the user has just pulled it out of.
    const store = (read: { id: string | null }): void => {
      if (read.id === null) {
        ledger.recordEmpty(target.root, scope, at, 'sync')
        log(`[perforce] sync ledger: nothing synced for ${scopeTextOf(filespecs)}`)
        return
      }
      // The floor rides in the log because it is what decides whether this
      // record retires the wider ones — a retired badge is invisible from the
      // graph, and without the number its cause cannot be reconstructed.
      const floor = syncFloorOf(spec, filespecs)
      ledger.record({
        clientRoot: target.root,
        paths: scope,
        change: read.id,
        source: 'sync',
        at,
        complete: outcome.complete,
        floor,
      })
      log(
        `[perforce] sync ledger: #${read.id} for ${scopeTextOf(filespecs)}${
          outcome.complete ? '' : ' (partial)'
        } (floor=${floor === NO_REGRESSION ? 'none' : floor})`,
      )
    }
    if (knownLanding !== undefined) {
      // p4's answer is already known, so the read-back — whose cost is the
      // scope's WIDTH, tens of seconds over a workspace root — is skipped: the
      // row exists because its changelist touched something inside the listing
      // scope, and this get covers that scope, so asking would only confirm it.
      //
      // The coverage premise is NOT re-checked here. `directSyncPoint` is the
      // only producer of this value and it is checked there, against these very
      // two scopes; a second evaluation of the same call would be a tautology
      // pretending to be a guard. The invariant is held by that single producer
      // plus the command-level test that drives it (`graphSyncToChangeLedger`).
      //
      // No tombstone can arise on this path either (the claim names a
      // changelist, and `spec` went through `clSpecOf`) and no poke is needed
      // (the entry is on disk before this command resolves, so the renderer's
      // `getThenRevalidate` already reads it). Both exist only on the read-back
      // path below.
      store({ id: knownLanding.change })
      log(
        `[perforce] sync ledger: ${scopeTextOf(filespecs)} — no read-back (this get covers the row's listing)`,
      )
      return
    }
    const read = await target.readGraphSyncPoint(filespecs, spec)
    if (!read.failed) {
      store(read)
      return
    }
    // "Could not ask" records nothing: an unreadable sync point must not be
    // invented. A p4 that refused will refuse again — only a window that expired
    // is worth asking a second time, since the query itself is fine.
    if (!read.timedOut) return
    const started = Date.now()
    void target
      .readGraphSyncPoint(filespecs, spec, SYNC_POINT_READBACK_SLOW_EXEC)
      .then((late) => {
        if (late.failed) {
          log(
            `[perforce] sync ledger: ${scopeTextOf(filespecs)} gave no answer twice; nothing recorded`,
          )
          return
        }
        store(late)
        log(
          `[perforce] sync ledger: ${scopeTextOf(filespecs)} read back late (${Date.now() - started}ms)`,
        )
        // Nothing about the workspace changed, but the graph's badge is renderer
        // state read from this ledger and its auto-refresh only watches the SCM
        // observables — without this the entry sits invisible until the user
        // happens to reload the graph, which is the whole complaint. One
        // re-publish per late entry, and late entries land at user pace.
        target.notifyScmStateChanged()
      })
      .catch((err: unknown) => {
        // Fire-and-forget: an unhandled rejection here would take down the
        // extension host (red line), and the get it belongs to is long done.
        log(
          `[perforce] sync ledger late read-back failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      })
  }

  /** One confirmation at a time: the status-bar entry stays clickable until the
   *  renderer mounts the dialog, and two stacked dialogs for one operation read
   *  as a stuck editor. */
  let cancelConfirmPending = false

  /**
   * Ask before stopping in-flight p4 work, then stop only if it is still the
   * same work. Both stop entries — the status-bar spinner's click and the sync
   * notification's cancel button — route through here, so the two can never
   * disagree about what needs confirming.
   */
  const confirmAndCancelBusy = async (target: PerforceClient): Promise<void> => {
    const epoch = target.cancellableEpoch
    if (epoch === undefined || cancelConfirmPending) return
    cancelConfirmPending = true
    try {
      const BTN_STOP = localize('perforce.btn.stopOperation', 'Stop Operation')
      const busy = target.status.busy ?? localize('perforce.busy.generic', 'Working')
      const picked = await window.showWarningMessage(
        localize(
          'perforce.cancelBusy.confirm',
          '{0} — stop it? Work already done is kept and anything unfinished is left as it is; any other p4 operation in this workspace is stopped too.',
          { 0: busy },
        ),
        BTN_STOP,
      )
      // Modal, but not instant: the run this asked about can finish — and the
      // client's own follow-up (the collect after a get) start — while the
      // dialog is up, and cancelling on a stale answer would kill work the user
      // never saw.
      if (picked !== BTN_STOP || target.cancellableEpoch !== epoch) return
      target.cancelBusy()
    } finally {
      cancelConfirmPending = false
    }
  }

  /**
   * Run a sync and report the outcome.
   *
   * The whole run sits inside a cancellable notification progress. No pre-flight
   * count is taken (on a wide scope that dry run costs close to a minute before
   * the first byte moves), so the bar stays indeterminate and the message pairs
   * the running file count with the elapsed clock.
   */
  const runSync = async (
    target: PerforceClient,
    spec: string,
    options: {
      scope?: readonly string[]
      /** The selection the `scope` filespecs were built from. Carried so the
       *  collect-after-refusal remedy can carve excluded subtrees out of the
       *  exact paths this get covered (a filespec list can't be re-carved). */
      scopeTargets?: readonly SyncScopeTarget[]
      force?: boolean
      /**
       * The scope as THIS CALL SITE names it — host paths plus directory-ness,
       * never the expanded filespecs (see `graphSyncLedger.ts` for why the
       * distinction matters). Recorded after a successful run so the graph can
       * answer "where has this workspace got to?" without asking p4.
       *
       * Deliberately required: every get entry point has to state its scope, or
       * the ledger develops holes and the graph falls back to the very query
       * this exists to avoid. Pass `[]` for "this get cannot be expressed as
       * host paths, record nothing".
       */
      ledgerScope: readonly SyncScopeTarget[]
      /**
       * Where this get is known to have landed without asking p4 — only the
       * graph's row menu can establish this (see `directSyncPoint`). Forwarded
       * verbatim to {@link recordSyncPoint}; carried in these options rather
       * than threaded through a second call path so every gate between a run
       * and its ledger entry stays in one place.
       */
      knownLanding?: KnownLanding
      /**
       * Internal: the user already answered this call's scope gate with "run as
       * chosen". Only the force-retry below sets it — re-running the gate there
       * would put the same question to the user twice for one decision.
       */
      overrideScope?: boolean
    },
  ): Promise<void> => {
    // The explicit-target gate, before any progress UI and before any spawn: a
    // get over paths the daily scope does not cover is put to the user, never
    // trimmed silently. "Obey the scope" rewrites BOTH the filespecs and the
    // ledger scope, so the recorded history matches what actually ran.
    let scope = options.scope
    let ledgerScope = options.ledgerScope
    // What the refused-get remedy below may collect: narrowed along with the
    // filespecs when the user chose to obey the scope, so the remedy cannot
    // reach back out to the very paths the get was refused on.
    let collectTargets = options.scopeTargets
    let overrideScope = options.overrideScope === true
    if (!overrideScope && options.scopeTargets !== undefined && options.scopeTargets.length > 0) {
      const decision = await confirmScopeTargets(
        target,
        options.scopeTargets,
        localize('perforce.act.get', 'Getting files'),
      )
      if (!decision.ok) return
      if (decision.override) {
        overrideScope = true
      } else if (decision.targets !== options.scopeTargets) {
        scope = buildSyncFilespecs(decision.targets)
        ledgerScope = decision.targets
        collectTargets = decision.targets
      }
    }
    const res = await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title:
          spec === '#head'
            ? localize('perforce.sync.progressTitleHead', 'Getting the latest revision')
            : spec === ''
              ? // Per-file force-get: each scope filespec already carries its own
                // `#rev`, so there is no shared spec to name in the title.
                localize('perforce.sync.progressTitlePicked', 'Getting the selected files')
              : localize('perforce.sync.progressTitle', 'Getting {0}', { 0: spec }),
        cancellable: true,
      },
      async (progress, token) => {
        // The status-bar spinner already owns stopping p4 operations; routing
        // the notification's button through the same confirmation keeps one
        // abort mechanism instead of two that can disagree. A declined
        // confirmation leaves this run going: the token stays flipped, but the
        // get's result is decided by whether the p4 child was killed.
        const cancelSub = token.onCancellationRequested(() => {
          // Nothing awaits this callback, so an escaping rejection would take
          // down the extension host (red line).
          void confirmAndCancelBusy(target).catch((err: unknown) => {
            log(
              `[perforce] cancel confirmation failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          })
        })
        try {
          // p4 prints one line per file; on a ten-thousand-file get, reporting
          // each one is ten thousand RPC hops for pixels that can't move that
          // fast. Coalesce to ~7fps and settle up at the end.
          let reportedAt = 0
          const report = (done: number, file: string | undefined, force: boolean): void => {
            const now = Date.now()
            if (!force && now - reportedAt < PROGRESS_REPORT_INTERVAL_MS) return
            reportedAt = now
            const suffix = file ? ` · ${file}` : ''
            // The bare count alone reads as stalled on a wide sync, so pair it
            // with the elapsed time (mirrors the status bar).
            const startedAt = target.status.syncProgress?.startedAt
            const elapsed =
              startedAt !== undefined ? ` · ${formatScanElapsed(now - startedAt)}` : ''
            const message = localize('perforce.sync.progressFiles', '{0} file(s){1}{2}', {
              0: String(done),
              1: elapsed,
              2: suffix,
            })
            progress.report({ message })
          }
          let lastDone = 0
          const run = await target.sync(spec, {
            ...(scope !== undefined ? { scope } : {}),
            // The typed targets the specs were built from, and only when this
            // call site NAMED them (a scope-less get's range is the daily scope,
            // which is the client's own question to ask): the client checks the
            // scope against these, so an escaped spelling (`con@tent` travels as
            // `con%40tent`) cannot make the check invisible.
            ...(options.scopeTargets !== undefined && ledgerScope.length > 0
              ? { scopeTargets: ledgerScope }
              : {}),
            ...(options.force !== undefined ? { force: options.force } : {}),
            ...(overrideScope ? { overrideScope: true } : {}),
            onProgress: ({ done, file }) => {
              lastDone = done
              report(done, file, false)
            },
          })
          if (lastDone > 0) report(lastDone, undefined, true)
          return run
        } finally {
          cancelSub.dispose()
        }
      },
    )
    if (res.cancelled) return
    // Collect exactly what this get was refused on. Falling back to a clean
    // refresh would only *discover* the drift and leave the files still
    // uncollected — a button labelled "Collect Changes" that collects nothing is
    // how a user concludes the get is simply broken. A scope-less get (the
    // status-bar entry, the most common one) is refused over its own default
    // range, so collect that range rather than degrading the far more frequent
    // path to discovery-only.
    const collectScope = async (): Promise<void> => {
      const collectLabel = localize('perforce.act.collect', 'Collecting changes')
      // The get itself ran with no noise (a get is about the daily scope, and
      // the setting has no say in what a sync transfers) — the COLLECT is a
      // write over files nobody has collected yet, so it is where the noise
      // applies. Targets this get named itself are the user's own selection and
      // get the dialog; the daily range is a discovery answer and is pruned
      // silently.
      if (collectTargets !== undefined) {
        await runCollect(target, collectTargets, collectLabel, 'explicit', {
          ...(overrideScope ? { overrideScope: true } : {}),
        })
        return
      }
      const askedScope = options.scope
      if (askedScope !== undefined && askedScope.length > 0) {
        // Graph depot-syntax scopes (`//...`) and the timeline's single-file
        // scope pass through untouched: they are p4's own grammar, named by the
        // caller, and a local exclude directory cannot trim a depot filespec.
        await target.reconcile({ specs: askedScope })
        return
      }
      // The daily scope is the range a scope-less get was bounded by, so that is
      // what it must collect — as TARGETS, not a `<dir>/...` expansion of it: the
      // write derives its own filespecs from them under the config in force at
      // that instant (δ applies the exclusions inside its call, native carves
      // them out on disk). A scope that cannot be expressed as host paths leaves
      // nothing to collect beyond the refresh that already ran.
      const daily = target.dailyScope
      if (daily !== undefined) {
        await runCollect(target, scopeTargets(daily), collectLabel, 'discovery')
        return
      }
      // No resolved daily scope. `syncScopes` is the whole client root in that
      // state, and the exclusions the scope declares are exactly what is unknown
      // about it — collecting it would open files the scope shields (the config
      // file above all) on behalf of a range the editor cannot vouch for. The
      // depot spellings are the caller's own explicit range and pass through.
      const scopes = target.syncScopes
      if (target.scopeState !== 'ready' && !scopes.every((spec) => spec.startsWith('//'))) {
        log(
          '[perforce] collect: refused — the daily scope is not resolved, so there is no range to collect',
        )
        await window.showWarningMessage(
          localize(
            'perforce.scope.refused',
            'The {0} operation was not run: {1}. Nothing was changed.',
            {
              0: localize('perforce.act.collect', 'Collecting changes'),
              1:
                target.scopeUnusableReason ??
                'the daily scope is not resolved, so there is no range to collect',
            },
          ),
        )
        return
      }
      await target.reconcile({ specs: scopes })
    }
    if (!res.ok) {
      const suggestion = res.error?.suggestion
      const message = localize('perforce.sync.failed', 'Get revision failed. {0}', {
        0: suggestion ?? '',
      }).trim()
      // A clobber refusal is the one failure with an obvious next step: the local
      // file has work in it that nobody has collected yet.
      if (res.error?.kind === 'clobber') {
        const BTN_COLLECT = localize('perforce.btn.collectChanges', 'Collect Changes')
        const BTN_FORCE = localize('perforce.btn.forceSync', 'Force Get')
        // No "View Diff" here: a clobber comes back on stderr with exit 1, so the
        // run was interrupted and `refusedFiles` (parsed from stdout) is empty —
        // there is no per-file local path to diff. Force is offered second and
        // still behind its own confirmation: it is the only way out for a user
        // who knows the local copy is disposable, but it destroys that copy.
        const picked = options.force
          ? await window.showErrorMessage(message, BTN_COLLECT)
          : await window.showErrorMessage(message, BTN_COLLECT, BTN_FORCE)
        if (picked === BTN_COLLECT) await collectScope()
        else if (
          picked === BTN_FORCE &&
          (await confirmForceGet(
            spec,
            scopeTextOf(effectiveSyncScope(options.scope, target.syncScopes)),
          ))
        ) {
          // The retry re-enters the same gate with the scope this call settled
          // on — so a scope change between the two runs is re-checked rather
          // than assumed — while the override the user already granted is
          // carried over instead of asked for twice.
          await runSync(target, spec, {
            ...options,
            force: true,
            scopeTargets: ledgerScope,
            ledgerScope,
            ...(scope !== undefined ? { scope } : {}),
            ...(overrideScope ? { overrideScope: true } : {}),
          })
        }
        return
      }
      await window.showErrorMessage(message)
      return
    }
    const summary = res.summary
    // "Nothing happened" has to account for refusals too, or a run that only
    // refused files reads as an unparseable no-op.
    const nothingHappened =
      !summary ||
      (summary.applied === 0 &&
        summary.keptOpen === 0 &&
        summary.mustResolve === 0 &&
        summary.refusedModified === 0 &&
        summary.refusedOverwrite === 0)
    // Record where this get landed BEFORE reporting it: the graph's badge is
    // read back from the ledger by whoever revalidates next (this very sync's
    // `getThenRevalidate`, another tab, another window), so the entry has to be
    // on disk by the time this resolves. A get p4 walked past is still a
    // position worth knowing, but a run whose outcome p4 never made legible
    // ("exit 0, nothing applied, no up-to-date line") is not — it could mean
    // anything, so nothing is recorded rather than a guess.
    // The claim the ledger may write is about the range the get ACTUALLY
    // covered — the daily scope for a get the editor bounded by it (a scope-less
    // get derives its targets FROM it) — and only when that range is expressible
    // as host-path entries with no exclusion hole inside any of them: the entry
    // `<P>/...` over a scope that excludes `P/gen` would claim `P/gen` too,
    // which no get has ever touched.
    //
    // There is no engine echo to prefer any more: δ reads the same config from
    // the same fixed location, so the LOCAL resolution IS the range both sides
    // ran over (an external edit inside the spawn window is not something either
    // side can promise away, and the plan deliberately adds no handshake for it).
    //
    // A get that named its own range is NOT bounded by the daily scope, so
    // intersecting it there would record a narrower range than p4 walked:
    // `//...` is the whole client mapping, and a target the user confirmed out
    // of scope runs as chosen. The whole-repo graph then has no record covering
    // it at all and badges "click to query" straight after its own get.
    const explicitScope = options.scope !== undefined && options.scope.length > 0
    const claimSource = explicitScope ? undefined : target.dailyScope
    const claim =
      claimSource !== undefined
        ? scopeTargetsWithin(claimSource, ledgerScope)
        : // No scope to intersect with: the named targets ARE the range p4 ran
          // over, so they are the claim.
          ledgerScope
    if (summary?.upToDate === true || !nothingHappened) {
      if (claim !== undefined) {
        await recordSyncPoint(
          target,
          spec,
          claim,
          {
            // A run that refused or skipped files leaves them at their OLD revision,
            // so the scope is only known to be synced AT LEAST this far. Recorded
            // either way — "I pulled it, why is nothing shown?" is worse than a
            // labelled upper bound — but the label has to survive to the badge.
            complete:
              summary !== undefined &&
              summary.refusedModified === 0 &&
              summary.refusedOverwrite === 0 &&
              summary.keptOpen === 0 &&
              summary.mustResolve === 0,
          },
          options.knownLanding,
        )
      } else {
        // The get's range cannot be stated as a claim at all (a directory with a
        // hole). Nothing may be recorded FOR it, but an older record over the
        // same area may now be false — and only a get that could have carried a
        // file BACKWARD can have done that, so a head get (or a per-file
        // `#head`) leaves the older records standing as the lower bounds they
        // are. The floor carries that distinction into the ledger, which is also
        // what decides which of them is retired.
        const floor = syncFloorOf(spec, buildSyncFilespecs(ledgerScope))
        if (floor !== NO_REGRESSION && ledger !== undefined) {
          ledger.recordUnknown(target.root, ledgerScope, Date.now(), 'sync', floor)
          log(
            `[perforce] sync ledger: the range of ${scopeTextOf(
              buildSyncFilespecs(ledgerScope),
            )} is not expressible with its exclusions; recorded as unknown (floor=${floor})`,
          )
        }
      }
    }
    if (summary?.upToDate && nothingHappened) {
      await window.showInformationMessage(
        localize('perforce.sync.upToDate', 'Already at the latest revision.'),
      )
      return
    }
    if (nothingHappened) {
      // Exit 0, nothing applied, and p4 never said "up-to-date" — we genuinely
      // don't know what happened. Claiming the file is current (what this branch
      // used to do) is the worst possible answer: it is indistinguishable from
      // success and sends the user away believing a stale file is fresh. Point at
      // the output channel, where `sync()` logged the raw text.
      const BTN_OUTPUT = localize('perforce.btn.openOutput', 'Open Perforce Output')
      const picked = await window.showWarningMessage(
        localize(
          'perforce.sync.unrecognized',
          'Get revision returned no recognized result. Check the Perforce output for details.',
        ),
        BTN_OUTPUT,
      )
      if (picked === BTN_OUTPUT) out.show()
      return
    }
    // One get can refuse some files and update others: an `allwrite noclobber`
    // client refuses locally-modified files one by one and still exits 0
    // (measured on P4D 2024.2), walking on past them. So every count gets
    // reported — leading with the refusal, which is the outcome with uncollected
    // work at stake, but never at the price of hiding what did land.
    const parts: string[] = []
    if (summary.refusedModified > 0) {
      parts.push(
        localize(
          'perforce.sync.refusedModified',
          '{0} file(s) not updated — they have local changes that have not been collected',
          { 0: String(summary.refusedModified) },
        ),
      )
    }
    if (summary.refusedOverwrite > 0) {
      parts.push(
        localize(
          'perforce.sync.refusedOverwrite',
          '{0} file(s) not updated — an untracked file with the same name is already on disk',
          { 0: String(summary.refusedOverwrite) },
        ),
      )
    }
    // "Updated 0 file(s)" is worth saying on its own, but next to a refusal it is
    // noise — there the refusal already is the story.
    if (summary.applied > 0 || (summary.refusedModified === 0 && summary.refusedOverwrite === 0)) {
      parts.push(
        localize('perforce.sync.applied', 'Updated {0} file(s)', { 0: String(summary.applied) }),
      )
    }
    if (summary.keptOpen > 0) {
      parts.push(
        localize('perforce.sync.keptOpen', '{0} skipped (open for edit)', {
          0: String(summary.keptOpen),
        }),
      )
    }
    if (summary.mustResolve > 0) {
      parts.push(
        localize('perforce.sync.mustResolve', '{0} need merging', {
          0: String(summary.mustResolve),
        }),
      )
    }
    const message = parts.join(' · ')
    // Collecting first is the lossless way out — p4 then schedules a resolve and
    // neither side is dropped — so it leads. Force-get is offered too (some local
    // copies really are disposable), but it destroys uncollected work, so it sits
    // behind the diff and behind its own confirmation.
    const LABELS: Record<RefusedSyncButton, string> = {
      collect: localize('perforce.btn.collectChanges', 'Collect Changes'),
      diff: localize('perforce.btn.viewRefusedDiff', 'View Diff'),
      force: localize('perforce.btn.forceSync', 'Force Get'),
      resolve: localize('perforce.btn.resolveNow', 'Resolve Conflicts'),
    }
    const kinds = refusedSyncButtons({
      refusedModified: summary.refusedModified,
      refusedOverwrite: summary.refusedOverwrite,
      mustResolve: summary.mustResolve,
      allowForce: options.force !== true,
    })
    if (kinds.length === 0) {
      await window.showInformationMessage(message)
      return
    }
    const picked = await window.showWarningMessage(message, ...kinds.map((k) => LABELS[k]))
    const kind = kinds.find((k) => LABELS[k] === picked)
    if (kind === 'collect') await collectScope()
    else if (kind === 'diff') await openRefusedDiff(target, res.refusedFiles)
    else if (kind === 'force') {
      // Per-file force: the refusal already names every file it skipped, so a
      // whole-scope `-f` re-run would re-transfer the entire scope for a
      // handful of files. Let the user check which to overwrite, then sync
      // exactly those (the picker's title is the confirmation).
      const specs = await pickForceGetFiles(res.refusedFiles, res.refusedOverwriteFiles)
      if (specs !== undefined) await runSync(target, '', { ...options, force: true, scope: specs })
    } else if (kind === 'resolve') {
      await commands.executeCommand('perforce.resolveChangelist', { rootUri: target.root })
    }
  }

  /** The whole-client scope as host paths: what a scope-less get covers. `p4
   *  sync //...` run against one client means every file its view maps, which
   *  is exactly the client root. */
  /** The whole client mapping as a ledger scope: every file the view maps, which
   *  is what `//...` lists and what the client root covers on disk. */
  const clientRootScope = (target: PerforceClient): SyncScopeTarget[] => [
    { path: target.root, isDirectory: true },
  ]

  /**
   * The scope a scope-less get really covers — for the sync ledger.
   *
   * It is NOT the client root: with no explicit scope, `PerforceClient.sync`
   * targets `_syncScopes`, the DAILY scope's own entries (the opened workspace
   * ∩ `.p4delta-scope`), and only falls back to the client root when that
   * scope has no directory entry at all. Focus is deliberately NOT part of it.
   * Recording the client root here would badge a whole-repo graph with the
   * newest changelist of the whole client, which the get never touched — the
   * same over-report the probe's own scope rule exists to prevent (see
   * `docs/graph.md`, "本地同步点"). The reverse is just as bad: the get's real
   * scope would then be answered from a wider record and shown as an upper
   * bound instead of the exact point it is.
   */
  const scopeLessLedgerScope = (target: PerforceClient): SyncScopeTarget[] => {
    const dirs = target.syncScopeDirs
    return dirs.length > 0
      ? dirs.map((path) => ({ path, isDirectory: true }))
      : clientRootScope(target)
  }

  // Swarm (P4 Code Review) commands. Registered unconditionally — the handlers
  // themselves read `perforce.swarm.enabled` / `.url` at call time and no-op with
  // a friendly toast when unconfigured, so toggling config takes effect without a
  // reload. All handlers live in the extension host (safe to declare in commands).
  // Its own output channel + structured logger so Swarm REST / poll logs are
  // timestamped, levelled, and don't mingle with p4 CLI logs. Verbose request
  // tracing is gated behind `perforce.swarm.trace`.
  const swarmOut = window.createOutputChannel('Swarm')
  context.subscriptions.push(swarmOut)
  const swarmLogger = createSwarmLogger((line) => swarmOut.appendLine(line))
  context.subscriptions.push(registerSwarmCommands(mgr, swarmLogger, cacheEnabled))

  // When Swarm is enabled + configured, the commit bar defaults to "Request New
  // Swarm Review…" (P4V parity). Read the same config the swarm handlers use.
  const swarmEnabled = await cfg.get('swarm.enabled', true)
  const swarmUrl = ((await cfg.get('swarm.url', '')) as string).trim()
  client.setSwarmAvailable(Boolean(swarmEnabled) && swarmUrl.length > 0)
  void client.refresh()

  /**
   * Wire a freshly created client in (the switch-workspace quick-pick), applying
   * the same sequence `activate` used for the first client — see
   * {@link wireSwitchedClient} for why the order matters.
   */
  const wireClient = async (newClient: PerforceClient): Promise<void> => {
    const refreshInterval = await cfg.get('refreshInterval', 0)
    const swarmOn = await cfg.get('swarm.enabled', true)
    const swarmUrlOn = ((await cfg.get('swarm.url', '')) as string).trim()
    await wireSwitchedClient(
      newClient,
      {
        refreshIntervalSec: refreshInterval,
        swarmAvailable: Boolean(swarmOn) && swarmUrlOn.length > 0,
      },
      {
        add: (c) => mgr.add(c),
        setActive: (r) => mgr.setActive(r),
        statusBarRefresh: () => statusBar.refresh(),
        trackClient: (c) => {
          context.subscriptions.push(timelineProvider.trackClient(c))
        },
        applyScopes: applyReconcileScope,
        applyDailyScope,
        applyReconcileExcludes,
        applyOpenedByOthersOptions,
        applySyncParallelThreads,
        startPolling: (c, seconds) => c.startPolling(seconds),
        setSwarmAvailable: (c, available) => c.setSwarmAvailable(available),
      },
    )
  }

  /** Resolve the one client a multi-selected get may run against. A get runs
   *  against a single client, so every selected path must live in the same
   *  workspace — spanning several (or none) aborts with an error. */
  const syncSelectionOwner = async (
    selection: readonly SelectionTarget[],
  ): Promise<PerforceClient | undefined> => {
    const owner = resolveCommonClient(
      selection.map((t) => t.path),
      (p) => mgr.resolveContaining(p),
    )
    if (owner !== undefined) return owner
    await window.showErrorMessage(
      localize(
        'perforce.sync.multiClient',
        'The selected files belong to different Perforce workspaces, so they cannot be synced in one operation.',
      ),
    )
    return undefined
  }

  context.subscriptions.push(
    // Point argument-less commands at the SCM-selected client. Pushed by the
    // renderer's ActiveRepoSyncContribution as `<providerId>.setActiveRepo`.
    commands.registerCommand('perforce.setActiveRepo', (...args: unknown[]) =>
      handleSetActiveRepo(mgr, statusBar, args[0] as string | null | undefined),
    ),

    // Switch the active workspace (client): list the user's clients, pick one,
    // and wire the freshly created client in. The old client stays registered
    // (multiple providers coexist); `mgr.add` dedupes by root.
    commands.registerCommand('perforce.switchClient', () => {
      const current = mgr.active
      if (!current) return
      return switchClient({
        mgr,
        log,
        createClient: (entry) =>
          PerforceClient.createForClient(
            {
              clientName: entry.clientName,
              clientRoot: entry.clientRoot,
              ...(current.user !== undefined ? { userName: current.user } : {}),
            },
            fallback,
            gate,
            cacheOptions,
            {
              log,
              watchRoot: root,
              workspaceRoot: root,
              createFileSystemWatcher: (glob) => workspace.createFileSystemWatcher(glob),
              // The decision the initial client was built with (refreshed on
              // config changes): a switched workspace gets the same engine.
              ...(p4deltaOptions !== undefined ? { p4delta: p4deltaOptions } : {}),
            },
          ),
        wire: wireClient,
      })
    }),

    commands.registerCommand('perforce.refresh', (arg) => mgr.resolveClient(arg)?.refresh()),

    // Collect (reconcile) a file's working-tree change into open state. From
    // explorer/editor: the active file; a directory target (explorer right-click
    // on a folder) recurses via p4's `<dir>/...` syntax so the whole subtree is
    // collected.
    commands.registerCommand('perforce.reconcile', async (...args: unknown[]) => {
      const arg0 = args[0] as { isDirectory?: boolean } | undefined
      const selection = selectionTargets(args[1])
      const collectLabel = localize('perforce.act.collect', 'Collecting changes')
      // Group header of the Changes (reconcile) group: collect every drift row
      // the group shows. The header arg carries no resourceUri — file rows in
      // that same group DO carry one and keep their per-path handling below.
      const groupId = (args[0] as { scmResourceGroupId?: string } | undefined)?.scmResourceGroupId
      if (groupId === RECONCILE_GROUP_ID && resourcePath(args[0]) === undefined) {
        const client = mgr.resolveClient(args[0])
        if (!client) return
        const paths = client.driftGroupPaths()
        if (paths.length === 0) return
        // The rows are files this client's own scan produced — a discovery
        // answer, not a selection — so the exclusions prune it silently (they
        // already pruned the scan). The typed targets are the rows' own: the
        // client's scope check is about targets, and a row whose name p4 escapes
        // (`a@b.txt` travels as `a%40b.txt`) must not read as "unconstrained".
        await runCollect(
          client,
          paths.map((path) => ({ path, isDirectory: false })),
          collectLabel,
          'discovery',
        )
        return
      }
      // Explorer multi-select: the raw typed targets go to the client together
      // with this operation's exclusions (see `runCollectOperation`) — carve or δ
      // is the client's call, made at execution time. SCM folder rows keep the
      // single recursive `<dir>/...` filespec (see reconcileUsesSelection).
      if (reconcileUsesSelection(selection, arg0?.isDirectory === true)) {
        const client = mgr.resolveClient({ resourceUri: selection[0]!.path })
        if (!client) return
        const targets: SyncScopeTarget[] = selection.map((t) => ({
          path: t.path,
          isDirectory: t.isDirectory,
        }))
        // The scope gate answers the range question and the noise gate the
        // setting's; both put what they find to the user instead of dropping it,
        // and neither confirmation covers the other.
        const decision = await confirmScopeTargets(client, targets, collectLabel)
        if (!decision.ok) return
        await runCollect(client, decision.targets, collectLabel, 'explicit', {
          ...(decision.override ? { overrideScope: true } : {}),
        })
        return
      }
      const path = await resolveTargetPath(args[0])
      if (!path) return
      const client = mgr.resolveClient({ resourceUri: path })
      if (!client) return
      const isDirectory = arg0?.isDirectory === true
      const single: SyncScopeTarget[] = [{ path, isDirectory }]
      const decision = await confirmScopeTargets(client, single, collectLabel)
      if (!decision.ok) return
      // Everything below runs over the DECISION's targets, never the raw path:
      // "obey" can narrow a directory into the part that is in range (a scope
      // with two includes can even split one directory in two), and running the
      // raw spelling afterwards would reach past the range the user just chose.
      await runCollect(client, decision.targets, collectLabel, 'explicit', {
        ...(decision.override ? { overrideScope: true } : {}),
      })
    }),

    // Collect the selected not-yet-opened files into a brand-new numbered
    // changelist (the reconcile-drift analogue of `moveToNewChangelist`). Only
    // meaningful from the Changes group, so the menu shows it solely
    // there. `reconcileInto` (not `reopen`) is the engine — these files are not
    // open yet, so `reopen` would no-op on them; `reconcile -c` opens them for
    // their on-disk action straight into the new changelist.
    commands.registerCommand('perforce.reconcileIntoNewChangelist', async (...args: unknown[]) => {
      const intoLabel = localize('perforce.act.newChangelist', 'Collecting into a new changelist')
      // Group header of the Changes (reconcile) group: collect every drift row
      // the group shows into the new changelist. The header arg carries no
      // resourceUri — file rows keep their per-path resolution below.
      const groupId = (args[0] as { scmResourceGroupId?: string } | undefined)?.scmResourceGroupId
      if (groupId === RECONCILE_GROUP_ID && resourcePath(args[0]) === undefined) {
        const target = mgr.resolveClient(args[0])
        if (!target) return
        const paths = target.driftGroupPaths()
        if (paths.length === 0) return
        // The rows are this client's own scan output, so the exclusions prune
        // them silently — but the freeze still has to happen before the input
        // box and the changelist write, or a setting edited in that gap would
        // slip under the plan.
        const plan = await planCollect(
          target,
          paths.map((path) => ({ path, isDirectory: false })),
          intoLabel,
          'discovery',
        )
        if (plan === undefined) return
        const description = await window.showInputBox({
          prompt: localize('perforce.newChangelist.prompt', 'New changelist description'),
        })
        if (description === undefined) return
        const created = await target.newChangelist(description)
        if (!created) return
        await runCollectPlan(target, plan, { changelist: created })
        return
      }
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      const target = mgr.resolveClient({ resourceUri: paths[0]! })
      if (!target) return
      // Same explicit-target gates as `perforce.reconcile`: a collect narrows
      // silently on its own (δ intersects the request), and a file outside the
      // daily scope — or hidden by the reconcile exclusions — is the user's
      // call, not the editor's. Both run BEFORE the input box, so a cancelled
      // dialog leaves no empty changelist behind.
      const decision = await confirmScopeTargets(
        target,
        paths.map((path) => ({ path, isDirectory: false })),
        intoLabel,
      )
      if (!decision.ok) return
      const plan = await planCollect(target, decision.targets, intoLabel, 'explicit')
      if (plan === undefined) return
      const description = await window.showInputBox({
        prompt: localize('perforce.newChangelist.prompt', 'New changelist description'),
      })
      if (description === undefined) return
      const created = await target.newChangelist(description)
      if (!created) return
      await runCollectPlan(target, plan, {
        changelist: created,
        ...(decision.override ? { overrideScope: true } : {}),
      })
    }),

    // --- Sync (get revision) ------------------------------------------------

    // Get the latest revision, no prompt. From the Explorer / editor this targets
    // the clicked file or folder; with no argument it targets the active editor's
    // file — the revision chip in the status bar is per-file, and that is the file
    // it describes.
    commands.registerCommand('perforce.syncLatest', async (...args: unknown[]) => {
      // Explorer/SCM multi-select: one filespec per element, directories kept
      // as directories — buildSyncFilespecs expands them to `<dir>/...`.
      const selection = selectionTargets(args[1])
      if (selection.length > 0) {
        const owner = await syncSelectionOwner(selection)
        if (!owner) return
        await runSync(owner, '#head', {
          scope: buildSyncFilespecs(selection),
          scopeTargets: selection,
          ledgerScope: selection,
        })
        return
      }
      const path = await resolveTargetPath(args[0])
      const target = path
        ? mgr.resolveClient({ resourceUri: path })
        : (mgr.resolveClient(args[0]) ?? mgr.active)
      if (!target) return
      const single = path ? singleSyncTarget(args[0], path) : undefined
      await runSync(
        target,
        '#head',
        single !== undefined
          ? {
              scope: [buildScopeFilespec(single.path, single.isDirectory)],
              scopeTargets: [single],
              ledgerScope: [single],
            }
          : { ledgerScope: scopeLessLedgerScope(target) },
      )
    }),

    // Get a specific revision: four ways to name one, each also available as a
    // force-get, matching what P4V offers.
    commands.registerCommand('perforce.sync', async (...args: unknown[]) => {
      const selection = selectionTargets(args[1])
      if (selection.length > 0) {
        const owner = await syncSelectionOwner(selection)
        if (!owner) return
        const filespecs = buildSyncFilespecs(selection)
        const spec = await pickSyncSpec()
        if (spec === undefined) return
        if (spec.force && !(await confirmForceGet(spec.spec, scopeTextOf(filespecs)))) return
        await runSync(owner, spec.spec, {
          scope: filespecs,
          scopeTargets: selection,
          ledgerScope: selection,
          ...(spec.force ? { force: true } : {}),
        })
        return
      }
      const path = await resolveTargetPath(args[0])
      const target = path
        ? mgr.resolveClient({ resourceUri: path })
        : (mgr.resolveClient(args[0]) ?? mgr.active)
      if (!target) return
      const single = path ? singleSyncTarget(args[0], path) : undefined
      const scoped =
        single !== undefined
          ? {
              scope: [buildScopeFilespec(single.path, single.isDirectory)],
              scopeTargets: [single],
              ledgerScope: [single],
            }
          : undefined
      const spec = await pickSyncSpec()
      if (spec === undefined) return
      if (spec.force) {
        // The dialog names the range this get will really cover. A scope-less get
        // falls through to the client's configured scope, so name that rather
        // than leaving the user to guess what "no scope" meant.
        const scopeText = scopeTextOf(effectiveSyncScope(scoped?.scope, target.syncScopes))
        if (!(await confirmForceGet(spec.spec, scopeText))) return
      }
      await runSync(target, spec.spec, {
        ...(scoped !== undefined ? scoped : { ledgerScope: scopeLessLedgerScope(target) }),
        ...(spec.force ? { force: true } : {}),
      })
    }),

    // Dry-run: what would a get bring in. Read-only, so no confirmation.
    commands.registerCommand('perforce.previewSync', async (...args: unknown[]) => {
      const path = await resolveTargetPath(args[0])
      const target = path
        ? mgr.resolveClient({ resourceUri: path })
        : (mgr.resolveClient(args[0]) ?? mgr.active)
      if (!target) return
      const scope = path
        ? [
            buildScopeFilespec(
              path,
              (args[0] as { isDirectory?: boolean } | undefined)?.isDirectory === true,
            ),
          ]
        : undefined
      const res = await target.previewSync(scope)
      if (!res.ok) {
        await window.showErrorMessage(
          localize('perforce.previewSync.failed', 'Could not preview what would be fetched.'),
        )
        return
      }
      if (res.upToDate) {
        await window.showInformationMessage(
          localize('perforce.sync.upToDate', 'Already at the latest revision.'),
        )
        return
      }
      const picks = res.files.map((f) => ({
        id: f.depotFile,
        label: displayName(f.clientFile ?? f.depotFile),
        description: `${f.action}${f.rev ? ` #${f.rev}` : ''}`,
        detail: f.depotFile,
      }))
      const choice = await window.showQuickPick(picks, {
        placeHolder: localize(
          'perforce.previewSync.placeholder',
          '{0} file(s) would be fetched — pick one to open it',
          { 0: String(res.files.length) },
        ),
      })
      if (!choice) return
      const local = res.files.find((f) => f.depotFile === choice.id)?.clientFile
      if (local) await commands.executeCommand('_workbench.openFile', local)
    }),

    // Copy a file's depot path — the identifier every P4V dialog and Swarm URL
    // wants, and there is no other way to get at it from the editor.
    commands.registerCommand('perforce.copyDepotPath', async (...args: unknown[]) => {
      const path = await resolveTargetPath(args[0])
      if (!path) return
      const target = mgr.resolveClient({ resourceUri: path })
      if (!target) return
      const info = await target.fstat(path)
      if (!info) {
        await window.showWarningMessage(
          localize('perforce.copyDepotPath.notControlled', 'This file is not in the depot.'),
        )
        return
      }
      await commands.executeCommand('_workbench.writeClipboard', info.depotFile)
    }),

    commands.registerCommand('perforce.showOutput', () => out.show()),

    // Stop whatever cancellable p4 operation is in flight. Wired to the
    // status-bar spinner's click while it's busy, so a slow operation doesn't
    // have to be waited out. Runtime-only registration (deliberately NOT in
    // `contributes.commands`) — declaring it there registers a handler-less
    // duplicate that shadows this one.
    commands.registerCommand('perforce.cancelBusy', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (target) await confirmAndCancelBusy(target)
    }),

    commands.registerCommand('perforce.login', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const password = await window.showInputBox({
        prompt: localize('perforce.login.prompt', 'Perforce password / ticket'),
      })
      if (password === undefined) return
      const res = await target.login(password)
      if (!res.ok) await notifyP4Failure('login', res.result)
      else await target.refresh()
    }),

    commands.registerCommand('perforce.logout', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const res = await target.logout()
      if (!res.ok) await notifyP4Failure('logout', res.result)
      else await target.refresh()
    }),

    commands.registerCommand('perforce.openFile', async (...args: unknown[]) => {
      const path =
        resourcePath(args[0]) ??
        (await commands.executeCommand<string | undefined>('_workbench.getActiveEditorFile'))
      if (path) await commands.executeCommand('_workbench.openFile', path)
    }),

    commands.registerCommand('perforce.openChange', async (...args: unknown[]) => {
      const [arg, options] = args as [
        unknown,
        ({ pinned?: boolean; preserveFocus?: boolean } | undefined)?,
      ]
      // From an SCM row: `{ resourceUri }`. From the dirty-diff host / editor
      // title: a bare path string.
      const path = resourcePath(arg) ?? (typeof arg === 'string' ? arg : undefined)
      if (!path) return
      // Double-click on an SCM row asks to pin (promote out of the preview slot);
      // Space-preview asks to preserve focus. Mirrors git.openChange.
      await mgr
        .resolveClient({ resourceUri: path })
        ?.openChange(path, options?.pinned ?? false, options?.preserveFocus ?? false)
    }),

    // Open a diff for a shelved file (no local copy exists): shelved content vs
    // its base revision. The row carries `{ changelist, depotFile, rev, action }`
    // as the command argument (there's no local path to resolve a client from, so
    // route via the active client).
    commands.registerCommand('perforce.openShelvedFile', async (...args: unknown[]) => {
      const req = args[0] as
        | { changelist?: string; depotFile?: string; rev?: string; action?: string }
        | undefined
      if (!req?.changelist || !req.depotFile) return
      await mgr.active?.openShelvedFile(
        req.changelist,
        req.depotFile,
        req.rev,
        (req.action ?? 'edit') as P4Action,
      )
    }),

    // Dirty-diff baseline: the file's have-revision content (host addresses this
    // as `<providerId>.getHeadContent`). Returns null when there's no baseline.
    commands.registerCommand('perforce.getHeadContent', async (...args: unknown[]) => {
      const path = typeof args[0] === 'string' ? args[0] : undefined
      if (!path) return null
      return (await mgr.resolveClient({ resourceUri: path })?.getHeadContent(path)) ?? null
    }),

    // Inline blame: annotate the file (host addresses this as
    // `<providerId>.getBlame`). Returns a BlameResultDto, or null on failure.
    commands.registerCommand('perforce.getBlame', async (...args: unknown[]) => {
      const path = typeof args[0] === 'string' ? args[0] : undefined
      if (!path) return null
      return (await mgr.resolveClient({ resourceUri: path })?.getBlame(path)) ?? null
    }),

    // Explorer working-tree hints: which of these visible rows have local drift
    // that isn't opened yet (host addresses this as `<providerId>.checkWorkingTree`).
    // A batch can span several p4 clients in a multi-root workspace, so paths are
    // grouped by owning client rather than routed off the first one; a path no
    // client owns is simply left out of the answer.
    commands.registerCommand('perforce.checkWorkingTree', async (...args: unknown[]) => {
      const paths = Array.isArray(args[0])
        ? (args[0] as unknown[]).filter((p): p is string => typeof p === 'string')
        : []
      if (paths.length === 0) return []
      const enabled = await workspace
        .getConfiguration('perforce')
        .get('reconcileHint.enabled', true)
      if (!enabled) return []

      const byClient = new Map<PerforceClient, string[]>()
      for (const path of paths) {
        // `resolveContaining`, not `resolveClient`: this is a data query, so a
        // path no client owns must be left out of the answer rather than fall
        // back to the active client, which would scan the wrong workspace.
        const client = mgr.resolveContaining(path)
        if (!client) continue
        const list = byClient.get(client)
        if (list) list.push(path)
        else byClient.set(client, [path])
      }
      if (byClient.size === 0) return []

      // One rejected client must not sink the whole batch — the remaining rows
      // still deserve their hints, and this runs on a render path where throwing
      // would surface as an unhandled rejection in the host.
      const perClient = await Promise.all(
        [...byClient].map(async ([client, owned]): Promise<WorkingTreeChangeDto[]> => {
          try {
            return await client.checkWorkingTree(owned)
          } catch (err) {
            log(`[perforce] checkWorkingTree failed for ${client.root}: ${String(err)}`)
            return []
          }
        }),
      )
      return perClient.flat()
    }),

    // Explorer behind hints: which of these visible rows have a have revision
    // behind the depot head (host addresses this as `<providerId>.checkBehind`).
    // Same multi-client grouping as checkWorkingTree; the provider pushes the
    // actual ↓ decoration, this only returns the behind subset.
    commands.registerCommand('perforce.checkBehind', async (...args: unknown[]) => {
      const paths = Array.isArray(args[0])
        ? (args[0] as unknown[]).filter((p): p is string => typeof p === 'string')
        : []
      if (paths.length === 0) return []

      const byClient = new Map<PerforceClient, string[]>()
      for (const path of paths) {
        const client = mgr.resolveContaining(path)
        if (!client) continue
        const list = byClient.get(client)
        if (list) list.push(path)
        else byClient.set(client, [path])
      }
      if (byClient.size === 0) return []

      const perClient = await Promise.all(
        [...byClient].map(async ([client, owned]): Promise<string[]> => {
          try {
            return await client.checkBehind(owned)
          } catch (err) {
            log(`[perforce] checkBehind failed for ${client.root}: ${String(err)}`)
            return []
          }
        }),
      )
      return perClient.flat()
    }),

    // --- Mutating operations (Phase 2) -------------------------------------
    // File-scoped ops resolve the client from the resource path; explorer/editor
    // entry points fall back to the active editor's file.

    commands.registerCommand('perforce.edit', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      await mgr.resolveClient({ resourceUri: paths[0]! })?.edit(paths)
    }),

    commands.registerCommand('perforce.add', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      await mgr.resolveClient({ resourceUri: paths[0]! })?.add(paths)
    }),

    commands.registerCommand('perforce.delete', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      const target = mgr.resolveClient({ resourceUri: paths[0]! })
      if (!target) return
      const BTN_DELETE = localize('perforce.btn.delete', 'Mark for Delete')
      const message =
        paths.length === 1
          ? localize('perforce.delete.confirm', "Open '{0}' for delete?", { 0: paths[0]! })
          : localize('perforce.delete.confirmMany', 'Open {0} files for delete?', {
              0: String(paths.length),
            })
      const confirm = await window.showWarningMessage(message, BTN_DELETE)
      if (confirm !== BTN_DELETE) return
      await target.delete(paths)
    }),

    commands.registerCommand('perforce.revert', async (...args: unknown[]) => {
      const selection = selectionTargets(args[1])
      // Unified revert: opened → `p4 revert` (leave the changelist + discard);
      // unopened → `p4 clean` (old Discard Uncollected). Branch order matters:
      // SCM folder rows carry `isDirectory: true` too, but they have a
      // `scmResourceGroupId` and a subtree-file selection — they must be caught
      // by the group branch first. A lone Explorer directory (selection is
      // exactly that directory — the context menu always materializes the
      // selection with the primary in it) recurses via `dir/...`; everything
      // else goes per-file, with directory entries merged into `directories`.
      let plan: RevertPlan
      let target: PerforceClient | undefined
      // The targets the CLEAN half was named over, for the scope gate below.
      // Only the two callers that named a working-tree range set it: a whole-CL
      // revert is `p4 revert` over files the user sees open (its clean half is
      // empty by construction), and the Changes-group header IS the scope's own
      // drift list — the group's collect does not put those rows to the user
      // either.
      let cleanTargets: readonly SyncScopeTarget[] | undefined
      const revertGroupId = (args[0] as { scmResourceGroupId?: string } | undefined)
        ?.scmResourceGroupId
      if (revertGroupId === RECONCILE_GROUP_ID && resourcePath(args[0]) === undefined) {
        // Group header of the Changes (reconcile) group: every row is an
        // unopened drift file, so revert = `p4 clean`. The shared confirm /
        // execute pipeline below routes a clean-only plan through
        // `revertReconcile`.
        const client = mgr.resolveClient(args[0])
        if (!client) return
        target = client
        const driftPaths = client.driftGroupPaths()
        if (driftPaths.length === 0) return
        plan = { opened: [], unopened: driftPaths }
      } else if (groupChangelistId(args[0]) !== undefined) {
        const groupCl = groupChangelistId(args[0])!
        // Group headers carry no resourceUri — take the changelist's own files
        // and route by the header's rootUri. File/folder rows DO carry a
        // resourceUri and keep their per-path resolution below.
        if (resourcePath(args[0]) === undefined) {
          const client = mgr.resolveClient(args[0])
          if (!client) return
          target = client
          const paths = client.pathsInChangelist(groupCl)
          if (paths.length === 0) return
          plan = {
            opened: paths.map((p) => {
              const changelist = knownChangelist(client.changelistOf(p) ?? groupCl)
              return changelist === undefined ? { path: p } : { path: p, changelist }
            }),
            unopened: [],
          }
        } else {
          const paths = await resolveTargetPaths(args)
          if (paths.length === 0) return
          const client = mgr.resolveClient({ resourceUri: paths[0]! })
          if (!client) return
          target = client
          plan = {
            opened: paths.map((p) => {
              const changelist = knownChangelist(client.changelistOf(p) ?? groupCl)
              return changelist === undefined ? { path: p } : { path: p, changelist }
            }),
            unopened: [],
          }
        }
      } else if (
        isRevertDirectoryTarget(
          selection,
          (args[0] as { isDirectory?: boolean } | undefined)?.isDirectory === true,
        )
      ) {
        // Selection empty happens for real: Explorer empty-area menu (no args[1])
        // and right-clicking the workspace root row (root filtered out of the
        // selection) — the directory path then comes from the primary arg.
        const dirPath = selection[0]?.path ?? (await resolveTargetPath(args[0]))
        if (!dirPath) return
        const dir = dirPath.replace(/[/\\]+$/, '')
        const client = mgr.resolveClient({ resourceUri: dir })
        if (!client) return
        target = client
        const tree = await client.openedInTree(dir)
        plan = {
          opened: tree.files,
          unopened: [],
          directories: [dir],
          ...(tree.unknown ? { openedUnknown: true } : {}),
        }
        cleanTargets = [{ path: dir, isDirectory: true }]
      } else {
        const files = selection.filter((t) => !t.isDirectory).map((t) => t.path)
        const dirs = selection
          .filter((t) => t.isDirectory)
          .map((t) => t.path.replace(/[/\\]+$/, ''))
        const first = files[0] ?? dirs[0] ?? (await resolveTargetPath(args[0]))
        if (first === undefined) return
        const client = mgr.resolveClient({ resourceUri: first })
        if (!client) return
        target = client
        plan = classifyRevertTargets(files, await client.openedStateAmong(files))
        if (dirs.length > 0) {
          const seen = new Set(plan.opened.map((f) => norm(f.path)))
          // One batched `p4 opened` round-trip for every directory entry — the
          // confirm dialog waits on this precheck.
          const tree = await client.openedInTrees(dirs)
          for (const f of tree.files) {
            if (seen.has(norm(f.path))) continue
            seen.add(norm(f.path))
            plan.opened.push(f)
          }
          plan = { ...plan, directories: dirs, ...(tree.unknown ? { openedUnknown: true } : {}) }
        }
        cleanTargets = [
          ...dirs.map((dir) => ({ path: dir, isDirectory: true })),
          ...plan.unopened.map((path) => ({ path, isDirectory: false })),
        ]
      }

      // `p4 clean` rediscovers working-tree drift — exactly what the reconcile
      // exclusions hide — while `p4 revert` acts on files the user explicitly
      // collected and already sees in the SCM panel, so only the clean half is
      // gated. Both gates run BEFORE the destructive confirm: a dialog that
      // promises to discard uncollected work must not then keep it, and one that
      // says nothing about it must not discard it either.
      const cleanLabel = localize('perforce.act.clean', 'Cleaning files')
      /** The gated clean, held across the confirm dialog: its rules were read
       *  once, before the user answered anything. */
      let cleanPlan: CollectPlan | undefined
      let cleanRunAsChosen = false
      // The gate answers about the CLEAN half's range, so a "no" there (a
      // dismissed dialog, or "obey" with nothing of that range left) drops the
      // clean — it must not cancel the `p4 revert` half, which acts on files the
      // user already sees open and which the exclusions were never about.
      let cleanDropped = false
      if (cleanTargets !== undefined && cleanTargets.length > 0) {
        const decision = await confirmScopeTargets(target, cleanTargets, cleanLabel)
        if (!decision.ok) {
          cleanDropped = true
          // The plan must drop them too, or the confirm below would promise to
          // discard files this run will keep.
          plan = { ...plan, unopened: [] }
        } else if (decision.override) {
          // "Run as chosen": the user's own answer to the RANGE question, so the
          // clean runs over exactly the named targets — the scope's exclusions
          // are set aside for this call (the collect paths do the same). The
          // noise is a different setting and is NOT set aside with it: the gate
          // below still runs, and its rules still apply.
          cleanRunAsChosen = true
        } else if (decision.targets !== cleanTargets) {
          // Obey: the PLAN narrows, so the confirm below names what will
          // actually be discarded — a plan left at its full width while the run
          // uses a narrower one is the same broken promise the noise gate
          // refuses, in the other direction.
          plan = {
            ...plan,
            unopened: decision.targets.filter((t) => !t.isDirectory).map((t) => t.path),
            directories: decision.targets.filter((t) => t.isDirectory).map((t) => t.path),
          }
        }
        if (!cleanDropped) {
          cleanPlan = await planCollect(
            target,
            [
              ...(plan.directories ?? []).map(
                (dir): SyncScopeTarget => ({ path: dir, isDirectory: true }),
              ),
              ...plan.unopened.map((path): SyncScopeTarget => ({ path, isDirectory: false })),
            ],
            cleanLabel,
            'explicit',
          )
          if (cleanPlan === undefined) {
            // Cancelled, or every clean target is hidden: the clean half is
            // dropped, the revert half stands.
            cleanDropped = true
            plan = { ...plan, unopened: [] }
          }
        }
      } else {
        // No clean range was named (see `cleanTargets`): the rows are already
        // the scope's own answer, so an entry the current scope or the
        // exclusions cover is dropped here instead of being put to the user.
        // The filter also keeps a stale drift row from making the client refuse
        // the whole clean.
        plan.unopened = plan.unopened.filter((p) => !target.isReconcileTargetExcluded(p))
        if (plan.unopened.length > 0) {
          cleanPlan = await planCollect(
            target,
            plan.unopened.map((path): SyncScopeTarget => ({ path, isDirectory: false })),
            cleanLabel,
            'discovery',
          )
          if (cleanPlan === undefined) {
            cleanDropped = true
            plan = { ...plan, unopened: [] }
          }
        }
      }
      // The confirm counts `plan`, the run executes `cleanRuns`, so the plan's
      // unopened files narrow to the ones that survived both gates — a dialog
      // that promises to discard work the clean half keeps is the one thing a
      // destructive confirm must never do.
      if (cleanPlan !== undefined) {
        const kept = cleanPlan.operations.flatMap((op) => op.targets)
        plan = { ...plan, unopened: kept.filter((t) => !t.isDirectory).map((t) => t.path) }
        if (cleanPlan.skipped) {
          // "Skip them" drops a target the user named: it runs nothing at all,
          // the clean half included. The directory specs are narrowed too — they
          // still drive `p4 revert <dir>/...`, and there is no reason to revert
          // a directory the user just answered "skip" for. Only a failed opened
          // query keeps them: there the subtree spec is the fail-open fallback
          // the dialog already promised.
          if (plan.openedUnknown !== true) {
            plan = { ...plan, directories: kept.filter((t) => t.isDirectory).map((t) => t.path) }
          }
          plan.unopenedExcluded = true
        }
      }
      /**
       * The clean's runs: one per rule group (a confirmed target cannot ride in
       * the same call as an unconfirmed one — the exclusion list is per call),
       * each carrying the raw targets and the targets the user authorized for
       * them. Their filespecs are NOT built here: the client derives them at
       * execution time from the state in force then, which is the only moment
       * that can answer for a `p4 clean` — and the same goes for the exclusions
       * themselves, so a rule added while this dialog was up still shields its
       * subtree from the clean.
       */
      const cleanRuns = (cleanPlan?.operations ?? []).map((op) => ({
        targets: op.targets,
        confirmedTargets: op.confirmedTargets,
      }))
      /**
       * Whether the clean half runs at all: neither gate dropped it, and it has
       * targets. No filespec list is built here — `cleanRuns` hands the client the
       * raw targets and its rules (see above).
       */
      const hasClean = !cleanDropped && cleanRuns.length > 0

      const actions = revertActionsOf(plan)
      if (!hasClean) actions.clean = []
      // The gate already reported why: an empty clean here is an answer, not a
      // finding, and re-announcing it would read as a second failure.
      if (actions.revert.length === 0 && !hasClean) {
        if (!cleanDropped) await notifyAllExcluded()
        return
      }

      const BTN_REVERT = localize('perforce.btn.revert', 'Revert')
      // The clean half's files are derived at execution time, after this dialog:
      // say so, so a scope or exclusion edited while the dialog is up is
      // announced rather than silently obeyed.
      const confirmText = hasClean
        ? `${formatRevertConfirm(plan)}\n${localize(
            'perforce.revert.confirmCurrentRules',
            'It runs under the workspace scope and reconcile exclusions in force when it starts.',
          )}`
        : formatRevertConfirm(plan)
      const confirm = await window.showWarningMessage(confirmText, BTN_REVERT)
      if (confirm !== BTN_REVERT) return

      if (actions.revert.length > 0) await target.revert(actions.revert)
      for (const run of cleanRuns) {
        const ok = await target.revertReconcile(
          { targets: run.targets },
          {
            ...(cleanRunAsChosen ? { overrideScope: true } : {}),
            ...(run.confirmedTargets.length > 0 ? { confirmedTargets: run.confirmedTargets } : {}),
          },
        )
        // An apply already started: repeating it after a failure is the one
        // thing a destructive operation must never do.
        if (!ok) break
      }
    }),

    commands.registerCommand('perforce.revertUnchanged', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      await target?.revertUnchanged(groupChangelistId(arg))
    }),

    // Revert every open file in a changelist (destructive — confirm first).
    commands.registerCommand('perforce.revertChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg) ?? 'default'
      if (!target) return
      const label =
        changelist === 'default'
          ? localize('perforce.group.default', 'Default Changelist')
          : `#${changelist}`
      const BTN_REVERT = localize('perforce.btn.revertAll', 'Revert All')
      const confirm = await window.showWarningMessage(
        localize(
          'perforce.revertChangelist.confirm',
          'Revert all files in {0}? Local changes will be lost.',
          {
            0: label,
          },
        ),
        BTN_REVERT,
      )
      if (confirm !== BTN_REVERT) return
      await target.revertChangelist(changelist)
    }),

    // Delete an empty numbered changelist (P4V parity). Blocked when it still has
    // open files; any shelf is removed first inside `deleteChangelist`.
    commands.registerCommand('perforce.deleteChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      if (target.hasOpenFiles(changelist)) {
        await window.showWarningMessage(
          localize(
            'perforce.deleteChangelist.notEmpty',
            'Changelist #{0} still has open files. Move or revert them before deleting it.',
            { 0: changelist },
          ),
        )
        return
      }
      const BTN_DELETE = localize('perforce.btn.deleteChangelist', 'Delete Changelist')
      const confirm = await window.showWarningMessage(
        localize(
          'perforce.deleteChangelist.confirm',
          'Delete changelist #{0}? Any shelved files it holds will also be deleted.',
          { 0: changelist },
        ),
        BTN_DELETE,
      )
      if (confirm !== BTN_DELETE) return
      await target.deleteChangelist(changelist)
    }),

    // Move file(s) / folder / whole changelist out of their changelist without
    // touching the working tree (`p4 revert -k`): they leave the changelist and
    // become uncollected working-tree drift again. From a group header (moves the
    // whole changelist), a folder subtree, or a file selection.
    commands.registerCommand('perforce.moveToReconcile', async (...args: unknown[]) => {
      const arg = args[0]
      const groupId = groupChangelistId(arg)
      const target =
        mgr.resolveClient(arg) ??
        (resourcePath(arg) ? mgr.resolveClient({ resourceUri: resourcePath(arg)! }) : undefined) ??
        mgr.active
      if (!target) return
      const paths =
        groupId && !resourcePath(arg)
          ? target.pathsInChangelist(groupId)
          : await resolveTargetPaths(args)
      if (paths.length === 0) return
      await target.moveToReconcile(paths)
    }),

    // Submit the default changelist using the SCM input-box description.
    commands.registerCommand('perforce.submitDefault', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const description = target.description
      if (!description.trim()) {
        await window.showWarningMessage(
          localize('perforce.submit.noDescription', 'Type a changelist description first.'),
        )
        return
      }
      const BTN_SUBMIT = localize('perforce.btn.submit', 'Submit')
      const confirm = await window.showWarningMessage(
        localize(
          'perforce.submit.confirmDefault',
          'Submit the default changelist to the depot? This cannot be undone.',
        ),
        BTN_SUBMIT,
      )
      if (confirm !== BTN_SUBMIT) return
      if (await target.submit('default', description)) target.description = ''
    }),

    // Submit a numbered changelist (from its group action) — spec is already set.
    commands.registerCommand('perforce.submitChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      const BTN_SUBMIT = localize('perforce.btn.submit', 'Submit')
      const confirm = await window.showWarningMessage(
        localize(
          'perforce.submit.confirmNumbered',
          'Submit changelist #{0} to the depot? This cannot be undone.',
          { 0: changelist },
        ),
        BTN_SUBMIT,
      )
      if (confirm !== BTN_SUBMIT) return
      await target.submit(changelist)
    }),

    // --- Numbered changelist management (Phase 3) --------------------------

    commands.registerCommand('perforce.newChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const description = await window.showInputBox({
        prompt: localize('perforce.newChangelist.prompt', 'New changelist description'),
      })
      if (description === undefined) return
      await target.newChangelist(description)
    }),

    // Move the clicked resource(s) into a changelist chosen from a quick-pick.
    commands.registerCommand('perforce.reopen', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      const target = mgr.resolveClient({ resourceUri: paths[0]! })
      if (!target) return
      const picks = await target.changelistPicks()
      const choice = await window.showQuickPick(picks, {
        placeHolder: localize('perforce.reopen.placeholder', 'Move file to changelist'),
      })
      if (!choice) return
      if (choice.id === 'new') {
        const description = await window.showInputBox({
          prompt: localize('perforce.newChangelist.prompt', 'New changelist description'),
        })
        if (description === undefined) return
        await target.moveToNewChangelist(description, paths)
        return
      }
      await target.reopen(choice.id, paths)
    }),

    // Drag-and-drop target: move dropped files directly into the changelist group
    // they were dropped on — no quick-pick. Only the default or a numbered pending
    // changelist is a valid target (a shelved-files group id also survives
    // `changelistIdFromGroupId` as a bare number, so reject it by raw id first).
    // Already-opened files are reopened into the target; not-yet-opened reconcile
    // files are collected straight into it (`reconcile -a -e -d -c`). Registered at
    // runtime (not in package.json's `commands`) so the SCM host can probe it via
    // CommandsRegistry to decide a group accepts drops, without a menu declaration
    // shadowing this handler. args: (groupArg with scmResourceGroupId, selection).
    commands.registerCommand('perforce.reopenTo', async (...args: unknown[]) => {
      const groupId = (args[0] as { scmResourceGroupId?: string } | undefined)?.scmResourceGroupId
      const paths = selectionPaths(args[1])
      if (groupId === undefined || paths.length === 0) return
      const target = mgr.resolveClient(args[0]) ?? mgr.resolveClient({ resourceUri: paths[0]! })
      if (!target) return

      if (groupId.startsWith('shelved:')) return
      const changelist = changelistIdFromGroupId(groupId)
      if (changelist !== 'default' && !/^\d+$/.test(changelist)) return
      const opened = paths.filter((p) => target.changelistOf(p) !== undefined)
      // `reconcileInto` runs the same discovery the exclusions hide, so an
      // excluded path must not be collected here. The two layers answer
      // differently, exactly as they do in the revert pipeline: a path the
      // workspace RANGE excludes is this row's own answer and is dropped
      // silently, while one the reconcile NOISE covers — a path the user dragged
      // onto a changelist themselves — is put to them ({@link planCollect}).
      // `opened` files were explicitly collected before and `reopen` stays
      // unfiltered (see revert).
      const uncollected = paths.filter(
        (p) => target.changelistOf(p) === undefined && !target.isScopeTargetExcluded(p),
      )
      if (uncollected.length > 0) {
        const intoLabel = localize('perforce.act.collect', 'Collecting changes')
        const plan = await planCollect(
          target,
          uncollected.map((path): SyncScopeTarget => ({ path, isDirectory: false })),
          intoLabel,
          'explicit',
        )
        // One `reconcile -c` call per rule group: a target the user confirmed
        // through must not share a call with one that keeps the noise (the
        // exclusion list is per call).
        if (plan !== undefined) {
          for (const op of plan.operations) {
            await target.reconcileInto(
              changelist,
              { targets: op.targets },
              op.confirmedTargets.length > 0 ? { confirmedTargets: op.confirmedTargets } : {},
            )
          }
        }
      }
      if (opened.length > 0) await target.reopen(changelist, opened)
    }),

    // One-step "group these edits into a new changelist": from a changelist group
    // header (moves the whole group) or a file-row selection (moves those files).
    commands.registerCommand('perforce.moveToNewChangelist', async (...args: unknown[]) => {
      const arg = args[0]
      const groupId = groupChangelistId(arg)
      const target =
        mgr.resolveClient(arg) ??
        (resourcePath(arg) ? mgr.resolveClient({ resourceUri: resourcePath(arg)! }) : undefined) ??
        mgr.active
      if (!target) return
      // Group-header invocation (a group id but no concrete resource) moves every
      // file in that changelist; a file-row invocation moves the selection.
      const paths =
        groupId && !resourcePath(arg)
          ? target.pathsInChangelist(groupId)
          : await resolveTargetPaths(args)
      if (paths.length === 0) return
      const description = await window.showInputBox({
        prompt: localize('perforce.newChangelist.prompt', 'New changelist description'),
      })
      if (description === undefined) return
      await target.moveToNewChangelist(description, paths)
    }),

    commands.registerCommand('perforce.editChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      const current = await target.getChangelistDescription(changelist)
      const description = await window.showInputBox({
        prompt: localize('perforce.editChangelist.prompt', 'Changelist description'),
        value: current,
      })
      if (description === undefined) return
      await target.editChangelistDescription(changelist, description)
    }),

    // --- Shelve / unshelve (Phase 3) --------------------------------------

    // Shelve a whole changelist. Works from a group header or a file row (both
    // carry `scmResourceGroupId`) — per the design, a file-row shelve archives the
    // file's entire changelist. The default changelist can't be shelved directly
    // (p4 requires a numbered CL), so its files are first moved into a fresh
    // numbered changelist (description prompted), then shelved.
    commands.registerCommand('perforce.shelve', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist) return
      if (changelist === 'default') {
        const paths = target.pathsInChangelist('default')
        if (paths.length === 0) {
          await window.showWarningMessage(
            localize(
              'perforce.shelve.defaultEmpty',
              'The default changelist has no files to shelve.',
            ),
          )
          return
        }
        const description = await window.showInputBox({
          prompt: localize(
            'perforce.shelve.defaultPrompt',
            'Description for the new changelist to shelve into',
          ),
        })
        if (description === undefined) return
        const created = await target.moveToNewChangelist(description, paths)
        if (!created) return
        await target.shelve(created)
        return
      }
      await target.shelve(changelist)
    }),

    // Unshelve a whole changelist (group header) or a single shelved file (row).
    commands.registerCommand('perforce.unshelve', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      const depotFile = resourcePath(arg)
      if (depotFile) await target.unshelveFile(changelist, depotFile)
      else await target.unshelve(changelist)
    }),

    // Restore an arbitrary shelved changelist by number (command palette) — for a
    // shelf not shown in this workspace's panel. Force-overwrites, so confirm.
    commands.registerCommand('perforce.unshelveByNumber', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      if (!target) return
      const changelist = await window.showInputBox({
        prompt: localize('perforce.unshelveByNumber.prompt', 'Changelist number to unshelve'),
      })
      const id = changelist?.trim()
      if (!id) return
      if (!/^\d+$/.test(id)) {
        await window.showWarningMessage(
          localize('perforce.unshelveByNumber.invalid', 'Enter a numeric changelist id.'),
        )
        return
      }
      const BTN_UNSHELVE = localize('perforce.btn.unshelve', 'Unshelve')
      const confirm = await window.showWarningMessage(
        localize(
          'perforce.unshelveByNumber.confirm',
          'Unshelve changelist #{0}? This overwrites local copies of any files it touches.',
          { 0: id },
        ),
        BTN_UNSHELVE,
      )
      if (confirm !== BTN_UNSHELVE) return
      await target.unshelveByNumber(id)
    }),

    // Delete a whole changelist's shelf (group header) or a single shelved file (row).
    commands.registerCommand('perforce.deleteShelved', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      const changelist = groupChangelistId(arg)
      if (!target || !changelist || changelist === 'default') return
      const depotFile = resourcePath(arg)
      const BTN_DELETE = localize('perforce.btn.deleteShelved', 'Delete Shelved')
      const message = depotFile
        ? localize('perforce.deleteShelved.confirmFile', "Delete shelved file '{0}'?", {
            0: depotFile,
          })
        : localize('perforce.deleteShelved.confirm', 'Delete shelved files in changelist #{0}?', {
            0: changelist,
          })
      const confirm = await window.showWarningMessage(message, BTN_DELETE)
      if (confirm !== BTN_DELETE) return
      if (depotFile) await target.deleteShelvedFile(changelist, depotFile)
      else await target.deleteShelved(changelist)
    }),

    // --- Resolve (Phase 3) ------------------------------------------------

    commands.registerCommand('perforce.resolve', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      await mgr.resolveClient({ resourceUri: paths[0]! })?.resolve(paths)
    }),

    commands.registerCommand('perforce.resolveChangelist', async (arg) => {
      const target = mgr.resolveClient(arg) ?? mgr.active
      await target?.resolveChangelist(groupChangelistId(arg) ?? 'default')
    }),

    // Accept our side of the merge for each file (`resolve -ay`): discards the
    // incoming side. Destructive — confirm first, like revert/delete.
    commands.registerCommand('perforce.resolveAcceptYours', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      const target = mgr.resolveClient({ resourceUri: paths[0]! })
      if (!target) return
      const BTN_ACCEPT = localize('perforce.btn.acceptYours', 'Accept Yours')
      const message =
        paths.length === 1
          ? localize(
              'perforce.resolveAcceptYours.confirm',
              "Resolve '{0}' by accepting your version? The incoming changes will be discarded.",
              { 0: paths[0]! },
            )
          : localize(
              'perforce.resolveAcceptYours.confirmMany',
              'Resolve {0} files by accepting your version? The incoming changes will be discarded.',
              { 0: String(paths.length) },
            )
      const confirm = await window.showWarningMessage(message, BTN_ACCEPT)
      if (confirm !== BTN_ACCEPT) return
      await target.resolveAcceptYours(paths)
    }),

    // Accept the incoming side of the merge (`resolve -at`): discards our local
    // edits. Destructive — confirm first.
    commands.registerCommand('perforce.resolveAcceptTheirs', async (...args: unknown[]) => {
      const paths = await resolveTargetPaths(args)
      if (paths.length === 0) return
      const target = mgr.resolveClient({ resourceUri: paths[0]! })
      if (!target) return
      const BTN_ACCEPT = localize('perforce.btn.acceptTheirs', 'Accept Theirs')
      const message =
        paths.length === 1
          ? localize(
              'perforce.resolveAcceptTheirs.confirm',
              "Resolve '{0}' by accepting the incoming version? Your local changes will be discarded.",
              { 0: paths[0]! },
            )
          : localize(
              'perforce.resolveAcceptTheirs.confirmMany',
              'Resolve {0} files by accepting the incoming version? Your local changes will be discarded.',
              { 0: String(paths.length) },
            )
      const confirm = await window.showWarningMessage(message, BTN_ACCEPT)
      if (confirm !== BTN_ACCEPT) return
      await target.resolveAcceptTheirs(paths)
    }),

    // Open the 3-way merge editor for an unresolved file (base = have revision,
    // incoming = depot head, result seed = the on-disk file with p4 conflict
    // markers). Saving runs `perforce.acceptResolved` (`resolve -ay`).
    commands.registerCommand('perforce.openMergeEditor', async (...args: unknown[]) => {
      const path = resourcePath(args[0]) ?? (typeof args[0] === 'string' ? args[0] : undefined)
      if (!path) return
      await mgr.resolveClient({ resourceUri: path })?.openMergeEditor(path)
    }),

    // Runtime command — NOT declared in contributes.commands (a declared
    // same-name command without a handler would shadow this one and silently
    // no-op). The merge editor's save follow-up: the user hand-merged on disk,
    // so saving accepts that content as the resolution (`resolve -ay`).
    commands.registerCommand('perforce.acceptResolved', async (...args: unknown[]) => {
      const path = resourcePath(args[0]) ?? (typeof args[0] === 'string' ? args[0] : undefined)
      if (!path) return
      await mgr.resolveClient({ resourceUri: path })?.acceptResolved(path)
    }),

    // --- Perforce Graph (read-only submitted-change history) ----------------
    // The client the graph targets. Defaults to the active client; `setRepo`
    // switches it to another discovered client (multi-client is a later
    // refinement, but the plumbing mirrors git-graph so it's ready).
    ...(() => {
      let graphRoot: string | undefined

      const graphClient = () =>
        (graphRoot ? mgr.resolveClient({ rootUri: graphRoot }) : undefined) ?? mgr.active

      // Follow-up reads (details / file diff) must land on the client the listing
      // came from. A scoped graph resolves its client by path, which need not be
      // the ambient one; reading `describe`/`where` on the wrong client resolves
      // every localPath to null. `clientRoot` is echoed back by the renderer from
      // `P4GraphLoadResult`; absent (older/whole-graph paths) → ambient client.
      // Strict lookup on purpose: `resolveClient` falls back to the active client,
      // which would silently swallow a stale root instead of letting the explicit
      // `graphClient()` fallback below take over.
      const graphClientFor = (req: { clientRoot?: string | null } | undefined) => {
        const root = req?.clientRoot
        return (root ? mgr.resolveContaining(root) : undefined) ?? graphClient()
      }

      const DEFAULT_MAX = 300

      // Default graph scope: the opened workspace folder as a p4 filespec
      // (`<path>/...`), so the graph mirrors what the user actually has open
      // rather than the whole client depot. `wholeRepo` widens it to `//...`.
      const workspaceScope = buildScopeFilespec(root, true)

      /**
       * The client + filespecs ONE graph read should use, resolved in one place
       * because the listing and the have-point probe are now two separate
       * commands: the renderer badges the row whose id comes back, so a probe
       * scoped differently from the list can name a change the list does not hold
       * and the badge silently never shows. `list` is what `p4 changes` gets,
       * `have` what the probe gets — identical except in the whole-repo branch.
       */
      const resolveGraphScope = (
        opts: P4GraphLoadOptions,
      ):
        | {
            kind: 'ok'
            target: PerforceClient
            list: string[]
            have: string[]
            pendingScopes?: readonly { path: string; isDirectory: boolean }[]
            /**
             * The same scope in the sync ledger's coordinates — host paths plus
             * directory-ness. `list`/`have` are built FROM this (`list` is
             * post-escaping and post-`<dir>/...`-expansion, so it can never be
             * compared for containment against anything else; see
             * `graphSyncLedger.ts`). Everything that reads or writes the ledger
             * keys on THIS.
             */
            ledgerScope: SyncScopeTarget[]
          }
        | { kind: 'multiClient'; pathCount: number }
        | { kind: 'none' } => {
        const scopePaths = opts.scopePaths
        if (scopePaths !== undefined && scopePaths.length > 0) {
          // Merged history spans one workspace only, same as sync: a union
          // across clients has no single ordered changelist list to show.
          const owner = resolveCommonClient(
            scopePaths.map((s) => s.path),
            (p) => mgr.resolveContaining(p),
          )
          if (owner === undefined) {
            // A single path that resolves to no client is not a merge problem —
            // it's simply outside every workspace (the palette entry acting on a
            // non-Perforce active file). Keep the pre-existing behaviour: null,
            // which the renderer renders as the plain "no changes" empty state.
            if (scopePaths.length === 1) {
              log(`[perforce] graph scope path is in no client: ${scopePaths[0]!.path}`)
              return { kind: 'none' }
            }
            return { kind: 'multiClient', pathCount: scopePaths.length }
          }
          // Directory expansion (`<dir>/...`), metachar escaping, dedupe and
          // nested-under-a-selected-directory collapsing all live here. One
          // build, both consumers — never rebuild it for the probe.
          const specs = buildSyncFilespecs(scopePaths)
          return {
            kind: 'ok',
            target: owner,
            list: specs,
            have: specs,
            pendingScopes: scopePaths,
            ledgerScope: [...scopePaths],
          }
        }
        const target = graphClient()
        if (!target) return { kind: 'none' }
        if (!opts.wholeRepo) {
          // The listing's own scope, so the probe asks exactly the question the
          // rows answer to. Narrowing this to the client root would let a sync
          // point produced by files OUTSIDE the opened folder badge a row the
          // folder never synced.
          return {
            kind: 'ok',
            target,
            list: [workspaceScope],
            have: [workspaceScope],
            ledgerScope: [{ path: root, isDirectory: true }],
          }
        }
        // `//...` cannot carry a revision specifier at all (p4: `Path '…' is not
        // under client's root`), so the probe asks the client root's wildcard
        // instead. Still the same answer: a have revision only exists for files
        // the view maps under that root, and those are a subset of what `//...`
        // lists — so the id can never fall outside the listing.
        return {
          kind: 'ok',
          target,
          list: ['//...'],
          have: [buildScopeFilespec(target.root, true)],
          ledgerScope: [{ path: target.root, isDirectory: true }],
        }
      }

      return [
        commands.registerCommand('perforce-graph.getRepos', () =>
          mgr.all.map((c) => ({ root: c.root, name: c.clientName })),
        ),
        commands.registerCommand('perforce-graph.setRepo', (...args: unknown[]) => {
          const next = args[0] as string
          if (next) graphRoot = next
          return true
        }),
        commands.registerCommand('perforce-graph.getChanges', async (...args: unknown[]) => {
          const opts = (args[0] ?? {}) as P4GraphLoadOptions
          const max = opts.maxChanges ?? DEFAULT_MAX

          const resolved = resolveGraphScope(opts)
          if (resolved.kind === 'multiClient') {
            log(`[perforce] graph scope spans multiple clients (${resolved.pathCount} paths)`)
            await window.showErrorMessage(
              localize(
                'perforce.graph.multiClient',
                'The selected paths are not in one Perforce workspace, so their history cannot be merged.',
              ),
            )
            return {
              changes: [],
              head: null,
              headClient: null,
              moreAvailable: false,
              pendingCount: 0,
              error: 'multiClient',
            } satisfies P4GraphLoadResult
          }
          if (resolved.kind === 'none') return null
          const { target, list, pendingScopes } = resolved
          if (opts.scopePaths !== undefined && opts.scopePaths.length > 0) {
            log(`[perforce] graph scoped to ${list.length} filespec(s): ${list.join(' ')}`)
          }

          const [listing, pendingCount] = await Promise.all([
            target.getGraphChanges(max, list),
            target.getPendingCount(pendingScopes),
          ])
          if (!listing) return null
          const { moreAvailable } = listing
          const visible = listing.changes.slice(0, max)
          const dtos = visible.map(
            (c, i) =>
              ({
                id: c.id,
                parents: visible[i + 1] ? [visible[i + 1]!.id] : [],
                author: c.author,
                client: c.client,
                date: c.date,
                message: c.message,
                body: c.body,
              }) satisfies P4GraphChangeDto,
          )
          return {
            changes: dtos,
            head: visible[0]?.id ?? null,
            headClient: target.clientName,
            moreAvailable,
            pendingCount,
            clientRoot: target.root,
          } satisfies P4GraphLoadResult
        }),
        // The have-point probe, split out of `getChanges` on purpose. Its cost is
        // the size of the scope, not of the answer: `p4 changes -m 1 <spec>#have`
        // measured ~40s on a million-file workspace (an indexed 200ms without the
        // revision specifier). The renderer asks only when the ledger has nothing
        // (or when the user asks outright), so this is now the expensive
        // EXCEPTION rather than the price of opening the graph.
        commands.registerCommand(
          'perforce-graph.getHaveChange',
          async (...args: unknown[]): Promise<P4GraphHaveChangeResult> => {
            const opts = (args[0] ?? {}) as P4GraphHaveChangeOptions
            const resolved = resolveGraphScope(opts)
            // No client to ask (or several, which is an error the listing itself
            // reported) is "no answer", not "nothing synced": the renderer keeps
            // whatever badge it had.
            if (resolved.kind !== 'ok') return { id: null, failed: true }
            // When the question was asked, not when it was answered. The answer
            // describes the have table as p4 read it — somewhere between these
            // two instants — so dating it at dispatch is the conservative choice:
            // it can never claim to be newer than it is, and a get that happened
            // while a slow probe was out therefore wins the ledger's
            // newest-wins comparison instead of being overwritten by a stale
            // answer stamped with the time it happened to arrive.
            const askedAt = Date.now()
            const result = await resolved.target.getGraphHaveChange(
              resolved.have,
              opts.force === true,
            )
            if (!ledger) return result
            if (result.failed) return result
            // Only an answer that really went to the server may be written down.
            // A non-forced probe eats `P4CacheNs.haveChange` (TTL = the longer of
            // the workspace TTL and 5min), so it can be a REPLAY of a reply from
            // before a get that has been recorded since — stamped `askedAt` it
            // would outrank that newer record, and in the rollback direction that
            // means claiming a changelist the scope no longer has. The auto-probe
            // still answers the tab it was asked for; it just does not get to
            // speak for the workspace afterwards. (The button is `force`, so it
            // always reaches p4 and always lands here.)
            if (opts.force !== true) return result
            if (result.id === null) {
              // The server says nothing here is synced. That is an answer, and it
              // must outrank whatever the ledger thought it knew — otherwise a
              // stale entry keeps outliving the truth it no longer describes,
              // which is precisely the freezing a query exists to break.
              ledger.recordEmpty(resolved.target.root, resolved.ledgerScope, askedAt, 'query')
              return result
            }
            // Truth beats bookkeeping: a query that answered overwrites the
            // record, so a get done outside the editor is reflected the moment
            // anyone asks (and stays reflected afterwards, with no second query).
            ledger.record({
              clientRoot: resolved.target.root,
              paths: resolved.ledgerScope,
              change: result.id,
              source: 'query',
              at: askedAt,
              complete: true,
              // Read-only: a query moves no file, so it can never be why a WIDER
              // record went stale. Without this, asking about a folder whose sync
              // point never touched it (the answer reads lower than the client's
              // by construction — see `#have`) would retire the client's own
              // answer and put `#? (click to query)` back on the whole-repo graph.
              floor: NO_REGRESSION,
            })
            return result
          },
        ),
        // The ledger's answer — plus whatever the tools outside the editor
        // recorded, which is newer than a get of ours more often than not in a
        // workspace people pull with them. Both go into ONE comparison, so a
        // newer external record wins and a query's tombstone still outranks it.
        // Zero p4 calls, synchronous. This is what the graph reads on every load
        // and scope switch; `getHaveChange` is only reached when this comes back
        // empty (and the scope is narrow enough to be worth asking about) or
        // when the user presses the query button.
        commands.registerCommand(
          'perforce-graph.getSyncPoint',
          (...args: unknown[]): P4GraphSyncPoint | null => {
            if (!ledger) return null
            const opts = (args[0] ?? {}) as P4GraphLoadOptions
            const resolved = resolveGraphScope(opts)
            if (resolved.kind !== 'ok') return null
            const answer = ledger.lookup(
              resolved.target.root,
              resolved.ledgerScope,
              externalSyncPoints.read(resolved.target.root),
            )
            if (!answer) return null
            if (answer.record.source === 'external') {
              // Which file it came from is logged where the file is read; this
              // line ties that record to the answer the graph is about to show.
              log(
                `[perforce] graph sync point: #${answer.record.change} over ${resolved.ledgerScope
                  .map((p) => p.path)
                  .join(', ')} recorded outside the editor`,
              )
            }
            return {
              id: answer.record.change,
              source: answer.record.source,
              at: answer.record.at,
              widerScope: answer.widerScope,
              partial: !answer.record.complete,
            }
          },
        ),
        commands.registerCommand('perforce-graph.getChangeDetails', async (...args: unknown[]) => {
          const id = args[0] as string
          // Pin the read to the client the listing came from: a scoped graph
          // resolves its client by path, which need not be the ambient one, and
          // reading `describe`/`where` on the wrong client yields null localPaths.
          const target = graphClientFor(args[1] as P4GraphChangeDetailsOptions | undefined)
          if (!target) return null
          const detail = await target.getGraphChangeDetails(id)
          if (!detail) return null
          return {
            id: detail.id,
            author: detail.author,
            client: detail.client,
            date: detail.date,
            body: detail.body,
            files: detail.files.map(
              (f) =>
                ({
                  status: statusFromAction(f.action),
                  path: displayPath(f.depotFile),
                  oldPath: null,
                  depotFile: f.depotFile,
                  rev: f.rev,
                  localPath: detail.localPaths.get(f.depotFile) ?? null,
                }) satisfies P4GraphFileChangeDto,
            ),
          } satisfies P4GraphChangeDetailsDto
        }),
        commands.registerCommand('perforce-graph.getPendingChanges', async () => {
          const target = graphClient()
          if (!target) return []
          const opened = await target.getOpenedForGraph()
          return opened.map((f) => {
            const status = statusFromAction(f.action)
            return {
              status,
              path: displayPath(f.depotFile),
              oldPath: null,
              depotFile: f.depotFile,
              rev: f.rev ?? '',
              localPath: f.localPath,
            } satisfies P4GraphFileChangeDto
          })
        }),
        // Open Commit: the blame/status-bar route. Resolves the uri's client
        // (falling back to the graph's current client) and opens the whole
        // changelist in the commit-changes view.
        commands.registerCommand('perforce.viewCommit', async (...args: unknown[]) => {
          await viewChangelist(mgr, graphClient, args[0], args[1], log)
        }),
        commands.registerCommand('perforce-graph.openFileDiff', async (...args: unknown[]) => {
          const req = args[0] as P4GraphFileDiffRequest
          const target = graphClientFor(req)
          if (!target) return
          await openGraphFileDiff(target, req, args[1] as { preserveFocus?: boolean } | undefined)
        }),
        commands.registerCommand(
          'perforce-graph.openWorkingTreeFile',
          async (...args: unknown[]) => {
            const localPath = args[0] as string
            if (!localPath) return
            // Pending files: show the have-revision vs local diff (mirrors the
            // SCM row's Open Changes), falling back to opening the file.
            await mgr.resolveClient({ resourceUri: localPath })?.openChange(localPath)
          },
        ),
        // P4V-style "get revision as of a changelist": run a `p4 sync` scoped
        // to the change. Moves the workspace's *have* revisions, never the
        // depot. Scope filespecs are passed bare — `_syncTargets` joins the
        // `@CL` suffix after escaping, so nothing here may carry one itself.
        commands.registerCommand('perforce-graph.syncToChange', async (...args: unknown[]) => {
          const req = (args[0] ?? {}) as P4GraphSyncRequest
          const spec = clSpecOf(req.change)
          if (!spec) {
            await window.showErrorMessage(
              localize('perforce.graphSync.invalidChange', 'Invalid changelist: {0}', {
                0: req.change,
              }),
            )
            return
          }

          const scopes = req.scopePaths
          let target: PerforceClient
          let filespecs: string[]
          // What this get covers as host paths, for the sync ledger. The graph
          // scopes are named in the same coordinates as every other entry point
          // (the selected paths, the opened folder, the client root), so a get
          // started here answers a later lookup from the Explorer or timeline —
          // and vice versa.
          let ledgerScope: SyncScopeTarget[]
          if (scopes !== undefined && scopes.length > 0) {
            // Data-query semantics: strict longest-prefix per path, and every
            // path must land in the same client — a sync spans one workspace.
            const owner = resolveCommonClient(
              scopes.map((s) => s.path),
              (p) => mgr.resolveContaining(p),
            )
            if (owner === undefined) {
              await window.showErrorMessage(
                localize(
                  'perforce.graphSync.noCommonClient',
                  'The selected paths are not in one Perforce workspace, so they cannot be synced to that changelist.',
                ),
              )
              return
            }
            target = owner
            filespecs = buildSyncFilespecs(scopes)
            ledgerScope = [...scopes]
          } else {
            const client = graphClient()
            if (!client) return
            target = client
            filespecs = [req.wholeRepo ? '//...' : workspaceScope]
            // The whole-repo branch lists `//...`, which is every file the
            // client's view maps — the client root, not the opened folder.
            ledgerScope = req.wholeRepo
              ? clientRootScope(client)
              : [{ path: root, isDirectory: true }]
          }

          const scopeList = filespecs.join(', ')
          if (filespecs.length === 0) {
            // `_syncTargets` falls back to the configured sync scope when the
            // list is empty, so an empty list would silently widen this get from
            // "the requested paths" to `//...` — and under `force` that means
            // overwriting uncollected work across the whole client, with a
            // confirmation dialog naming no scope at all. Refuse rather than let
            // the fallback reinterpret what the user asked for.
            await window.showErrorMessage(
              localize(
                'perforce.graphSync.emptyScope',
                'No sync scope: the request carried no usable path.',
              ),
            )
            return
          }
          const confirmKind = graphSyncConfirmKind({
            ...(scopes !== undefined ? { scopePaths: scopes } : {}),
            ...(req.isLatest !== undefined ? { isLatest: req.isLatest } : {}),
            ...(req.confirmed !== undefined ? { confirmed: req.confirmed } : {}),
            ...(req.force !== undefined ? { force: req.force } : {}),
          })
          if (confirmKind === 'force') {
            if (!(await confirmForceGet(spec, scopeTextOf(filespecs)))) return
          } else if (confirmKind === 'timeTravel') {
            const BTN_SYNC = localize('perforce.btn.confirmSync', 'Confirm Sync')
            const BTN_CANCEL = localize('perforce.btn.cancel', 'Cancel')
            const picked = await window.showWarningMessage(
              localize(
                'perforce.graphSync.timeTravelConfirm',
                'Files that are not open for edit will be reset to their state as of changelist {0}. Files that are open (checked out) are protected by the server and are left alone.',
                { 0: spec },
              ),
              BTN_SYNC,
              BTN_CANCEL,
            )
            if (picked !== BTN_SYNC) return
          }
          // Whether this get can write the row's changelist down without asking
          // p4 first (see `directSyncPoint`). Judged here because the listing
          // scope has to be resolved by the very function that served the
          // listing — anything derived from THIS get's own scope would make the
          // coverage test trivially true, which is exactly the mistake the
          // multi-directory dialog would otherwise hide.
          let knownLanding: KnownLanding | undefined
          // No `listScope` = nothing was established, and the get falls back to
          // asking p4 — never to guessing. Deliberately NOT "resolve an absent
          // listScope as the opened folder": that would hand a caller which only
          // echoed `clientRoot` a listing scope that makes the coverage test pass
          // by construction (the unscoped get covers that very folder), which is
          // the over-report this whole judgment exists to prevent.
          if (req.listScope !== undefined) {
            const listed = resolveGraphScope(req.listScope)
            if (listed.kind !== 'ok') {
              log(`[perforce] sync ledger: read-back (row's listing unusable: ${listed.kind})`)
            } else {
              // The bare id: `spec` is the `@CL` p4 syntax, while the ledger
              // stores the id the graph's rows carry.
              const claim = directSyncPoint({
                change: spec.slice(1),
                getScope: ledgerScope,
                getClientRoot: target.root,
                listed: {
                  scope: listed.ledgerScope,
                  clientRoot: listed.target.root,
                  wholeRepo: req.listScope.wholeRepo === true,
                },
                ...(req.clientRoot !== undefined ? { displayedClientRoot: req.clientRoot } : {}),
              })
              if (claim.ok) {
                knownLanding = { change: claim.change }
              } else {
                // Only a request that CLAIMED to know says why it was not
                // believed; every other entry point never claimed anything.
                log(`[perforce] sync ledger: read-back (row claim unusable: ${claim.reason})`)
              }
            }
          }
          // Provenance for the graph's gets: the client logs every sync's counts
          // (and the `-f` marker), but only this line says the get came from a
          // graph row and which scope it asked for.
          log(
            `[perforce] graph sync${req.force === true ? ' -f' : ''} ${scopeList.slice(0, 500)}${
              scopeList.length > 500 ? `… (${filespecs.length} filespecs)` : ''
            } to ${spec}`,
          )
          await runSync(target, spec, {
            scope: filespecs,
            ...(scopes !== undefined && scopes.length > 0 ? { scopeTargets: scopes } : {}),
            ledgerScope,
            ...(knownLanding !== undefined ? { knownLanding } : {}),
            ...(req.force === true ? { force: true } : {}),
          })
        }),
        // The top-level directories of the graph client's root, for the
        // multi-directory "Get Revision…" dialog. A plain filesystem read —
        // zero p4 calls; any failure (missing root, permission) reads as
        // "no scopes" and the dialog explains it cannot list folders.
        commands.registerCommand(
          'perforce-graph.getSyncScopes',
          async (): Promise<P4GraphSyncScopeDto[]> => {
            const client = graphClient()
            if (!client) return []
            try {
              const entries = await readdir(client.root, { withFileTypes: true })
              return entries
                .filter((e) => e.isDirectory())
                .map((e) => ({ name: e.name, path: join(client.root, e.name) }))
                .sort((a, b) => a.name.localeCompare(b.name))
            } catch {
              return []
            }
          },
        ),
      ]
    })(),
  )
}

export function deactivate(): void {
  // Disposables on context.subscriptions (clients, status bar, commands) handle teardown.
}
