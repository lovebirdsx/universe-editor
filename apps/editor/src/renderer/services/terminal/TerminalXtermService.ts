/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TerminalXtermService — owns the live xterm.js instance per terminalId.
 *
 *  The xterm instance and its wrapper DOM node live for the whole terminal
 *  process lifetime, decoupled from React. Views (panel / editor) only reparent
 *  the wrapper into their host element on mount and detach it on unmount — the
 *  instance is never disposed/recreated on a view switch, so cursor, scroll
 *  position and selection survive. The instance is released only when the
 *  terminal process is closed or exits (driven by onDidRemoveTerminal).
 *--------------------------------------------------------------------------------------------*/

import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import {
  createDecorator,
  Disposable,
  DisposableStore,
  Emitter,
  IConfigurationService,
  InstantiationType,
  registerSingleton,
  type Event,
  type URI,
} from '@universe-editor/platform'
import { ITerminalManagerService } from './TerminalManagerService.js'
import { createFileLinkProvider } from '../../workbench/panel/terminal/terminalLinkProvider.js'
import {
  copyTerminalSelection,
  handleTerminalClipboardKey,
  pasteClipboardIntoTerminal,
} from '../../workbench/panel/terminal/terminalClipboard.js'

const DEFAULT_SCROLLBACK = 5000

export interface ITerminalLinkHandlers {
  resolveFile: (absolutePath: string) => Promise<URI | null>
  openFile: (uri: URI, line?: number, col?: number) => void
  getCwd: () => string
}

export interface ITerminalXtermHolder {
  readonly term: Terminal
  readonly wrapper: HTMLElement
  readonly onDidChangeSelection: Event<void>
  setLinkHandlers(handlers: ITerminalLinkHandlers): void
  /** Move the wrapper into a host element and repaint/restore. */
  reattachTo(host: HTMLElement): void
  fit(): void
  scheduleFit(): void
  saveScroll(): void
  restoreScroll(): void
  focus(): void
  hasSelection(): boolean
  copy(): Promise<void>
  paste(): Promise<void>
}

export interface ITerminalXtermService {
  readonly _serviceBrand: undefined
  /** Lazily create (or return) the persistent xterm holder for a terminal. */
  acquire(id: string): ITerminalXtermHolder
  get(id: string): ITerminalXtermHolder | undefined
  release(id: string): void
}

export const ITerminalXtermService = createDecorator<ITerminalXtermService>('terminalXtermService')

// ---------------------------------------------------------------------------

function isDarkTheme(config: IConfigurationService): boolean {
  return config.get<string>('workbench.colorTheme') !== 'light'
}

function themeFor(isDark: boolean) {
  return isDark
    ? { background: '#1a1a1c', foreground: '#cccccc', cursor: '#cccccc' }
    : { background: '#ffffff', foreground: '#333333', cursor: '#333333' }
}

const noopHandlers: ITerminalLinkHandlers = {
  resolveFile: async () => null,
  openFile: () => {},
  getCwd: () => '',
}

class TerminalXtermHolder extends Disposable implements ITerminalXtermHolder {
  readonly term: Terminal
  readonly wrapper: HTMLElement

  private readonly _fit: FitAddon
  private readonly _onDidChangeSelection = this._register(new Emitter<void>())
  readonly onDidChangeSelection: Event<void> = this._onDidChangeSelection.event

  private _handlers: ITerminalLinkHandlers = noopHandlers
  private _hasSelection = false
  private _savedScroll: number | undefined
  private _rafId = 0
  private readonly _id: string
  private readonly _manager: ITerminalManagerService

