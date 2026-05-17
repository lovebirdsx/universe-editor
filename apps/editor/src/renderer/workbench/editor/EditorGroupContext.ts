import { createContext, useContext } from 'react'
import type { IEditorGroup } from '@universe-editor/platform'

export const EditorGroupContext = createContext<IEditorGroup | null>(null)
export const useEditorGroup = (): IEditorGroup | null => useContext(EditorGroupContext)
