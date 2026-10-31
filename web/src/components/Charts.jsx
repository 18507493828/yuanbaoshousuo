/**
 * 纯 SVG 图形组件，不引第三方图表库。
 * 数据都来自本次扫描结果，不画没有数据的图。
 */

/** 环形分布图：给强/中/弱线索占比，或单个分数环用（传 max） */
export function Donut({
  segments = [],
  max,
  size = 72,
  thickness = 9,
  center,
  centerClass = 'donut-num',
  track = '#eceff4'
}) {
  const sum = segments.reduce((n, s) => n + (Number(s.value) || 0), 0)
  const total = max || sum
  const r = (size - thickness) / 2
  const circumference = 2 * Math.PI * r
  const gap = segments.filter((s) => s.value > 0).length > 1 ? 1.5 : 0

  let offset = 0
  const arcs = []

  if (total > 0) {
    for (const [i, s] of segments.entries()) {
      const value = Number(s.value) || 0
      if (value <= 0) continue
      const ratio = Math.min(value / total, 1)
      const len = ratio * circumference
      const dash = Math.max(len - gap, 0.5)
      arcs.push(
        <circle
          key={i}
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={s.color}
          strokeWidth={thickness}
          strokeDasharray={`${dash} ${circumference - dash}`}
          strokeDashoffset={-offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )
      offset += len
    }
  }

  return (
    <svg className="donut" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={track}
        strokeWidth={thickness}
      />
      {arcs}
      {center !== undefined && center !== null && (
        <text
          x="50%"
          y="50%"
          textAnchor="middle"
          dominantBaseline="central"
          className={centerClass}
        >
          {center}
        </text>
      )}
    </svg>
  )
}

/** 证据点阵：一个点代表一个独立站点，颜色按信源等级深浅区分 */
export function SiteDots({ sites = [], total = 0, max = 10 }) {
  const limit = Math.min(total || sites.length, max)
  const dots = Array.from({ length: limit }, (_, i) => sites[i]?.tier || null)

  return (
    <span className="dots" title={`${total} 个独立站点`}>
      {dots.map((tier, i) => (
        <i key={i} className={`dot ${tier ? `dot-${tier}` : 'dot-x'}`} />
      ))}
      {(total || 0) > max && <em>+{total - max}</em>}
    </span>
  )
}

/** 横向条形图：本次扫描里出现频次最高的信号 */
export function SignalBars({ items = [], className = '' }) {
  const max = Math.max(...items.map((i) => i.count), 1)

  return (
    <ul className={`bars ${className}`.trim()}>
      {items.map((it) => (
        <li key={it.key}>
          <span className="bar-label">{it.key}</span>
          <span className="bar-track">
            <i style={{ width: `${Math.max((it.count / max) * 100, 6)}%` }} />
          </span>
          <span className="bar-num">{it.count}</span>
        </li>
      ))}
    </ul>
  )
}
