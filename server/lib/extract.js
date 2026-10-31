/**
 * 从元宝搜索返回的页面里，抽出「可能是哪只股票」以及「命中了什么信号」。
 *
 * 原则：只认原文里真实出现的代码和名称，不猜、不补、不做行业映射表。
 * 宁可漏，不可错 —— 选股场景里一个臆造的标的比少一条线索代价大得多。
 */

/** A 股代码 → 市场与板块 */
const MARKET_RULES = [
  { test: /^68[89]/, market: 'SH', board: '科创板' },
  { test: /^60[0135]/, market: 'SH', board: '沪市主板' },
  { test: /^00[0123]/, market: 'SZ', board: '深市主板' },
  { test: /^30[01]/, market: 'SZ', board: '创业板' },
  { test: /^(43|83|87|88|92)/, market: 'BJ', board: '北交所' }
]

/** 看起来像 202610 这种日期，不能当股票代码 */
function looksLikeDate(code) {
  const head = Number(code.slice(0, 4))
  if (head >= 1990 && head <= 2035) return true
  const month = Number(code.slice(4))
  if (month >= 1 && month <= 12 && /^(19|20)/.test(code)) return true
  return false
}

/** 指数与板块代码，不是个股：881xxx/884xxx 这类是行业指数 */
const INDEX_CODE_RE = /^(881|882|883|884|885|886|887|888|999)\d{3}$/

export function classifyCode(code) {
  if (INDEX_CODE_RE.test(code)) return null
  const rule = MARKET_RULES.find((r) => r.test.test(code))
  if (!rule) return null
  if (looksLikeDate(code)) return null
  return { code, market: rule.market, board: rule.board }
}

const CODE_RE = /(?<![\d.])((?:SH|SZ|BJ)\s*)?(\d{6})(?![\d.])/gi

/** 扫描全部代码出现位置（不去重），用于按上下文取信号 */
function scanCodes(text) {
  const src = String(text || '')
  const out = []
  let m
  CODE_RE.lastIndex = 0
  while ((m = CODE_RE.exec(src))) {
    const hit = classifyCode(m[2])
    if (!hit) continue
    if (m[1]) {
      const prefix = m[1].trim().toUpperCase()
      if (prefix !== hit.market) hit.market = prefix
    }
    out.push({ ...hit, at: m.index, end: m.index + m[0].length })
  }
  return out
}

/** 找出文本里的全部 A 股代码（去重） */
export function findCodes(text) {
  const seen = new Set()
  const out = []
  for (const hit of scanCodes(text)) {
    if (seen.has(hit.code)) continue
    seen.add(hit.code)
    out.push({ code: hit.code, market: hit.market, board: hit.board })
  }
  return out
}

const NAME_CLEAN = /(股份有限公司|有限公司|集团股份|股份公司|集团|控股|科技股份)$/

function cleanName(raw) {
  let name = String(raw || '').replace(/^[（(]|[）)]$/g, '').trim()
  name = name.replace(NAME_CLEAN, '')
  if (name.length < 2 || name.length > 6) return ''
  if (/^\d+$/.test(name)) return ''
  return name
}

const BAD_NAME = /^(同比|环比|公司|股票|代码|公告|证券|上市|停牌|复牌|收盘|报收|记者|编辑|来源|观点|分析|点评|研报|机构|净利|营收|亿元|万元)/

/** 这些词经常紧跟在代码后面，但明显不是公司名 */
const NAME_STOPLIST = new Set([
  '业绩', '预增', '预盈', '预减', '公告', '中标', '订单', '三季报', '中报', '年报', '季报',
  '净利', '营收', '回购', '增持', '减持', '调研', '评级', '涨价', '提价', '扩产', '投产',
  '量产', '报告', '披露', '增长', '下滑', '亏损', '风险', '龙头', '概念', '板块', '个股',
  '股票', '代码', '简称', '公司', '记者', '编辑', '报道', '快讯', '早报', '晚间', '午间',
  '独家', '重磅', '深度', '观察', '解读', '复盘', '盘前', '盘中', '收盘', '涨幅', '跌幅',
  '股价', '市值', '估值', '基金', '券商', '机构', '行业', '产业', '赛道', '标的', '受益'
])

/** 名称里出现这些词，基本可以断定是从标题里切错了 */
const NAME_FORBIDDEN =
  /(业绩|预增|预盈|预减|预计|净利|净利润|营收|翻倍|扭亏|增长|下滑|亏损|中标|订单|公告|回购|增持|减持|调研|评级|涨价|提价|扩产|投产|量产|报告|快讯|披露|亿元|万元|同比|环比|股价|市值|估值|龙头|概念|板块|个股|股票|代码|简称|投资|基金|券商|行业|产业|赛道|受益)/

/** 标题里常见的状语前缀，切进名称里要剥掉 */
const LEAD_NOISE = [
  '当晚', '当日', '当天', '近日', '近期', '昨日', '今日', '今年', '去年', '明年',
  '目前', '同时', '此外', '另外', '其中', '截至', '据悉', '据报', '对此',
  '数据显示', '值得一提', '值得注意的是'
]

function acceptName(raw) {
  let name = cleanName(raw)
  if (!name) return ''
  for (const p of LEAD_NOISE) {
    if (name.startsWith(p) && name.length - p.length >= 2) {
      name = name.slice(p.length)
      break
    }
  }
  if (name.length < 2) return ''
  if (BAD_NAME.test(name)) return ''
  if (NAME_STOPLIST.has(name)) return ''
  if (NAME_FORBIDDEN.test(name)) return ''
  return name
}

