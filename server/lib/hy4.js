/**
 * 混元 Hy4 preview 语义提炼层（可选）
 *
 * 规则引擎能认出「净利润同比下滑」这种固定搭配，认不出「利润承压」「毛利被挤压」，
 * 也读不出「在手订单 170.73 亿元，同比增 88.2%」到底意味着什么。
 * 这一层把候选标的的证据摘要交给模型，提炼四样东西：
 *
 *   event   事件类型（业绩超预期 / 大额订单 / 产能扩张 / 风险事件 …）
 *   points  支撑买入理由的具体事实，尽量带数字
 *   risks   摘要里出现的风险点
 *   verdict 一句话判断，只描述「信息说明了什么」，不给买卖结论
 *
 * 设计约束：
 *   1. 只允许依据传入的摘要，摘要里没有的一律留空 —— 不能让模型补行业常识凑数；
 *   2. 未配置 HY4_API_KEY 时 enabled() 返回 false，所有调用方自动退回规则结果；
 *   3. 调用失败只降级不抛错，扫描流程不能因为模型不可用而中断。
 */

import { getPersona, DEFAULT_PERSONA } from './personas.js'
import { clip } from './text.js'

const DEFAULT_BASE = 'https://tokenhub.tencentmaas.com/v1'
const DEFAULT_MODEL = 'hy4-preview'
const DEFAULT_TIMEOUT = 30000

export class Hy4Error extends Error {
  constructor(code, message, status) {
    super(message)
    this.name = 'Hy4Error'
    this.code = code
    this.status = status
  }
}

function env(name, fallback = '') {
  const v = process.env[name]
  return v === undefined || v === null || String(v).trim() === '' ? fallback : String(v).trim()
}

export function hy4Enabled() {
  return Boolean(env('HY4_API_KEY'))
}

export function hy4Model() {
  return env('HY4_MODEL', DEFAULT_MODEL)
}

export function hy4TopN() {
  const n = Number(env('HY4_TOP_N', '6'))
  return Number.isFinite(n) && n > 0 ? Math.min(20, Math.floor(n)) : 6
}

