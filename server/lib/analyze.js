/**
 * 按需 AI 分析层
 *
 * 和「扫描时顺手做一次语义提炼」不同，这里是用户点开某只票、或点开某条消息时才跑：
 *
 *   scope=stock    综合研判 —— 消息面 + 行情 + 120 日走势，给多空依据、跟踪项、价格位置
 *   scope=message  单条解读 —— 这一条消息对这只票意味着什么，力度多大、还缺什么证据
 *
 * 关键在于给模型喂了文本模型自己拿不到的东西：真实现价、涨跌幅、市值、PE、年内区间位置。
 * 所以结论不是「新闻摘要 + 通用评论」，而是能落到「消息在哪、价格在哪」上的判断。
 *
 * 约束和扫描时一致：只依据传入材料，不补行业常识，不给买卖建议与目标价。
 */

import crypto from 'node:crypto'
import { chat, hy4Enabled, hy4Model, parseJsonLoose } from './hy4.js'
import { getPersona, DEFAULT_PERSONA } from './personas.js'
import { fetchDaily } from './kline.js'
import { clip } from './text.js'

const TTL = 30 * 60 * 1000
const CACHE_MAX = 300

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

const round = (v, n = 2) => {
  const p = 10 ** n
  return Math.round(v * p) / p
}

function pct(a, b) {
  return b > 0 ? ((a - b) / b) * 100 : 0
}

/** 把日 K 压成几句人话：近 5/20/60 日涨跌、在近 120 日区间的位置、均线上下 */
export function summarizeTrend(bars) {
  if (!Array.isArray(bars) || bars.length < 20) return null
  const closes = bars.map((b) => b.close)
  const last = closes[closes.length - 1]
  const at = (n) => closes[Math.max(0, closes.length - 1 - n)]
  const high = Math.max(...bars.map((b) => b.high))
  const low = Math.min(...bars.map((b) => b.low))
  const ma = (n) => {
    const seg = closes.slice(-n)
    return seg.reduce((s, v) => s + v, 0) / seg.length
  }
  const ma20 = ma(20)
  const ma60 = closes.length >= 60 ? ma(60) : null

  return {
    latest: round(last),
    d5: round(pct(last, at(5)), 1),
    d20: round(pct(last, at(20)), 1),
    d60: round(pct(last, at(60)), 1),
    pos: Math.round(((last - low) / (high - low || 1)) * 100),
    high: round(high),
    low: round(low),
    ma20: round(ma20),
    aboveMa20: last >= ma20,
    ma60: ma60 === null ? null : round(ma60),
    aboveMa60: ma60 === null ? null : last >= ma60,
    from: bars[0].date,
    to: bars[bars.length - 1].date,
    days: bars.length
  }
}

async function trendOf(code, market) {
  try {
    const data = await fetchDaily(code, market, 120)
    return summarizeTrend(data.bars)
  } catch {
    return null
  }
}

function fmtTrend(t) {
  if (!t) return '（走势数据没取到）'
  const dir = (v) => `${v >= 0 ? '+' : ''}${v}%`
  return [
    `近 5 日 ${dir(t.d5)}，近 20 日 ${dir(t.d20)}，近 60 日 ${dir(t.d60)}`,
    `现价处于近 ${t.days} 个交易日区间 ${t.low}–${t.high} 的 ${t.pos}% 分位`,
    `20 日均线 ${t.ma20}（现价在${t.aboveMa20 ? '上方' : '下方'}）${
      t.ma60 !== null ? `，60 日均线 ${t.ma60}（现价在${t.aboveMa60 ? '上方' : '下方'}）` : ''
    }`
  ].join('；')
}

function fmtQuote(stock) {
  const parts = []
  if (stock.price > 0) {
    parts.push(`现价 ${stock.price} 元`)
    parts.push(`今日 ${stock.changePct >= 0 ? '+' : ''}${round(stock.changePct || 0)}%`)
  }
  if (stock.marketCap > 0) parts.push(`总市值 ${Math.round(stock.marketCap)} 亿元`)
  if (stock.pe > 0) parts.push(`PE(TTM) ${round(stock.pe, 1)}`)
  if (stock.pb > 0) parts.push(`PB ${round(stock.pb, 2)}`)
  if (stock.turnover > 0) parts.push(`换手率 ${round(stock.turnover, 2)}%`)
  return parts.join('｜') || '（行情未取到）'
}

