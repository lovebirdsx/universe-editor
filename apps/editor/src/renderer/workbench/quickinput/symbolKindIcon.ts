/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Resolves `symbol-kind-<n>` icon ids (n = Monaco 0-based SymbolKind) used by the
 *  Go to Symbol quick picks to a lucide icon. Markdown headings are SymbolKind.String
 *  (14) → Hash, matching the Outline view. Falls back to Hash for unknown kinds.
 *--------------------------------------------------------------------------------------------*/

import {
  Ban,
  Binary,
  Box,
  Braces,
  Brackets,
  Component,
  File,
  Hash,
  Key,
  List,
  Lock,
  Package,
  Parentheses,
  Sigma,
  ToggleLeft,
  Type,
  Variable,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react'

// Indexed by Monaco's 0-based SymbolKind.
const SYMBOL_KIND_ICONS: Record<number, LucideIcon> = {
  0: File, // File
  1: Package, // Module
  2: Braces, // Namespace
  3: Package, // Package
  4: Box, // Class
  5: Parentheses, // Method
  6: Wrench, // Property
  7: Variable, // Field
  8: Wrench, // Constructor
  9: List, // Enum
  10: Component, // Interface
  11: Parentheses, // Function
  12: Variable, // Variable
  13: Lock, // Constant
  14: Hash, // String (markdown headings)
  15: Binary, // Number
  16: ToggleLeft, // Boolean
  17: Brackets, // Array
  18: Braces, // Object
  19: Key, // Key
  20: Ban, // Null
  21: List, // EnumMember
  22: Box, // Struct
  23: Zap, // Event
  24: Sigma, // Operator
  25: Type, // TypeParameter
}

const FALLBACK = Hash

/** Returns a lucide icon for a `symbol-kind-<n>` id, or undefined for other ids. */
export function resolveSymbolKindIcon(iconId: string): LucideIcon | undefined {
  const match = /^symbol-kind-(\d+)$/.exec(iconId)
  if (!match) return undefined
  return SYMBOL_KIND_ICONS[Number(match[1])] ?? FALLBACK
}
