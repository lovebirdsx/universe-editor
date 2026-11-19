/*---------------------------------------------------------------------------------------------
 *  Renderer DOM tests that still run in the no-StrictMode `renderer-dom-legacy`
 *  project because dev-only double-invoked effects break their assumptions.
 *  The list may only shrink (guard: strictModeExclusions.test.ts pins the
 *  budget). Once it is empty, delete the legacy project and this file.
 *--------------------------------------------------------------------------------------------*/

export const strictModeExcludedTests: string[] = [
  // Subscription arrays assume one effect pass; the rehearsal adds a second.
  'src/renderer/workbench/__tests__/useEventValue.test.tsx',
  // Instance-per-render assertions; the dry-run instance doubles the count.
  'src/renderer/workbench/__tests__/useScopedContextKey.test.tsx',
  // Render counts must be exactly one per commit.
  'src/renderer/workbench/agents/__tests__/ChatBody.memo.test.tsx',
  // IntersectionObserver instance / colorize call counts assume one mount.
  'src/renderer/workbench/agents/__tests__/CodeBlock.test.tsx',
  // Incremental parse counts double during the rehearsal.
  'src/renderer/workbench/agents/__tests__/ToolCallCard.test.tsx',
  // Deduplicated reads are recorded twice (one per effect pass).
  'src/renderer/workbench/agents/__tests__/useForeignSessionStats.test.tsx',
  // getModels call counts per event are doubled.
  'src/renderer/workbench/ai/__tests__/AiFeatureModelsPanel.test.tsx',
  // Reload counts and pending-request arrays assume a single mount.
  'src/renderer/workbench/ai/__tests__/AiProvidersPanel.test.tsx',
  // Asserts the editor component mounts exactly once per scope swap.
  'src/renderer/workbench/editor/__tests__/EditorGroupView.perforceGraphScopeSwap.test.tsx',
  // Asserts the editor component mounts exactly once per preview swap.
  'src/renderer/workbench/editor/__tests__/EditorGroupView.previewNav.test.tsx',
  // The rehearsal cleanup already flips the "disposed" flag under test.
  'src/renderer/workbench/extensions/__tests__/ExtensionsView.leak.test.tsx',
  // Reload counts on mount / re-mount assume one load per activation.
  'src/renderer/workbench/gitGraph/__tests__/GitGraphEditor.scmSync.test.tsx',
  // saveScroll is expected once on unmount; the dry run calls it twice.
  'src/renderer/workbench/panel/terminal/__tests__/TerminalInstance.leak.test.tsx',
  // Command counts and the clock ledger assume one query per action.
  'src/renderer/workbench/perforceGraph/__tests__/PerforceGraphEditor.test.tsx',
  // Reload counts and the cached-page array assume a single mount.
  'src/renderer/workbench/perforceSyncHistory/__tests__/PerforceSyncHistoryEditor.test.tsx',
  // Watcher subscription count is expected to be exactly one.
  'src/renderer/workbench/search/__tests__/SearchView.watcher.test.tsx',
  // Subscription dispose is expected exactly once on unmount.
  'src/renderer/workbench/triggers/__tests__/TriggerManagerEditor.test.tsx',
  // readRunReport call counts assume one refresh per trigger.
  'src/renderer/workbench/triggers/__tests__/TriggerReportEditor.test.tsx',
]

/** Lower this as files are fixed; never raise it. */
export const STRICT_MODE_EXCLUSION_BUDGET = 18