function fmtMessages(messages, cap = 12) {
  return messages
    .slice(0, cap)
    .map((m, i) => {
      const body = m.snippet ? `\n   摘要：${m.snippet}` : '\n   摘要：（只有标题，无正文）'
      return `${i + 1}. [${m.site || '未知站点'}｜${m.date || '无日期'}｜${
        m.tier === 'A' ? '权威来源' : m.tier === 'B' ? '主流媒体' : '一般来源'
      }] ${m.title || ''}${body}`
    })
    .join('\n')
}

const STOCK_TASK = `你现在要给这只 A 股做一次结构化研判。除了消息面，我还会给你真实现价、市值和 120 日走势——把「消息在说什么」和「价格走到哪了」分开判断，再合起来看。

规则：
1. 只能使用我给你的材料。材料里没有的财务数据、业务占比、机构预测一律不许补。
2. drivers / risks 只能来自消息面，每条不超过 40 字，必须带材料里的具体数字或事实，空话无效。
3. flow 单独写价格位置：现价在近 120 日区间的什么位置、和均线的关系，与消息面是印证还是背离。
4. watch 写接下来该盯什么（公告、财报科目、订单、数据），最多 3 条，每条不超过 25 字。
5. stance 只能取「偏多 / 中性 / 偏空」，只描述材料整体倾向，不等于买卖建议。
6. 消息条数少于 4 条、或者说法互相矛盾时，confidence 必须给 low。
7. 不写目标价、不预测点位、不给仓位建议。
8. 只围绕这一只票写：不要提别的公司名称或代码，不做同行业横向对比，也不要顺带推荐其他标的。
9. 只输出 JSON，不要解释、不要代码块。

输出格式：
{"stance":"偏多","headline":"一句话结论，不超过 40 字","drivers":["..."],"risks":["..."],"watch":["..."],"flow":"...","confidence":"high"}`

const MESSAGE_TASK = `你现在只判断一条公开消息对这只 A 股意味着什么。我同样会给你现价和 120 日走势，用来判断这条消息是不是已经被价格反映。

规则：
1. 只依据这条消息的标题和摘要。不要引入你记忆里的其他背景。
2. 摘要只有标题、没有具体内容时，impact 必须是「难以判断」，confidence 必须是 low。
3. figures 只填原文里出现过的数字（金额、增速、份额、数量…），原文没有就给空数组，不要自己算。
4. path 说明这条消息影响公司的哪一环——收入、成本、订单、产能、估值还是预期；没有依据就留空串。
5. verify 写还要核对什么才能确认，最多 2 条，每条不超过 25 字。
6. 不写买卖建议、不写目标价。
7. 只讲这条消息对这只票的影响，不要牵扯其他公司。
8. 只输出 JSON，不要解释、不要代码块。

输出格式：
{"impact":"利好","strength":"中","gist":"这条消息说了什么，不超过 40 字","figures":["..."],"path":"...","verify":["..."],"confidence":"high"}`

function arr(v, cap = 4, len = 60) {
  const list = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : []
  return list.map((x) => clip(x, len)).filter(Boolean).slice(0, cap)
}

function pickEnum(v, allowed, fallback) {
  return allowed.includes(String(v || '').trim()) ? String(v).trim() : fallback
}

/**
 * 综合研判
 * @param {{stock:object, messages:object[], persona?:string}} input
 */
