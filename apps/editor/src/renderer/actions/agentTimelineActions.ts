/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  In-session chat widget commands: timeline keyboard navigation (Alt+J/K,
 *  scroll, collapse), the prompt-suggestion popover, in-session find (Ctrl+F),
 *  copy-focused-message, and jump-to-plan / show-changes. All route to the
 *  focused AcpChatWidget via resolveNavWidget / IAcpChatWidgetService.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  IEditorResolverService,
  IHostService,
  ILayoutService,
  IViewDescriptorService,
  IViewsService,
  IWorkspaceService,
  MenuId,
  PartId,
  URI,
  ViewContainerLocation,
  localize2,
  type ServicesAccessor,
} from '@universe-editor/platform'
import { IAcpChatWidgetService } from '../services/acp/session/acpChatWidgetService.js'
import { IAcpSessionService } from '../services/acp/session/acpSessionService.js'
import { subAgentTranscriptToText } from '../services/acp/session/acpSessionContent.js'
import { AcpSessionEditorInput } from '../services/acp/session/acpSessionEditorInput.js'
import { readChatContextArg, readContextTarget } from '../services/acp/chatContextTarget.js'
import { openResourcePreviewInGroup } from '../services/resourcePreview/openResourcePreview.js'
import { toPngBase64 } from '../services/acp/promptImage.js'
import { findByStickyKey } from '../workbench/agents/stickyScroll.js'
import { subtreeCardKeys } from '../workbench/agents/timelineCollapse.js'
import { createdFilePath } from '../workbench/agents/toolCallDisplay.js'
import { toolCallPathUri } from '../workbench/agents/toolCallPaths.js'
import {
  ACP_CHAT_CARD_GROUP,
  ACP_COPY_GROUP,
  ACP_CHAT_SESSION_GROUP,
  ACP_NAV_WHEN,
  ACP_SCOPED_KEY_WEIGHT,
  CATEGORY,
  resolveNavWidget,
  resolveSessionWidget,
} from './_agentShared.js'

// ---------------------------------------------------------------------------
// Timeline keyboard navigation (Alt+J / Alt+K, vim-style; Alt+H / Alt+L the
// tree's Left / Right arrow). Movement walks the visible rows — a step off an
// expanded card lands on its first child, exactly like the Explorer tree — while
// Alt+H/L fold and unfold the focused card before stepping out or in.
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
        { primary: 'alt+down', when: ACP_NAV_WHEN, weight: ACP_SCOPED_KEY_WEIGHT },
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
        { primary: 'alt+up', when: ACP_NAV_WHEN, weight: ACP_SCOPED_KEY_WEIGHT },
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
        { primary: 'alt+a', when: ACP_NAV_WHEN, weight: ACP_SCOPED_KEY_WEIGHT },
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

