/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Registers the renderer-side Swarm Reviews list filter settings. These are
 *  consumed by SwarmReviewsView (author set + approvable-only for "Needs My
 *  Action", hide-approved for "Authored by Me") and persisted to settings.json
 *  under `perforce.swarm.*`, so they survive reloads and can be edited by hand.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationRegistry,
  Disposable,
  IWorkbenchContribution,
  localize,
} from '@universe-editor/platform'
import { SwarmFilterConfigKeys } from '../services/swarm/swarmReviewFilter.js'

export class SwarmConfigurationContribution extends Disposable implements IWorkbenchContribution {
  constructor() {
    super()
    this._register(
      ConfigurationRegistry.registerConfiguration({
        id: 'perforce.swarm.reviewsView',
        title: localize('settings.swarm.reviewsView', 'Swarm Reviews'),
        properties: {
          [SwarmFilterConfigKeys.needsActionAuthors]: {
            type: 'array',
            items: { type: 'string' },
            default: [],
            description: localize(
              'settings.swarm.needsActionAuthors',
              'Only show reviews in "Needs My Action" whose author is in this set. Empty shows all authors.',
            ),
          },
          [SwarmFilterConfigKeys.needsActionApprovableOnly]: {
            type: 'boolean',
            default: false,
            description: localize(
              'settings.swarm.needsActionApprovableOnly',
              'Only show reviews in "Needs My Action" that you can currently approve.',
            ),
          },
          [SwarmFilterConfigKeys.authoredHideApproved]: {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.swarm.authoredHideApproved',
              'Hide already-approved reviews from the "Authored by Me" group.',
            ),
          },
          'perforce.swarm.notifications.enabled': {
            type: 'boolean',
            default: true,
            description: localize(
              'settings.swarm.notifications.enabled',
              'Show an OS desktop notification when a new review enters "Needs My Action" while the editor window is not focused. Clicking the notification opens the review.',
            ),
          },
        },
      }),
    )
  }
}
