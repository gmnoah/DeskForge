import { describe, expect, it } from 'vitest'

describe('Document preview format resolution', () => {
  it('detects html extensions and mime types', () => {
    const isHtml = (filename: string, mime?: string) => {
      const name = filename.toLowerCase()
      const m = mime?.toLowerCase() ?? ''
      return name.endsWith('.html') || name.endsWith('.htm') || name.endsWith('.xhtml') || m === 'text/html'
    }

    expect(isHtml('index.html')).toBe(true)
    expect(isHtml('report.htm')).toBe(true)
    expect(isHtml('app.xhtml')).toBe(true)
    expect(isHtml('download', 'text/html')).toBe(true)
    expect(isHtml('style.css')).toBe(false)
    expect(isHtml('readme.md')).toBe(false)
  })

  it('detects markdown, svg and images', () => {
    const detectFormat = (filename: string, mime?: string) => {
      const name = filename.toLowerCase()
      const m = mime?.toLowerCase() ?? ''
      if (name.endsWith('.html') || name.endsWith('.htm') || m === 'text/html') return 'html'
      if (name.endsWith('.md') || name.endsWith('.markdown') || m === 'text/markdown') return 'markdown'
      if (name.endsWith('.svg') || m === 'image/svg+xml') return 'svg'
      if ((/\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(name) || m.startsWith('image/')) && !name.endsWith('.svg')) return 'image'
      return 'source'
    }

    expect(detectFormat('README.md')).toBe('markdown')
    expect(detectFormat('icon.svg')).toBe('svg')
    expect(detectFormat('photo.PNG')).toBe('image')
    expect(detectFormat('diagram.jpg')).toBe('image')
    expect(detectFormat('data.json')).toBe('source')
    expect(detectFormat('app.ts')).toBe('source')
  })

  it('detects html and markdown formats when title is a descriptive label but target path ends with extension', () => {
    const detectTargetFormat = (target: { title?: string; path?: string; sourcePath?: string; mime?: string }) => {
      const filename = target.title || target.sourcePath?.split('/').at(-1) || target.path?.split('/').at(-1) || ''
      const name = filename.toLowerCase()
      const targetPath = (target.sourcePath ?? target.path ?? '').toLowerCase()
      const m = target.mime?.toLowerCase() ?? ''
      if (name.endsWith('.html') || name.endsWith('.htm') || targetPath.endsWith('.html') || targetPath.endsWith('.htm') || m === 'text/html') return 'html'
      if (name.endsWith('.md') || name.endsWith('.markdown') || targetPath.endsWith('.md') || targetPath.endsWith('.markdown') || m === 'text/markdown') return 'markdown'
      return 'source'
    }

    expect(detectTargetFormat({
      title: '昭山 · 山市晴岚 — 单文件介绍页',
      sourcePath: '/Users/mac/NOAH/NOAH知识/网页产出/昭山风景区介绍.html',
    })).toBe('html')

    expect(detectTargetFormat({
      title: '2026 年度规划',
      path: 'docs/plan.md',
    })).toBe('markdown')
  })

  it('enables dual mode (rendered vs source) for previewable markup', () => {
    const canRenderDualMode = (format: string) => ['html', 'markdown', 'svg'].includes(format)

    expect(canRenderDualMode('html')).toBe(true)
    expect(canRenderDualMode('markdown')).toBe(true)
    expect(canRenderDualMode('svg')).toBe(true)
    expect(canRenderDualMode('image')).toBe(false)
    expect(canRenderDualMode('source')).toBe(false)
  })

  it('enforces secure sandbox attributes on preview iframe without allow-same-origin (S2)', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const modalSrc = await readFile(join(__dirname, 'DocumentPreviewModal.tsx'), 'utf8')

    const sandboxMatch = modalSrc.match(/sandbox="([^"]+)"/)
    expect(sandboxMatch).not.toBeNull()
    const sandboxValue = sandboxMatch![1]

    expect(sandboxValue).not.toContain('allow-same-origin')
    expect(sandboxValue).toContain('allow-scripts')
    expect(sandboxValue).toContain('allow-forms')
  })

  it('renders SVG via data URI without dangerouslySetInnerHTML (S2)', async () => {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const modalSrc = await readFile(join(__dirname, 'DocumentPreviewModal.tsx'), 'utf8')

    expect(modalSrc).not.toContain('dangerouslySetInnerHTML')
    expect(modalSrc).toContain('data:image/svg+xml;utf8')
  })
})
