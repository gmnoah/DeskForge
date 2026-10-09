import React, { useState } from 'react'
import type { DailyUsageBucket, TokenUsageDimension } from '../../types'
import { formatTokenCount } from '../work/run-insights'

interface TokenUsageBarChartProps {
  buckets: DailyUsageBucket[]
  dimension: TokenUsageDimension
  currency: 'USD' | 'CNY'
  modelColors: Record<string, string>
}

interface HoverState {
  bucket: DailyUsageBucket
  x: number
  y: number
}

function formatValue(value: number, dimension: TokenUsageDimension, currency: 'USD' | 'CNY'): string {
  if (dimension === 'tokens') {
    return formatTokenCount(value)
  }
  if (dimension === 'cost') {
    const symbol = currency === 'USD' ? '$' : '¥'
    if (value < 0.01 && value > 0) return `<${symbol}0.01`
    return `${symbol}${value.toFixed(2)}`
  }
  return value.toLocaleString('zh-CN')
}

export function TokenUsageBarChart({
  buckets,
  dimension,
  currency,
  modelColors,
}: TokenUsageBarChartProps) {
  const [hover, setHover] = useState<HoverState | null>(null)

  // Extract bucket values according to dimension
  const getBucketTotal = (bucket: DailyUsageBucket): number => {
    if (dimension === 'tokens') return bucket.tokens
    if (dimension === 'cost') return currency === 'USD' ? bucket.costUsd : bucket.costCny
    return bucket.requests
  }

  const getModelSegmentValue = (model: { tokens: number; costUsd: number; costCny: number; requests: number }): number => {
    if (dimension === 'tokens') return model.tokens
    if (dimension === 'cost') return currency === 'USD' ? model.costUsd : model.costCny
    return model.requests
  }

  const maxTotal = Math.max(1, ...buckets.map(getBucketTotal))

  // Determine nice Y-axis ticks
  const tickCount = 4
  const yTicks: number[] = []
  for (let i = 0; i <= tickCount; i++) {
    yTicks.push(Math.round((maxTotal / tickCount) * i))
  }

  const chartHeight = 180
  const chartWidth = 600

  return (
    <div className="analytics-chart-container">
      <div className="analytics-chart-wrap">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="analytics-bar-chart-svg"
          preserveAspectRatio="none"
        >
          {/* Y-axis grid lines */}
          {yTicks.map((tick) => {
            const y = chartHeight - (tick / maxTotal) * (chartHeight - 32) - 24
            return (
              <g key={tick} className="chart-grid-line">
                <line
                  x1="45"
                  y1={y}
                  x2={chartWidth}
                  y2={y}
                  strokeDasharray="4 4"
                />
                <text x="40" y={y + 3} textAnchor="end" className="chart-axis-label">
                  {formatValue(tick, dimension, currency)}
                </text>
              </g>
            )
          })}

          {/* Bars */}
          {buckets.map((bucket, index) => {
            const total = getBucketTotal(bucket)
            const availableHeight = chartHeight - 32
            const slotWidth = (chartWidth - 50) / Math.max(1, buckets.length)
            const barWidth = Math.min(28, Math.max(10, slotWidth * 0.45))
            const centerX = 50 + index * slotWidth + slotWidth / 2
            const x = centerX - barWidth / 2
            const baseY = chartHeight - 24

            // Calculate stacked segments
            const models = Object.entries(bucket.byModel)
            let accumulatedY = 0

            return (
              <g
                key={bucket.date}
                className="chart-bar-group"
                onMouseEnter={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  setHover({
                    bucket,
                    x: rect.left + rect.width / 2,
                    y: rect.top,
                  })
                }}
                onMouseLeave={() => setHover(null)}
              >
                {/* Column transparent hit area */}
                <rect
                  x={x - 8}
                  y={0}
                  width={barWidth + 16}
                  height={chartHeight}
                  fill="transparent"
                  className="chart-bar-hit-area"
                />

                {/* Stacked rects */}
                {total > 0 ? (
                  models.map(([modelKey, modelData], mIdx) => {
                    const segmentVal = getModelSegmentValue(modelData)
                    if (segmentVal <= 0) return null
                    const segmentHeight = Math.max(2, (segmentVal / maxTotal) * availableHeight)
                    const segmentY = baseY - accumulatedY - segmentHeight
                    accumulatedY += segmentHeight
                    const color = modelColors[modelKey] || 'var(--accent)'
                    const isTop = mIdx === models.length - 1 || accumulatedY >= (total / maxTotal) * availableHeight

                    return (
                      <rect
                        key={modelKey}
                        x={x}
                        y={segmentY}
                        width={barWidth}
                        height={segmentHeight}
                        fill={color}
                        rx={isTop ? 3 : 0}
                        ry={isTop ? 3 : 0}
                        className="chart-bar-segment"
                      />
                    )
                  })
                ) : (
                  // Zero indicator dash
                  <line
                    x1={x}
                    y1={baseY}
                    x2={x + barWidth}
                    y2={baseY}
                    className="chart-zero-indicator"
                  />
                )}

                {/* X-axis date label */}
                <text
                  x={centerX}
                  y={chartHeight - 6}
                  textAnchor="middle"
                  className="chart-x-label"
                >
                  {bucket.displayDate}
                </text>
              </g>
            )
          })}
        </svg>

        {/* Hover Tooltip */}
        {hover && (
          <div
            className="chart-tooltip"
            style={{
              position: 'fixed',
              left: `${hover.x}px`,
              top: `${hover.y - 12}px`,
              transform: 'translate(-50%, -100%)',
              pointerEvents: 'none',
              zIndex: 1000,
            }}
          >
            <div className="chart-tooltip-header">
              <strong>{hover.bucket.date}</strong>
              <span>总计: {formatValue(getBucketTotal(hover.bucket), dimension, currency)}</span>
            </div>
            {Object.keys(hover.bucket.byModel).length > 0 ? (
              <div className="chart-tooltip-items">
                {Object.entries(hover.bucket.byModel).map(([name, data]) => (
                  <div key={name} className="chart-tooltip-item">
                    <span
                      className="chart-tooltip-dot"
                      style={{ backgroundColor: modelColors[name] || 'var(--accent)' }}
                    />
                    <span className="chart-tooltip-name">{name}</span>
                    <span className="chart-tooltip-value">
                      {formatValue(getModelSegmentValue(data), dimension, currency)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="chart-tooltip-empty">当日无调用记录</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
