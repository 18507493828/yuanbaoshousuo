/**
 * 候选筛选：股价、总市值、市盈率三类区间。
 *
 * 规则很简单——设了哪个区间就只保留落在区间里的标的；
 * 亏损（PE ≤ 0）、停牌（无现价）在设了对应条件时一律排除，
 * 因为拿不到有效数值就无法判断是否满足条件。
 */

const FIELDS = [
  { key: 'price', label: '股价', unit: '元' },
  { key: 'cap', label: '市值', unit: '亿' },
  { key: 'pe', label: 'PE', unit: '' }
]

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * @param {object} raw 前端传来的 { priceMin, priceMax, capMin, capMax, peMin, peMax }
 * @returns {null | {priceMin:number|null, ...}} 全为空时返回 null
 */
export function parseFilters(raw) {
  const out = {}
  let active = false

  for (const { key } of FIELDS) {
    let min = toNumber(raw?.[`${key}Min`])
    let max = toNumber(raw?.[`${key}Max`])
    if (min !== null && max !== null && min > max) [min, max] = [max, min]
    out[`${key}Min`] = min
    out[`${key}Max`] = max
    if (min !== null || max !== null) active = true
  }

  return active ? out : null
}

function inRange(value, min, max) {
  if (min !== null && value < min) return false
  if (max !== null && value > max) return false
  return true
}

/**
 * @param {object} candidate 候选标的（需带 price / marketCap / pe）
 * @param {object|null} filters parseFilters 的返回值
 */
export function passFilter(candidate, filters) {
  if (!filters) return true

  if (filters.priceMin !== null || filters.priceMax !== null) {
    if (!(candidate.price > 0)) return false
    if (!inRange(candidate.price, filters.priceMin, filters.priceMax)) return false
  }

  if (filters.capMin !== null || filters.capMax !== null) {
    if (!(candidate.marketCap > 0)) return false
    if (!inRange(candidate.marketCap, filters.capMin, filters.capMax)) return false
  }

  if (filters.peMin !== null || filters.peMax !== null) {
    // 亏损股与缺数据的标的不参与 PE 区间比较
    if (!(candidate.pe > 0)) return false
    if (!inRange(candidate.pe, filters.peMin, filters.peMax)) return false
  }

  return true
}

/**
 * 排除项：名称里带关键词的直接剔除（ST、退市这类）。
 * 只在用户明确要求时生效，默认不排除任何标的。
 */
export function isExcluded(candidate, exclude) {
  if (!exclude?.length) return false
  const name = String(candidate?.name || '').toUpperCase()
  if (!name) return false
  return exclude.some((k) => {
    const key = String(k || '').toUpperCase()
    return key.length > 0 && name.includes(key)
  })
}

/**
 * 排序口径。默认按证据厚度（分数），其余是用户口头常说的几种。
 * 缺数据的排到最后，不参与比较。
 */
export function sortCandidates(list, sort) {
  const arr = [...list]
  const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback)

  switch (sort) {
    case 'gainers':
      arr.sort((a, b) => num(b.changePct, -999) - num(a.changePct, -999))
      break
    case 'losers':
      arr.sort((a, b) => num(a.changePct, 999) - num(b.changePct, 999))
      break
    case 'capAsc':
      arr.sort((a, b) => num(a.marketCap, Infinity) - num(b.marketCap, Infinity))
      break
    case 'capDesc':
      arr.sort((a, b) => num(b.marketCap, -1) - num(a.marketCap, -1))
      break
    default:
      arr.sort((a, b) => num(b.score, 0) - num(a.score, 0))
  }
  return arr
}

/** 一句话描述当前筛选条件，写进报告和日志 */
export function describeFilters(filters) {
  if (!filters) return ''
  const parts = []
  for (const { key, label, unit } of FIELDS) {
    const min = filters[`${key}Min`]
    const max = filters[`${key}Max`]
    if (min === null && max === null) continue
    if (min !== null && max !== null) parts.push(`${label} ${min}–${max}${unit}`)
    else if (min !== null) parts.push(`${label} ≥ ${min}${unit}`)
    else parts.push(`${label} ≤ ${max}${unit}`)
  }
  return parts.join('｜')
}
