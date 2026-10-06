import { Icon } from '../../icons'
import type { ConnectionTestView } from './connection-test'

export function ConnectionTestNotice({ result, onClose }: { result: ConnectionTestView; onClose?: () => void }) {
  return <div className={`inline-notice connection-test-result ${result.tone === 'error' ? 'error' : 'success'}`} role="status" aria-live="polite">
    <Icon name={result.tone === 'error' ? 'warning' : 'check'} />
    <span>
      <strong>{result.title}</strong>
      {result.detail && <small>{result.detail}</small>}
      {result.suggestion && <small>{result.suggestion}</small>}
      {result.notice && <small className="connection-test-notice">{result.notice}</small>}
      {result.technical && <details><summary>技术信息</summary><code>{result.technical}</code></details>}
    </span>
    {onClose && <button type="button" onClick={onClose}>关闭</button>}
  </div>
}
