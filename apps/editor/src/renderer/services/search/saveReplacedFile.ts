import { URI, type IEditorGroupsService, type IUriIdentityService } from '@universe-editor/platform'
import { FileEditorInput } from '../editor/FileEditorInput.js'

/**
 * After applying search-replace edits to an open Monaco model, save the file
 * to disk via the owning FileEditorInput.
 *
 * Searches all editor groups (not just the active one) and uses the platform-aware
 * uriIdentity so Windows/macOS drive-letter and path case differences resolve to
 * the same file.
 */
export async function saveReplacedFile(
  resource: URI,
  editorGroupsService: IEditorGroupsService,
  uriIdentity: IUriIdentityService,
): Promise<void> {
  for (const group of editorGroupsService.groups) {
    for (const editor of group.editors) {
      if (editor instanceof FileEditorInput && uriIdentity.isEqual(editor.resource, resource)) {
        await editor.save()
        return
      }
    }
  }
}
