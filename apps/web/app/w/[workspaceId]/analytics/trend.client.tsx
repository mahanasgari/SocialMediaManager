'use client'

import { useState } from 'react'

export type SeriesPoint = {
  day: string
  postsPublished: number
  impressions: number | null
  reach: number | null
  likes: number | null
  engagementRate: number | null
}

export type SeriesData = {
  windowDays: number
  from: string
  points: SeriesPoint[]
  totals: Record<string, number | null>
  previous: Record<string, number | null>
  comparable: boolean
}

/**
 * Impressions per day.
 *
 * COLUMNS, NOT A LINE, and the first version got this wrong. A line says the
 * quantity between two points is meaningful, and it is not: posting is
 * episodic, so most days have no reading and the line drew isolated dots
 * joined by implication. Daily totals are discrete magnitudes compared against
 * each other, which is a column's job.
 *
 * ONE HUE, not a categorical palette. The days are not entities to tell apart —
 * identity is not the job here, magnitude is — so a palette that assigns each
 * day its own colour would be inventing distinctions the data does not have.
 *
 * A DAY WITH NO READING DRAWS NOTHING, and is not the same as a day that
 * measured zero. Both are visually blank in a column chart, so the tooltip is
 * what separates them: "no impressions reported" against "0 impressions". Reach
 * and the published count ride along there too, which is why one series on the
 * plot loses nothing.
 */
export function Trend({ data }: { data: SeriesData }) {
  const [hover, setHover] = useState<number | null>(null)

  const width = 720
  const height = 180
  const pad = { top: 10, right: 8, bottom: 22, left: 44 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom

  const values = data.points
    .map((p) => p.impressions)
    .filter((v): v is number => typeof v === 'number')
  const max = values.length > 0 ? Math.max(...values) : 0

  if (max === 0) {
    return (
      <p className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
        No impressions recorded in this window yet. Metrics arrive after a post publishes, and some
        networks report them a day late.
      </p>
    )
  }

  const band = plotW / data.points.length
  // Capped, and never filling the slot — the leftover is deliberate air.
  const barW = Math.min(band - 2, 24)
  const active = hover === null ? null : data.points[hover]

  return (
    <div className="viz-root">
      <style>{`
        .viz-root { --series-1: #2a78d6; }
        @media (prefers-color-scheme: dark) {
          :root:where(:not([data-theme="light"])) .viz-root { --series-1: #3987e5; }
        }
        :root[data-theme="dark"] .viz-root { --series-1: #3987e5; }
      `}</style>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={`Impressions per day over the last ${data.windowDays} days`}
        onMouseLeave={() => setHover(null)}
      >
        {/* Recessive grid: three lines, no box, no tick on every value. */}
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line
              x1={pad.left}
              x2={pad.left + plotW}
              y1={pad.top + plotH - f * plotH}
              y2={pad.top + plotH - f * plotH}
              stroke="currentColor"
              className="text-border"
              strokeWidth={1}
            />
            <text
              x={pad.left - 8}
              y={pad.top + plotH - f * plotH + 3}
              textAnchor="end"
              className="fill-muted-foreground text-[9px] tabular-nums"
            >
              {compact(max * f)}
            </text>
          </g>
        ))}

        {data.points.map((point, i) => {
          const centre = pad.left + i * band + band / 2
          const value = point.impressions
          const h = typeof value === 'number' ? (value / max) * plotH : 0

          return (
            <g key={point.day}>
              {/* Hit target spans the whole band, far larger than the bar. */}
              <rect
                x={pad.left + i * band}
                y={pad.top}
                width={band}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
              {hover === i && (
                <rect
                  x={pad.left + i * band}
                  y={pad.top}
                  width={band}
                  height={plotH}
                  className="fill-muted"
                  opacity={0.35}
                />
              )}
              {h > 0 && (
                // 4px rounded data-end, square at the baseline: the shape grows
                // from the axis rather than floating.
                <rect
                  x={centre - barW / 2}
                  y={pad.top + plotH - h}
                  width={barW}
                  height={h}
                  rx={Math.min(4, barW / 2)}
                  fill="var(--series-1)"
                />
              )}
              {h > 0 && h > 6 && (
                <rect
                  x={centre - barW / 2}
                  y={pad.top + plotH - Math.min(4, h)}
                  width={barW}
                  height={Math.min(4, h)}
                  fill="var(--series-1)"
                />
              )}
            </g>
          )
        })}

        <line
          x1={pad.left}
          x2={pad.left + plotW}
          y1={pad.top + plotH}
          y2={pad.top + plotH}
          stroke="currentColor"
          className="text-border"
          strokeWidth={1}
        />

        <text x={pad.left} y={height - 6} className="fill-muted-foreground text-[9px]">
          {data.points[0]?.day}
        </text>
        <text
          x={pad.left + plotW}
          y={height - 6}
          textAnchor="end"
          className="fill-muted-foreground text-[9px]"
        >
          {data.points[data.points.length - 1]?.day}
        </text>
      </svg>

      {/* The readout carries what one series on the plot leaves out — and the
          distinction a blank column cannot make on its own. */}
      <p className="mt-1 min-h-[1.25rem] text-xs text-muted-foreground" aria-live="polite">
        {active ? (
          <>
            <span className="font-medium text-foreground">{active.day}</span>
            {' · '}
            {active.impressions === null
              ? 'no impressions reported'
              : `${fmt(active.impressions)} impressions`}
            {' · '}
            {active.reach === null ? 'no reach reported' : `${fmt(active.reach)} reach`}
            {active.postsPublished > 0 && ` · ${active.postsPublished} published`}
          </>
        ) : (
          'Hover a day for its numbers.'
        )}
      </p>
    </div>
  )
}

/**
 * Period-over-period deltas.
 *
 * A KPI row rather than a chart: five numbers whose job is comparison against
 * one other number each, which a plot would only decorate.
 */
export function Comparison({ data }: { data: SeriesData }) {
  const rows = [
    { key: 'postsPublished', label: 'Published' },
    { key: 'impressions', label: 'Impressions' },
    { key: 'reach', label: 'Reach' },
    { key: 'likes', label: 'Likes' },
    { key: 'clicks', label: 'Clicks' },
  ]

  return (
    <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {rows.map(({ key, label }) => {
        const now = data.totals[key]
        const before = data.previous[key]
        const delta =
          typeof now === 'number' && typeof before === 'number' && before > 0
            ? ((now - before) / before) * 100
            : null

        return (
          <div key={key} className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums">
              {/* An em dash, never 0. "Not reported" and "zero" are different
                  claims, and this is where the difference is loudest. */}
              {typeof now === 'number' ? fmt(now) : '—'}
            </p>
            {delta !== null && data.comparable ? (
              <p className="text-xs tabular-nums text-muted-foreground">
                <span style={{ color: delta >= 0 ? 'hsl(var(--success))' : 'hsl(var(--warning))' }}>
                  {delta >= 0 ? '+' : ''}
                  {delta.toFixed(1)}%
                </span>{' '}
                vs previous
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">no earlier period</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function fmt(value: number): string {
  return value.toLocaleString()
}

/** Axis labels only. Full precision lives in the readout and the tiles. */
function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(Math.round(value))
}
