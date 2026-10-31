import 'dotenv/config'
import express from 'express'
import compression from 'compression'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import { searchPro, hasKey, authMode, authLabel } from './lib/wsa.js'
import { STRATEGIES, TOPIC_GROUPS, TOPIC_PRESETS, buildQueries, getStrategies } from './lib/strategies.js'
import { extractFromPage, detectSignals } from './lib/extract.js'
import { buildCandidates, summarizeCandidates } from './lib/score.js'
import { buildReport } from './lib/report.js'
import { hy4Enabled, hy4Model, hy4TopN, enrichCandidate } from './lib/hy4.js'
import { analyzeStock, analyzeMessage, analyzeKey, analyzeCache } from './lib/analyze.js'
import { tierOf } from './lib/trust.js'
import { DEFAULT_PERSONA, getPersona, personaBrief } from './lib/personas.js'
import { fetchDaily } from './lib/kline.js'
import { fetchProfiles } from './lib/profile.js'
import { fetchQuotes } from './lib/quote.js'
import { parseFilters, passFilter, describeFilters, sortCandidates, isExcluded } from './lib/filters.js'
import { clip } from './lib/text.js'
import { planQuery, refineQuery, describePlan } from './lib/planner.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT || 8787)
const MAX_TOPIC = 60
const MAX_EXTRA = 120
const MAX_CANDIDATES = 30

const FRESHNESS_RE = /^(d([1-9]|[12]\d|30)|m([1-9]|1[0-2])|y[1-5]|\d{4}-\d{2}-\d{2}(,\d{4}-\d{2}-\d{2})?)$/

const app = express()
app.use(compression())
app.use(express.json({ limit: '1mb' }))

/* ── 检索结果缓存：同一条检索式短时间内重复跑，直接复用，省额度也快 ── */
const CACHE_TTL = 10 * 60 * 1000
const CACHE_MAX = 300
const cache = new Map()

function cacheGet(key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL) {
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

function normalizeOptions(input = {}) {
  const mode = [0, 1, 2].includes(Number(input.mode)) ? Number(input.mode) : 2
  const cnt = [10, 20, 30, 40, 50].includes(Number(input.cnt)) ? Number(input.cnt) : 30
  const freshRaw = String(input.freshness || '').trim()
  const freshness = FRESHNESS_RE.test(freshRaw) ? freshRaw : 'm3'
  const industry = ['gov', 'news', 'acad', 'finance'].includes(input.industry) ? input.industry : ''
  const limit = Math.min(MAX_CANDIDATES, Math.max(5, Number(input.limit) || 20))
  return { mode, cnt, freshness, industry, limit }
}

function badRequest(res, code, message) {
  res.status(400).json({ error: { code, message } })
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    hasKey: hasKey(),
    auth: authMode(),
    authLabel: authLabel(),
    endpoint: process.env.WSA_ENDPOINT || 'https://api.wsa.cloud.tencent.com/SearchPro',
    llm: { enabled: hy4Enabled(), model: hy4Model(), topN: hy4TopN() }
  })
})

app.get('/api/strategies', (_req, res) => {
  res.json({
    strategies: STRATEGIES.map((s) => ({
      key: s.key,
      name: s.name,
      desc: s.desc,
      angles: s.angles.length
    })),
    topics: TOPIC_PRESETS,
    topicGroups: TOPIC_GROUPS,
    personas: personaBrief(),
    defaultPersona: DEFAULT_PERSONA
  })
})

/** 单条检索，调试和「自己查一条」用 */
app.post('/api/search', async (req, res) => {
  const { query } = req.body || {}
  if (!query || !String(query).trim()) return badRequest(res, 'EMPTY_QUERY', '检索词不能为空')
  const options = normalizeOptions(req.body)
  try {
    const result = await searchPro({
      query: String(query).trim(),
      mode: options.mode,
      cnt: options.cnt,
      freshness: options.freshness,
      industry: options.industry
    })
    res.json({
      query: result.query,
      version: result.version,
      requestId: result.requestId,
      elapsedMs: result.elapsedMs,
      pages: result.pages.map((p) => ({
        title: p.title,
        url: p.url,
        site: p.site,
        date: p.date,
        passage: (p.passage || '').slice(0, 200)
      }))
    })
  } catch (err) {
    res.status(err.status && err.status >= 400 ? err.status : 502).json({
      error: { code: err.code || 'UNKNOWN', message: err.message }
    })
  }
})

