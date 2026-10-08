import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { bridge } from '../../bridge'
import { Icon } from '../../icons'
import type { DocumentPreviewTarget, JsonRecord } from '../../types'
import { Spinner, useFocusTrap } from '../../ui'
import { Markdown } from './WorkTimeline'

export interface DocumentPreviewModalProps {
  target?: DocumentPreviewTarget | undefined
  onClose: () => void
  onOpenExternalPath?: ((path: string) => void) | undefined
  onOpenExternalArtifact?: ((id: string) => void) | undefined
}

export function DocumentPreviewModal({
  target,
  onClose,
  onOpenExternalPath,
  onOpenExternalArtifact,
}: DocumentPreviewModalProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [text, setText] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered')
  const [viewport, setViewport] = useState<'desktop' | 'mobile'>('desktop')
  const [copied, setCopied] = useState(false)
  const [iframeKey, setIframeKey] = useState(0)
  const [imageDataUrl, setImageDataUrl] = useState<string | undefined>()

  const titleId = useId()
  const modalRef = useRef<HTMLDivElement>(null)

  const filename = useMemo(() => {
    if (!target) return ''
    if (target.title) return target.title
    if (target.path) return target.path.split('/').at(-1) ?? target.path
    return '文件预览'
  }, [target])

  const { isHtml, isMarkdown, isSvg, isImage, formatLabel } = useMemo(() => {
    const name = filename.toLowerCase()
    const mime = target?.mime?.toLowerCase() ?? ''
    const isHtml = name.endsWith('.html') || name.endsWith('.htm') || name.endsWith('.xhtml') || mime === 'text/html'
    const isMarkdown = name.endsWith('.md') || name.endsWith('.markdown') || mime === 'text/markdown'
    const isSvg = name.endsWith('.svg') || mime === 'image/svg+xml'
    const isImage = (/\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(name) || mime.startsWith('image/')) && !isSvg
    let formatLabel = 'CODE'
    if (isHtml) formatLabel = 'HTML'
    else if (isMarkdown) formatLabel = 'MARKDOWN'
    else if (isSvg) formatLabel = 'SVG'
    else if (isImage) formatLabel = 'IMAGE'
    else if (name.endsWith('.json')) formatLabel = 'JSON'
    else if (name.endsWith('.css')) formatLabel = 'CSS'
    else if (name.endsWith('.js') || name.endsWith('.ts') || name.endsWith('.tsx') || name.endsWith('.jsx')) formatLabel = 'SCRIPT'
    return { isHtml, isMarkdown, isSvg, isImage, formatLabel }
  }, [filename, target?.mime])

  const canRender = isHtml || isMarkdown || isSvg

  // Reset or initialize view mode when target changes
  useEffect(() => {
    if (!target) return
    setMode(canRender ? 'rendered' : 'source')
    setViewport('desktop')
    setCopied(false)
    setIframeKey((prev) => prev + 1)
  }, [target, canRender])

  // Load content
  useEffect(() => {
    if (!target) {
      setText('')
      setError(undefined)
      setTruncated(false)
      setImageDataUrl(undefined)
      return
    }

    if (target.content !== undefined) {
      setText(target.content)
      setTruncated(target.truncated === true)
      setImageDataUrl(undefined)
      setLoading(false)
      setError(undefined)
      return
    }

    let active = true
    setLoading(true)
    setError(undefined)
    setImageDataUrl(undefined)

    const fetchContent = async () => {
      try {
        if (target.path) {
          const result = await bridge.readFileContent(target.path)
          if (!active) return
          setText(result.text ?? '')
          setTruncated(result.truncated === true)
          setImageDataUrl(result.dataUrl)
          setLoading(false)
        } else if (target.artifactId) {
          const result = await bridge.getArtifactText(target.artifactId)
          if (!active) return
          const record = result && typeof result === 'object' ? (result as JsonRecord) : {}
          setText(typeof record.text === 'string' ? record.text : '')
          setTruncated(record.truncated === true)
          setLoading(false)
        } else {
          if (!active) return
          setText('')
          setLoading(false)
        }
      } catch (err) {
        if (!active) return
        setError(err instanceof Error ? err.message : '无法读取文件内容')
        setLoading(false)
      }
    }

    void fetchContent()

    return () => {
      active = false
    }
  }, [target])

  useFocusTrap(Boolean(target), modalRef, onClose)

  if (!target) return null

  const handleCopy = async () => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      // ignore
    }
  }

  const handleOpenExternal = () => {
    if (target.path && onOpenExternalPath) {
      onOpenExternalPath(target.path)
    } else if (target.artifactId && onOpenExternalArtifact) {
      onOpenExternalArtifact(target.artifactId)
    }
  }

  const handleReload = () => {
    setIframeKey((prev) => prev + 1)
  }

  const lineCount = text ? text.split('\n').length : 0
  const charCount = text ? text.length : 0

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <section
        ref={modalRef}
        className="modal-document-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="document-preview-header">
          <div className="document-preview-meta">
            <span className="document-preview-icon">
              <Icon name={isHtml ? 'globe' : isImage ? 'file' : 'file'} size={15} />
            </span>
            <strong id={titleId} className="document-preview-title" title={target.path ?? filename}>
              {filename}
            </strong>
            <span className="document-preview-tag">{formatLabel}</span>
            {truncated && <span className="document-preview-tag warning">{isImage ? '图片超过 10 MB' : '已截取前 2 MB'}</span>}
          </div>

          <div className="document-preview-toolbar">
            {canRender && (
              <div className="document-preview-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'rendered'}
                  className={`document-preview-tab-btn${mode === 'rendered' ? ' is-active' : ''}`}
                  onClick={() => setMode('rendered')}
                >
                  <Icon name={isHtml ? 'globe' : 'file'} size={13} />
                  <span>{isHtml ? '网页渲染' : isMarkdown ? '排版预览' : '矢量预览'}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'source'}
                  className={`document-preview-tab-btn${mode === 'source' ? ' is-active' : ''}`}
                  onClick={() => setMode('source')}
                >
                  <Icon name="file" size={13} />
                  <span>源代码</span>
                </button>
              </div>
            )}

            {isHtml && mode === 'rendered' && (
              <div className="document-preview-viewport-toggle" title="切换视口大小">
                <button
                  type="button"
                  className={`document-preview-viewport-btn${viewport === 'desktop' ? ' is-active' : ''}`}
                  onClick={() => setViewport('desktop')}
                >
                  全宽
                </button>
                <button
                  type="button"
                  className={`document-preview-viewport-btn${viewport === 'mobile' ? ' is-active' : ''}`}
                  onClick={() => setViewport('mobile')}
                >
                  移动端
                </button>
              </div>
            )}

            {isHtml && mode === 'rendered' && (
              <button
                type="button"
                className="document-preview-btn"
                title="重新载入页面"
                onClick={handleReload}
              >
                <Icon name="refresh" size={13} />
                <span>刷新</span>
              </button>
            )}

            <button
              type="button"
              className={`document-preview-btn${copied ? ' is-copied' : ''}`}
              title="复制全部代码/文本"
              onClick={handleCopy}
            >
              <Icon name={copied ? 'check' : 'copy'} size={13} />
              <span>{copied ? '已复制' : '复制'}</span>
            </button>

            {(target.path || target.artifactId) && (
              <button
                type="button"
                className="document-preview-btn"
                title="在默认浏览器 / 系统程序中打开"
                onClick={handleOpenExternal}
              >
                <Icon name="external" size={13} />
                <span>在外部打开</span>
              </button>
            )}

            <button
              type="button"
              className="icon-button"
              title="关闭预览 (Esc)"
              aria-label="关闭预览"
              onClick={onClose}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </header>

        <div className="document-preview-body">
          {loading && (
            <div className="document-preview-status">
              <Spinner size={24} />
              <span>正在读取文件内容…</span>
            </div>
          )}

          {!loading && error && (
            <div className="document-preview-status error">
              <Icon name="warning" size={28} />
              <p>{error}</p>
              {(target.path || target.artifactId) && (
                <button type="button" className="button secondary" onClick={handleOpenExternal}>
                  尝试在系统默认程序中打开
                </button>
              )}
            </div>
          )}

          {!loading && !error && (
            <>
              {isImage ? (
                <div className="document-preview-image-wrapper">
                  {target.content ?? imageDataUrl ? (
                    <img
                      src={target.content ?? imageDataUrl}
                      alt={filename}
                    />
                  ) : (
                    <p className="document-preview-note">图片超过 10 MB，无法内置预览，请在系统默认程序中打开。</p>
                  )}
                </div>
              ) : mode === 'rendered' && isHtml ? (
                <div className={`document-preview-viewport-wrapper viewport-${viewport}`}>
                  <iframe
                    key={iframeKey}
                    sandbox="allow-scripts allow-forms"
                    srcDoc={text}
                    title={filename}
                    className="document-preview-iframe"
                  />
                </div>
              ) : mode === 'rendered' && isMarkdown ? (
                <div className="document-preview-markdown-wrapper">
                  <Markdown onOpenPath={onOpenExternalPath}>{text}</Markdown>
                </div>
              ) : mode === 'rendered' && isSvg ? (
                <div className="document-preview-svg-wrapper">
                  <img
                    src={`data:image/svg+xml;utf8,${encodeURIComponent(text)}`}
                    alt={filename}
                    className="document-preview-svg-image"
                  />
                </div>
              ) : (
                <div className="document-preview-source-wrapper">
                  <pre>
                    <code>{text}</code>
                  </pre>
                </div>
              )}
            </>
          )}
        </div>

        <footer className="document-preview-footer">
          <div className="document-preview-footer-left">
            <span>{lineCount} 行</span>
            <span>{charCount} 字符</span>
            {target.path && <span title={target.path}>{target.path}</span>}
          </div>
          <div className="document-preview-footer-right">
            {isHtml && mode === 'rendered' && <span>内置沙箱安全预览 · 包含实时 JS 运行环境</span>}
            <span>Esc 退出预览</span>
          </div>
        </footer>
      </section>
    </div>
  )
}
