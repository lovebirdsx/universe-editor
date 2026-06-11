/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpSessionFilterService — shared, ephemeral search state for the AGENTS
 *  session list. The trigger button lives in the view title bar
 *  (AgentsViewToolbar / SessionsPopover) while the find widget and the filtered
 *  list live in the body (SessionListBody); they have no common React ancestor,
 *  so the open/query state is held here as observables. Not persisted.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  Disposable,
  InstantiationType,
  observableValue,
  registerSingleton,
  type IObservable,
  type ISettableObservable,
} from '@universe-editor/platform'

export interface IAcpSessionFilterService {
  readonly _serviceBrand: undefined
  readonly searchOpen: IObservable<boolean>
  readonly query: IObservable<string>
  setQuery(value: string): void
  openSearch(): void
  closeSearch(): void
  toggleSearch(): void
}

export const IAcpSessionFilterService =
  createDecorator<IAcpSessionFilterService>('acpSessionFilterService')

export class AcpSessionFilterService extends Disposable implements IAcpSessionFilterService {
  declare readonly _serviceBrand: undefined

  private readonly _searchOpen: ISettableObservable<boolean> = observableValue(
    'acp.sessionSearchOpen',
    false,
  )
  private readonly _query: ISettableObservable<string> = observableValue(
    'acp.sessionSearchQuery',
    '',
  )

  readonly searchOpen: IObservable<boolean> = this._searchOpen
  readonly query: IObservable<string> = this._query

  setQuery(value: string): void {
    this._query.set(value, undefined)
  }

  openSearch(): void {
    this._searchOpen.set(true, undefined)
  }

  closeSearch(): void {
    this._query.set('', undefined)
    this._searchOpen.set(false, undefined)
  }

  toggleSearch(): void {
    if (this._searchOpen.get()) this.closeSearch()
    else this.openSearch()
  }
}

registerSingleton(IAcpSessionFilterService, AcpSessionFilterService, InstantiationType.Delayed)
