import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_RULES_PATH = join(REPO_ROOT, 'scripts', 'sensitive-rules.json')

const configPath = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : DEFAULT_RULES_PATH
console.log(JSON.stringify(JSON.parse(readFileSync(configPath, 'utf8'))))
