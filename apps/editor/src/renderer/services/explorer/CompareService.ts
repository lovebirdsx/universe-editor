/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  CompareService — remembers the single resource picked via "Select for
 *  Compare" so a later "Compare with Selected" can diff against it. Mirrors
 *  VSCode's `resourceSelectedForCompare` state. In-memory only.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  createDecorator,
  type Event,
  type URI,
} from '@universe-editor/platform'

export interface ICompareService {
  readonly _serviceBrand: undefined
  readonly onDidChange: Event<void>
  /** The resource remembered as the left-hand side of a comparison, or null. */
  readonly selectedResource: URI | null
  selectForCompare(resource: URI): void
  clear(): void
}

export const ICompareService = createDecorator<ICompareService>('compareService')

export class CompareService extends Disposable implements ICompareService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  private _selectedResource: URI | null = null

  get selectedResource(): URI | null {
    return this._selectedResource
  }

  selectForCompare(resource: URI): void {
    this._selectedResource = resource
    this._onDidChange.fire()
  }

  clear(): void {
    if (this._selectedResource === null) return
    this._selectedResource = null
    this._onDidChange.fire()
  }
}
