/**
 * 自然语言 → 检索计划
 *
 * 原来的输入只有「主题词」，角度、时间、筛选全靠代码里写死的默认值，
 * 用户想表达「近一个月、订单大增、市值 100-500 亿、只要 10 家」就只能改代码。
 * 这一层把一整句话解析成结构化的检索引擎参数：
 *
 *   topic        主题词（只取用户原话里出现的行业/概念，不扩写）
 *   strategies   信息角度（业绩/订单/机构/涨价/回购/主题）
 *   freshness    时间范围
 *   filters      股价、市值、PE 区间
 *   exclude      排除项（ST 等）
 *   sort         排序口径
 *   limit        取几只
 *   extraQueries 模型按原话补的自定义检索式
 *
 * 优先级：规则解析永远先跑一遍，能确定就直出（快、可解释）；
 * 主题词不在词库里、或句子很长（通常带修饰条件）时再交给 Hy4 解析。
 * 模型不可用/超时/输出不合规一律退回规则结果，搜索不会因此中断。
 */

import { chat, hy4Enabled, parseJsonLoose, hy4Model } from './hy4.js'
import { STRATEGIES, TOPIC_PRESETS } from './strategies.js'
import { parseFilters, describeFilters } from './filters.js'
import { PERSONAS, DEFAULT_PERSONA } from './personas.js'
import { resolveStock } from './resolve.js'

const STRATEGY_KEYS = STRATEGIES.map((s) => s.key)
const PERSONA_KEYS = PERSONAS.map((p) => p.key)
const FRESHNESS_KEYS = ['d1', 'd7', 'm1', 'm3', 'm6', 'y1']
const SORT_KEYS = ['score', 'gainers', 'losers', 'capAsc', 'capDesc']

const STRATEGY_NAME = Object.fromEntries(STRATEGIES.map((s) => [s.key, s.name]))
const FRESHNESS_NAME = {
  d1: '今天',
  d7: '近一周',
  m1: '近一个月',
  m3: '近三个月',
  m6: '近半年',
  y1: '近一年'
}
const SORT_NAME = {
  score: '',
  gainers: '按涨幅排序',
  losers: '按跌幅排序',
  capAsc: '市值从小到大',
  capDesc: '市值从大到小'
}

export const DEFAULT_PLAN = {
  mode: 'screen',
  focus: null,
  topic: '',
  strategies: ['earnings', 'orders'],
  persona: DEFAULT_PERSONA,
  freshness: 'm3',
  cnt: 30,
  limit: 20,
  filters: null,
  exclude: [],
  sort: 'score',
  extraQueries: [],
  intent: '',
  source: 'rule',
  readback: ''
}

const clampNum = (v, min, max) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(max, Math.max(min, n))
}

/* ── 规则解析 ───────────────────────────────────────────── */

const FRESHNESS_RULES = [
  [/(今天|今日|当天|刚刚|最新)/, 'd1'],
  [/(本周|这周|近一周|最近一周|一周内|最近七天|近七天|7\s*天)/, 'd7'],
  [/(近三个月|最近三个月|三个月|一个季度|本季度|上季度|90\s*天)/, 'm3'],
  [/(本月|这个月|近一个月|最近一个月|一个月|近一月|30\s*天)/, 'm1'],
  [/(近半年|最近半年|半年|六个月|两个季度)/, 'm6'],
  [/(今年|本年|年初至今|年内|近一年|最近一年|一年)/, 'y1']
]

const STRATEGY_RULES = [
  ['earnings', /(业绩|预增|预盈|净利|利润|财报|季报|年报|扭亏|超预期|增长)/],
  ['orders', /(中标|订单|合同|签约|大单|采购|发包)/],
  ['institution', /(机构|调研|评级|基金|北向|加仓|持仓|券商)/],
  ['pricehike', /(涨价|提价|供不应求|扩产|产能|量产|景气|紧缺)/],
  ['buyback', /(回购|增持|股权激励|员工持股)/],
  ['theme', /(龙头|产业链|受益|概念|板块|标的)/]
]