  constructor(
    id: string,
    manager: ITerminalManagerService,
    private readonly _config: IConfigurationService,
  ) {
    super()
    this._id = id
    this._manager = manager

    this.wrapper = document.createElement('div')
    this.wrapper.style.position = 'absolute'
    this.wrapper.style.inset = '0'
    // No padding here on purpose: padding lives on the host (.instance) instead.
    // FitAddon measures this wrapper, and when the panel is CSS-hidden (Allotment
    // sets the pane to height:0) a wrapper with its own padding would still report
    // padding height as clientHeight, defeating fit()'s zero-size guard and
    // collapsing the terminal to 1 row on every toggle.

    this.term = new Terminal({
      fontFamily: 'Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: this._config.get<number>('terminal.integrated.scrollback') ?? DEFAULT_SCROLLBACK,
      theme: themeFor(isDarkTheme(this._config)),
    })
    this._fit = new FitAddon()
    this.term.loadAddon(this._fit)
    this.term.loadAddon(new WebLinksAddon())
    this.term.open(this.wrapper)
    this.term.attachCustomKeyEventHandler((event) => handleTerminalClipboardKey(event, this.term))

    // These subscriptions live for the whole terminal-process lifetime and are
    // disposed when the holder is released (onDidRemoveTerminal → release). The
    // holder is registered on the singleton TerminalXtermService, so they root
    // through it and aren't flagged as leaks while a terminal is still open.
    const store = this._register(new DisposableStore())
    store.add(manager.attach(id, (data) => this.term.write(data)))
    store.add(this.term.onData((data) => manager.input(id, data)))
    store.add(
      this.term.onSelectionChange(() => {
        this._hasSelection = this.term.hasSelection()
        this._onDidChangeSelection.fire()
      }),
    )
    store.add(
      this._config.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('workbench.colorTheme')) {
          this.term.options.theme = themeFor(isDarkTheme(this._config))
        }
        if (e.affectsConfiguration('terminal.integrated.scrollback')) {
          this.term.options.scrollback =
            this._config.get<number>('terminal.integrated.scrollback') ?? DEFAULT_SCROLLBACK
        }
      }),
    )
    store.add(
      this.term.registerLinkProvider(
        createFileLinkProvider(
          this.term,
          (absPath) => this._handlers.resolveFile(absPath),
          (uri, line, col) => this._handlers.openFile(uri, line, col),
          () => this._handlers.getCwd(),
        ),
      ),
    )

    this._register({
      dispose: () => {
        if (this._rafId) cancelAnimationFrame(this._rafId)
        this.wrapper.remove()
        this.term.dispose()
      },
    })
  }

  setLinkHandlers(handlers: ITerminalLinkHandlers): void {
    this._handlers = handlers
  }

  reattachTo(host: HTMLElement): void {
    // appendChild moves the node (single-host); remove() first is just defensive.
    this.wrapper.remove()
    host.appendChild(this.wrapper)
    this.fit()
    // The DOM renderer skips repaints while detached — force a full repaint so a
    // reattached terminal isn't blank/stale, then restore the saved viewport.
    this.term.refresh(0, this.term.rows - 1)
    this.restoreScroll()
  }

  fit(): void {
    if (this.wrapper.clientWidth === 0 || this.wrapper.clientHeight === 0) return
    const dims = this._fit.proposeDimensions()
    if (!dims || !dims.cols || !dims.rows) return
    // Guard against a transient/hidden layout where proposeDimensions clamps to
    // its 1-row minimum: never resize down to a degenerate buffer.
    if (dims.rows < 2 && this.term.rows >= 2) return
    if (dims.cols === this.term.cols && dims.rows === this.term.rows) return
    this.term.resize(dims.cols, dims.rows)
    this._manager.resize(this._id, dims.cols, dims.rows)
  }

  scheduleFit(): void {
    if (this._rafId) return
    this._rafId = requestAnimationFrame(() => {
      this._rafId = 0
      this.fit()
    })
  }

  saveScroll(): void {
    this._savedScroll = this.term.buffer.active.viewportY
  }

  restoreScroll(): void {
    if (this._savedScroll !== undefined) this.term.scrollToLine(this._savedScroll)
  }

  focus(): void {
    this.term.focus()
  }

  hasSelection(): boolean {
    return this._hasSelection
  }

  async copy(): Promise<void> {
    await copyTerminalSelection(this.term)
  }

  async paste(): Promise<void> {
    await pasteClipboardIntoTerminal(this.term)
  }
}

export class TerminalXtermService extends Disposable implements ITerminalXtermService {
  declare readonly _serviceBrand: undefined

  private readonly _holders = new Map<string, TerminalXtermHolder>()

  constructor(
    @ITerminalManagerService private readonly _manager: ITerminalManagerService,
    @IConfigurationService private readonly _config: IConfigurationService,
  ) {
    super()
    this._register(this._manager.onDidRemoveTerminal(({ id }) => this.release(id)))
  }

  acquire(id: string): ITerminalXtermHolder {
    let holder = this._holders.get(id)
    if (!holder) {
      holder = this._register(new TerminalXtermHolder(id, this._manager, this._config))
      this._holders.set(id, holder)
    }
    return holder
  }

  get(id: string): ITerminalXtermHolder | undefined {
    return this._holders.get(id)
  }

  release(id: string): void {
    const holder = this._holders.get(id)
    if (!holder) return
    this._holders.delete(id)
    // delete() both disposes the holder and removes it from this service's
    // store, so closed terminals don't accumulate as dead refs over a session.
    this._store.delete(holder)
  }

  override dispose(): void {
    this._holders.clear()
    super.dispose()
  }
}

registerSingleton(ITerminalXtermService, TerminalXtermService, InstantiationType.Delayed)