export async function analyzeStock({ stock, messages = [], persona = DEFAULT_PERSONA }) {
  if (!hy4Enabled()) return { ok: false, reason: 'NO_MODEL' }
  if (!stock?.code) return { ok: false, reason: 'NO_STOCK' }

  const role = getPersona(persona)
  const trend = await trendOf(stock.code, stock.market)

  const user = `标的：${stock.name || stock.code}（${stock.code}，${stock.board || 'A股'}${
    stock.industry ? `，${stock.industry}` : ''
  }）
行情：${fmtQuote(stock)}
走势：${fmtTrend(trend)}

公开消息（共 ${messages.length} 条，按时间倒序）：
${fmtMessages(messages) || '（没有检索到消息）'}`

  const started = Date.now()
  let content
  try {
    const res = await chat({ system: `${role.stance}\n\n${STOCK_TASK}`, user, maxTokens: 1200 })
    content = res.content
  } catch (err) {
    return { ok: false, reason: 'MODEL_ERROR', error: err?.message || String(err) }
  }

  const parsed = parseJsonLoose(content)
  if (!parsed) return { ok: false, reason: 'BAD_OUTPUT', raw: String(content).slice(0, 200) }

  return {
    ok: true,
    scope: 'stock',
    trend,
    elapsedMs: Date.now() - started,
    model: hy4Model(),
    persona: { key: role.key, name: role.name },
    analysis: {
      stance: pickEnum(parsed.stance, ['偏多', '中性', '偏空'], '中性'),
      headline: clip(parsed.headline, 100),
      drivers: arr(parsed.drivers, 4, 90),
      risks: arr(parsed.risks, 4, 90),
      watch: arr(parsed.watch, 3, 50),
      flow: clip(parsed.flow, 160),
      confidence: pickEnum(parsed.confidence, ['high', 'medium', 'low'], 'low')
    }
  }
}

/**
 * 单条消息解读
 * @param {{stock:object, message:object, persona?:string}} input
 */
export async function analyzeMessage({ stock, message, persona = DEFAULT_PERSONA }) {
  if (!hy4Enabled()) return { ok: false, reason: 'NO_MODEL' }
  if (!stock?.code || !message?.title) return { ok: false, reason: 'NO_MESSAGE' }

  const role = getPersona(persona)
  const trend = await trendOf(stock.code, stock.market)

  const user = `标的：${stock.name || stock.code}（${stock.code}，${stock.board || 'A股'}）
行情：${fmtQuote(stock)}
走势：${fmtTrend(trend)}

这条消息：
标题：${message.title}
来源：${message.site || '未知站点'}｜${message.date || '无日期'}｜${
    message.tier === 'A' ? '权威来源' : message.tier === 'B' ? '主流媒体' : '一般来源'
  }
摘要：${message.snippet || '（只有标题，无正文）'}`

  const started = Date.now()
  let content
  try {
    const res = await chat({ system: `${role.stance}\n\n${MESSAGE_TASK}`, user, maxTokens: 900 })
    content = res.content
  } catch (err) {
    return { ok: false, reason: 'MODEL_ERROR', error: err?.message || String(err) }
  }

  const parsed = parseJsonLoose(content)
  if (!parsed) return { ok: false, reason: 'BAD_OUTPUT', raw: String(content).slice(0, 200) }

  return {
    ok: true,
    scope: 'message',
    elapsedMs: Date.now() - started,
    model: hy4Model(),
    persona: { key: role.key, name: role.name },
    analysis: {
      impact: pickEnum(parsed.impact, ['利好', '利空', '中性', '难以判断'], '难以判断'),
      strength: pickEnum(parsed.strength, ['强', '中', '弱'], '弱'),
      gist: clip(parsed.gist, 100),
      figures: arr(parsed.figures, 4, 40),
      path: clip(parsed.path, 120),
      verify: arr(parsed.verify, 2, 50),
      confidence: pickEnum(parsed.confidence, ['high', 'medium', 'low'], 'low')
    }
  }
}

/** 缓存键：同一只票的同一条消息，短时间内重复点开不必再问一遍模型 */
export function analyzeKey(scope, code, extra = '') {
  return crypto.createHash('sha1').update(`${scope}|${code}|${extra}`).digest('hex')
}

export const analyzeCache = { get: cacheGet, set: cacheSet }