const SORT_RULES = [
  ['gainers', /(涨幅|涨得最多|领涨|涨最多|强势)/],
  ['losers', /(跌幅|跌得最多|跌最多|回调最深)/],
  ['capAsc', /(市值从小到大|小盘优先|市值最小)/],
  ['capDesc', /(市值从大到小|大盘优先|市值最大)/]
]

/** 找句子里最长的词库命中，作为主题词。空格不参与比较，返回词库里的标准写法 */
function matchTopic(text) {
  const flat = String(text || '').replace(/\s+/g, '')
  let best = ''
  for (const t of TOPIC_PRESETS) {
    const key = t.replace(/\s+/g, '')
    if (flat.includes(key) && key.length > best.replace(/\s+/g, '').length) best = t
  }
  return best
}

/** 去掉条件片段、角度提示词，剩下的就是用户想找的行业/概念 */
function stripConditions(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/(?:总)?市值[^，。；,;]{0,10}?(\d+(?:\.\d+)?)\s*亿?(?:\s*[-–~到至]\s*\d+(?:\.\d+)?\s*亿?)?/g, ' ')
    .replace(/股价[^，。；,;]{0,10}/g, ' ')
    .replace(/(?:PE|pe|市盈率)[^，。；,;]{0,10}/g, ' ')
    .replace(/[^，。；,;]{0,6}\d+(?:\.\d+)?\s*亿(?:以上|以下|以内|之上|之下)?[^，。；,;]{0,4}/g, ' ')
    .replace(/[^，。；,;]{0,6}\d+(?:\.\d+)?\s*(?:元|块)(?:以上|以下|以内)?[^，。；,;]{0,4}/g, ' ')
    .replace(/(?:排除|不要|剔除|去掉|不看)\s*\S{0,6}/g, ' ')
    .replace(/(?:按|以)?(?:涨幅|跌幅|市值|分数|证据)[^，。；,;]{0,6}排序/g, ' ')
    .replace(new RegExp(`(?:${
      STRATEGY_RULES.map(([, re]) => re.source).join('|')
    })`, 'g'), ' ')
    .replace(/近\s*(?:一|1|3|三|6|六|12|半)\s*个?(?:月|年|周|季度)|最近\s*\S{0,3}|今天|今日|本周|这周|今年|年内/g, ' ')
    .replace(/业绩预增|预增|预盈|扭亏|业绩|净利|利润/g, ' ')
    .replace(/帮我|请|麻烦|找一下|找找|筛一下|筛选|搜索|搜一下|查一下|看一下|看看|有没有|推荐|整理|一下|给我|要|只想|只看|只要/g, ' ')
    .replace(/的(?:公司|股票|标的|个股|票|股)/g, ' ')
    .replace(/[，。！？、；：,.;:!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 把「三」「十」「十五」这类小数字转成阿拉伯数字 */
const CN_DIGIT = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
function toNumberish(raw) {
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw)
  if (raw === '十') return 10
  if (/^十[一二三四五六七八九]$/.test(raw)) return 10 + CN_DIGIT[raw[1]]
  if (/^[一二三四五六七八九]十$/.test(raw)) return CN_DIGIT[raw[0]] * 10
  return CN_DIGIT[raw] ?? null
}

/**
 * 抽一类区间：单位是「亿」时按市值理解，单位是「元 / 块」或带「股价」时按股价理解。
 * 句式覆盖：「100-500 亿」「100 亿以上」「低于 200 亿」「30 元以下」「10 到 30 块」。
 */
function parseRanges(text) {
  const out = {}
  const put = (key, min, max) => {
    if (min !== null) out[`${key}Min`] = min
    if (max !== null) out[`${key}Max`] = max
  }

  // 市值：必须出现「亿」，且句子里没有把亿用在营收/订单/利润上
  const moneyContext = /(营收|收入|订单|合同|净利|利润|中标金额|采购额)/.test(text)
  const yi = /(市值|盘子|小市值|大市值|中小市值)/
  if (yi.test(text) || (!moneyContext && /亿/.test(text))) {
    const range = text.match(/(\d+(?:\.\d+)?)\s*亿?\s*[-–~到至]\s*(\d+(?:\.\d+)?)\s*亿/)
    if (range) put('cap', Number(range[1]), Number(range[2]))
    else {
      const below = text.match(/(?:市值|盘子)?[^0-9]{0,4}(\d+(?:\.\d+)?)\s*亿\s*(?:以下|以内|之下|内)/)
      const under = text.match(/(?:低于|小于|不超过|不到|少于)\s*(\d+(?:\.\d+)?)\s*亿/)
      const above = text.match(/(?:市值|盘子)?[^0-9]{0,4}(\d+(?:\.\d+)?)\s*亿\s*(?:以上|之上|起)/)
      const over = text.match(/(?:高于|大于|超过|至少|不低于)\s*(\d+(?:\.\d+)?)\s*亿/)
      if (below) put('cap', null, Number(below[1]))
      else if (under) put('cap', null, Number(under[1]))
      if (above) put('cap', Number(above[1]), null)
      else if (over) put('cap', Number(over[1]), null)
    }
  }

  // 小市值 / 大盘股这类口头说法映射到常用档位
  if (/(小市值|微盘|中小市值|市值(?:较小|小的|很小|不大|偏低))/.test(text) && out.capMax === undefined) {
    out.capMax = 200
  }
  if (/(大盘股|蓝筹|权重股)/.test(text) && out.capMin === undefined) out.capMin = 500

  // 股价
  if (/(股价|价格|元|块)/.test(text)) {
    const range = text.match(/(\d+(?:\.\d+)?)\s*(?:元|块)?\s*[-–~到至]\s*(\d+(?:\.\d+)?)\s*(?:元|块)/)
    const below = text.match(/(?:股价)?[^0-9]{0,4}(\d+(?:\.\d+)?)\s*(?:元|块)\s*(?:以下|以内|之下)/)
    const above = text.match(/(?:股价)?[^0-9]{0,4}(\d+(?:\.\d+)?)\s*(?:元|块)\s*(?:以上|之上)/)
    const under = text.match(/(?:股价|价格)\s*(?:低于|小于|不超过|不到)\s*(\d+(?:\.\d+)?)/)
    const over = text.match(/(?:股价|价格)\s*(?:高于|大于|超过|不低于)\s*(\d+(?:\.\d+)?)/)
    if (range) put('price', Number(range[1]), Number(range[2]))
    else if (below) put('price', null, Number(below[1]))
    else if (above) put('price', Number(above[1]), null)
    else if (under) put('price', null, Number(under[1]))
    else if (over) put('price', Number(over[1]), null)
  }

  // PE / 市盈率
  const peRange = text.match(/(?:PE|pe|市盈率)\s*(\d+(?:\.\d+)?)\s*[-–~到至]\s*(\d+(?:\.\d+)?)/)
  const peBelow = text.match(/(?:PE|pe|市盈率)\s*(?:低于|小于|≤|<|不超过)?\s*(\d+(?:\.\d+)?)\s*(?:倍|以下|以内)?/)
  const peAbove = text.match(/(?:PE|pe|市盈率)\s*(?:高于|大于|≥|>|超过)\s*(\d+(?:\.\d+)?)/)
  if (peRange) put('pe', Number(peRange[1]), Number(peRange[2]))
  else if (peAbove) put('pe', Number(peAbove[1]), null)
  else if (peBelow) put('pe', null, Number(peBelow[1]))
  if (/(低估值|估值低|估值便宜)/.test(text) && out.peMax === undefined) out.peMax = 30

  return out
}

function parseExclude(text) {
  const list = []
  if (/排除\s*ST|不要\s*ST|非\s*ST|剔除\s*ST|去掉\s*ST|不看\s*ST|不包含\s*ST/i.test(text)) list.push('ST')
  if (/(排除|不要|剔除|去掉)(亏损|亏损股|亏钱)/.test(text)) list.push('亏损')
  return list
}

/**
 * 纯规则解析。任何时候都能跑出结果，作为模型解析的兜底。
 * @param {string} query
 */
export function rulePlan(query) {
  const text = String(query || '').trim()
  const lower = text
  const topicHit = matchTopic(lower)

  let freshness = 'm3'
  for (const [re, key] of FRESHNESS_RULES) {
    if (re.test(lower)) {
      freshness = key
      break
    }
  }

  const strategies = []
  for (const [key, re] of STRATEGY_RULES) {
    if (re.test(lower)) strategies.push(key)
  }
  // 只说了行业没说角度，按「有事件」的两个角度铺开
  if (!strategies.length) strategies.push('earnings', 'orders')

  let sort = 'score'
  for (const [key, re] of SORT_RULES) {
    if (re.test(lower)) {
      sort = key
      break
    }
  }

  let limit = 20
  // 「只要 10 家」只看量词是家/只/支，不能用「个」——「一个月」会误命中
  const limitMatch = lower.match(/(?:前|只要|最多|取|给我|给|要|留)?\s*(\d{1,2})\s*(?:家|只|支)/)
  if (limitMatch) limit = Math.min(30, Math.max(5, Number(limitMatch[1])))
  else {
    const cnLimit = lower.match(/(?:前|只要|最多|取)?\s*([一二两三四五六七八九十]{1,3})\s*(?:家|只|支)/)
    if (cnLimit) {
      const n = toNumberish(cnLimit[1])
      if (n) limit = Math.min(30, Math.max(5, n))
    }
  }

  // 主题：优先词库命中；否则剔掉条件片段和角度词，取剩下的行业名
  let topic = topicHit
  if (!topic) {
    const cleaned = stripConditions(lower)
    topic = (cleaned || lower).slice(0, 24)
  }

  const filters = parseRanges(lower)
  const exclude = parseExclude(lower)

  const plan = {
    ...DEFAULT_PLAN,
    topic,
    strategies,
    freshness,
    limit,
    filters: parseFilters(filters),
    exclude: exclude.filter((x) => x !== '亏损'),
    sort,
    source: 'rule',
    intent: '',
    extraQueries: []
  }

  // 说了「排除亏损」就等价于 PE > 0
  if (exclude.includes('亏损') && !plan.filters) plan.filters = parseFilters({ peMin: 0.01 })
  if (exclude.includes('亏损') && plan.filters && plan.filters.peMin === null) {
    plan.filters = { ...plan.filters, peMin: 0.01 }
  }

  plan.confident = Boolean(topicHit) && lower.length <= 30
  plan.readback = describePlan(plan)
  return plan
}

/* ── 个股计划 ───────────────────────────────────────────── */

/**
 * 句子里锁定了某一只股票时，计划整体换成「个股深度」：
 * 不再按行业铺检索式，而是围绕这一只票铺公告、财报、机构、风险、行业地位。
 * 筛选条件在这条路径上没有意义（就一只票，筛掉就没了），一律不生效。
 */
function stockPlan(query, focus) {
  const rule = rulePlan(query)
  const plan = {
    ...DEFAULT_PLAN,
    mode: 'stock',
    focus: { code: focus.code, market: focus.market, board: focus.board, name: focus.name || '' },
    topic: focus.name || focus.code,
    strategies: ['stock'],
    persona: rule.persona || DEFAULT_PERSONA,
    freshness: rule.freshness,
    limit: 24,
    filters: null,
    exclude: [],
    sort: 'score',
    extraQueries: [],
    intent: `看${focus.name || focus.code}这只票`,
    source: focus.via === 'code' ? 'code' : 'stock',
    via: focus.via
  }
  plan.readback = describePlan(plan)
  return plan
}

/* ── 模型解析 ───────────────────────────────────────────── */

const PLAN_SYSTEM = `你是把中文选股需求翻译成检索参数的解析器。只输出 JSON，不要解释。

可用角度 strategies（可多选）：
- earnings 业绩预增（业绩预告、财报、净利润增长）
- orders 订单中标（中标、重大合同、在手订单）
- institution 机构动向（调研、评级、持仓）
- pricehike 产品涨价（提价、扩产、景气）
- buyback 回购增持（回购、增持、股权激励）
- theme 主题扫描（产业链、受益标的）

可用时间 freshness：d1 今天 / d7 近一周 / m1 近一个月 / m3 近三个月 / m6 近半年 / y1 近一年
可用角色 persona：master 资深分析师 / industry 产业链研究员 / quant 量化选股 / risk 风控审查
可用排序 sort：score 按证据厚度 / gainers 按涨幅 / losers 按跌幅 / capAsc 市值升序 / capDesc 市值降序

输出字段：
{"topic":"","strategies":[],"persona":"master","freshness":"m3","limit":20,
 "filters":{"priceMin":null,"priceMax":null,"capMin":null,"capMax":null,"peMin":null,"peMax":null},
 "exclude":[],"sort":"score","extraQueries":[],"intent":""}

规则：
1. topic 必须是用户原话里出现过的行业或概念词，只做精简（去掉"板块""概念"等后缀），绝不补充用户没提的行业。
2. filters 单位：股价是元，市值是亿元，PE 是倍。没提到的项必须填 null，不要填 0（0 会被当成真区间）。用户说"小市值"给 capMax 200，"大盘股"给 capMin 500。
3. exclude 填要排除的标签，例如 ["ST"]；不要排除就把数组留空。
4. limit 取 5 到 30，用户没说就填 20。
5. extraQueries 是 0 到 2 条更贴合用户原话的检索式，必须包含 topic，每条不超过 30 字。模板检索式已经覆盖常见角度，这里只补用户特别强调的条件（例如"连续三个季度净利润增长"）。
6. intent 用一句话概括用户想找什么，不超过 25 字。`

function buildPlanUserPrompt(query) {
  return `用户输入：${query}`
}

function normalizePlan(raw, query) {
  const rule = rulePlan(query)
  if (!raw || typeof raw !== 'object') return rule

  const pickEnum = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback)

  const strategies = (Array.isArray(raw.strategies) ? raw.strategies : [])
    .map((s) => String(s).trim())
    .filter((s) => STRATEGY_KEYS.includes(s))

  const filterRaw = {}
  for (const k of ['priceMin', 'priceMax', 'capMin', 'capMax', 'peMin', 'peMax']) {
    const n = clampNum(raw?.filters?.[k], 0, 1e7)
    // 0 一律按「没设」处理：模型很爱把没提到的项填 0，当成真区间会把名单筛空
    if (n !== null && n > 0) filterRaw[k] = n
  }

  const extras = (Array.isArray(raw.extraQueries) ? raw.extraQueries : [])
    .map((s) => String(s || '').trim())
    .filter((s) => s.length >= 4 && s.length <= 40)
    .slice(0, 2)

  const topicRaw = String(raw.topic || '').trim().replace(/[「」"']/g, '')
  const topic = (topicRaw || rule.topic).slice(0, 24)

  const plan = {
    mode: 'screen',
    focus: null,
    topic,
    strategies: strategies.length ? [...new Set(strategies)].slice(0, 4) : rule.strategies,
    persona: pickEnum(String(raw.persona || ''), PERSONA_KEYS, rule.persona || DEFAULT_PERSONA),
    freshness: pickEnum(String(raw.freshness || ''), FRESHNESS_KEYS, rule.freshness),
    cnt: 30,
    limit: clampNum(raw.limit, 5, 30) ?? rule.limit,
    filters: parseFilters(filterRaw) || rule.filters,
    exclude: (Array.isArray(raw.exclude) ? raw.exclude : [])
      .map((s) => String(s || '').trim().slice(0, 4))
      .filter(Boolean)
      .slice(0, 4),
    sort: pickEnum(String(raw.sort || ''), SORT_KEYS, rule.sort),
    extraQueries: extras,
    intent: String(raw.intent || '').slice(0, 40),
    source: 'llm',
    readback: ''
  }

  // 模型把主题理解成空、或长到不像主题时，用规则结果兜底
  if (!plan.topic) plan.topic = rule.topic
  plan.readback = describePlan(plan)
  return plan
}

/**
 * 解析一整句话。规则先跑，判断不了再问模型。
 * 永远返回可用的 plan，不会抛错。
 *
 * @param {string} query
 * @returns {Promise<object>}
 */
export async function planQuery(query) {
  const q = String(query || '').trim().slice(0, 200)
  if (!q) return { ...DEFAULT_PLAN, readback: '' }

  const rule = rulePlan(q)

  // 句子指向具体某只票时先走个股路径：不再铺行业检索式，也省掉模型那几秒
  if (!matchTopic(q)) {
    const focus = await resolveStock(q).catch(() => null)
    if (focus) return stockPlan(q, focus)
  }

  // 短句且主题词命中词库时，规则结果已经足够准，不必多花 3 秒
  if (rule.confident || !hy4Enabled()) return rule

  try {
    const { content, elapsedMs } = await chat({
      system: PLAN_SYSTEM,
      user: buildPlanUserPrompt(q),
      temperature: 0.1,
      maxTokens: 600
    })
    const parsed = parseJsonLoose(content)
    if (!parsed) return { ...rule, plannerError: '模型没有返回可解析的 JSON' }
    const plan = normalizePlan(parsed, q)
    plan.plannerMs = elapsedMs
    plan.plannerModel = hy4Model()
    return plan
  } catch (err) {
    return { ...rule, plannerError: err?.message || String(err) }
  }
}

/** 一行话说明这组参数是什么意思，展示在结果页顶部 */
export function describePlan(plan) {
  if (!plan) return ''
  if (plan.mode === 'stock' && plan.focus) {
    const parts = [`${plan.focus.name || plan.focus.code}`]
    if (plan.focus.code) parts.push(`${plan.focus.market} ${plan.focus.code}`)
    parts.push('个股全维度')
    parts.push(FRESHNESS_NAME[plan.freshness] || '近三个月')
    parts.push(`${plan.limit} 条消息`)
    return parts.join(' · ')
  }
  const parts = []
  if (plan.topic) parts.push(plan.topic)
  const names = (plan.strategies || []).map((k) => STRATEGY_NAME[k]).filter(Boolean)
  if (names.length) parts.push(names.join(' + '))
  parts.push(FRESHNESS_NAME[plan.freshness] || '近三个月')
  let f = describeFilters(plan.filters)
  // PE > 0 是「排除亏损」的技术写法，回显时用人话
  if (plan.filters?.peMin === 0.01 && plan.filters?.peMax === null) {
    f = f.replace(/PE\s*≥\s*0\.01/, '排除亏损股')
  }
  if (f) parts.push(f)
  if (plan.exclude?.length) parts.push(`排除 ${plan.exclude.join('、')}`)
  if (SORT_NAME[plan.sort]) parts.push(SORT_NAME[plan.sort])
  if (plan.limit) parts.push(`${plan.limit} 只`)
  return parts.join(' · ')
}

/* ── 追问：在已有名单上继续收窄 ─────────────────────────── */

const REFINE_SYSTEM = `用户在已经拿到一份候选名单之后，提出追加要求。你要把它翻译成对这份名单的调整操作，只输出 JSON。

输出字段：
{"filters":{"priceMin":null,"priceMax":null,"capMin":null,"capMax":null,"peMin":null,"peMax":null},
 "sort":"score","limit":null,"exclude":[],"keep":[],"drop":[],"note":""}

规则：
1. 只输出这句话要求改动的项，没提到的项填 null 或空数组，不要顺手改别的条件。
2. filters 里只要写这句话提到的区间：股价单位元、市值单位亿元、PE 单位倍。"市值 200 亿以下"写 {"capMax":200}。
3. 想从名单里删掉具体标的用 drop（填 6 位代码），只想留某几只用 keep。
4. sort 只能取 score / gainers / losers / capAsc / capDesc。limit 只在用户明确说了数量时填（"留 5 只"），否则必须填 null。
5. note 用一句中文说清你做了什么，不超过 20 字，例如"只看市值 200 亿以下"。
6. 这句话和名单调整无关（比如问某家公司怎么样），所有字段留空，note 写"无关"。`

function buildRefineUserPrompt(query, { plan, candidates }) {
  const rows = candidates.slice(0, 40).map((c) => ({
    code: c.code,
    name: c.name || '',
    board: c.board || '',
    price: c.price ?? null,
    cap: c.marketCap ?? null,
    pe: c.pe ?? null,
    level: c.level,
    score: c.score,
    industry: c.industry || ''
  }))
  const current = describeFilters(parseFilters(plan?.filters)) || '无'

  return `当前筛选条件：${current}
当前名单（${candidates.length} 只，已按证据厚度排序）：
${JSON.stringify(rows)}

用户追加要求：${query}`
}

/** 规则兜底：从追问里抽区间/排序/数量，抽不到就说没听懂 */
function ruleRefine(query) {
  const plan = rulePlan(query)
  const filters = plan.filters
  const hasLimit = /(\d{1,2})\s*(?:家|只|个|支)/.test(query)
  const sort = plan.sort !== 'score' ? plan.sort : null

  if (!filters && !hasLimit && !sort) return null
  return {
    filters,
    sort,
    limit: hasLimit ? plan.limit : null,
    exclude: plan.exclude,
    keep: [],
    drop: [],
    note: describeFilters(filters) || (sort ? SORT_NAME[sort] : `保留 ${plan.limit} 只`),
    source: 'rule'
  }
}

/**
 * 解析一次追问，返回可以直接作用在名单上的操作。
 * 解析不出来时返回 { ops: null, note: '没听懂…' }
 */
export async function refineQuery(query, { plan, candidates = [] }) {
  const q = String(query || '').trim().slice(0, 120)
  if (!q) return { ops: null, note: '说一句要改什么，例如「只看市值 200 亿以下」' }

  // 只有句子里真的提了数量，才允许改条数；否则模型爱给个 1，会把名单截成一条
  const wantsCount = /(\d{1,2}|[一二两三四五六七八九十]{1,2})\s*(?:家|只|支)/.test(q) || /前\s*\d+/.test(q)

  if (hy4Enabled() && candidates.length) {
    try {
      const { content } = await chat({
        system: REFINE_SYSTEM,
        user: buildRefineUserPrompt(q, { plan, candidates }),
        temperature: 0.1,
        maxTokens: 400
      })
      const parsed = parseJsonLoose(content)
      if (parsed) {
        const filterRaw = {}
        for (const k of ['priceMin', 'priceMax', 'capMin', 'capMax', 'peMin', 'peMax']) {
          const n = clampNum(parsed?.filters?.[k], 0, 1e7)
          if (n !== null && n > 0) filterRaw[k] = n
        }
        const keep = (Array.isArray(parsed.keep) ? parsed.keep : [])
          .map((s) => String(s).trim())
          .filter((s) => /^\d{6}$/.test(s))
        const drop = (Array.isArray(parsed.drop) ? parsed.drop : [])
          .map((s) => String(s).trim())
          .filter((s) => /^\d{6}$/.test(s))
        const note = String(parsed.note || '').slice(0, 30)
        if (note === '无关') {
          return { ops: null, note: '这句话不是对名单的调整，改个说法试试' }
        }
        const ops = {
          filters: Object.keys(filterRaw).length ? filterRaw : null,
          sort: SORT_KEYS.includes(parsed.sort) && parsed.sort !== 'score' ? parsed.sort : null,
          limit: wantsCount ? clampNum(parsed.limit, 1, 60) : null,
          exclude: (Array.isArray(parsed.exclude) ? parsed.exclude : [])
            .map((s) => String(s || '').trim().slice(0, 4))
            .filter(Boolean),
          keep: keep.length ? keep : [],
          drop,
          note: note || '已按你的要求调整',
          source: 'llm'
        }
        const touched =
          ops.filters || ops.sort || ops.limit || ops.exclude.length || ops.keep.length || ops.drop.length
        if (touched) return { ops, note: ops.note }
      }
    } catch {
      /* 落到规则兜底 */
    }
  }

  const fallback = ruleRefine(q)
  if (fallback) return { ops: fallback, note: fallback.note }
  return { ops: null, note: '没听懂要改什么，可以试试「市值 200 亿以下」「只看涨幅前三」' }
}
