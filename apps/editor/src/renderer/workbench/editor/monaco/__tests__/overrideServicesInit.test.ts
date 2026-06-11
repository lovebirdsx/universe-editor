/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Regression: Monaco's StandaloneServices apply override services only on first
 *  init, and the first StandaloneServices.get() silently inits with an empty
 *  override set. loadMonaco() calls setTheme/createModel (both resolve standalone
 *  services) during boot, so unless we explicitly initialize with our overrides
 *  FIRST, the references peek tree falls back to the default ITextModelService
 *  and throws "Model not found" for files the user hasn't opened.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'

const rec = vi.hoisted(() => {
  const order: string[] = []
  const state: { initOverrides?: Record<string, unknown> } = {}
  return {
    order,
    state,
    reset() {
      order.length = 0
      delete state.initOverrides
    },
  }
})

vi.mock('monaco-editor', () => {
  const editor = {
    setTheme: () => rec.order.push('setTheme'),
    createModel: () => {
      rec.order.push('createModel')
      return { dispose: () => {} }
    },
    getModel: () => null,
    addKeybindingRule: () => {},
    defineTheme: () => {},
    create: () => ({}),
  }
  const makeDefaults = () => ({
    diagnosticsOptions: {},
    modeConfiguration: {},
    options: {},
    setDiagnosticsOptions: () => {},
    setModeConfiguration: () => {},
    setOptions: () => {},
  })
  const languages = {
    register: () => {},
    setMonarchTokensProvider: () => ({ dispose: () => {} }),
  }
  const json = { jsonDefaults: makeDefaults() }
  const typescript = { typescriptDefaults: makeDefaults(), javascriptDefaults: makeDefaults() }
  const css = {
    cssDefaults: makeDefaults(),
    lessDefaults: makeDefaults(),
    scssDefaults: makeDefaults(),
  }
  const html = {
    htmlDefaults: makeDefaults(),
    handlebarDefaults: makeDefaults(),
    razorDefaults: makeDefaults(),
  }
  return { editor, languages, json, typescript, css, html }
})

vi.mock('monaco-editor/esm/vs/editor/editor.worker?worker', () => ({ default: class {} }))
vi.mock('monaco-editor/esm/vs/language/json/json.worker?worker', () => ({ default: class {} }))
vi.mock('monaco-editor/esm/vs/language/typescript/ts.worker?worker', () => ({ default: class {} }))
vi.mock('monaco-editor/esm/vs/language/css/css.worker?worker', () => ({ default: class {} }))
vi.mock('monaco-editor/esm/vs/language/html/html.worker?worker', () => ({ default: class {} }))

vi.mock('monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js', () => ({
  StandaloneServices: {
    initialize: (overrides: Record<string, unknown>) => {
      rec.order.push('initialize')
      rec.state.initOverrides = overrides
    },
  },
}))

// Keep boot side-effects quiet so the test exercises only the init ordering.
vi.mock('../monacoActionsBridge.js', () => ({ bridgeAllMonacoActions: () => Promise.resolve() }))
vi.mock('../monacoNlsBootstrap.js', () => ({ applyMonacoNls: () => {} }))

afterEach(() => {
  vi.resetModules()
  rec.reset()
})

describe('MonacoLoader override-services initialization', () => {
  it('initializes StandaloneServices with our overrides before any service is resolved', async () => {
    // The renderer setup file pre-warms a separate MonacoLoader instance (with no
    // overrides). Reset the module graph so we drive a fresh loader, then clear
    // anything the pre-warm recorded.
    vi.resetModules()
    rec.reset()
    const { MonacoLoader } = await import('../MonacoLoader.js')
    const bulk = { __bulk: true }
    const text = { __text: true }
    MonacoLoader.setBulkEditService(bulk)
    MonacoLoader.setTextModelService(text)

    await MonacoLoader.ensureInitialized()

    // initialize must run, and run before the first setTheme / createModel which
    // would otherwise silently init with an empty override set.
    expect(rec.order[0]).toBe('initialize')
    expect(rec.order).toContain('setTheme')
    expect(rec.order).toContain('createModel')
    expect(rec.order.indexOf('initialize')).toBeLessThan(rec.order.indexOf('setTheme'))
    expect(rec.order.indexOf('initialize')).toBeLessThan(rec.order.indexOf('createModel'))

    // and it must carry our overrides, keyed by the service-id strings Monaco's
    // decorators were created with.
    expect(rec.state.initOverrides?.['textModelService']).toBe(text)
    expect(rec.state.initOverrides?.['IWorkspaceEditService']).toBe(bulk)
  })
})