/**
 * 在代码附近找股票名称。
 * 常见写法：宁德时代(300750)、宁德时代 300750、300750 宁德时代、300750.SZ 宁德时代
 */
export function findNameNear(text, code) {
  const src = String(text || '')
  const idx = src.indexOf(code)
  if (idx < 0) return ''

  const before = src.slice(Math.max(0, idx - 16), idx)

  // 形式一：名称(code)
  const m1 = before.match(/([\u4e00-\u9fa5A-Za-z]{2,8})\s*[（(]\s*(?:SH|SZ|BJ)?\s*$/i)
  if (m1) {
    const name = acceptName(m1[1])
    if (name) return name
  }

  // 形式二：名称 300750（标题里最常见）
  const m2 = before.match(/([\u4e00-\u9fa5]{2,6})\s*$/u)
  if (m2) {
    const name = acceptName(m2[1])
    if (name) return name
  }

  // 形式三：代码在前，名称在后
  const after = src.slice(idx + code.length, idx + code.length + 16)
  const m3 = after.match(/^(?:\.[A-Z]{2})?\s*[）)]?\s*[：:，,、\s]\s*([\u4e00-\u9fa5]{2,6})/)
  if (m3) {
    const name = acceptName(m3[1])
    if (name) return name
  }

  return ''
}

/** 信号词典：正面 / 负面，每条都带可解释的关键词 */
export const SIGNALS = {
  positive: [
    { key: '业绩', words: ['预增', '净利润增长', '同比增长', '扭亏', '超预期', '创历史新高', '大幅增长', '业绩大增', '净利大增'] },
    { key: '订单', words: ['中标', '大单', '重大合同', '签订', '订单饱满', '订单增长', '新增订单'] },
    { key: '机构', words: ['机构调研', '密集调研', '买入评级', '增持评级', '上调评级', '目标价', '基金加仓', '北向资金', '社保基金'] },
    { key: '涨价', words: ['涨价', '提价', '供不应求', '缺货', '价格上涨', '排产饱满'] },
    { key: '回购', words: ['回购', '增持计划', '股权激励', '员工持股', '现金分红', '高分红'] },
    { key: '扩张', words: ['扩产', '投产', '量产', '产能释放', '新建产能', '产能爬坡'] },
    { key: '政策', words: ['政策支持', '补贴', '纳入目录', '获批', '通过审批', '试点'] }
  ],
  negative: [
    { key: '减持', words: ['减持', '清仓式减持', '拟减持'] },
    { key: '亏损', words: ['亏损', '预减', '同比下滑', '同比下降', '业绩变脸', '由盈转亏'] },
    { key: '监管', words: ['问询函', '立案调查', '行政处罚', '违规', '退市风险', '风险提示', '监管关注'] }
  ]
}

/** 命中哪些信号 */
export function detectSignals(text) {
  const src = String(text || '')
  const positive = []
  const negative = []
  for (const group of SIGNALS.positive) {
    const hit = group.words.filter((w) => src.includes(w))
    if (hit.length) positive.push({ key: group.key, words: hit })
  }
  for (const group of SIGNALS.negative) {
    const hit = group.words.filter((w) => src.includes(w))
    if (hit.length) negative.push({ key: group.key, words: hit })
  }
  return { positive, negative }
}

/** 把文本切成句子片段，记录位置 */
function splitSegments(text, start = 0) {
  const segs = []
  let cursor = 0
  const re = /[。！？；\n]+/g
  let m
  while ((m = re.exec(text))) {
    segs.push({ text: text.slice(cursor, m.index), start: start + cursor, end: start + m.index })
    cursor = m.index + m[0].length
  }
  if (cursor < text.length) {
    segs.push({ text: text.slice(cursor), start: start + cursor, end: start + text.length })
  }
  return segs
}

/**
 * 一条页面 → 命中的标的
 *
 * 信号按「代码所在的那一句」取，不按整页取 —— 列表型文章里
 * 「300620 预计净利翻倍……300395 净利润下滑」必须分别归到各自的公司。
 * 一句话里出现多个代码时，再按逗号拆一层。
 * @returns {{code,market,board,name,signals}[]}
 */
export function extractFromPage(page) {
  const title = page.title || ''
  const passage = page.passage || ''
  const content = String(page.content || '').slice(0, 1500)
  const core = `${title} ${passage}`.trim()
  const full = `${core} ${content}`.trim()

  const hits = scanCodes(full)
  if (!hits.length) return []

  // 逐句切分；一句里有多只股票时再按逗号细分，避免信号串味
  let segs = splitSegments(full)
  segs = segs.flatMap((seg) => {
    const count = new Set(scanCodes(seg.text).map((h) => h.code)).size
    if (count <= 1) return [seg]
    const parts = []
    let cursor = 0
    for (const piece of seg.text.split(/(?<=[，,、])/)) {
      parts.push({ text: piece, start: seg.start + cursor, end: seg.start + cursor + piece.length })
      cursor += piece.length
    }
    return parts
  })

  const scopeOf = (at) => {
    const seg = segs.find((s) => at >= s.start && at < s.end)
    return seg ? seg.text : ''
  }

  const byCode = new Map()
  for (const h of hits) {
    const item = byCode.get(h.code) || { code: h.code, market: h.market, board: h.board, scopes: [] }
    const scope = scopeOf(h.at)
    if (scope) item.scopes.push(scope)
    byCode.set(h.code, item)
  }

  return [...byCode.values()].map((item) => {
    const scope = item.scopes.join(' ')
    const name = findNameNear(core, item.code) || findNameNear(scope, item.code)
    return {
      code: item.code,
      market: item.market,
      board: item.board,
      name,
      signals: detectSignals(scope)
    }
  })
}