/** 固定并发池：同时最多跑 limit 个任务，其余排队 */
async function runWithLimit(items, limit, worker) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index], index)
    }
  })
  await Promise.all(runners)
}

/** 执行一条检索式并抽出标的 */
async function runQuery(q, options) {
  const started = Date.now()
  const key = `${q.query}|${options.mode}|${options.cnt}|${options.freshness}|${options.industry}`

  let pages = cacheGet(key)
  let cached = true
  if (!pages) {
    cached = false
    const result = await searchPro({
      query: q.query,
      mode: options.mode,
      cnt: options.cnt,
      freshness: options.freshness,
      industry: options.industry
    })
    pages = result.pages
    cacheSet(key, pages)
  }

  const records = []
  const codes = new Set()
  for (const page of pages) {
    for (const hit of extractFromPage(page)) {
      codes.add(hit.code)
      records.push({ ...hit, page, queryLabel: q.queryLabel || q.label })
    }
  }

  return { records, codes: [...codes], hits: pages.length, pages, cached, elapsedMs: Date.now() - started, q }
}

/* ── 个股模式：把一组页面收成「一只票 + 一串消息」 ── */

const MESSAGE_CAP = 24
// 提到这只票的页面够这么多条，就只留这些，不再拿别家公司的页面凑数
const MIN_OWN_MESSAGES = 8

/** 页面 → 消息：按 URL、标题去重，相关的排前面，其次按日期倒序 */
function collectMessages(pages, focus) {
  const seenUrl = new Set()
  const seenTitle = new Set()
  const out = []

  for (const p of pages) {
    const url = String(p.url || '')
    const title = String(p.title || '').replace(/\s+/g, '')
    if (url && seenUrl.has(url)) continue
    if (title && seenTitle.has(title)) continue
    if (!title && !url) continue
    if (url) seenUrl.add(url)
    if (title) seenTitle.add(title)

    const body = `${p.title || ''} ${p.passage || ''}`
    const relevant =
      (focus.name && body.includes(focus.name)) || (focus.code && body.includes(focus.code))
    // H 股公告（[HK]、01880 这类）和 A 股是同一家公司但编号不同，排后面
    const hk = /\[HK\]|（H股）|\(H股\)|^港股/.test(p.title || '')
    const { tier, reason } = tierOf(url, p.site || '')

    out.push({
      title: p.title || '(无标题)',
      url,
      site: p.site || '',
      date: p.date || '',
      snippet: clip(p.passage, 300),
      tier,
      tierReason: reason,
      relevant: Boolean(relevant),
      hk,
      query: p.queryLabel || ''
    })
  }

  out.sort(
    (a, b) =>
      Number(b.relevant && !b.hk) - Number(a.relevant && !a.hk) ||
      Number(b.relevant) - Number(a.relevant) ||
      String(b.date || '').localeCompare(String(a.date || ''))
  )

  // 用户问的是一只票，列表里就不该混进别家公司：先只留正文或标题提到这只票的页面。
  // 这类页面不够时（公司太小、检索面窄）才用其余页面补齐，保证消息量不至于空。
  const own = focus?.name ? out.filter((m) => m.relevant) : out
  const pool = own.length >= MIN_OWN_MESSAGES ? own : out
  return pool.slice(0, MESSAGE_CAP)
}

/**
 * 个股模式的候选：只有一只，但要带上全部消息。
 * 打分仍走 buildCandidates，口径和行业模式一致（信源质量 × 交叉印证 × 时效）。
 */
function buildFocusCandidate({ focus, messages }) {
  const records = messages.map((m) => ({
    code: focus.code,
    market: focus.market,
    board: focus.board,
    name: focus.name || '',
    signals: detectSignals(`${m.title} ${m.snippet}`),
    page: { title: m.title, url: m.url, site: m.site, date: m.date, passage: m.snippet },
    queryLabel: m.query
  }))

  const scored = buildCandidates(records)[0]
  const base = scored || {
    code: focus.code,
    market: focus.market,
    board: focus.board,
    name: focus.name || '',
    score: 0,
    level: 'weak',
    siteCount: messages.length,
    aTierCount: 0,
    latest: messages[0]?.date || '',
    queryCount: 1,
    positives: [],
    negatives: [],
    sites: []
  }

  return {
    ...base,
    name: base.name || focus.name || '',
    focus: true,
    messages,
    messageCount: messages.length
  }
}

