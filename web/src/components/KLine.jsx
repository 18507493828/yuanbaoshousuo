/**
 * 日 K 线蜡烛图，纯 SVG。
 * 涨红跌绿按 A 股习惯；纵轴不标数字，避免缩放时文字变形，数值放图例里。
 */

const UP = '#cf2b45'
const DOWN = '#0f9d6e'
const MA = '#c08a2a'
const GRID = '#f1f3f7'

const W = 640
const H = 150
const PRICE_TOP = 4
const PRICE_BOTTOM = 100
const VOL_TOP = 110
const VOL_BOTTOM = 146
const MA_WINDOW = 20

function fmt(v) {
  if (!Number.isFinite(v)) return '—'
  return v >= 100 ? v.toFixed(1) : v.toFixed(2)
}

export default function KLine({ data, height = 132 }) {
  const bars = data?.bars || []
  if (!bars.length) return null

  const highs = bars.map((b) => b.high)
  const lows = bars.map((b) => b.low)
  const max = Math.max(...highs)
  const min = Math.min(...lows)
  const span = max - min || 1
  const maxVol = Math.max(...bars.map((b) => b.volume || 0), 1)

  const step = W / bars.length
  const bodyW = Math.max(1.4, Math.min(step * 0.62, 7))
  const yOf = (p) => PRICE_BOTTOM - ((p - min) / span) * (PRICE_BOTTOM - PRICE_TOP)

  // MA20：收盘价简单移动平均
  const maPoints = []
  let sum = 0
  for (let i = 0; i < bars.length; i += 1) {
    sum += bars[i].close
    if (i >= MA_WINDOW) sum -= bars[i - MA_WINDOW].close
    if (i >= MA_WINDOW - 1) {
      const x = i * step + step / 2
      maPoints.push(`${x.toFixed(2)},${yOf(sum / MA_WINDOW).toFixed(2)}`)
    }
  }

  return (
    <div className="kline">
      <div className="kline-legend">
        <span>
          最新 <b>{fmt(data.summary?.latest)}</b>
        </span>
        <span className={data.summary?.changePct >= 0 ? 'is-up' : 'is-down'}>
          {bars.length} 日 {data.summary?.changePct >= 0 ? '+' : ''}
          {data.summary?.changePct}%
        </span>
        <span>
          区间 {fmt(data.summary?.low)}–{fmt(data.summary?.high)}
        </span>
        <span className="kline-src">
          {data.source} · {data.source === '新浪财经' ? '日线不复权' : '前复权'}
          {data.cached ? ' · 缓存' : ''}
        </span>
      </div>

      <svg
        className="kline-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        height={height}
        role="img"
        aria-label={`${data.name || data.code} 最近 ${bars.length} 个交易日 K 线`}
      >
        {[0.25, 0.5, 0.75].map((r) => (
          <line
            key={r}
            x1="0"
            x2={W}
            y1={PRICE_TOP + (PRICE_BOTTOM - PRICE_TOP) * r}
            y2={PRICE_TOP + (PRICE_BOTTOM - PRICE_TOP) * r}
            stroke={GRID}
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {bars.map((b, i) => {
          const x = i * step + step / 2
          const up = b.close >= b.open
          const color = up ? UP : DOWN
          const top = yOf(Math.max(b.open, b.close))
          const bottom = yOf(Math.min(b.open, b.close))
          const h = Math.max(bottom - top, 1.2)

          const volH = ((b.volume || 0) / maxVol) * (VOL_BOTTOM - VOL_TOP)

          return (
            <g key={b.date + i}>
              <line
                x1={x}
                x2={x}
                y1={yOf(b.high)}
                y2={yOf(b.low)}
                stroke={color}
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
              <rect
                x={x - bodyW / 2}
                y={top}
                width={bodyW}
                height={h}
                fill={color}
                opacity={up ? 0.95 : 0.9}
              />
              <rect
                x={x - bodyW / 2}
                y={VOL_BOTTOM - volH}
                width={bodyW}
                height={Math.max(volH, 0.6)}
                fill={color}
                opacity="0.22"
              />
            </g>
          )
        })}

        {maPoints.length > 1 && (
          <polyline
            points={maPoints.join(' ')}
            fill="none"
            stroke={MA}
            strokeWidth="1.2"
            opacity="0.85"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      <div className="kline-axis">
        <span>{bars[0]?.date}</span>
        <span className="kline-ma">MA20</span>
        <span>{bars[bars.length - 1]?.date}</span>
      </div>
    </div>
  )
}