function endpoint() {
  const base = env('HY4_BASE_URL', DEFAULT_BASE).replace(/\/+$/, '')
  // 允许直接写完整的 chat/completions 地址
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`
}

/**
 * hy4-preview 默认开启深度思考，这对「照着摘要提炼事实」是纯负担：
 * 实测思考会吃满 max_tokens 让 content 返回空串，耗时也从 3.4s 涨到 38s。
 * 所以默认关掉，需要时把 HY4_THINKING 设成 enabled。
 */
function thinkingConfig() {
  const v = env('HY4_THINKING', 'disabled').toLowerCase()
  return v === 'enabled' ? null : { type: 'disabled' }
}

/**
 * 仅在开启深度思考时才需要指定推理深度。
 * 提炼摘要这种任务用不上，设 low 能省一半以上的等待和 token。
 */
function reasoningEffort() {
  const v = env('HY4_REASONING_EFFORT', 'low').toLowerCase()
  return ['low', 'medium', 'high'].includes(v) ? v : ''
}

/**
 * 从模型输出里抠出 JSON。
 * 模型经常会套一层 ```json 或前后加一句「好的，结果如下」。
 */
export function parseJsonLoose(text) {
  const raw = String(text || '').trim()
  if (!raw) return null

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : raw

  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null

  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * 一次 chat 调用。走 OpenAI 兼容格式（POST /chat/completions）。
 * 如果你的端点不是这个形态，只需要改这一个函数。
 */
export async function chat({ system, user, temperature = 0.2, maxTokens = 1500 }) {
  if (!hy4Enabled()) throw new Hy4Error('NO_KEY', '未配置 HY4_API_KEY')

  const timeout = Number(env('HY4_TIMEOUT_MS', String(DEFAULT_TIMEOUT)))
  const effort = reasoningEffort()
  const thinking = thinkingConfig()
  const started = Date.now()

  let res
  try {
    res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env('HY4_API_KEY')}`
      },
      body: JSON.stringify({
        model: hy4Model(),
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: user }
        ],
        temperature,
        max_tokens: maxTokens,
        stream: false,
        // 关掉思考时 reasoning_effort 没有意义，传了反而可能被服务端忽略或报错
        ...(thinking ? { thinking } : effort ? { reasoning_effort: effort } : {})
      }),
      signal: AbortSignal.timeout(Number.isFinite(timeout) ? timeout : DEFAULT_TIMEOUT)
    })
  } catch (err) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    throw new Hy4Error(
      isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      isTimeout ? `模型请求超时（${timeout}ms）` : `无法连接模型服务：${err?.message || err}`
    )
  }

  const rawText = await res.text()
  let data
  try {
    data = JSON.parse(rawText)
  } catch {
    throw new Hy4Error('BAD_RESPONSE', `模型返回了非 JSON 内容（HTTP ${res.status}）`, res.status)
  }

  if (!res.ok) {
    const msg =
      data?.error?.message || data?.Response?.Error?.Message || data?.message || rawText.slice(0, 200)
    throw new Hy4Error('HTTP_ERROR', `模型调用失败（HTTP ${res.status}）：${msg}`, res.status)
  }

  const choice = data?.choices?.[0] || {}
  const content =
    choice?.message?.content ??
    choice?.delta?.content ??
    data?.Response?.Choices?.[0]?.Message?.Content ??
    ''

  return {
    content: String(content || ''),
    finishReason: choice?.finish_reason || '',
    reasoningTokens: data?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    usage: data?.usage || null,
    elapsedMs: Date.now() - started
  }
}

/**
 * 系统提示词 = 角色设定 + 任务约束。
 *
 * 角色段落只改「怎么读这些摘要」，四条硬约束和输出结构对所有角色一致 ——
 * 换了角色，事实的边界不能跟着变松。
 */
export function buildSystemPrompt(persona) {
  return `${persona.stance}

用户会给你一只 A 股标的和若干条公开网页摘要。你的任务是从这些摘要里提炼事实，按下面的格式输出 JSON。

规则：

1. 只能使用摘要里明确出现的信息。摘要没提到的，宁可留空，绝不允许补充行业常识、财报印象、股价记忆。
2. points 的写法：${persona.pointsHint}。
3. risks 的写法：${persona.risksHint}。摘要里确实没有风险信息时给空数组，不要为了凑数硬写。
4. points 和 risks 每条都要具体，「业绩向好」这种空话无效；有数字的必须带上数字。每条一句话说完，不超过 50 字，不要写「后续看……验证」这类尾巴。
5. verdict 用你自己这个角色的口吻，说明「这些信息共同指向什么」，不超过 40 字，一句话写完，不给买卖建议、不预测股价、不写目标价。
6. confidence 取 high / medium / low：摘要条数少、说法互相矛盾、或只有标题没有内容时，必须给 low。
7. 只输出 JSON，不要任何解释性文字，不要 markdown 代码块。

输出格式：
{"event":"事件类型","points":["..."],"risks":["..."],"confidence":"high","verdict":"..."}`
}

function buildUserPrompt(candidate) {
  const sites = (candidate.sites || []).slice(0, 6)
  const evidence = sites
    .map((s, i) => {
      const head = `${i + 1}. [${s.site || '未知站点'}｜${s.date || '无日期'}｜${
        s.tier === 'A' ? '权威来源' : s.tier === 'B' ? '主流媒体' : '一般线索'
      }] ${s.title || ''}`
      const body = s.snippet ? `\n   摘要：${s.snippet}` : '\n   摘要：（无）'
      return head + body
    })
    .join('\n')

  const ruleSignals = [
    candidate.positives?.length ? `规则命中的正面词：${candidate.positives.map((p) => p.key).join('、')}` : '',
    candidate.negatives?.length ? `规则命中的风险词：${candidate.negatives.map((n) => n.key).join('、')}` : ''
  ]
    .filter(Boolean)
    .join('\n')

  return `标的：${candidate.name || candidate.code}（${candidate.code}，${candidate.board || ''}）

${ruleSignals ? `参考（可能误报，请以摘要原文为准）：\n${ruleSignals}\n\n` : ''}公开信息摘要：
${evidence || '（无可用摘要）'}`
}

/**
 * 给一只候选标的做语义提炼。
 * 失败或解析不出 JSON 时返回 null，调用方保留规则结果即可。
 *
 * @param {object} candidate 候选标的（含 sites 证据）
 * @param {{persona?: string}} opts 角色 key，缺省用 DEFAULT_PERSONA
 */
export async function enrichCandidate(candidate, { persona = DEFAULT_PERSONA } = {}) {
  if (!hy4Enabled() || !candidate?.code) return null

  const role = getPersona(persona)

  const { content, elapsedMs, finishReason, reasoningTokens } = await chat({
    system: buildSystemPrompt(role),
    user: buildUserPrompt(candidate),
    maxTokens: 1200
  })

  const parsed = parseJsonLoose(content)
  if (!parsed) {
    // finish=length 且 content 为空，基本都是深度思考把 max_tokens 吃光了
    const truncated = finishReason === 'length' && !String(content).trim()
    const error = truncated
      ? `输出被 max_tokens 截断（思考消耗 ${reasoningTokens} tokens），把 HY4_THINKING 设为 disabled`
      : '模型没有返回可解析的 JSON'
    return {
      ok: false,
      persona: { key: role.key, name: role.name },
      error,
      raw: String(content).slice(0, 200),
      finishReason,
      reasoningTokens,
      elapsedMs
    }
  }

  const arr = (v) => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? [v] : [])
  const confidence = ['high', 'medium', 'low'].includes(parsed.confidence)
    ? parsed.confidence
    : 'low'

  return {
    ok: true,
    elapsedMs,
    persona: { key: role.key, name: role.name },
    event: String(parsed.event || '').slice(0, 40),
    points: arr(parsed.points).map((x) => clip(x, 160)).filter(Boolean).slice(0, 5),
    risks: arr(parsed.risks).map((x) => clip(x, 160)).filter(Boolean).slice(0, 5),
    confidence,
    verdict: clip(parsed.verdict, 100),
    model: hy4Model()
  }
}