/**
 * 给前 N 个候选做语义提炼。
 * 并发压到 3，单条失败只记录不中断；模型不可用时整体跳过。
 */
async function enrichTop(candidates, { concurrency = 3, persona = DEFAULT_PERSONA, onEach } = {}) {
  let cursor = 0
  const hits = candidates.length

  const worker = async () => {
    while (cursor < hits) {
      const index = cursor++
      const cand = candidates[index]
      try {
        cand.hy4 = await enrichCandidate(cand, { persona })
      } catch (err) {
        cand.hy4 = { ok: false, error: err?.message || String(err) }
      }
      onEach?.(cand, index)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, hits) }, worker))
}

/** 主体：选股扫描，SSE 逐条推送进度 */
app.post('/api/screen', async (req, res) => {
  const freeQuery = String(req.body?.query || '').trim().slice(0, 200)
  const bodyTopic = String(req.body?.topic || '').trim().slice(0, MAX_TOPIC)
  const extra = String(req.body?.extra || '').trim().slice(0, MAX_EXTRA)
  const strategyInput = Array.isArray(req.body?.strategies)
    ? req.body.strategies
    : req.body?.strategy || 'theme'

  if (!freeQuery && !bodyTopic) {
    return badRequest(
      res,
      'EMPTY_TOPIC',
      '先写一句想找什么，例如「近一个月半导体设备里订单大增、市值 100-500 亿的公司」'
    )
  }
  if (!hasKey()) {
    return badRequest(res, 'NO_API_KEY', `${authLabel()}。请在 .env 里填 WSA_API_KEY（sk- 开头）`)
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })

  const startedAt = Date.now()
  let aborted = false
  // 注意：不能用 req.on('close')，请求体读完就会触发，会把后续推送吞掉
  const isAborted = () => aborted || res.writableEnded || res.destroyed
  const send = (event, data) => {
    if (isAborted()) return
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const heartbeat = setInterval(() => {
    if (!isAborted()) res.write(': ping\n\n')
  }, 15000)

  res.on('close', () => {
    if (!res.writableEnded) aborted = true
    clearInterval(heartbeat)
  })

  // 一句话进来先解析成检索计划：主题词、角度、时间、筛选、排除项、排序、条数
  let plan = null
  if (freeQuery) {
    send('plan_start', { query: freeQuery })
    plan = await planQuery(freeQuery)
    if (isAborted()) {
      clearInterval(heartbeat)
      return
    }
    send('plan', plan)
  }

  // 个股模式：句子锁定了某一只票，检索式换成围绕这只票的七个方向
  const focus = plan?.mode === 'stock' && plan.focus?.code ? plan.focus : null
  const topic = focus?.name || plan?.topic || bodyTopic
  const persona = getPersona(
    String(plan?.persona || req.body?.persona || process.env.HY4_PERSONA || DEFAULT_PERSONA)
  )
  const baseOptions = normalizeOptions(req.body)
  const options = {
    ...baseOptions,
    freshness: plan?.freshness && FRESHNESS_RE.test(plan.freshness) ? plan.freshness : baseOptions.freshness,
    limit: plan?.limit
      ? Math.min(MAX_CANDIDATES, Math.max(5, Number(plan.limit) || baseOptions.limit))
      : baseOptions.limit
  }

  const filters = focus ? null : plan ? parseFilters(plan.filters) : parseFilters(req.body?.filters)
  const exclude = focus ? [] : Array.isArray(plan?.exclude) ? plan.exclude : []
  const sort = plan?.sort || 'score'

  const picked = getStrategies(focus ? ['stock'] : plan?.strategies || strategyInput)
  const strategyName = picked.map((s) => s.name).join(' + ')
  const strategyKeys = picked.map((s) => s.key)
  const queries = buildQueries({
    strategies: strategyKeys,
    topic,
    extra,
    extras: plan?.extraQueries || []
  })

  send('meta', {
    mode: focus ? 'stock' : 'screen',
    focus: focus || null,
    strategy: { key: strategyKeys.join(','), name: strategyName },
    strategies: picked.map((s) => ({ key: s.key, name: s.name })),
    persona: { key: persona.key, name: persona.name, tagline: persona.tagline },
    topic,
    plan: plan
      ? {
          source: plan.source,
          intent: plan.intent,
          readback: plan.readback || describePlan(plan),
          freshness: plan.freshness,
          limit: plan.limit,
          filters: describeFilters(filters),
          exclude,
          sort,
          extraQueries: plan.extraQueries || [],
          plannerError: plan.plannerError || '',
          plannerMs: plan.plannerMs || 0
        }
      : null,
    total: queries.length,
    options: { mode: options.mode, cnt: options.cnt, freshness: options.freshness },
    queries: queries.map((q) => ({
      id: q.id,
      label: q.label,
      group: q.group,
      query: q.query
    }))
  })

  const records = []
  const allPages = []
  const failure = []

  // 角度可以多选，一次最多 20 条检索式；并发压到 4，避免撞搜索结果接口的 QPS 限制
  await runWithLimit(queries, 4, async (q) => {
    if (isAborted()) return
    try {
      const r = await runQuery(q, options)
      if (focus) {
        // 个股模式下所有页面都属于这一只票，不需要再从正文里猜代码
        for (const page of r.pages) {
          allPages.push({ ...page, queryLabel: q.queryLabel || q.label })
        }
      } else {
        records.push(...r.records)
      }
      send('query', {
        id: q.id,
        label: q.label,
        group: q.group,
        query: q.query,
        ok: true,
        hits: r.hits,
        cached: r.cached,
        codes: r.codes.length,
        elapsedMs: r.elapsedMs
      })
    } catch (err) {
      failure.push({ label: q.label, message: err.message })
      send('query', {
        id: q.id,
        label: q.label,
        group: q.group,
        query: q.query,
        ok: false,
        message: err.message
      })
    }
  })

  // 心跳留着不动：语义提炼可能要跑十几秒，中间没有事件容易被代理掐断
  if (isAborted()) {
    clearInterval(heartbeat)
    return
  }

  const all = focus
    ? [buildFocusCandidate({ focus, messages: collectMessages(allPages, focus) })]
    : buildCandidates(records)

  // 打一次批量行情：股价、市值、PE 既是筛选条件，也是卡片上要显示的数值
  const quotes = await fetchQuotes(all.map((c) => ({ code: c.code, market: c.market })))

  // 个别标的会被批量接口漏掉（停牌、刚上市、批量过长被截断），单独补一次
  const missing = all.filter((c) => !quotes.get(c.code))
  if (missing.length) {
    await runWithLimit(missing.slice(0, 12), 2, async (c) => {
      try {
        const retry = await fetchQuotes([{ code: c.code, market: c.market }])
        for (const [code, q] of retry) quotes.set(code, q)
      } catch {
        /* 补不上就留空，展示层有兜底 */
      }
    })
  }

  for (const c of all) {
    const q = quotes.get(c.code)
    if (!q) continue
    if (q.name) c.name = q.name
    c.price = q.price
    c.changePct = q.changePct
    c.pe = q.pe
    c.pb = q.pb
    c.marketCap = q.marketCap
    c.floatCap = q.floatCap
    c.turnover = q.turnover
    c.suspended = q.suspended
  }

  // 名称兜底：行情也没给出名称的，用名称档案补；补不到就留空，前端显示代码
  const nameless = all.filter((c) => !c.name || c.name === c.code)
  if (nameless.length) {
    try {
      const rows = await fetchProfiles(nameless.map((c) => ({ code: c.code, market: c.market })))
      const byCode = new Map(rows.map((r) => [r.code, r]))
      for (const c of nameless) {
        const hit = byCode.get(c.code)
        if (hit?.name) c.name = hit.name
        if (hit?.industry && !c.industry) c.industry = hit.industry
      }
    } catch {
      /* 名称补不上不影响名单 */
    }
  }

  // 排除项（ST 等）先剔，再按区间筛，最后按口径排序截断；个股模式就一只票，不参与筛选
  const notExcluded = exclude.length ? all.filter((c) => !isExcluded(c, exclude)) : all
  const kept = filters ? notExcluded.filter((c) => passFilter(c, filters)) : notExcluded
  const candidates = focus ? all.slice(0, 1) : sortCandidates(kept, sort).slice(0, options.limit)
  const searchMs = Date.now() - startedAt

  // 先下发规则结果，页面可以先渲染名单；模型结论随后逐条补上
  send('candidates', { candidates, searchMs })

  // 语义提炼：只跑前 N 个候选，失败的保留规则结果，不阻断扫描
  // 个股模式不在这里跑——页面会根据用户点开的范围，按需调用 /api/analyze
  let llm = {
    enabled: hy4Enabled() && !focus,
    model: hy4Model(),
    persona: { key: persona.key, name: persona.name },
    enriched: 0,
    failed: 0,
    ms: 0
  }
  if (llm.enabled && candidates.length) {
    const topN = Math.min(hy4TopN(), candidates.length)
    send('enrich_start', { total: topN, model: llm.model, persona: llm.persona })

    const enrichStarted = Date.now()
    await enrichTop(candidates.slice(0, topN), {
      persona: persona.key,
      onEach: (cand, index) => {
        if (cand.hy4?.ok) llm.enriched += 1
        else llm.failed += 1
        send('enrich', { code: cand.code, index, model: llm.model, hy4: cand.hy4 })
      }
    })
    llm.ms = Date.now() - enrichStarted
  }

  const summary = summarizeCandidates(candidates, startedAt, queries.length)
  summary.searchMs = searchMs
  summary.llm = llm
  summary.filter =
    filters || exclude.length
      ? {
          desc: [describeFilters(filters), exclude.length ? `排除 ${exclude.join('、')}` : '']
            .filter(Boolean)
            .join('｜'),
          before: all.length,
          after: kept.length,
          dropped: all.length - kept.length
        }
      : null
  summary.sort = sort

  send('done', {
    candidates,
    summary,
    failed: failure,
    startedAt,
    meta: {
      mode: focus ? 'stock' : 'screen',
      focus: focus
        ? { code: focus.code, market: focus.market, name: candidates[0]?.name || focus.name, board: focus.board }
        : null,
      strategyName,
      strategies: picked.map((s) => s.name),
      topic,
      query: freeQuery,
      personaName: persona.name,
      personaTagline: persona.tagline,
      filters: describeFilters(filters),
      exclude,
      sort,
      planReadback: plan?.readback || describePlan(plan),
      planSource: plan?.source || '',
      queries: queries.length,
      queryList: queries.map((q) => ({ label: q.label, query: q.query }))
    }
  })
  clearInterval(heartbeat)
  res.end()
})

