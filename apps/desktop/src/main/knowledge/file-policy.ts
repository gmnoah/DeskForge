import { basename, extname } from 'node:path'

/** Which workspace files the knowledge index reads. Conservative by design. */

const TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'mdx', 'txt', 'text', 'rst', 'adoc', 'asciidoc', 'org', 'tex', 'csv', 'tsv',
  'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'html', 'htm', 'css', 'scss', 'less',
])
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'm', 'mm', 'c', 'h',
  'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'php', 'lua', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'r', 'scala', 'dart',
  'vue', 'svelte', 'astro', 'gradle', 'proto', 'graphql', 'gql', 'ex', 'exs', 'erl', 'hs', 'clj', 'el', 'vim', 'tf', 'hcl',
  'nix', 'zig', 'jl', 'pl', 'groovy', 'cmake',
])
const KNOWN_TEXT_NAMES = new Set([
  'readme', 'license', 'licence', 'notice', 'changelog', 'contributing', 'authors', 'makefile', 'dockerfile', 'gemfile',
  'rakefile', 'procfile', 'justfile', 'cmakelists.txt', 'agents.md',
])
const NOISY_NAMES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'cargo.lock', 'poetry.lock', 'composer.lock', 'gemfile.lock', 'go.sum', 'bun.lockb'])
const ALLOWED_ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template'])

export type KnowledgeFileKind = 'text' | 'code' | 'docx'

/** Files that commonly hold credentials are never indexed, even when not ignored. */
export function isSensitiveFile(path: string): boolean {
  const name = basename(path).toLowerCase()
  if (ALLOWED_ENV_TEMPLATES.has(name)) return false
  if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return true
  if (/\.(pem|key|p12|pfx|keystore|jks|kdbx|ovpn|asc|gpg)$/.test(name)) return true
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(name)) return true
  if (['.npmrc', '.pypirc', '.netrc', '.git-credentials', '.htpasswd', '.pgpass', '.dockercfg'].includes(name)) return true
  if (/^(secrets?|credentials?)(\.[a-z0-9]+)?$/.test(name)) return true
  if (/^service[-_]?account.*\.json$/.test(name)) return true
  return false
}

export function knowledgeFileKind(path: string): KnowledgeFileKind | undefined {
  const name = basename(path).toLowerCase()
  if (NOISY_NAMES.has(name) || /\.(min\.(js|css)|map)$/.test(name)) return undefined
  const extension = extname(name).slice(1)
  if (extension === 'docx') return 'docx'
  if (CODE_EXTENSIONS.has(extension)) return 'code'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  if (KNOWN_TEXT_NAMES.has(name) || KNOWN_TEXT_NAMES.has(name.replace(/\.[^.]+$/, ''))) return 'text'
  if (ALLOWED_ENV_TEMPLATES.has(name)) return 'text'
  return undefined
}
