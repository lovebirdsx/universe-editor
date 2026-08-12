import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { isMarkdownPreviewResource, languageForResource } from '../resourceLanguage.js'

const lang = (path: string): string => languageForResource(URI.file(path))

describe('languageForResource', () => {
  it('maps C# files to csharp', () => {
    expect(lang('/proj/Game.cs')).toBe('csharp')
    expect(lang('/proj/Script.csx')).toBe('csharp')
  })

  it('maps common code extensions to their Monaco language id', () => {
    const cases: Record<string, string> = {
      '/a.ts': 'typescript',
      '/a.tsx': 'typescript',
      '/a.js': 'javascript',
      '/a.py': 'python',
      '/a.go': 'go',
      '/a.rs': 'rust',
      '/a.java': 'java',
      '/a.kt': 'kotlin',
      '/a.swift': 'swift',
      '/a.rb': 'ruby',
      '/a.php': 'php',
      '/a.lua': 'lua',
      '/a.c': 'c',
      '/a.h': 'c',
      '/a.cpp': 'cpp',
      '/a.sql': 'sql',
      '/a.sh': 'shell',
      '/a.ps1': 'powershell',
      '/a.json': 'json',
      '/a.yaml': 'yaml',
      '/a.md': 'markdown',
      '/a.wgsl': 'wgsl',
    }
    for (const [path, expected] of Object.entries(cases)) {
      expect(lang(path), path).toBe(expected)
    }
  })

  it('is case-insensitive on the extension', () => {
    expect(lang('/proj/Game.CS')).toBe('csharp')
    expect(lang('/proj/README.MD')).toBe('markdown')
  })

  it('recognises extension-less files by name', () => {
    expect(lang('/proj/Dockerfile')).toBe('dockerfile')
    expect(lang('/proj/Gemfile')).toBe('ruby')
    expect(lang('/proj/.editorconfig')).toBe('ini')
  })

  it('maps .log files to the log language for level-aware highlighting', () => {
    expect(lang('/proj/main.log')).toBe('log')
    expect(lang('/proj/RENDERER.LOG')).toBe('log')
  })

  it('maps TOML files to the toml language', () => {
    expect(lang('/proj/Cargo.toml')).toBe('toml')
    expect(lang('/proj/Cargo.lock')).toBe('toml')
    expect(lang('/proj/Pipfile')).toBe('toml')
    expect(lang('/proj/poetry.lock')).toBe('toml')
  })

  it('maps dotenv files to the dotenv language', () => {
    expect(lang('/proj/.env')).toBe('dotenv')
    expect(lang('/proj/.env.local')).toBe('dotenv')
    expect(lang('/proj/.env.production')).toBe('dotenv')
    expect(lang('/proj/dev.env')).toBe('dotenv')
    expect(lang('/proj/.flaskenv')).toBe('dotenv')
  })

  it('maps ignore files to the ignore language', () => {
    expect(lang('/proj/.gitignore')).toBe('ignore')
    expect(lang('/proj/.dockerignore')).toBe('ignore')
  })

  it('maps makefiles to the makefile language', () => {
    expect(lang('/proj/Makefile')).toBe('makefile')
    expect(lang('/proj/gnumakefile')).toBe('makefile')
    expect(lang('/proj/build.mk')).toBe('makefile')
  })

  it('maps diff and patch files to the diff language', () => {
    expect(lang('/proj/changes.diff')).toBe('diff')
    expect(lang('/proj/fix.patch')).toBe('diff')
  })

  it('maps shell rc files to the shell language', () => {
    expect(lang('/proj/.bashrc')).toBe('shell')
    expect(lang('/proj/.zshrc')).toBe('shell')
  })

  it('maps ini-style dotfiles to the ini language', () => {
    expect(lang('/proj/.npmrc')).toBe('ini')
    expect(lang('/proj/.gitmodules')).toBe('ini')
  })

  it('does not let the dotenv pattern swallow similar names', () => {
    expect(lang('/proj/.environment')).toBe('plaintext')
  })

  it('falls back to plaintext for unknown or extension-less files', () => {
    expect(lang('/proj/notes.unknownext')).toBe('plaintext')
    expect(lang('/proj/LICENSE')).toBe('plaintext')
  })

  it('identifies resources that can use the markdown preview', () => {
    expect(isMarkdownPreviewResource(URI.file('/proj/README.md'))).toBe(true)
    expect(isMarkdownPreviewResource(URI.file('/proj/README.mdx'))).toBe(true)
    expect(isMarkdownPreviewResource(URI.file('/proj/readme.txt'))).toBe(false)
  })
})
