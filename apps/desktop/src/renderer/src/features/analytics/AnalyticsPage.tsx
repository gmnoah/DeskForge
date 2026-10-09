import React, { useEffect, useMemo, useState } from 'react'
import { bridge } from '../../bridge'
import { Icon } from '../../icons'
import type {
  TokenUsageDimension,
  TokenUsageMetricsReport,
  TokenUsageTimeRange,
} from '../../types'
import { Spinner } from '../../ui'
import { formatTokenCount } from '../work/run-insights'
import { TokenUsageBarChart } from './TokenUsageBarChart'

const MODEL_PALETTE = [
  '#6366f1', // Indigo
  '#06b6d4', // Cyan
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#ec4899', // Pink
  '#8b5cf6', // Violet
  '#3b82f6', // Blue
  '#14b8a6', // Teal
]

interface AnalyticsPageProps {
  onBackToTasks?: () => void
}

export function AnalyticsPage({ onBackToTasks }: AnalyticsPageProps) {
  const [range, setRange] = useState<TokenUsageTimeRange>('7d')
  const [provider, setProvider] = useState<string>('all')
  const [dimension, setDimension] = useState<TokenUsageDimension>('tokens')
  const [currency, setCurrency] = useState<'USD' | 'CNY'>('USD')
  const [metrics, setMetrics] = useState<TokenUsageMetricsReport | null>(null)
  const [loading, setLoading] = useState<boolean>(true)

  const loadMetrics = async (targetRange = range, targetProvider = provider) => {
    setLoading(true)
    try {
      const data = await bridge.getTokenUsage({
        range: targetRange,
        ...(targetProvider === 'all' ? {} : { provider: targetProvider }),
      })
      setMetrics(data)
    } catch {
      setMetrics(null)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadMetrics(range, provider)
  }, [range, provider])

  // Assign consistent colors to each model
  const modelColors = useMemo(() => {
    const colors: Record<string, string> = {}
    if (!metrics) return colors
    metrics.modelBreakdowns.forEach((item, index) => {
      colors[item.modelName || item.modelId] = MODEL_PALETTE[index % MODEL_PALETTE.length] ?? '#6366f1'
    })
    return colors
  }, [metrics])

  return (
    <div className="analytics-page">
      {/* Top Filter and Controls Bar */}
      <header className="analytics-header titlebar-drag">
        <div className="analytics-header-left">
          {onBackToTasks && (
            <button
              type="button"
              className="button ghost icon-only no-drag"
              title="返回工作"
              onClick={onBackToTasks}
            >
              <Icon name="arrowRight" size={16} style={{ transform: 'rotate(180deg)' }} />
            </button>
          )}
          <div className="analytics-title-group">
            <h1>用量与计费</h1>
            <span className="analytics-subtitle">
              统计模型调用与会话日志；记录每次回合的 Token、费用与响应耗时。
            </span>
          </div>
        </div>

        <div className="analytics-controls no-drag">
          {/* Time range segmented control */}
          <div className="segmented-control" role="group" aria-label="时间范围">
            <button
              type="button"
              className={`segmented-btn ${range === 'today' ? 'is-active' : ''}`}
              onClick={() => setRange('today')}
            >
              今天
            </button>
            <button
              type="button"
              className={`segmented-btn ${range === '7d' ? 'is-active' : ''}`}
              onClick={() => setRange('7d')}
            >
              7 天
            </button>
            <button
              type="button"
              className={`segmented-btn ${range === '30d' ? 'is-active' : ''}`}
              onClick={() => setRange('30d')}
            >
              30 天
            </button>
            <button
              type="button"
              className={`segmented-btn ${range === 'all' ? 'is-active' : ''}`}
              onClick={() => setRange('all')}
            >
              全部
            </button>
          </div>

          {/* Provider selector */}
          <div className="analytics-select-wrap">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              aria-label="筛选供应商"
            >
              <option value="all">全部供应商</option>
              <option value="deepseek">DeepSeek</option>
              <option value="kimi">Kimi</option>
              <option value="tongyi">通义千问</option>
              <option value="custom">自定义 / 兼容</option>
            </select>
            <Icon name="chevronDown" size={14} className="analytics-select-arrow" />
          </div>

          {/* Currency switch */}
          <div className="segmented-control" role="group" aria-label="货币单位">
            <button
              type="button"
              className={`segmented-btn ${currency === 'USD' ? 'is-active' : ''}`}
              onClick={() => setCurrency('USD')}
              title="美元计价"
            >
              USD ($)
            </button>
            <button
              type="button"
              className={`segmented-btn ${currency === 'CNY' ? 'is-active' : ''}`}
              onClick={() => setCurrency('CNY')}
              title="人民币计价"
            >
              CNY (¥)
            </button>
          </div>

          {/* Refresh button */}
          <button
            type="button"
            className="button secondary icon-only"
            title="刷新数据"
            disabled={loading}
            onClick={() => void loadMetrics(range, provider)}
          >
            {loading ? <Spinner size={14} /> : <Icon name="refresh" size={14} />}
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="analytics-content">
        {/* Top 4 Summary Cards */}
        <section className="analytics-metric-grid">
          {/* Card 1: Token */}
          <div className="analytics-card metric-card">
            <span className="metric-card-label">Token</span>
            <div className="metric-card-primary">
              {metrics ? formatTokenCount(metrics.totalTokens) : '—'}
            </div>
            <div className="metric-card-sub">
              {metrics ? (
                <>
                  输入 {formatTokenCount(metrics.promptTokens)} · 输出{' '}
                  {formatTokenCount(metrics.completionTokens)} · 缓存{' '}
                  {formatTokenCount(metrics.cacheReadTokens)}
                </>
              ) : (
                '暂无数据'
              )}
            </div>
          </div>

          {/* Card 2: Requests */}
          <div className="analytics-card metric-card">
            <span className="metric-card-label">请求</span>
            <div className="metric-card-primary">
              {metrics ? metrics.totalRequests.toLocaleString('zh-CN') : '—'}
            </div>
            <div
              className={`metric-card-sub ${
                metrics && metrics.failedRequests > 0 ? 'is-danger' : ''
              }`}
            >
              {metrics ? (
                metrics.failedRequests > 0 ? (
                  `${metrics.failedRequests} 次失败`
                ) : (
                  '0 次失败'
                )
              ) : (
                '暂无数据'
              )}
            </div>
          </div>

          {/* Card 3: Cost */}
          <div className="analytics-card metric-card">
            <span className="metric-card-label">费用</span>
            <div className="metric-card-primary is-cost">
              {metrics
                ? `≈${currency === 'USD' ? '$' : '¥'}${
                    currency === 'USD'
                      ? metrics.estimatedCostUsd.toFixed(2)
                      : metrics.estimatedCostCny.toFixed(2)
                  }${metrics.unknownPriceCount > 0 ? '+' : ''}`
                : '—'}
            </div>
            <div className="metric-card-sub">
              {metrics && metrics.unknownPriceCount > 0
                ? `${metrics.unknownPriceCount} 个未配置价格`
                : '按官方单价估算'}
            </div>
          </div>

          {/* Card 4: Cache Hit Rate */}
          <div className="analytics-card metric-card">
            <span className="metric-card-label">缓存命中率</span>
            <div className="metric-card-primary">
              {metrics ? `${Math.round(metrics.cacheHitRate * 100)}%` : '0%'}
            </div>
            <div className="metric-card-sub">占提示词</div>
          </div>
        </section>

        {/* Main Section: Chart & Breakdown List */}
        <section className="analytics-card chart-card">
          <div className="chart-card-header">
            {/* Dimension Switcher */}
            <div className="segmented-control chart-dimension-switch" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={dimension === 'tokens'}
                className={`segmented-btn ${dimension === 'tokens' ? 'is-active' : ''}`}
                onClick={() => setDimension('tokens')}
              >
                Token
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={dimension === 'cost'}
                className={`segmented-btn ${dimension === 'cost' ? 'is-active' : ''}`}
                onClick={() => setDimension('cost')}
              >
                费用
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={dimension === 'requests'}
                className={`segmented-btn ${dimension === 'requests' ? 'is-active' : ''}`}
                onClick={() => setDimension('requests')}
              >
                请求
              </button>
            </div>
          </div>

          {/* Chart Display */}
          {metrics && metrics.dailyBuckets.length > 0 ? (
            <TokenUsageBarChart
              buckets={metrics.dailyBuckets}
              dimension={dimension}
              currency={currency}
              modelColors={modelColors}
            />
          ) : (
            <div className="analytics-empty-chart">
              <span>暂无对应时间段的调用记录</span>
            </div>
          )}

          {/* Breakdown List by Model */}
          <div className="analytics-breakdown-section">
            <h3 className="breakdown-title">模型用量构成</h3>
            {metrics && metrics.modelBreakdowns.length > 0 ? (
              <div className="breakdown-list">
                {metrics.modelBreakdowns.map((item) => {
                  const color = modelColors[item.modelName || item.modelId] || 'var(--accent)'
                  const displayCost =
                    currency === 'USD'
                      ? `$${item.costUsd.toFixed(2)}`
                      : `¥${item.costCny.toFixed(2)}`
                  const dimValue =
                    dimension === 'tokens'
                      ? `${item.tokens.toLocaleString('zh-CN')} tokens`
                      : dimension === 'cost'
                      ? `≈${displayCost}`
                      : `${item.requests} 个请求`

                  return (
                    <div key={item.modelId} className="breakdown-item">
                      <div className="breakdown-item-top">
                        <div className="breakdown-model-info">
                          <span
                            className="breakdown-model-dot"
                            style={{ backgroundColor: color }}
                          />
                          <span className="breakdown-model-name">
                            {item.modelName || item.modelId}
                          </span>
                          <span className="breakdown-model-provider-badge">
                            {item.provider}
                          </span>
                        </div>
                        <span className="breakdown-item-value">{dimValue}</span>
                      </div>

                      {/* Progress Bar */}
                      <div className="breakdown-progress-track">
                        <div
                          className="breakdown-progress-fill"
                          style={{
                            width: `${Math.max(2, item.percentage)}%`,
                            backgroundColor: color,
                          }}
                        />
                      </div>

                      {/* Meta line */}
                      <div className="breakdown-item-meta">
                        <span>{item.requests} 个请求</span>
                        <span>·</span>
                        <span>≈{displayCost}</span>
                        {item.tokensPerSecond > 0 && (
                          <>
                            <span>·</span>
                            <span>{item.tokensPerSecond} token/秒</span>
                          </>
                        )}
                        <span>·</span>
                        <span>{item.percentage}%</span>
                        {item.failedRequests > 0 && (
                          <>
                            <span>·</span>
                            <span className="breakdown-failed-count">
                              {item.failedRequests} 次失败
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="breakdown-empty">暂无模型调用数据</div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
