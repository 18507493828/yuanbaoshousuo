/**
 * 日 K 线：只为了让人看清「这只票现在在什么位置」，不参与打分。
 *
 * 数据源是公开行情接口（腾讯为主、东方财富兜底），前复权。
 * 模型不参与这一层——文本模型生成不出真实价格，只有真接口能给。
 */

const TIMEOUT_MS = 8000
const TTL = 10 * 60 * 1000
const CACHE_MAX = 200

const cache = new Map()

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > TTL) {
    cache.delete(key)
    return null
  }
  return hit.value
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) cache.delete(oldest[0])
  }
  cache.set(key, { at: Date.now(), value })
}

async function getJson(url, referer = 'https://gu.qq.com/') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        ...(referer ? { referer } : {})
      }
    })
    if (!res.ok) throw new Error(`行情接口 HTTP ${res.status}`)
    const text = await res.text()
    // 被 WAF 拦下来时返回的是 HTML 页面，不是 JSON
    if (/^\s*</.test(text)) {
      const err = new Error('行情接口被拦截（返回 HTML）')
      err.blocked = true
      throw err
    }
    return JSON.parse(text)
  } finally {
    clearTimeout(timer)
  }
}

/** 腾讯接口被 WAF 挡过之后，半小时内不再去试，省得每次等一次失败 */
let tencentBlockedUntil = 0

function symbolOf(code, market) {
  const prefix = market === 'SH' ? 'sh' : market === 'SZ' ? 'sz' : 'bj'
  return `${prefix}${code}`
}

function validBar(b) {
  return (
    b.date &&
    Number.isFinite(b.open) &&
    Number.isFinite(b.close) &&
    Number.isFinite(b.high) &&
    Number.isFinite(b.low) &&
    b.open > 0 &&
    b.close > 0 &&
    b.high >= b.low
  )
}

/** 腾讯财经：一次拿日期/开/收/高/低/量，sh、sz、bj 前缀通用 */
async function fromTencent(code, market, days) {
  if (Date.now() < tencentBlockedUntil) return null
  const symbol = symbolOf(code, market)
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${days},qfq`
  let json
  try {
    json = await getJson(url)
  } catch (err) {
    if (err?.blocked) tencentBlockedUntil = Date.now() + 30 * 60 * 1000
    throw err
  }
  const node = json?.data?.[symbol]
  if (!node) return null

  const rows = node.qfqday || node.day || []
  const bars = rows
    .map((r) => ({
      date: String(r[0] || ''),
      open: Number(r[1]),
      close: Number(r[2]),
      high: Number(r[3]),
      low: Number(r[4]),
      volume: Number(r[5]) || 0
    }))
    .filter(validBar)

  if (!bars.length) return null
  return { source: '腾讯财经', name: node.qt?.[symbol]?.[1] || '', bars }
}

/** 新浪财经：日线，返回标准 JSON 数组，腾讯被拦时用它顶上 */
async function fromSina(code, market, days) {
  const symbol = symbolOf(code, market)
  const url =
    `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData` +
    `?symbol=${symbol}&scale=240&ma=no&datalen=${days}`
  const json = await getJson(url, '')
  const rows = Array.isArray(json) ? json : []
  const bars = rows
    .map((r) => ({
      date: String(r.day || ''),
      open: Number(r.open),
      close: Number(r.close),
      high: Number(r.high),
      low: Number(r.low),
      volume: Number(r.volume) || 0
    }))
    .filter(validBar)

  if (!bars.length) return null
  return { source: '新浪财经', name: '', bars }
}

/** 东方财富：前两个都拿不到时兜底，secid 1=沪 0=深 */
async function fromEastmoney(code, market, days) {
  if (market === 'BJ') return null
  const secid = `${market === 'SH' ? 1 : 0}.${code}`
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
    `&klt=101&fqt=1&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56&end=20500101&lmt=${days}`
  const json = await getJson(url, 'https://quote.eastmoney.com/')
  const rows = json?.data?.klines || []
  const bars = rows
    .map((line) => {
      const p = String(line).split(',')
      return {
        date: p[0],
        open: Number(p[1]),
        close: Number(p[2]),
        high: Number(p[3]),
        low: Number(p[4]),
        volume: Number(p[5]) || 0
      }
    })
    .filter(validBar)

  if (!bars.length) return null
  return { source: '东方财富', name: json?.data?.name || '', bars }
}

function summarize(bars) {
  const first = bars[0]
  const last = bars[bars.length - 1]
  const highs = bars.map((b) => b.high)
  const lows = bars.map((b) => b.low)
  const changePct = first.close > 0 ? ((last.close - first.close) / first.close) * 100 : 0

  return {
    latest: last.close,
    latestDate: last.date,
    start: first.close,
    changePct: Math.round(changePct * 10) / 10,
    high: Math.max(...highs),
    low: Math.min(...lows)
  }
}

/**
 * @param {string} code 6 位代码
 * @param {'SH'|'SZ'|'BJ'} market
 * @param {number} days 取多少根日线，默认 120
 */
export async function fetchDaily(code, market, days = 120) {
  const key = `${market}${code}:${days}`
  const hit = cacheGet(key)
  if (hit) return { ...hit, cached: true }

  let result = null
  let lastError = null

  for (const loader of [fromTencent, fromSina, fromEastmoney]) {
    try {
      result = await loader(code, market, days)
      if (result) break
    } catch (err) {
      lastError = err
    }
  }

  if (!result) {
    throw new Error(lastError?.message || '没有拿到这只票的日 K 数据')
  }

  const bars = result.bars.slice(-days)
  const payload = {
    code,
    market,
    name: result.name,
    source: result.source,
    days: bars.length,
    bars,
    summary: summarize(bars)
  }
  cacheSet(key, payload)
  return { ...payload, cached: false }
}
