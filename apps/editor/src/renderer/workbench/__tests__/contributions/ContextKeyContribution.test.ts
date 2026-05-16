import { afterEach, describe, expect, it } from 'vitest'
import {
  ContextKeyService,
  LifecyclePhase,
  LifecycleService,
  observableValue,
  PartId,
  type HostPlatform,
} from '@universe-editor/platform'
import { ContextKeyContribution } from '../../../contributions/ContextKeyContribution.js'

function makeLayoutStub(initial?: Partial<Record<PartId, boolean>>) {
  const visible = observableValue<Readonly<Record<PartId, boolean>>>('layout', {
    [PartId.ActivityBar]: true,
    [PartId.SideBar]: true,
    [PartId.SecondarySideBar]: false,
    [PartId.EditorArea]: true,
    [PartId.Panel]: false,
    [PartId.StatusBar]: true,
    ...initial,
  })
  return { visible }
}

function makeEditorStub() {
  const activeEditor = observableValue<{ id: string } | undefined>('activeEditor', undefined)
  return { activeEditor }
}

function makeHostStub(platform: HostPlatform) {
  return { platform }
}

describe('ContextKeyContribution', () => {
  let contribution: ContextKeyContribution | undefined

  afterEach(() => {
    contribution?.dispose()
    contribution = undefined
  })

  it('seeds platform keys: exactly one of isWindows/isMac/isLinux is true', () => {
    const ctx = new ContextKeyService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('darwin') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      new LifecycleService(),
    )
    expect(ctx.get('isWindows')).toBe(false)
    expect(ctx.get('isMac')).toBe(true)
    expect(ctx.get('isLinux')).toBe(false)
    ctx.dispose()
  })

  it('reflects initial Part visibility', () => {
    const ctx = new ContextKeyService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub({ [PartId.SideBar]: true, [PartId.Panel]: false }) as never,
      makeEditorStub() as never,
      new LifecycleService(),
    )
    expect(ctx.get('sideBarVisible')).toBe(true)
    expect(ctx.get('panelVisible')).toBe(false)
    ctx.dispose()
  })

  it('synchronises sideBarVisible when LayoutService.visible changes', () => {
    const ctx = new ContextKeyService()
    const layout = makeLayoutStub({ [PartId.SideBar]: true })
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('linux') as never,
      layout as never,
      makeEditorStub() as never,
      new LifecycleService(),
    )
    expect(ctx.get('sideBarVisible')).toBe(true)
    layout.visible.set({ ...layout.visible.get(), [PartId.SideBar]: false }, undefined)
    expect(ctx.get('sideBarVisible')).toBe(false)
    ctx.dispose()
  })

  it('synchronises activeEditorId / hasActiveEditor on editor change', () => {
    const ctx = new ContextKeyService()
    const editor = makeEditorStub()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      editor as never,
      new LifecycleService(),
    )
    expect(ctx.get('hasActiveEditor')).toBe(false)
    expect(ctx.get('activeEditorId')).toBeUndefined()
    editor.activeEditor.set({ id: 'file:///a.lua' }, undefined)
    expect(ctx.get('hasActiveEditor')).toBe(true)
    expect(ctx.get('activeEditorId')).toBe('file:///a.lua')
    ctx.dispose()
  })

  it('sets workbenchReady once the Ready phase is reached', async () => {
    const ctx = new ContextKeyService()
    const lifecycle = new LifecycleService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      lifecycle,
    )
    expect(ctx.get('workbenchReady')).toBe(false)
    lifecycle.setPhase(LifecyclePhase.Ready)
    await lifecycle.when(LifecyclePhase.Ready)
    expect(ctx.get('workbenchReady')).toBe(true)
    ctx.dispose()
  })

  it('sets workbenchRestored once the Restored phase is reached', async () => {
    const ctx = new ContextKeyService()
    const lifecycle = new LifecycleService()
    contribution = new ContextKeyContribution(
      ctx,
      makeHostStub('win32') as never,
      makeLayoutStub() as never,
      makeEditorStub() as never,
      lifecycle,
    )
    expect(ctx.get('workbenchRestored')).toBe(false)
    lifecycle.setPhase(LifecyclePhase.Restored)
    await lifecycle.when(LifecyclePhase.Restored)
    expect(ctx.get('workbenchRestored')).toBe(true)
    ctx.dispose()
  })
})
