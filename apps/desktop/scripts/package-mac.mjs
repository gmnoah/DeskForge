import { execSync } from 'node:child_process'
import process from 'node:process'

const arch = process.env.TARGET_ARCH || process.arch || 'arm64'
console.log(`>> Building DeskForge for macOS (${arch})...`)

execSync(`electron-rebuild -v 43.1.0 -a ${arch} -m . -o better-sqlite3 --force`, { stdio: 'inherit' })
execSync('pnpm build', { stdio: 'inherit' })
execSync(`CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --config.npmRebuild=false --mac dir dmg zip --${arch}`, { stdio: 'inherit' })
