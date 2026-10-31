/** 后端接口封装：健康检查、策略列表、SSE 选股扫描、报告导出 */

export async function fetchHealth() {
  const res = await fetch('/api/health')
  if (!res.ok) throw new Error(`健康检查失败：HTTP ${res.status}`)
  return res.json()
}

export async function fetchStrategies() {
  const res = await fetch('/api/strategies')
  if (!res.ok) throw new Error(`策略列表加载失败：HTTP ${res.status}`)
  return res.json()
}

/**
 * 发起选股扫描，消费 SSE 事件
 * @param {object} body { query } 或兼容旧写法 { topic, strategies, persona, freshness, cnt, limit, filters }
 */
export async function streamScreen(
  body,
  { onPlanStart, onPlan, onMeta, onQuery, onCandidates, onEnrichStart, onEnrich, onDone, signal }
) {
  const res = await fetch('/api/screen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })

  const contentType = res.headers.get('content-type') || ''
  if (!res.ok || !contentType.includes('event-stream')) {
    let message = `请求失败：HTTP ${res.status}`
    let code = 'HTTP_ERROR'
    try {
      const data = await res.json()
      if (data?.error?.message) message = data.error.message
      if (data?.error?.code) code = data.error.code
    } catch {
      /* 保持默认文案 */
    }
    // 5xx 基本都是 Node 服务没起或刚崩，本地开发最常见的情况
    if (res.status >= 500 && code === 'HTTP_ERROR') {
      message = '后端服务没有响应（127.0.0.1:8787）。先运行 npm run dev，等 api 起来后再试。'
      code = 'BACKEND_DOWN'
    }
    const err = new Error(message)
    err.code = code
    throw err
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const dispatch = (rawChunk) => {
    let event = 'message'
    let data = ''
    for (const line of rawChunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data += line.slice(5).trim()
    }
    if (!data) return
    let payload
    try {
      payload = JSON.parse(data)
    } catch {
      return
    }
    if (event === 'plan_start') onPlanStart?.(payload)
    else if (event === 'plan') onPlan?.(payload)
    else if (event === 'meta') onMeta?.(payload)
    else if (event === 'query') onQuery?.(payload)
    else if (event === 'candidates') onCandidates?.(payload)
    else if (event === 'enrich_start') onEnrichStart?.(payload)
    else if (event === 'enrich') onEnrich?.(payload)
    else if (event === 'done') onDone?.(payload)
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let cut
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      if (chunk.trim()) dispatch(chunk)
    }
  }
  if (buffer.trim()) dispatch(buffer)
}

/**
 * 日 K 线（前复权），服务端代理公开行情接口。
 * 列表默认全展开时会同时要几十张图，这里限并发，别把行情接口打满。
 */
const KLINE_LIMIT = 4
let klineActive = 0
const klineWaiting = []

function acquireKline() {
  if (klineActive < KLINE_LIMIT) {
    klineActive += 1
    return Promise.resolve()
  }
  return new Promise((resolve) => klineWaiting.push(resolve))
}

function releaseKline() {
  const next = klineWaiting.shift()
  if (next) next()
  else klineActive = Math.max(0, klineActive - 1)
}

export async function fetchKline(code, market, days = 120) {
  await acquireKline()
  try {
    const qs = new URLSearchParams({ code, market, days: String(days) })
    const res = await fetch(`/api/kline?${qs}`)
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error(data?.error?.message || `K 线加载失败：HTTP ${res.status}`)
    }
    return data
  } finally {
    releaseKline()
  }
}

/**
 * 追问：把一句话解析成对现有名单的调整操作。
 * 只传名单的关键字段，不重传证据，省流量也避免模型被长文带偏。
 */
export async function fetchRefine({ query, plan, candidates }) {
  const slim = (candidates || []).map((c) => ({
    code: c.code,
    name: c.name,
    board: c.board,
    price: c.price ?? null,
    marketCap: c.marketCap ?? null,
    pe: c.pe ?? null,
    level: c.level,
    score: c.score,
    industry: c.industry || ''
  }))

  const res = await fetch('/api/refine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, plan, candidates: slim })
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.error?.message || `追问失败：HTTP ${res.status}`)
  }
  return data
}

/**
 * 按需 AI 分析。
 *   scope=stock   一只票的综合研判（消息面 + 行情 + 走势）
 *   scope=message 单条消息的解读
 * 返回 { ok, analysis, trend } 或 { ok:false, reason }
 */
export async function fetchAnalyze({ scope = 'stock', stock, messages = [], message = null, persona }) {
  const res = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, stock, messages, message, persona })
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.message || data?.error?.message || `AI 分析失败：HTTP ${res.status}`)
  }
  return data
}

/** 批量取名称与行业，拿不到就返回空数组，不阻断主流程 */export async function fetchProfile(items) {
  if (!items?.length) return []
  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data?.profiles) ? data.profiles : []
  } catch {
    return []
  }
}

export async function fetchReport(payload) {
  const res = await fetch('/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
  if (!res.ok) {
    let message = `导出失败：HTTP ${res.status}`
    try {
      const data = await res.json()
      if (data?.error?.message) message = data.error.message
    } catch {
      /* ignore */
    }
    throw new Error(message)
  }
  return res.text()
}

/** 触发浏览器下载 */
export function downloadMarkdown(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
