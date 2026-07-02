/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorResolver actions: "Reopen With..." command.
 *--------------------------------------------------------------------------------------------*/

import {
  Action2,
  IEditorGroupsService,
  IEditorResolverService,
  IQuickInputService,
  IUriIdentityService,
  URI,
  localize,
  localize2,
  type ServicesAccessor,
  type UriComponents,
} from '@universe-editor/platform'

export class ReopenWithAction extends Action2 {
  static readonly ID = 'workbench.action.reopenWith'

  constructor() {
    super({
      id: ReopenWithAction.ID,
      title: localize2('action.reopenWith.title', 'Reopen With...'),
      category: localize2('command.category.file', 'File'),
      f1: true,
    })
  }

  override async run(
    accessor: ServicesAccessor,
    args?: { resource?: UriComponents; editorId?: string; groupId?: number },
  ): Promise<void> {
    const resolver = accessor.get(IEditorResolverService)
    const quickInput = accessor.get(IQuickInputService)
    const groups = accessor.get(IEditorGroupsService)
    const uriIdentity = accessor.get(IUriIdentityService)

    const rawResource = args?.resource
    if (!rawResource) return

    const uri = URI.revive(rawResource) as URI
    const candidates = resolver.resolveEditors(uri)
    if (candidates.length === 0) return

    const pick = await quickInput.pick(
      candidates.map((c) => ({ label: c.info.displayName, id: c.info.typeId })),
      { placeholder: localize('action.reopenWith.placeHolder', 'Select editor type') },
    )
    if (!pick) return

    const group =
      (args?.groupId !== undefined ? groups.getGroup(args.groupId) : undefined) ??
      groups.activeGroup
    // Prefer the exact tab (two editors can share one URI, e.g. image + text);
    // fall back to the first editor with this resource for resource-only callers.
    const existing =
      (args?.editorId !== undefined
        ? group.editors.find((e) => e.id === args.editorId)
        : undefined) ?? group.editors.find((e) => uriIdentity.isEqual(e.resource, uri))
    if (existing) group.closeEditor(existing)

    await resolver.openEditor(uri, { preferredTypeId: pick.id, pinned: true })
  }
}