// The tree's Left / Right arrow: Alt+L unfolds the focused card in place (a
// second press then steps into its first child), Alt+H folds it in place (a
// second press then steps out to the parent card). Both are also offered on the
// card context menu (the menu cannot answer "which level am I on", so it gates
// on the card shape instead: a card with children can be entered, a nested card
// can be left).
export class FocusDeeperAcpTimelineItemAction extends Action2 {
  static readonly ID = 'workbench.action.agent.focusDeeperTimelineItem'
  constructor() {
    super({
      id: FocusDeeperAcpTimelineItemAction.ID,
      title: localize2('action.agent.focusDeeperTimelineItem', 'Unfold Card or Step Into It'),
      category: CATEGORY,
      icon: 'arrow-right',
      keybinding: { primary: 'alt+l', when: ACP_NAV_WHEN },
      menu: [
        {
          id: MenuId.AcpChatContext,
          group: ACP_CHAT_CARD_GROUP,
          order: 3,
          when: 'acpChatContextSubAgent',
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    // The menu already moved the cursor onto the clicked card (ChatBody focuses
    // the slot before opening), so `in` starts from exactly that card.
    resolveSessionWidget(accessor, readChatContextArg(arg).sessionId)?.moveTimelineLevel('in')
  }
}

export class FocusOuterAcpTimelineItemAction extends Action2 {
  static readonly ID = 'workbench.action.agent.focusOuterTimelineItem'
  constructor() {
    super({
      id: FocusOuterAcpTimelineItemAction.ID,
      title: localize2('action.agent.focusOuterTimelineItem', 'Fold Card or Step Out'),
      category: CATEGORY,
      icon: 'arrow-left',
      keybinding: { primary: 'alt+h', when: ACP_NAV_WHEN },
      menu: [
        {
          id: MenuId.AcpChatContext,
          group: ACP_CHAT_CARD_GROUP,
          order: 4,
          when: 'acpChatContextNestedCard',
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    resolveSessionWidget(accessor, readChatContextArg(arg).sessionId)?.moveTimelineLevel('out')
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
          group: '0_session',
          order: 30,
        },
        // Order matches the editor-title slot above, so the two entry points
        // list the session-level items in the same order.
        { id: MenuId.AcpChatContext, group: ACP_CHAT_SESSION_GROUP, order: 30 },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    resolveSessionWidget(accessor, readChatContextArg(arg).sessionId)?.jumpToPlan()
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
          group: '0_session',
          order: 10,
        },
        // Session-wide and read-only-safe, so it carries no `when` — same as
        // its editor-title slot.
        { id: MenuId.AcpChatContext, group: ACP_CHAT_SESSION_GROUP, order: 10 },
      ],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    // Snapshot every service synchronously — the accessor dies past the first await.
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    const viewDescriptorService = accessor.get(IViewDescriptorService)

    // Explorer-style toggle: re-invoking while the view holds focus hides the sidebar.
    if (
      layoutService.getVisible(PartId.SideBar) &&
      viewsService.getActiveViewContainerId(ViewContainerLocation.SideBar) ===
        SESSION_CHANGES_CONTAINER_ID &&
      layoutService.getPart(PartId.SideBar)?.isFocused()
    ) {
      layoutService.setVisible(PartId.SideBar, false)
      return
    }
    await showSessionChangesView(layoutService, viewsService, viewDescriptorService)
  }
}

/** Container id of the Session Changes view; toggled by ShowAcpSessionChangesAction. */
export const SESSION_CHANGES_CONTAINER_ID = 'workbench.view.sessionChanges'

/** View id of the Session Changes view; shared by the view registration
 *  (BuiltInViewsContribution) and the focus action. Lives here rather than in
 *  the view component so neither side imports the other's React tree. */
export const SESSION_CHANGES_VIEW_ID = 'workbench.view.sessionChanges.main'

async function showSessionChangesView(
  layoutService: ILayoutService,
  viewsService: IViewsService,
  viewDescriptorService: IViewDescriptorService,
): Promise<void> {
  viewsService.openViewContainer(SESSION_CHANGES_CONTAINER_ID)
  viewDescriptorService.setViewCollapsed(SESSION_CHANGES_VIEW_ID, false)
  await layoutService.focusView(SESSION_CHANGES_VIEW_ID, { source: 'command' })
}

/**
 * Focus the Session Changes view: reveal its container, expand the view and
 * move DOM focus into its file tree. No default keybinding — the command
 * palette (f1) finds it, same as FocusCommitChangesAction.
 */
export class FocusSessionChangesAction extends Action2 {
  static readonly ID = 'workbench.view.sessionChanges.focus'

  constructor() {
    super({
      id: FocusSessionChangesAction.ID,
      title: localize2('action.sessionChanges.focus', 'Focus on Session Changes View'),
      category: localize2('command.category.view', 'View'),
      f1: true,
    })
  }

  override async run(accessor: ServicesAccessor): Promise<void> {
    // Snapshot every service synchronously — the accessor dies past the first await.
    const layoutService = accessor.get(ILayoutService)
    const viewsService = accessor.get(IViewsService)
    const viewDescriptorService = accessor.get(IViewDescriptorService)

    await showSessionChangesView(layoutService, viewsService, viewDescriptorService)
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

// Alt+F toggles whatever card holds the keyboard cursor. The context menu can
// name a specific card instead — and its two rows read "Collapse Card" /
// "Expand Card", so they need the *stated* end state (menu labels are fixed when
// the menu opens; a toggle could fold the wrong way if the state moved on).
// The icon is shared by both rows because `desc.icon` is per-command.
export class ToggleAcpTimelineItemCollapseAction extends Action2 {
  static readonly ID = 'workbench.action.agent.toggleTimelineItemCollapse'
  constructor() {
    super({
      id: ToggleAcpTimelineItemCollapseAction.ID,
      title: localize2('action.agent.toggleTimelineItemCollapse', 'Toggle Timeline Item Collapse'),
      category: CATEGORY,
      icon: 'collapse-all',
      keybinding: { primary: 'alt+f', when: ACP_NAV_WHEN },
      precondition: ACP_NAV_WHEN,
      menu: [
        {
          id: MenuId.AcpChatContext,
          group: ACP_CHAT_CARD_GROUP,
          order: 1,
          when: 'acpChatContextCard && !acpChatContextCardCollapsed',
          title: localize2('action.agent.collapseCard', 'Collapse Card'),
        },
        {
          id: MenuId.AcpChatContext,
          group: ACP_CHAT_CARD_GROUP,
          order: 1,
          when: 'acpChatContextCard && acpChatContextCardCollapsed',
          title: localize2('action.agent.expandCard', 'Expand Card'),
        },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    const { sessionId, slotKey } = readChatContextArg(arg)
    const widget = resolveSessionWidget(accessor, sessionId)
    if (widget === undefined) return
    if (slotKey !== undefined) {
      widget.setSlotCollapsed(new Map([[slotKey, !widget.isSlotCollapsed(slotKey)]]))
      return
    }
    // No slot in the arg (Alt+F, command palette) → act on the focused card.
    widget.toggleCollapse()
  }
}

/**
 * Fold / unfold a sub-agent card *together with everything nested under it* — a
 * Task card can carry dozens of children, and folding them one chevron at a
 * time is the whole reason this row exists. Like the single-card rows above,
 * the two entries are mutually exclusive on the parent card's own state: a
 * collapsed sub-agent card (the default) offers "Expand Card and Children",
 * an expanded one offers "Collapse Card and Children". A child folded by hand
 * while the parent stays open is not covered — re-opening the parent re-opens it.
 */
export class ToggleAcpTimelineCardSubtreeAction extends Action2 {
  static readonly ID = 'workbench.action.agent.toggleCardSubtreeCollapse'
  constructor() {
    super({
      id: ToggleAcpTimelineCardSubtreeAction.ID,
      title: localize2(
        'action.agent.toggleCardSubtreeCollapse',
        'Toggle Card and Children Collapse',
      ),
      category: CATEGORY,
      icon: 'expand-all',
      // Needs the clicked card from the menu args — a bare invocation has no target.
      f1: false,
      menu: [
        {
          id: MenuId.AcpChatContext,
          group: ACP_CHAT_CARD_GROUP,
          order: 2,
          when: 'acpChatContextSubAgent && !acpChatContextCardCollapsed',
          title: localize2('action.agent.collapseCardSubtree', 'Collapse Card and Children'),
        },
        {
          id: MenuId.AcpChatContext,
          group: ACP_CHAT_CARD_GROUP,
          order: 2,
          when: 'acpChatContextSubAgent && acpChatContextCardCollapsed',
          title: localize2('action.agent.expandCardSubtree', 'Expand Card and Children'),
        },
      ],
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    const { sessionId, slotKey } = readChatContextArg(arg)
    if (sessionId === undefined || slotKey === undefined) return
    const session = accessor.get(IAcpSessionService).getById(sessionId)
    const widget = resolveSessionWidget(accessor, sessionId)
    if (session === undefined || widget === undefined) return
    const keys = subtreeCardKeys(session.timeline.get(), slotKey)
    if (keys.length === 0) return
    const target = !widget.isSlotCollapsed(slotKey)
    widget.setSlotCollapsed(new Map(keys.map((key) => [key, target])))
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
        { primary: 'down', when: 'acpPromptPopupVisible', weight: ACP_SCOPED_KEY_WEIGHT },
        { primary: 'ctrl+n', when: 'acpPromptPopupVisible', weight: ACP_SCOPED_KEY_WEIGHT },
        { primary: 'ctrl+j', when: 'acpPromptPopupVisible', weight: ACP_SCOPED_KEY_WEIGHT },
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
        { primary: 'up', when: 'acpPromptPopupVisible', weight: ACP_SCOPED_KEY_WEIGHT },
        { primary: 'ctrl+p', when: 'acpPromptPopupVisible', weight: ACP_SCOPED_KEY_WEIGHT },
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
        { primary: 'tab', when: 'acpPromptPopupVisible', weight: ACP_SCOPED_KEY_WEIGHT },
        { primary: 'enter', when: 'acpPromptPopupVisible', weight: ACP_SCOPED_KEY_WEIGHT },
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
      keybinding: [
        { primary: 'escape', when: 'acpPromptPopupVisible', weight: ACP_SCOPED_KEY_WEIGHT },
      ],
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
      keybinding: { primary: 'ctrl+f', when: ACP_NAV_WHEN, weight: ACP_SCOPED_KEY_WEIGHT },
      menu: [
        {
          id: MenuId.EditorTitle,
          when: `activeEditorType == '${AcpSessionEditorInput.TYPE_ID}'`,
          group: '0_session',
          order: 20,
        },
        { id: MenuId.AcpChatContext, group: ACP_CHAT_SESSION_GROUP, order: 20 },
      ],
      f1: true,
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    resolveSessionWidget(accessor, readChatContextArg(arg).sessionId)?.openFind()
  }
}

export class ChatFindNextAction extends Action2 {
  static readonly ID = 'workbench.action.agent.findNext'
  constructor() {
    super({
      id: ChatFindNextAction.ID,
      title: localize2('action.agent.findNext', 'Find Next'),
      category: CATEGORY,
      keybinding: { primary: 'f3', when: 'acpChatFindVisible', weight: ACP_SCOPED_KEY_WEIGHT },
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
      keybinding: {
        primary: 'shift+f3',
        when: 'acpChatFindVisible',
        weight: ACP_SCOPED_KEY_WEIGHT,
      },
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
      keybinding: { primary: 'escape', when: 'acpChatFindVisible', weight: ACP_SCOPED_KEY_WEIGHT },
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
      icon: 'copy',
      title: localize2('action.agent.copyFocusedMessage', 'Copy Message'),
      category: CATEGORY,
      precondition: ACP_NAV_WHEN,
      menu: [{ id: MenuId.AcpChatContext, group: ACP_COPY_GROUP, order: 1 }],
      f1: true,
    })
  }
  override async run(accessor: ServicesAccessor): Promise<void> {
    const text = resolveNavWidget(accessor)?.getFocusedText()
    if (text) await navigator.clipboard.writeText(text)
  }
}

export class CopySelectedTextAction extends Action2 {
  static readonly ID = 'workbench.action.agent.copySelectedText'
  constructor() {
    super({
      id: CopySelectedTextAction.ID,
      icon: 'copy',
      title: localize2('common.copy', 'Copy'),
      category: CATEGORY,
      precondition: ACP_NAV_WHEN,
      menu: [
        { id: MenuId.AcpChatContext, group: ACP_COPY_GROUP, order: 0, when: 'acpChatHasSelection' },
      ],
    })
  }
  override async run(): Promise<void> {
    const text = window.getSelection()?.toString()
    if (text) await navigator.clipboard.writeText(text)
  }
}

// ---------------------------------------------------------------------------
// Fragment-targeted copy actions. The timeline context menu (and the prompt
// input's attachment-chip menu) resolves the fragment under the cursor into a
// typed target carried on the menu args; each action gates on its own
// contextKey so exactly one shows per fragment kind. No keybindings, no f1 —
// these exist only as context-menu entries.
// ---------------------------------------------------------------------------

export class CopyAcpImageAction extends Action2 {
  static readonly ID = 'workbench.action.agent.copyImage'
  constructor() {
    super({
      id: CopyAcpImageAction.ID,
      icon: 'copy',
      title: localize2('action.agent.copyImage', 'Copy Image'),
      category: CATEGORY,
      menu: [
        { id: MenuId.AcpChatContext, group: ACP_COPY_GROUP, order: 2, when: 'acpChatContextImage' },
        {
          id: MenuId.AcpPromptContext,
          group: ACP_COPY_GROUP,
          order: 1,
          when: 'acpPromptContextImage',
        },
      ],
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const target = readContextTarget(arg)
    if (target?.kind !== 'image') return
    // Snapshot before the first await — the accessor dies past it.
    const hostService = accessor.get(IHostService)
    try {
      const base64 = await toPngBase64(target.src)
      await hostService.writeClipboardImage(base64)
    } catch (err) {
      // Best-effort, same as the ChatImage preview overlay's copy button.
      console.warn('[acp] copy image failed', err)
    }
  }
}

export class CopyAcpResourcePathAction extends Action2 {
  static readonly ID = 'workbench.action.agent.copyResourcePath'
  constructor() {
    super({
      id: CopyAcpResourcePathAction.ID,
      icon: 'copy',
      title: localize2('action.agent.copyResourcePath', 'Copy Path'),
      category: CATEGORY,
      menu: [
        { id: MenuId.AcpChatContext, group: ACP_COPY_GROUP, order: 3, when: 'acpChatContextPath' },
      ],
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const target = readContextTarget(arg)
    if (target?.kind !== 'path') return
    let text = target.uri
    try {
      const parsed = URI.parse(target.uri)
      if (parsed.scheme === 'file') text = parsed.fsPath
    } catch {
      // Malformed agent output — fall back to the raw uri string.
    }
    await navigator.clipboard.writeText(text)
  }
}

export class CopyAcpContextTextAction extends Action2 {
  static readonly ID = 'workbench.action.agent.copyContextText'
  constructor() {
    super({
      id: CopyAcpContextTextAction.ID,
      icon: 'copy',
      title: localize2('action.agent.copyContextText', 'Copy Text'),
      category: CATEGORY,
      menu: [
        {
          id: MenuId.AcpChatContext,
          group: ACP_COPY_GROUP,
          order: 4,
          when: 'acpChatContextChipText',
        },
        {
          id: MenuId.AcpPromptContext,
          group: ACP_COPY_GROUP,
          order: 3,
          when: 'acpPromptContextChipText',
        },
      ],
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const target = readContextTarget(arg)
    if (target?.kind !== 'text') return
    await navigator.clipboard.writeText(target.text)
  }
}

export class CopyAcpReferenceAction extends Action2 {
  static readonly ID = 'workbench.action.agent.copyReference'
  constructor() {
    super({
      id: CopyAcpReferenceAction.ID,
      icon: 'copy',
      title: localize2('action.agent.copyReference', 'Copy Reference'),
      category: CATEGORY,
      menu: [
        {
          id: MenuId.AcpPromptContext,
          group: ACP_COPY_GROUP,
          order: 2,
          when: 'acpPromptContextRef',
        },
      ],
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const target = readContextTarget(arg)
    if (target?.kind !== 'text') return
    await navigator.clipboard.writeText(target.text)
  }
}

// ---------------------------------------------------------------------------
// Card-targeted actions: they read the card the menu was raised on out of the
// args and resolve its content from the session model at click time. Nothing
// heavy rides in the args — a sub-agent transcript can be megabytes, and the
// fold state must be the live one, not a snapshot from when the menu opened.
// ---------------------------------------------------------------------------

export class CopyAcpSubAgentTranscriptAction extends Action2 {
  static readonly ID = 'workbench.action.agent.copySubAgentTranscript'
  constructor() {
    super({
      id: CopyAcpSubAgentTranscriptAction.ID,
      icon: 'copy',
      title: localize2('action.agent.copySubAgentTranscript', 'Copy Sub-Agent Transcript'),
      category: CATEGORY,
      menu: [
        {
          id: MenuId.AcpChatContext,
          group: ACP_COPY_GROUP,
          order: 5,
          when: 'acpChatContextSubAgent',
        },
      ],
    })
  }
  override async run(accessor: ServicesAccessor, arg?: unknown): Promise<void> {
    const { sessionId, slotKey } = readChatContextArg(arg)
    if (sessionId === undefined || slotKey === undefined) return
    const session = accessor.get(IAcpSessionService).getById(sessionId)
    if (session === undefined) return
    const item = findByStickyKey(session.timeline.get(), slotKey)
    if (item?.kind !== 'toolCall') return
    // "Copy Message" on the same card already carries the children (indented)
    // along with the parent's title / diffs / output; this is the sub-agent part
    // on its own, e.g. to paste into a fresh prompt. A card whose children are
    // all blank copies nothing rather than clearing the clipboard.
    const transcript = subAgentTranscriptToText(item.call)
    if (transcript !== undefined) await navigator.clipboard.writeText(transcript)
  }
}

/**
 * The card header's read affordance, reachable from the menu. One shared body:
 * a whole-file write opens as a rendered preview when the document has one
 * (markdown / html) and as the file itself otherwise — exactly what the header
 * button does, so the two can't diverge. The two commands differ only in which
 * of them the menu shows (and therefore in its label and icon).
 */
function openCreatedToolCallFile(accessor: ServicesAccessor, arg: unknown): void {
  const { sessionId, slotKey } = readChatContextArg(arg)
  if (sessionId === undefined || slotKey === undefined) return
  const session = accessor.get(IAcpSessionService).getById(sessionId)
  const editorGroups = accessor.get(IEditorGroupsService)
  const editorResolver = accessor.get(IEditorResolverService)
  const folder = accessor.get(IWorkspaceService).current?.folder
  if (session === undefined) return
  const item = findByStickyKey(session.timeline.get(), slotKey)
  if (item?.kind !== 'toolCall') return
  const path = createdFilePath(item.call)
  if (path === undefined) return
  const uri = toolCallPathUri(path, folder)
  if (!openResourcePreviewInGroup(editorGroups, editorGroups.activeGroup, uri)) {
    void editorResolver.openEditor(uri, { pinned: true })
  }
}

export class OpenAcpToolCallPreviewAction extends Action2 {
  static readonly ID = 'workbench.action.agent.openToolCallPreview'
  constructor() {
    super({
      id: OpenAcpToolCallPreviewAction.ID,
      icon: 'open-preview',
      title: localize2('resourcePreview.openPreview', 'Open Preview'),
      category: CATEGORY,
      f1: false,
      menu: [
        {
          id: MenuId.AcpChatContext,
          group: ACP_CHAT_CARD_GROUP,
          order: 5,
          when: 'acpChatContextCreatedPreview',
        },
      ],
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    openCreatedToolCallFile(accessor, arg)
  }
}

export class OpenAcpToolCallFileAction extends Action2 {
  static readonly ID = 'workbench.action.agent.openToolCallFile'
  constructor() {
    super({
      id: OpenAcpToolCallFileAction.ID,
      // The same glyphs the card header uses for the two cases (Eye / FileSymlink).
      icon: 'go-to-file',
      title: localize2('acp.toolCall.openFile', 'Open File'),
      category: CATEGORY,
      f1: false,
      menu: [
        {
          id: MenuId.AcpChatContext,
          group: ACP_CHAT_CARD_GROUP,
          order: 5,
          when: 'acpChatContextCreatedFile',
        },
      ],
    })
  }
  override run(accessor: ServicesAccessor, arg?: unknown): void {
    openCreatedToolCallFile(accessor, arg)
  }
}
