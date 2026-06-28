/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  In-session chat widget commands: timeline keyboard navigation (Alt+J/K,
 *  scroll, collapse), the prompt-suggestion popover, in-session find (Ctrl+F),
 *  copy-focused-message, and jump-to-plan / show-changes. All route to the
 *  focused AcpChatWidget via resolveNavWidget / IAcpChatWidgetService.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IViewsService,
  MenuId,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpChatWidgetService } from '../services/acp/acpChatWidgetService.js'
import { AcpSessionEditorInput } from '../services/acp/acpSessionEditorInput.js'
import { ACP_NAV_WHEN, CATEGORY, resolveNavWidget } from './_agentShared.js'

// ---------------------------------------------------------------------------
// Timeline keyboard navigation (Alt+J / Alt+K, vim-style)
// Targets the focused AcpChatWidget via IAcpChatWidgetService. Gated by
// `acpChatFocused`, which the widget service toggles based on real DOM focus.
// ---------------------------------------------------------------------------

export class FocusNextAcpTimelineItemAction extends Action2 {
  static readonly ID = 'workbench.action.agent.focusNextTimelineItem'
  constructor() {
    super({
      id: FocusNextAcpTimelineItemAction.ID,
      title: localize2('action.agent.focusNextTimelineItem', 'Focus Next Timeline Item'),
      category: CATEGORY,
      icon: 'timeline-next',
      keybinding: [
        { primary: 'alt+down', when: ACP_NAV_WHEN },
        { primary: 'alt+j', when: ACP_NAV_WHEN },
      ],
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 3,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.moveTimeline('next')
  }
}

export class FocusPreviousAcpTimelineItemAction extends Action2 {
  static readonly ID = 'workbench.action.agent.focusPreviousTimelineItem'
  constructor() {
    super({
      id: FocusPreviousAcpTimelineItemAction.ID,
      title: localize2('action.agent.focusPreviousTimelineItem', 'Focus Previous Timeline Item'),
      category: CATEGORY,
      icon: 'timeline-prev',
      keybinding: [
        { primary: 'alt+up', when: ACP_NAV_WHEN },
        { primary: 'alt+k', when: ACP_NAV_WHEN },
      ],
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 2,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.moveTimeline('prev')
  }
}

export class FocusTopAcpTimelineAction extends Action2 {
  static readonly ID = 'workbench.action.agent.focusTopTimelineItem'
  constructor() {
    super({
      id: FocusTopAcpTimelineAction.ID,
      title: localize2('action.agent.focusTopTimelineItem', 'Focus Top Timeline Item'),
      category: CATEGORY,
      icon: 'timeline-top',
      keybinding: [
        { primary: 'alt+home', when: ACP_NAV_WHEN },
        { primary: 'alt+a', when: ACP_NAV_WHEN },
      ],
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 4,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.moveTimeline('first')
  }
}

export class FocusBottomAcpTimelineAction extends Action2 {
  static readonly ID = 'workbench.action.agent.focusBottomTimelineItem'
  constructor() {
    super({
      id: FocusBottomAcpTimelineAction.ID,
      title: localize2('action.agent.focusBottomTimelineItem', 'Focus Bottom Timeline Item'),
      category: CATEGORY,
      icon: 'timeline-bottom',
      keybinding: [
        { primary: 'alt+end', when: ACP_NAV_WHEN },
        { primary: 'alt+e', when: ACP_NAV_WHEN },
      ],
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 5,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.moveTimeline('last')
  }
}

export class JumpToAcpPlanAction extends Action2 {
  static readonly ID = 'workbench.action.agent.jumpToPlan'
  constructor() {
    super({
      id: JumpToAcpPlanAction.ID,
      title: localize2('action.agent.jumpToPlan', 'Jump to Plan'),
      category: CATEGORY,
      icon: 'go-to-plan',
      keybinding: { primary: 'alt+p', when: ACP_NAV_WHEN },
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 1,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.jumpToPlan()
  }
}

export class ShowAcpSessionChangesAction extends Action2 {
  static readonly ID = 'workbench.action.agent.showSessionChanges'
  constructor() {
    super({
      id: ShowAcpSessionChangesAction.ID,
      title: localize2('action.agent.showSessionChanges', 'Show Session Changes'),
      category: CATEGORY,
      icon: 'diff',
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 0,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IViewsService).openViewContainer('workbench.view.sessionChanges')
  }
}

export class ScrollAcpTimelineUpAction extends Action2 {
  static readonly ID = 'workbench.action.agent.scrollTimelineUp'
  constructor() {
    super({
      id: ScrollAcpTimelineUpAction.ID,
      title: localize2('action.agent.scrollTimelineUp', 'Scroll Timeline Up'),
      category: CATEGORY,
      keybinding: [
        { primary: 'ctrl+alt+up', when: ACP_NAV_WHEN },
        { primary: 'ctrl+alt+k', when: ACP_NAV_WHEN },
      ],
      precondition: ACP_NAV_WHEN,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.scrollTimeline('up')
  }
}

export class ScrollAcpTimelineDownAction extends Action2 {
  static readonly ID = 'workbench.action.agent.scrollTimelineDown'
  constructor() {
    super({
      id: ScrollAcpTimelineDownAction.ID,
      title: localize2('action.agent.scrollTimelineDown', 'Scroll Timeline Down'),
      category: CATEGORY,
      keybinding: [
        { primary: 'ctrl+alt+down', when: ACP_NAV_WHEN },
        { primary: 'ctrl+alt+j', when: ACP_NAV_WHEN },
      ],
      precondition: ACP_NAV_WHEN,
      f1: true,
    })
  }

  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.scrollTimeline('down')
  }
}

export class ScrollAcpTimelinePageUpAction extends Action2 {
  static readonly ID = 'workbench.action.agent.scrollTimelinePageUp'
  constructor() {
    super({
      id: ScrollAcpTimelinePageUpAction.ID,
      title: localize2('action.agent.scrollTimelinePageUp', 'Scroll Timeline Page Up'),
      category: CATEGORY,
      keybinding: [{ primary: 'ctrl+alt+pageup', when: ACP_NAV_WHEN }],
      precondition: ACP_NAV_WHEN,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.scrollTimeline('pageUp')
  }
}

export class ScrollAcpTimelinePageDownAction extends Action2 {
  static readonly ID = 'workbench.action.agent.scrollTimelinePageDown'
  constructor() {
    super({
      id: ScrollAcpTimelinePageDownAction.ID,
      title: localize2('action.agent.scrollTimelinePageDown', 'Scroll Timeline Page Down'),
      category: CATEGORY,
      keybinding: [{ primary: 'ctrl+alt+pagedown', when: ACP_NAV_WHEN }],
      precondition: ACP_NAV_WHEN,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.scrollTimeline('pageDown')
  }
}

export class ScrollAcpTimelineToTopAction extends Action2 {
  static readonly ID = 'workbench.action.agent.scrollTimelineToTop'
  constructor() {
    super({
      id: ScrollAcpTimelineToTopAction.ID,
      title: localize2('action.agent.scrollTimelineToTop', 'Scroll Timeline to Top'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+alt+home', when: ACP_NAV_WHEN },
      precondition: ACP_NAV_WHEN,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.scrollTimeline('top')
  }
}

export class ScrollAcpTimelineToBottomAction extends Action2 {
  static readonly ID = 'workbench.action.agent.scrollTimelineToBottom'
  constructor() {
    super({
      id: ScrollAcpTimelineToBottomAction.ID,
      title: localize2('action.agent.scrollTimelineToBottom', 'Scroll Timeline to Bottom'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+alt+end', when: ACP_NAV_WHEN },
      precondition: ACP_NAV_WHEN,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.scrollTimeline('bottom')
  }
}

export class ToggleAcpTimelineItemCollapseAction extends Action2 {
  static readonly ID = 'workbench.action.agent.toggleTimelineItemCollapse'
  constructor() {
    super({
      id: ToggleAcpTimelineItemCollapseAction.ID,
      title: localize2('action.agent.toggleTimelineItemCollapse', 'Toggle Timeline Item Collapse'),
      category: CATEGORY,
      keybinding: { primary: 'alt+f', when: ACP_NAV_WHEN },
      precondition: ACP_NAV_WHEN,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.toggleCollapse()
  }
}

export class CycleAcpTimelineCollapseAction extends Action2 {
  static readonly ID = 'workbench.action.agent.cycleTimelineCollapse'
  constructor() {
    super({
      id: CycleAcpTimelineCollapseAction.ID,
      title: localize2('action.agent.cycleTimelineCollapse', 'Cycle Timeline Collapse (All)'),
      category: CATEGORY,
      keybinding: { primary: 'ctrl+alt+f', when: ACP_NAV_WHEN },
      precondition: ACP_NAV_WHEN,
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.cycleCollapseMode()
  }
}

// ---------------------------------------------------------------------------
// Prompt suggestion popover navigation (slash-command + @-mention lists).
//
// These mirror VSCode's SuggestWidget commands: navigation / accept / hide are
// real keybindings gated on `acpPromptPopupVisible` (owned by the focused
// PromptInput via IAcpChatWidgetService), routed to the focused widget. The
// PromptInput no longer hand-rolls these keys in onKeyDown — the global handler
// resolves them through the registry like any other command.
//
// `ctrl+k` is deliberately absent: it is the app's chord leader (ctrl+k ctrl+s,
// …), and resolveKeystroke checks chord prefixes before single strokes, so a
// single-stroke ctrl+k here would be shadowed. ctrl+n/ctrl+p (the keys VSCode's
// own suggest widget uses) plus arrows cover navigation cleanly.
// ---------------------------------------------------------------------------

export class SelectNextAcpPromptSuggestionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.prompt.selectNextSuggestion'
  constructor() {
    super({
      id: SelectNextAcpPromptSuggestionAction.ID,
      title: localize2('action.agent.prompt.selectNextSuggestion', 'Select Next Suggestion'),
      category: CATEGORY,
      keybinding: [
        { primary: 'down', when: 'acpPromptPopupVisible' },
        { primary: 'ctrl+n', when: 'acpPromptPopupVisible' },
        { primary: 'ctrl+j', when: 'acpPromptPopupVisible' },
      ],
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.popoverSelectNext()
  }
}

export class SelectPreviousAcpPromptSuggestionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.prompt.selectPreviousSuggestion'
  constructor() {
    super({
      id: SelectPreviousAcpPromptSuggestionAction.ID,
      title: localize2(
        'action.agent.prompt.selectPreviousSuggestion',
        'Select Previous Suggestion',
      ),
      category: CATEGORY,
      keybinding: [
        { primary: 'up', when: 'acpPromptPopupVisible' },
        { primary: 'ctrl+p', when: 'acpPromptPopupVisible' },
      ],
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.popoverSelectPrev()
  }
}

export class AcceptAcpPromptSuggestionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.prompt.acceptSuggestion'
  constructor() {
    super({
      id: AcceptAcpPromptSuggestionAction.ID,
      title: localize2('action.agent.prompt.acceptSuggestion', 'Accept Suggestion'),
      category: CATEGORY,
      keybinding: [
        { primary: 'tab', when: 'acpPromptPopupVisible' },
        { primary: 'enter', when: 'acpPromptPopupVisible' },
      ],
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.popoverAccept()
  }
}

export class HideAcpPromptSuggestionAction extends Action2 {
  static readonly ID = 'workbench.action.agent.prompt.hideSuggestion'
  constructor() {
    super({
      id: HideAcpPromptSuggestionAction.ID,
      title: localize2('action.agent.prompt.hideSuggestion', 'Hide Suggestions'),
      category: CATEGORY,
      keybinding: [{ primary: 'escape', when: 'acpPromptPopupVisible' }],
    })
  }
  override run(accessor: ServicesAccessor): void {
    accessor.get(IAcpChatWidgetService).lastFocusedWidget?.popoverHide()
  }
}

// ---------------------------------------------------------------------------
// In-session find (Ctrl+F). Modeled on Monaco's find widget so the keys match:
// Ctrl+F opens, F3 / Shift+F3 step through matches, Escape closes. Open gates on
// `acpChatFocused` (Ctrl+F from anywhere in the chat); the navigation / close
// commands gate on `acpChatFindVisible` (true only when the *focused* widget's
// find bar is open) so they don't shadow F3 / Escape elsewhere.
// ---------------------------------------------------------------------------

export class ChatFindAction extends Action2 {
  static readonly ID = 'workbench.action.agent.find'
  constructor() {
    super({
      id: ChatFindAction.ID,
      title: localize2('action.agent.find', 'Find in Session'),
      category: CATEGORY,
      icon: 'search',
      keybinding: { primary: 'ctrl+f', when: ACP_NAV_WHEN },
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: 'navigation',
          order: 0,
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.openFind()
  }
}

export class ChatFindNextAction extends Action2 {
  static readonly ID = 'workbench.action.agent.findNext'
  constructor() {
    super({
      id: ChatFindNextAction.ID,
      title: localize2('action.agent.findNext', 'Find Next'),
      category: CATEGORY,
      keybinding: { primary: 'f3', when: 'acpChatFindVisible' },
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.findNext()
  }
}

export class ChatFindPreviousAction extends Action2 {
  static readonly ID = 'workbench.action.agent.findPrevious'
  constructor() {
    super({
      id: ChatFindPreviousAction.ID,
      title: localize2('action.agent.findPrevious', 'Find Previous'),
      category: CATEGORY,
      keybinding: { primary: 'shift+f3', when: 'acpChatFindVisible' },
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.findPrev()
  }
}

export class ChatFindCloseAction extends Action2 {
  static readonly ID = 'workbench.action.agent.findClose'
  constructor() {
    super({
      id: ChatFindCloseAction.ID,
      title: localize2('action.agent.findClose', 'Close Find'),
      category: CATEGORY,
      keybinding: { primary: 'escape', when: 'acpChatFindVisible' },
    })
  }
  override run(accessor: ServicesAccessor): void {
    resolveNavWidget(accessor)?.closeFind()
  }
}

export class CopyFocusedAcpMessageAction extends Action2 {
  static readonly ID = 'workbench.action.agent.copyFocusedMessage'
  constructor() {
    super({
      id: CopyFocusedAcpMessageAction.ID,
      title: localize2('action.agent.copyFocusedMessage', 'Copy Message'),
      category: CATEGORY,
      precondition: ACP_NAV_WHEN,
      menu: [{ id: MenuId.AcpChatContext, group: '1_copy', order: 1 }],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const text = resolveNavWidget(accessor)?.getFocusedText()
    if (text) await navigator.clipboard.writeText(text)
  }
}
