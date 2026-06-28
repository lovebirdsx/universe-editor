import { URI, isEqualResource, type IEditorGroupsService } from '@universe-editor/platform'
import { FileEditorInput } from '../editor/FileEditorInput.js'

/**
 * After applying search-replace edits to an open Monaco model, save the file
 * to disk via the owning FileEditorInput.
 *
 * Searches all editor groups (not just the active one) and uses isEqualResource
 * so that Windows drive-letter case differences (C: vs c:) are handled correctly.
 */
export async function saveReplacedFile(
  resource: URI,
  editorGroupsService: IEditorGroupsService,
): Promise<void> {
  for (const group of editorGroupsService.groups) {
    for (const editor of group.editors) {
      if (editor instanceof FileEditorInput && isEqualResource(editor.resource, resource)) {
        await editor.save()
        return
      }
    }
  }
}