/**
 * 追问：在一份已经跑出来的名单上继续收窄，不重新检索。
 * 名单和证据都不变，只是按新条件过滤/排序 —— 这是和「重新问一遍 AI」最大的区别：
 * 结果可回溯，不会因为重新检索换出一批新的公司。
 */
app.post('/api/refine', async (req, res) => {
  const query = String(req.body?.query || '').trim()
  const candidates = Array.isArray(req.body?.candidates) ? req.body.candidates.slice(0, 80) : []
  if (!query) return badRequest(res, 'EMPTY_QUERY', '说一句要改什么，例如「只看市值 200 亿以下」')

  try {
    const result = await refineQuery(query, { plan: req.body?.plan || null, candidates })
    res.json(result)
  } catch (err) {
    res.status(502).json({ error: { code: 'REFINE_FAILED', message: err?.message || '解析失败' } })
  }
})

/** 日 K 线：给候选补一段走势，让「现在在什么位置」有依据 */
app.get('/api/kline', async (req, res) => {
  const code = String(req.query.code || '').trim()
  const market = String(req.query.market || '').trim().toUpperCase()
  const days = Math.min(250, Math.max(20, Number(req.query.days) || 120))

  if (!/^\d{6}$/.test(code)) return badRequest(res, 'BAD_CODE', '股票代码需要 6 位数字')
  if (!['SH', 'SZ', 'BJ'].includes(market)) {
    return badRequest(res, 'BAD_MARKET', '市场只支持 SH / SZ / BJ')
  }

  try {
    const data = await fetchDaily(code, market, days)
    res.json(data)
  } catch (err) {
    res.status(502).json({ error: { code: 'KLINE_FAILED', message: err.message } })
  }
})

