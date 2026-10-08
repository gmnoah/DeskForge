import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const vitestPkg = require.resolve('vitest/package.json')
const vitestEntry = join(dirname(vitestPkg), 'vitest.mjs')
const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const electronEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

// `pnpm install` builds better-sqlite3 for Node's ABI; tests run under Electron's.
const sqlitePath = require.resolve('better-sqlite3')
const probe = spawnSync(electronPath, ['-e', `new (require(${JSON.stringify(sqlitePath)}))(':memory:').close()`], { env: electronEnv, encoding: 'utf8' })
if (probe.status !== 0) {
  console.warn('[vitest-electron] better-sqlite3 is not built for Electron; running rebuild:electron')
  const rebuild = spawnSync('pnpm', ['run', 'rebuild:electron'], { cwd: desktopRoot, stdio: 'inherit', shell: process.platform === 'win32' })
  if (rebuild.status !== 0) process.exit(rebuild.status ?? 1)
}

const result = spawnSync(electronPath, [vitestEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: electronEnv,
})

if (result.error) throw result.error
process.exit(result.status ?? (result.signal ? 1 : 0))
