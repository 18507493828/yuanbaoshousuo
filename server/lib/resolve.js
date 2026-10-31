/**
 * 从一句话里认出「用户说的是哪一只股票」。
 *
 * 有了这一层，「请分析中国中免」就不用再当成行业词去铺一堆检索式：
 * 直接锁定 601888，检索式换成围绕这只票的公告、财报、机构、风险、行业地位，
 * 返回的每一条消息都能归到同一只票上。
 *
 * 识别顺序：
 *   1. 句子里有 6 位代码 → 直接按代码定；
 *   2. 去掉「帮我分析下…怎么样」这类口水词，把剩下的中文串丢给腾讯的联想接口，
 *      只认 A 股（GP-A），并且要求名称与原句能对上，避免把行业词认成个股。
 *
 * 认不出来就返回 null，调用方照旧走行业检索，不影响原有流程。
 */

import { classifyCode } from './extract.js'

const SUGGEST_URL = 'https://smartbox.gtimg.cn/s3/'
const TIMEOUT_MS = 3500
const TTL = 30 * 60 * 1000

const cache = new Map()

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36'

/** 长词放前面，避免「怎么样」被「怎么」先吃掉一半 */
const NOISE = [
  '怎么样', '怎么办', '怎么看', '能买吗', '可以买吗', '值得买吗', '值不值', '分析一下', '分析下',
  '研究一下', '点评一下', '解读一下', '看一下', '看下', '看看', '说说', '讲讲', '聊聊', '介绍下',
  '介绍一下', '梳理一下', '判断一下', '评估一下', '帮我', '帮忙', '麻烦', '请', '分析', '研究',
  '点评', '解读', '介绍', '梳理', '判断', '评估', '如何', '怎么', '值得', '现在', '目前', '最近',
  '近期', '今天', '明天', '后市', '走势', '行情', '估值', '基本面', '消息', '情况', '最新', '一下',
  '这只', '那个', '个股', '股票', '股价', '多少', '能买', '买入', '卖出', '持有', '加仓', '减仓',
  '的', '吗', '呢', '吧', '啊', '呀', '么'
]

const NOISE_RE = new RegExp(NOISE.join('|'), 'g')

/** 去掉口水词和标点，只留下可能是公司名的部分 */
export function cleanQuery(text) {
  return String(text || '')
    .replace(NOISE_RE, ' ')
    .replace(/[，。！？、；：,.!?;:（）()【】\[\]"'“”‘’《》\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 联想接口返回的是 \uXXXX 转义文本，先还原成中文 */
function unescapeUnicode(text) {
  return String(text || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  )
}

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
  if (cache.size > 500) cache.clear()
  cache.set(key, { at: Date.now(), value })
}

/**
 * 一条联想请求。返回 [{market,code,name,type}]，失败返回空数组。
 * 数据结构：v_hint="sh~601888~中国中免~zgzm~GP-A^hk~01880~中国中免~zgzm~GP"
 */
async function suggest(keyword) {
  const hit = cacheGet(keyword)
  if (hit) return hit

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let rows = []
  try {
    const res = await fetch(`${SUGGEST_URL}?q=${encodeURIComponent(keyword)}&t=all`, {
      signal: controller.signal,
      headers: { 'user-agent': UA, referer: 'https://gu.qq.com/' }
    })
    if (res.ok) {
      const text = unescapeUnicode(await res.text())
      const body = text.match(/v_hint="([^"]*)"/)?.[1] || ''
      rows = body
        .split('^')
        .map((seg) => {
          const p = seg.split('~')
          if (p.length < 5) return null
          return {
            market: p[0].toLowerCase(),
            code: p[1],
            name: p[2],
            type: p[4] || ''
          }
        })
        .filter(Boolean)
    }
  } catch {
    rows = []
  } finally {
    clearTimeout(timer)
  }

  cacheSet(keyword, rows)
  return rows
}

/** 从联想结果里挑一只 A 股：名称要能和原句对上，宁可认不出也不乱认 */
function pick(clean, rows) {
  const aShares = rows.filter((r) => /^GP-A/.test(r.type) && /^\d{6}$/.test(r.code))
  if (!aShares.length) return null

  const exact = aShares.find((r) => r.name === clean)
  if (exact) return exact

  // 原句里带着完整名称，例如「中国中免还有机会吗」
  const inside = aShares
    .filter((r) => r.name.length >= 2 && clean.includes(r.name))
    .sort((a, b) => b.name.length - a.name.length)[0]
  if (inside) return inside

  // 用户只写了简称，例如「茅台」「宁德」；只有一个候选时才认，多个候选说明有歧义
  const reverse = aShares.filter((r) => r.name.length >= 2 && r.name.includes(clean))
  if (reverse.length === 1) return reverse[0]
  if (reverse.length > 1) {
    const shortest = reverse.slice().sort((a, b) => a.name.length - b.name.length)[0]
    // 只有一个名称以它开头，说明这个简称基本无歧义
    const heads = reverse.filter((r) => r.name.startsWith(clean))
    if (heads.length === 1) return heads[0]
    return shortest.name.length === clean.length + 1 ? shortest : null
  }

  return null
}

/**
 * 识别句子里指向的个股。
 * @param {string} query
 * @returns {Promise<{code:string,market:'SH'|'SZ'|'BJ',board:string,name:string,via:'code'|'name'}|null>}
 */
export async function resolveStock(query) {
  const text = String(query || '').trim()
  if (!text) return null

  // 1. 显式代码
  const codeHit = text.match(/(?<!\d)(\d{6})(?!\d)/)
  if (codeHit) {
    const hit = classifyCode(codeHit[1])
    if (hit) return { ...hit, name: '', via: 'code' }
  }

  // 2. 名称联想
  const clean = cleanQuery(text)
  if (!clean || clean.length > 14) return null

  for (const run of clean.split(' ').filter(Boolean).slice(0, 2)) {
    if (run.length < 2 || run.length > 10) continue
    if (!/^[\u4e00-\u9fa5A-Za-z]+$/.test(run)) continue

    const rows = await suggest(run)
    const hit = pick(run, rows)
    if (!hit) continue

    const cls = classifyCode(hit.code)
    if (!cls) continue
    return { ...cls, name: hit.name, via: 'name' }
  }

  return null
}
