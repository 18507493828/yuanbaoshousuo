/**
 * 行情快照：现价、涨跌幅、市盈率、市净率、总市值、流通市值、换手率。
 *
 * 只做一件事——给候选标的配上可用于筛选和展示的数值。
 * 一次批量请求拿完，不逐只打接口；5 分钟缓存，盘中不会拿到太旧的价格。
 * 数据源是腾讯行情，文本模型给不出这些数字。
 */

const TIMEOUT_MS = 6000
const TTL = 5 * 60 * 1000
const BATCH = 40

const cache = new Map()

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'

function cacheGet(code) {
  const hit = cache.get(code)
  if (!hit) return null
  if (Date.now() - hit.at > TTL) {
    cache.delete(code)
    return null
  }
  return hit.value
}

function cacheSet(code, value) {
  cache.set(code, { at: Date.now(), value })
}

function symbolOf(code, market) {
  const prefix = market === 'SH' ? 'sh' : market === 'SZ' ? 'sz' : 'bj'
  return `${prefix}${code}`
}

/**
 * 腾讯字段是以 ~ 分隔的长数组，常用的几位：
 * 1 名称｜2 代码｜3 现价｜32 涨跌幅%｜38 换手率｜39 市盈率TTM
 * 44 流通市值(亿)｜45 总市值(亿)｜46 市净率｜49 量比
 */
function parseLine(line) {
  const hit = line.match(/v_[a-z]{2}(\d{6})="([^"]*)"/)
  if (!hit) return null

  const f = hit[2].split('~')
  if (f.length < 50) return null

  const price = Number(f[3]) || 0
  const name = String(f[1] || '').trim()
  if (!name) return null

  return {
    code: hit[1],
    name,
    price,
    changePct: Number(f[32]) || 0,
    turnover: Number(f[38]) || 0,
    pe: Number(f[39]) || 0,
    floatCap: Number(f[44]) || 0,
    marketCap: Number(f[45]) || 0,
    pb: Number(f[46]) || 0,
    volumeRatio: Number(f[49]) || 0,
    suspended: price <= 0
  }
}

async function queryBatch(items) {
  const symbols = items.map((it) => symbolOf(it.code, it.market)).join(',')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`https://qt.gtimg.cn/q=${symbols}`, {
      signal: controller.signal,
      headers: { 'user-agent': UA, referer: 'https://gu.qq.com/' }
    })
    if (!res.ok) throw new Error(`行情接口 HTTP ${res.status}`)

    // 这里返回的是 GBK，直接按 UTF-8 读会把名称读成乱码
    const buf = await res.arrayBuffer()
    const text = new TextDecoder('gbk').decode(buf)

    const rows = []
    for (const line of text.split(';')) {
      const row = parseLine(line)
      if (row) rows.push(row)
    }
    return rows
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 批量取行情快照，失败的批次静默跳过。
 * @param {{code:string, market:'SH'|'SZ'|'BJ'}[]} list
 * @returns {Promise<Map<string, object>>} code → 快照
 */
export async function fetchQuotes(list) {
  const unique = []
  const seen = new Set()
  for (const it of list) {
    const code = String(it?.code || '').trim()
    if (!/^\d{6}$/.test(code) || seen.has(code)) continue
    seen.add(code)
    unique.push({ code, market: it.market === 'SH' || it.market === 'SZ' ? it.market : 'BJ' })
  }

  const out = new Map()
  const missing = []

  for (const it of unique) {
    const hit = cacheGet(it.code)
    if (hit) out.set(it.code, hit)
    else missing.push(it)
  }

  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH)
    try {
      const rows = await queryBatch(chunk)
      for (const row of rows) {
        cacheSet(row.code, row)
        out.set(row.code, row)
      }
    } catch {
      /* 单批失败不影响其他批次，也阻断不了扫描 */
    }
  }

  return out
}
