import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const bundledRuntimeDependencies = [
  '@deskforge/contracts',
  '@deskforge/core',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@modelcontextprotocol/sdk',
]

export default defineConfig({
  main: {
    resolve: {
      alias: [
        { find: '@earendil-works/pi-ai/compat', replacement: resolve(__dirname, 'src/pi-ai-compat-stub.ts') },
      ],
    },
    plugins: [externalizeDepsPlugin({ exclude: bundledRuntimeDependencies })],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'agent-host': resolve(__dirname, 'src/workers/agent-host.ts'),
          'tool-runner': resolve(__dirname, 'src/workers/tool-runner.ts'),
        },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundledRuntimeDependencies })],
    build: { outDir: 'dist/preload', rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [react()],
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/scheduler/')) {
              return 'vendor-react'
            }
            if (
              id.includes('node_modules/react-markdown/') ||
              id.includes('node_modules/remark-gfm/') ||
              id.includes('node_modules/micromark') ||
              id.includes('node_modules/unist') ||
              id.includes('node_modules/mdast') ||
              id.includes('node_modules/vfile') ||
              id.includes('node_modules/devlop')
            ) {
              return 'vendor-markdown'
            }
            if (id.includes('node_modules/@phosphor-icons/')) {
              return 'vendor-icons'
            }
          },
        },
      },
    },
  },
})
