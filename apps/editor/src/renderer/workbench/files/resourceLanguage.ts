import type { URI } from '@universe-editor/platform'
import { extensionOfBasename, basenameOfResource } from './resourceInfo.js'

// Maps file extensions to Monaco language ids. Monaco ships tokenizers for all
// of these out of the box (see monaco-editor/esm/vs/basic-languages); the ids
// below are taken verbatim from each language's `.contribution.js`. Keys are
// lowercase to match `extensionOfBasename`, which lowercases its result.
const LANG_BY_EXT: Record<string, string> = {
  // data / config / markup
  '.json': 'json',
  '.jsonc': 'json',
  '.json5': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdown': 'markdown',
  '.mkd': 'markdown',
  '.mdx': 'mdx',
  '.txt': 'plaintext',
  '.log': 'plaintext',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.htm': 'html',
  '.xhtml': 'html',
  '.xml': 'xml',
  '.svg': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.ini': 'ini',
  '.properties': 'ini',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  // Monaco has no TOML grammar; keep it readable as plaintext rather than
  // mis-highlighting it as ini.
  '.toml': 'plaintext',

  // web / scripting
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.cts': 'typescript',
  '.mts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.pyw': 'python',
  '.rb': 'ruby',
  '.gemspec': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
  '.pl': 'perl',
  '.pm': 'perl',
  '.r': 'r',
  '.jl': 'julia',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.clj': 'clojure',
  '.cljs': 'clojure',
  '.cljc': 'clojure',
  '.edn': 'clojure',
  '.coffee': 'coffeescript',

  // systems / compiled
  '.cs': 'csharp',
  '.csx': 'csharp',
  '.cake': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.jav': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.m': 'objective-c',
  '.dart': 'dart',
  '.scala': 'scala',
  '.sc': 'scala',
  '.sbt': 'scala',
  '.vb': 'vb',
  '.pas': 'pascal',
  '.fs': 'fsharp',
  '.fsi': 'fsharp',
  '.fsx': 'fsharp',
  '.sol': 'sol',
  '.wgsl': 'wgsl',

  // shell / infra / data
  '.sh': 'shell',
  '.bash': 'shell',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.psd1': 'powershell',
  '.bat': 'bat',
  '.cmd': 'bat',
  '.dockerfile': 'dockerfile',
  '.tf': 'hcl',
  '.tfvars': 'hcl',
  '.hcl': 'hcl',
  '.proto': 'proto',
  '.sql': 'sql',
  '.rst': 'restructuredtext',
}

// Extension-less (or fixed-name) files Monaco recognises by filename. Keys are
// lowercase; matched case-insensitively against the basename.
const LANG_BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  jakefile: 'javascript',
  '.gitattributes': 'ini',
  '.gitconfig': 'ini',
  '.editorconfig': 'ini',
}

export function languageForResource(resource: URI): string {
  const basename = basenameOfResource(resource)
  const byName = LANG_BY_FILENAME[basename.toLowerCase()]
  if (byName) return byName
  const ext = extensionOfBasename(basename)
  return ext ? (LANG_BY_EXT[ext] ?? 'plaintext') : 'plaintext'
}

export function isMarkdownPreviewResource(resource: URI): boolean {
  const languageId = languageForResource(resource)
  return languageId === 'markdown' || languageId === 'mdx'
}
