/**
 * 候选标的打分与排序。
 *
 * 分数不是「涨的概率」，是「公开信息里支持买入理由的证据有多厚」。
 * 三个维度：信源质量、交叉印证广度、信息新鲜度，命中负面信号再扣。
 */

import { tierOf, siteKeyOf } from './trust.js'
import { clip } from './text.js'

const TIER_WEIGHT = { A: 3, B: 2, C: 1 }

const POSITIVE_POINT = 0.8
const POSITIVE_CAP = 4
const NEGATIVE_POINT = 1.5
const NEGATIVE_CAP = 4.5

function daysBetween(dateStr) {
  if (!dateStr) return null
  const m = String(dateStr).match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(d.getTime())) return null
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000))
}

/**
 * 摘要要围住这条票自己，而不是永远取文章开头。
 *
 * 列表型长文（「11 家公司发布业绩预告」）里，被抽中的公司常排在正文中后段，
 * 取前 260 字会得到一段跟它无关的同业新闻，看起来像证据串错了。
 * 命中位置靠后时从它前面一点开始截，并在开头标省略号。
 */
function snippetAround(passage, code, name, max = 260) {
  const text = String(passage || '')
  if (!text) return ''
  const pos = [code, name]
    .filter((s) => s && String(s).trim().length >= 3)
    .map((s) => text.indexOf(String(s)))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0]
  if (pos === undefined || pos <= 80) return clip(text, max)
  return `…${clip(text.slice(pos - 60), max)}`
}

/** 越新越值钱，一年以上基本只当背景资料 */
function recencyFactor(ageDays) {
  if (ageDays === null) return 1
  if (ageDays <= 7) return 1.3
  if (ageDays <= 30) return 1.15
  if (ageDays <= 180) return 1
  if (ageDays <= 365) return 0.85
  return 0.7
}

function levelOf(score, siteCount, aTierCount, allMainstream) {
  // 有权威来源，或全部来自主流财经媒体且站点够多 —— 两种都算强线索
  if (score >= 10 && siteCount >= 3 && (aTierCount >= 1 || allMainstream)) return 'strong'
  if (score >= 4.5 && siteCount >= 2) return 'medium'
  return 'weak'
}

export const LEVEL_META = {
  strong: { label: '线索强', hint: '多个独立信源交叉印证，且有权威来源或全部来自主流财经媒体' },
  medium: { label: '线索中', hint: '有 2 个以上站点提及，可继续深挖' },
  weak: { label: '线索弱', hint: '单一信源或信息偏旧，仅作线索' }
}

/**
 * @param {Array} records [{ code, market, board, name, signals, page, queryLabel }]
 * @returns {Array} 候选标的，按分数降序
 */
export function buildCandidates(records) {
  const byCode = new Map()

  for (const rec of records) {
    if (!rec?.code) continue
    let item = byCode.get(rec.code)
    if (!item) {
      item = {
        code: rec.code,
        market: rec.market,
        board: rec.board,
        name: '',
        sites: [],
        seenUrls: new Set(),
        seenHostQuery: new Set(),
        positives: new Map(),
        negatives: new Map(),
        queryLabels: new Set()
      }
      byCode.set(rec.code, item)
    }

    if (!item.name && rec.name) item.name = rec.name
    item.queryLabels.add(rec.queryLabel || '')

    const page = rec.page || {}
    const url = page.url || ''
    const key = `${url}|${rec.queryLabel || ''}`
    // 同一页面被多条检索式命中，只算一次证据，但检索式覆盖度单独记
    if (url && item.seenUrls.has(url)) continue
    if (key) item.seenUrls.add(url)

    const { tier, reason } = tierOf(url, page.site || '')
    const ageDays = daysBetween(page.date)
    item.sites.push({
      title: page.title || '(无标题)',
      url,
      site: page.site || '',
      date: page.date || '',
      ageDays,
      snippet: snippetAround(page.passage, rec.code, rec.name, 260),
      tier,
      tierReason: reason,
      query: rec.queryLabel || ''
    })

    for (const g of rec.signals?.positive || []) {
      const cur = item.positives.get(g.key) || { key: g.key, words: new Set(), count: 0 }
      g.words.forEach((w) => cur.words.add(w))
      cur.count += 1
      item.positives.set(g.key, cur)
    }
    for (const g of rec.signals?.negative || []) {
      const cur = item.negatives.get(g.key) || { key: g.key, words: new Set(), count: 0 }
      g.words.forEach((w) => cur.words.add(w))
      cur.count += 1
      item.negatives.set(g.key, cur)
    }
  }

  const candidates = []

  for (const item of byCode.values()) {
    // 只保留一个站点的一条证据，避免同站多文把分数堆高
    const byHost = new Map()
    for (const s of item.sites) {
      const key = siteKeyOf(s.url) || s.url
      const prev = byHost.get(key)
      if (!prev || (s.ageDays ?? 9999) < (prev.ageDays ?? 9999)) byHost.set(key, s)
    }
    const sites = [...byHost.values()]

    let quality = 0
    let aTierCount = 0
    for (const s of sites) {
      quality += (TIER_WEIGHT[s.tier] || 1) * recencyFactor(s.ageDays)
      if (s.tier === 'A') aTierCount += 1
    }

    const siteCount = sites.length
    const crossBonus = siteCount >= 5 ? 4 : siteCount >= 3 ? 2 : 0

    const positiveKeys = [...item.positives.keys()]
    const negativeKeys = [...item.negatives.keys()]
    const positivePoint = Math.min(positiveKeys.length * POSITIVE_POINT, POSITIVE_CAP)
    const negativePoint = Math.min(negativeKeys.length * NEGATIVE_POINT, NEGATIVE_CAP)

    const allMainstream = siteCount >= 3 && sites.every((s) => s.tier === 'B')

    const score = Math.max(
      0,
      Math.round((quality + crossBonus + positivePoint - negativePoint) * 10) / 10
    )

    const latest = sites
      .map((s) => s.date)
      .filter(Boolean)
      .sort()
      .pop()

    candidates.push({
      code: item.code,
      market: item.market,
      board: item.board,
      // 名称留空交给下游补（行情接口 / 名称档案），不要用代码占位，
      // 否则「name 为空才补」的判断会失效，卡片上就一直显示代码
      name: item.name || '',
      score,
      level: levelOf(score, siteCount, aTierCount, allMainstream),
      siteCount,
      aTierCount,
      latest: latest || '',
      queryCount: [...item.queryLabels].filter(Boolean).length,
      positives: positiveKeys.map((k) => ({
        key: k,
        words: [...(item.positives.get(k)?.words || [])].slice(0, 4)
      })),
      negatives: negativeKeys.map((k) => ({
        key: k,
        words: [...(item.negatives.get(k)?.words || [])].slice(0, 4)
      })),
      sites: sites.sort((a, b) => (a.ageDays ?? 9999) - (b.ageDays ?? 9999)).slice(0, 6)
    })
  }

  return candidates
    .filter((c) => c.siteCount >= 1 && c.positives.length > 0)
    .sort((a, b) => b.score - a.score || b.siteCount - a.siteCount)
}

export function summarizeCandidates(candidates, startedAt, queryCount) {
  const levels = { strong: 0, medium: 0, weak: 0 }
  for (const c of candidates) levels[c.level] += 1
  return {
    total: candidates.length,
    levels,
    queries: queryCount,
    elapsedMs: Date.now() - startedAt,
    topScore: candidates[0]?.score ?? 0
  }
}
