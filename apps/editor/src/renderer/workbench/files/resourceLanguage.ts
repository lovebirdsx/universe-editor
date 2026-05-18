import type { URI } from '@universe-editor/platform'
import { extensionOfBasename, basenameOfResource } from './resourceInfo.js'

const LANG_BY_EXT: Record<string, string> = {
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'plaintext',
  '.log': 'plaintext',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'plaintext',
  '.ini': 'ini',
  '.sh': 'shell',
}

export function languageForResource(resource: URI): string {
  const ext = extensionOfBasename(basenameOfResource(resource))
  return ext ? (LANG_BY_EXT[ext] ?? 'plaintext') : 'plaintext'
}
