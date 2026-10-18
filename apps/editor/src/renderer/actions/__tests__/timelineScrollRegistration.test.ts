import { describe, expect, it } from 'vitest'
import { CommandsRegistry } from '@universe-editor/platform'
import {
  ScrollAcpTimelineDownAction,
  ScrollAcpTimelineToBottomAction,
  ScrollAcpTimelineToTopAction,
  ScrollAcpTimelineUpAction,
} from '../agentTimelineActions.js'
import '../index.js'

// Regression: the to-top/to-bottom actions lived in agentTimelineActions but
// were never registered by the production barrel, so their keybindings silently
// did nothing while unit tests (which register actions themselves) stayed green.
describe('timeline scroll action registration', () => {
  it('registers every timeline scroll action in the production barrel', () => {
    const actions = [
      ScrollAcpTimelineUpAction,
      ScrollAcpTimelineDownAction,
      ScrollAcpTimelineToTopAction,
      ScrollAcpTimelineToBottomAction,
    ]
    for (const action of actions) {
      expect(CommandsRegistry.getCommand(action.ID), action.ID).toBeDefined()
    }
  })
})
