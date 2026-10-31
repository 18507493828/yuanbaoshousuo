/**
 * 在已经拿到的名单上继续收窄 —— 不重新检索。
 *
 * 追问的价值就在这里：名单背后那批网页证据不动，只是换个口径看同一份结果。
 * 重新问一遍 AI 会换一批公司出来，上一轮看到的东西就断了。
 */

const RANGE_KEYS = ['price', 'cap', 'pe']

function inRange(value, min, max) {
  if (min != null && value < min) return false
  if (max != null && value > max) return false
  return true
}

/** 与后端 passFilter 同口径：设了区间就要求有有效数值，亏损/停牌直接排除 */
export function passFilter(c, filters) {
  if (!filters) return true

  if (filters.priceMin != null || filters.priceMax != null) {
    if (!(c.price > 0)) return false
    if (!inRange(c.price, filters.priceMin, filters.priceMax)) return false
  }
  if (filters.capMin != null || filters.capMax != null) {
    if (!(c.marketCap > 0)) return false
    if (!inRange(c.marketCap, filters.capMin, filters.capMax)) return false
  }
  if (filters.peMin != null || filters.peMax != null) {
    if (!(c.pe > 0)) return false
    if (!inRange(c.pe, filters.peMin, filters.peMax)) return false
  }
  return true
}

export function isExcluded(c, exclude) {
  if (!exclude?.length) return false
  const name = String(c.name || '').toUpperCase()
  if (!name) return false
  return exclude.some((k) => {
    const key = String(k || '').toUpperCase()
    return key.length > 0 && name.includes(key)
  })
}

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

function mergeFilters(base, patch) {
  const out = { ...(base || {}) }
  for (const key of RANGE_KEYS) {
    if (patch[`${key}Min`] != null) out[`${key}Min`] = patch[`${key}Min`]
    if (patch[`${key}Max`] != null) out[`${key}Max`] = patch[`${key}Max`]
  }
  return out
}

/**
 * 依次应用追问操作。
 * 筛选条件是累加的（只收紧不放宽）：已经落到名单外的标的不可能在后续步骤里回来。
 *
 * @param {object[]} list 完整候选（按证据厚度排序）
 * @param {object[]} ops 追问操作栈
 * @param {object|null} baseFilters 首次检索时的筛选条件
 */
export function applyOps(list, ops, baseFilters = null) {
  if (!ops?.length) return list

  let out = list
  let filters = baseFilters

  for (const op of ops) {
    if (!op) continue

    if (op.keep?.length) {
      const keep = new Set(op.keep)
      out = out.filter((c) => keep.has(c.code))
    }
    if (op.drop?.length) {
      const drop = new Set(op.drop)
      out = out.filter((c) => !drop.has(c.code))
    }
    if (op.exclude?.length) {
      out = out.filter((c) => !isExcluded(c, op.exclude))
    }
    if (op.filters) {
      filters = mergeFilters(filters, op.filters)
      out = out.filter((c) => passFilter(c, filters))
    }
    if (op.sort) out = sortCandidates(out, op.sort)
    if (op.limit) out = out.slice(0, op.limit)
  }

  return out
}
