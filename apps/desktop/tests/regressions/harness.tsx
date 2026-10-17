import { useState } from 'react'
import '../../src/renderer/src/design/index.css'
import { createRoot } from 'react-dom/client'
import App, { Onboarding } from '../../src/renderer/src/App'
import { DocumentPreviewModal } from '../../src/renderer/src/features/work/DocumentPreviewModal'
import type { WorkbenchSnapshot } from '../../src/renderer/src/types'

const i18nCase = new URLSearchParams(location.search).has('i18n')
const imageCase = new URLSearchParams(location.search).get('image')
const size = imageCase === 'large' ? 11 * 1024 * 1024 : 3 * 1024 * 1024
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV9kAAAAASUVORK5CYII='
const requests: Array<{path: string; maxBytes?: number}> = []
Object.assign(window, {
  previewRequests: requests,
  deskforge: {
    settings: { update: async () => ({}) },
    app: { readFileContent: async (input: { path: string; maxBytes?: number }) => {
      requests.push(input)
      const truncated = size > (input.maxBytes ?? 10 * 1024 * 1024)
      return { path: input.path, name: 'photo.png', size, text: '', truncated, dataUrl: truncated ? undefined : png }
    } },
  },
})
const snapshot = {
  models: [{ id: 'fixture-model', hasSecret: true }], workspaces: [{ id: 'fixture-workspace' }],
  settings: { memoryEnabled: false, defaultExecutionMode: 'execute' }, chrome: { connected: false, grants: [] },
} as unknown as WorkbenchSnapshot

if (i18nCase) {
  let settings = { locale: 'zh-CN', theme: 'system', memoryEnabled: false, defaultExecutionMode: 'execute', ...JSON.parse(localStorage.getItem('fixture-settings') ?? '{}') }
  const fixture = {
    ...snapshot,
    workspaces: [{ id: 'fixture-workspace', name: '我的项目', path: '/fixture/project', selected: true }],
    models: [{ id: 'fixture-model', name: '我的模型', provider: 'deepseek', modelId: 'fixture-model', hasSecret: true }],
    runs: [], memory: [], mcpServers: [], skills: [], automations: [], persistentGrants: [], capabilityPackages: [],
    onboardingComplete: true,
  }
  window.deskforge = {
    bootstrap: async () => ({ ...fixture, settings }),
    settings: {
      get: async () => settings,
      update: async (patch: Record<string, unknown>) => {
        settings = { ...settings, ...patch }
        localStorage.setItem('fixture-settings', JSON.stringify(settings))
        return settings
      },
    },
    models: { catalog: async () => [] },
    knowledge: { listStatus: async () => [], getEmbeddings: async () => ({ enabled: false }) },
    events: { subscribe: () => () => {} },
  } as unknown as typeof window.deskforge
}

function Harness() {
  const [open, setOpen] = useState(true)
  const [finished, setFinished] = useState(false)
  if (i18nCase) return <App />
  if (imageCase) return <DocumentPreviewModal target={{ path: '/fixture/photo.png', title: 'photo.png', mime: 'image/png' }} onClose={() => {}} />
  return <>
    <Onboarding open={open} snapshot={snapshot} perform={async action => action()} onDone={() => { setOpen(false); setFinished(true) }} />
    {finished && <p role="status">工作台已就绪</p>}
    {!open && <button onClick={() => setOpen(true)}>重新打开引导</button>}
  </>
}
createRoot(document.getElementById('root')!).render(<Harness />)