/** 批量取名称与行业，用于给候选打行业标签 */
app.post('/api/profile', async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 200) : []
  if (!items.length) return badRequest(res, 'NO_ITEMS', '没有需要查询的标的')

  try {
    const profiles = await fetchProfiles(items)
    res.json({ profiles })
  } catch (err) {
    res.status(502).json({ error: { code: 'PROFILE_FAILED', message: err.message } })
  }
})

/**
 * 按需 AI 分析：点开某只票 / 某条消息时才跑。
 *
 * 和扫描时的语义提炼区别在于输入：这里带上了真实现价、市值和 120 日走势，
 * 所以结论能落到「消息在说什么 + 价格走到哪了」，而不是又一段新闻摘要。
 */
app.post('/api/analyze', async (req, res) => {
  const scope = req.body?.scope === 'message' ? 'message' : 'stock'
  const raw = req.body?.stock || {}
  const code = String(raw.code || '').trim()
  const market = String(raw.market || '').trim().toUpperCase()

  if (!/^\d{6}$/.test(code)) return badRequest(res, 'BAD_CODE', '股票代码需要 6 位数字')
  if (!['SH', 'SZ', 'BJ'].includes(market)) return badRequest(res, 'BAD_MARKET', '市场只支持 SH / SZ / BJ')
  if (!hy4Enabled()) {
    return res.json({ ok: false, reason: 'NO_MODEL', message: '没有配置 HY4_API_KEY，这一块用不了模型' })
  }

  const stock = {
    code,
    market,
    name: String(raw.name || '').slice(0, 20),
    board: String(raw.board || '').slice(0, 10),
    industry: String(raw.industry || '').slice(0, 20),
    price: Number(raw.price) || 0,
    changePct: Number(raw.changePct) || 0,
    pe: Number(raw.pe) || 0,
    pb: Number(raw.pb) || 0,
    marketCap: Number(raw.marketCap) || 0,
    turnover: Number(raw.turnover) || 0
  }

  const messages = (Array.isArray(req.body?.messages) ? req.body.messages : [])
    .slice(0, 14)
    .map((m) => ({
      title: String(m?.title || '').slice(0, 120),
      site: String(m?.site || '').slice(0, 40),
      date: String(m?.date || '').slice(0, 20),
      tier: ['A', 'B', 'C'].includes(m?.tier) ? m.tier : 'C',
      snippet: String(m?.snippet || '').slice(0, 400),
      url: String(m?.url || '').slice(0, 300)
    }))
    .filter((m) => m.title)

  const message = req.body?.message
    ? {
        title: String(req.body.message.title || '').slice(0, 120),
        site: String(req.body.message.site || '').slice(0, 40),
        date: String(req.body.message.date || '').slice(0, 20),
        tier: ['A', 'B', 'C'].includes(req.body.message.tier) ? req.body.message.tier : 'C',
        snippet: String(req.body.message.snippet || '').slice(0, 400)
      }
    : null

  if (scope === 'stock' && !messages.length) {
    return res.json({ ok: false, reason: 'NO_MESSAGES', message: '没有可分析的消息' })
  }
  if (scope === 'message' && !message) {
    return res.json({ ok: false, reason: 'NO_MESSAGE', message: '缺少要解读的那条消息' })
  }

  const persona = String(req.body?.persona || DEFAULT_PERSONA)
  const extra =
    scope === 'stock'
      ? messages.map((m) => m.title).join('|')
      : `${message.title}|${message.date}|${message.snippet.slice(0, 60)}`
  const key = analyzeKey(scope, code, extra)

  const hit = analyzeCache.get(key)
  if (hit) return res.json({ ...hit, cached: true })

  try {
    const result =
      scope === 'stock'
        ? await analyzeStock({ stock, messages, persona })
        : await analyzeMessage({ stock, message, persona })
    if (result.ok) analyzeCache.set(key, result)
    res.json({ ...result, cached: false })
  } catch (err) {
    res.status(502).json({ ok: false, reason: 'FAILED', message: err?.message || '分析失败' })
  }
})

/** 导出 Markdown 报告 */
app.post('/api/report', (req, res) => {
  const { candidates, summary, meta, startedAt } = req.body || {}
  if (!Array.isArray(candidates)) return badRequest(res, 'NO_RESULTS', '没有可导出的结果')
  try {
    const md = buildReport({
      candidates,
      summary: summary || {},
      meta: meta || {},
      startedAt: startedAt || Date.now()
    })
    res.type('text/markdown; charset=utf-8').send(md)
  } catch (err) {
    res.status(500).json({ error: { code: 'REPORT_FAILED', message: err.message } })
  }
})

// 生产模式下直接托管前端构建产物
const distDir = path.resolve(__dirname, '../dist')
if (fs.existsSync(path.join(distDir, 'index.html'))) {
  app.use(express.static(distDir))
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.use((err, _req, res, _next) => {
  console.error('[stocklens]', err?.message || err)
  res.status(500).json({ error: { code: 'INTERNAL', message: err?.message || '服务内部错误' } })
})

app.listen(PORT, () => {
  console.log(`[stocklens] API 已启动 http://localhost:${PORT}`)
  console.log(`[stocklens] 鉴权 ${authLabel()}`)
})
