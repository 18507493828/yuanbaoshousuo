/**
 * 证券基本档案：名称、所属行业。
 *
 * 只做一件事——把代码翻译成「这家公司叫什么、属于哪个行业」。
 * 行业名沿用东方财富的板块口径（如「半导体」「电池」「白酒Ⅱ」），
 * 一次批量请求拿完，不逐只打接口。
 */

const TIMEOUT_MS = 6000
const TTL = 6 * 60 * 60 * 1000
const BATCH = 40

/** 同一套接口有多个接入点，逐个试，避免单个节点限流导致整批失败 */
const HOSTS = [
  'https://push2.eastmoney.com',
  'https://82.push2.eastmoney.com',
  'https://push2delay.eastmoney.com'
]

const cache = new Map()
const FIELDS = 'f12,f13,f14,f100'

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

async function getJson(url, referer = 'https://quote.eastmoney.com/') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36',
        referer
      }
    })
    if (!res.ok) throw new Error(`档案接口 HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

function secidOf(code, market) {
  return `${market === 'SH' ? 1 : 0}.${code}`
}

function clean(text) {
  const s = String(text ?? '').trim()
  if (!s || s === '-' || s === '--') return ''
  return s
}

async function queryBatch(items) {
  const secids = items.map((it) => secidOf(it.code, it.market)).join(',')
  const path = `/api/qt/ulist.np/get?secids=${secids}&fields=${FIELDS}`

  let json = null
  let lastError = null
  for (const host of HOSTS) {
    try {
      json = await getJson(host + path)
      if (json) break
    } catch (err) {
      lastError = err
    }
  }
  if (!json) throw lastError || new Error('档案接口不可用')

  const diff = json?.data?.diff
  const rows = Array.isArray(diff) ? diff : diff ? Object.values(diff) : []

  const out = []
  for (const row of rows) {
    const code = clean(row?.f12)
    if (!code) continue
    out.push({
      code,
      name: clean(row?.f14),
      industry: clean(row?.f100)
    })
  }
  return out
}

/**
 * 巨潮资讯：国标行业口径（如「专用设备制造业」），比东财粗，
 * 但接口稳、不挑网络，作为东财拿不到时的兜底。
 */
async function queryCninfo(code) {
  const url = `http://www.cninfo.com.cn/data20/companyOverview/getCompanyIntroduction?scode=${code}`
  const json = await getJson(url, 'http://www.cninfo.com.cn/')
  const rec = json?.data?.records?.[0]
  const info = rec?.basicInformation?.[0]
  if (!info) return null

  const industry = clean(info.F032V)
  if (!industry) return null
  return {
    code,
    name: clean(info.ASECNAME) || clean(rec.ASECNAME),
    industry,
    source: '巨潮'
  }
}

/** 小并发池，避免补齐时把接口打满 */
async function runWithLimit(items, limit, worker) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await worker(item)
    }
  })
  await Promise.all(runners)
}

/**
 * 批量取名称与行业，失败的批次静默跳过。
 * @param {{code:string, market:'SH'|'SZ'|'BJ'}[]} list
 * @returns {Promise<{code:string,name:string,industry:string}[]>}
 */
export async function fetchProfiles(list) {
  const unique = []
  const seen = new Set()
  for (const it of list) {
    const code = String(it?.code || '').trim()
    if (!/^\d{6}$/.test(code) || seen.has(code)) continue
    seen.add(code)
    unique.push({ code, market: it.market === 'SH' || it.market === 'SZ' ? it.market : 'BJ' })
  }

  const result = []
  const missing = []

  for (const it of unique) {
    const hit = cacheGet(it.code)
    if (hit) result.push(hit)
    else missing.push(it)
  }

  for (let i = 0; i < missing.length; i += BATCH) {
    const chunk = missing.slice(i, i + BATCH)
    try {
      const rows = await queryBatch(chunk)
      for (const row of rows) {
        const value = { ...row, source: '东方财富' }
        cacheSet(row.code, value)
        result.push(value)
      }
    } catch {
      /* 单批失败不影响其他批次 */
    }
  }

  // 东财没拿到的，用巨潮补；两源都失败就留空，前端不显示行业标签
  const got = new Set(result.map((r) => r.code))
  const rest = unique.filter((it) => !got.has(it.code)).slice(0, 40)
  if (rest.length) {
    await runWithLimit(rest, 4, async (it) => {
      try {
        const row = await queryCninfo(it.code)
        if (!row) return
        cacheSet(row.code, row)
        result.push(row)
      } catch {
        /* 拿不到就算了 */
      }
    })
  }

  // 按传入顺序返回，前端好对齐
  const byCode = new Map(result.map((r) => [r.code, r]))
  return unique.map((it) => byCode.get(it.code)).filter(Boolean)
}
