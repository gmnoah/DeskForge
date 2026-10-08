import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const RENDERER_BUDGET_BYTES = 700 * 1024 // 700 KB
const RENDERER_INITIAL_BUDGET_BYTES = 1536 * 1024 // 1.5 MB
const AGENT_HOST_BUDGET_BYTES = 1600 * 1024 // 1.6 MB

const root = process.cwd()
const rendererAssetsDir = join(root, 'apps/desktop/dist/renderer/assets')
const agentHostPath = join(root, 'apps/desktop/dist/main/agent-host.cjs')

let failed = false

// Check agent-host.cjs
try {
  const stat = statSync(agentHostPath)
  const sizeKb = (stat.size / 1024).toFixed(1)
  console.log(`[Bundle Size] agent-host.cjs: ${sizeKb} KB (Budget: ${AGENT_HOST_BUDGET_BYTES / 1024} KB)`)
  if (stat.size > AGENT_HOST_BUDGET_BYTES) {
    console.error(`[FAIL] agent-host.cjs exceeds budget! (${stat.size} > ${AGENT_HOST_BUDGET_BYTES})`)
    failed = true
  }
} catch (err) {
  console.error(`[FAIL] Could not stat agent-host.cjs:`, err.message)
  failed = true
}

// Check renderer index JS
try {
  const files = readdirSync(rendererAssetsDir)
  const indexJs = files.find((f) => f.startsWith('index-') && f.endsWith('.js'))
  if (!indexJs) {
    console.error(`[FAIL] Could not find renderer index-*.js in ${rendererAssetsDir}`)
    failed = true
  } else {
    const stat = statSync(join(rendererAssetsDir, indexJs))
    const sizeKb = (stat.size / 1024).toFixed(1)
    console.log(`[Bundle Size] renderer ${indexJs}: ${sizeKb} KB (Budget: ${RENDERER_BUDGET_BYTES / 1024} KB)`)
    if (stat.size > RENDERER_BUDGET_BYTES) {
      console.error(`[FAIL] renderer index-*.js exceeds budget! (${stat.size} > ${RENDERER_BUDGET_BYTES})`)
      failed = true
    }
  }
} catch (err) {
  console.error(`[FAIL] Could not check renderer assets:`, err.message)
  failed = true
}

// Splitting vendors into chunks does not shrink first paint: index.html loads the
// entry plus every modulepreload, so budget their sum as well.
try {
  const html = readFileSync(join(root, 'apps/desktop/dist/renderer/index.html'), 'utf8')
  const assets = [...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="\.?\/?(assets\/[^"]+\.js)"/g)].map((match) => match[1])
  const unique = [...new Set(assets)]
  if (unique.length === 0) throw new Error('no script assets referenced from index.html')
  const total = unique.reduce((sum, asset) => sum + statSync(join(root, 'apps/desktop/dist/renderer', asset)).size, 0)
  console.log(`[Bundle Size] renderer initial load (${unique.length} files): ${(total / 1024).toFixed(1)} KB (Budget: ${RENDERER_INITIAL_BUDGET_BYTES / 1024} KB)`)
  if (total > RENDERER_INITIAL_BUDGET_BYTES) {
    console.error(`[FAIL] renderer initial load exceeds budget! (${total} > ${RENDERER_INITIAL_BUDGET_BYTES})`)
    failed = true
  }
} catch (err) {
  console.error(`[FAIL] Could not check renderer initial load:`, err.message)
  failed = true
}

if (failed) {
  process.exit(1)
} else {
  console.log('✓ All bundle size budgets met!')
}
