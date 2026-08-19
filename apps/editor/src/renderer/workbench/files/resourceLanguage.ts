import type { URI } from '@universe-editor/platform'
import { languageRegistry } from '../../services/languages/LanguageRegistry.js'
import { toMonacoLanguageId } from '../../services/textmate/languageIdMapping.js'
import { extensionOfBasename, basenameOfResource } from './resourceInfo.js'

// Maps file extensions to Monaco language ids. Most ids ship Monaco tokenizers
// out of the box (monaco-editor/esm/vs/basic-languages); a few (dotenv / ignore /
// makefile / diff) are TextMate grammar-only, contributed by the built-in
// extensions/textmate-grammars extension. Keys are lowercase to match
// `extensionOfBasename`, which lowercases its result.
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
  '.log': 'log',
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
  '.toml': 'toml',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.env': 'dotenv',
  '.diff': 'diff',
  '.patch': 'diff',

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
  '.zsh': 'shell',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.psd1': 'powershell',
  '.bat': 'bat',
  '.cmd': 'bat',
  '.dockerfile': 'dockerfile',
  '.mk': 'makefile',
  '.mak': 'makefile',
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
  makefile: 'makefile',
  gnumakefile: 'makefile',
  '.gitattributes': 'ini',
  '.gitconfig': 'ini',
  '.gitmodules': 'ini',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.env': 'dotenv',
  '.flaskenv': 'dotenv',
  '.gitignore': 'ignore',
  '.npmignore': 'ignore',
  '.dockerignore': 'ignore',
  '.eslintignore': 'ignore',
  '.prettierignore': 'ignore',
  '.vscodeignore': 'ignore',
  '.bashrc': 'shell',
  '.bash_profile': 'shell',
  '.bash_aliases': 'shell',
  '.zshrc': 'shell',
  '.zshenv': 'shell',
  '.zprofile': 'shell',
  '.profile': 'shell',
  'cargo.lock': 'toml',
  pipfile: 'toml',
  'poetry.lock': 'toml',
}

// Basename patterns checked after exact filename matches, before extensions.
// Tested against the lowercased basename.
const LANG_BY_BASENAME_PATTERN: readonly [RegExp, string][] = [[/^\.env\./, 'dotenv']]

export function languageForResource(resource: URI): string {
  const basename = basenameOfResource(resource)
  const lowerBasename = basename.toLowerCase()

  // Exact filename: extension declarations win over the built-in table (VSCode
  // semantics — later-registered associations take precedence).
  const contributedName = languageRegistry.lookupByFilename(lowerBasename)
  if (contributedName) return toMonacoLanguageId(contributedName.id)
  const byName = LANG_BY_FILENAME[lowerBasename]
  if (byName) return byName

  // Basename pattern / filenamePatterns, before the extension fallback.
  const contributedPattern = languageRegistry.lookupByPattern(resource.path.toLowerCase())
  if (contributedPattern) return toMonacoLanguageId(contributedPattern.id)
  for (const [pattern, language] of LANG_BY_BASENAME_PATTERN) {
    if (pattern.test(lowerBasename)) return language
  }

  // Extension: contributed first, then the built-in table.
  const ext = extensionOfBasename(basename)
  if (ext) {
    const contributedExt = languageRegistry.lookupByExtension(ext)
    if (contributedExt) return toMonacoLanguageId(contributedExt.id)
    return LANG_BY_EXT[ext] ?? 'plaintext'
  }
  return 'plaintext'
}

export function isMarkdownPreviewResource(resource: URI): boolean {
  const languageId = languageForResource(resource)
  return languageId === 'markdown' || languageId === 'mdx'
}
