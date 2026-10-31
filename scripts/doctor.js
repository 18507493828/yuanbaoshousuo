/**
 * 联通性自检：真实发起一次 SearchPro 调用，确认密钥、网络、返回结构都正常。
 * 用法：
 *   npm run doctor
 *   npm run doctor -- "要检索的词"
 *
 * 会消耗 1 次调用额度。
 */

import 'dotenv/config'
import { searchPro, authMode, authLabel } from '../server/lib/wsa.js'
import { hy4Enabled, hy4Model, enrichCandidate } from '../server/lib/hy4.js'
import { DEFAULT_PERSONA, PERSONAS, getPersona } from '../server/lib/personas.js'

const argv = process.argv.slice(2)
const personaArg = argv.find((a) => a.startsWith('--persona='))
const personaKey = personaArg ? personaArg.split('=')[1] : process.env.HY4_PERSONA || DEFAULT_PERSONA
const role = getPersona(personaKey)
const query = argv.filter((a) => !a.startsWith('--')).join(' ').trim() || '元宝搜索'
const mode = authMode()

console.log('──────── StockLens 联通性自检 ────────')
console.log(`鉴权方式：${authLabel()}`)
console.log(`检索词　：${query}`)

if (mode === 'none' || mode === 'tc3-incomplete') {
  console.error('\n密钥不完整，先补齐 .env：')
  console.error('  WSA_API_KEY=sk-xxxx                    （服务 API KEY，推荐）')
  console.error('  或 WSA_SECRET_ID + WSA_SECRET_KEY      （TC3 签名）')
  process.exit(1)
}

try {
  const result = await searchPro({ query, mode: 2, cnt: 10 })
  console.log(`结果　　：HTTP 成功｜版本 ${result.version || '—'}｜耗时 ${result.elapsedMs}ms`)
  console.log(`RequestId：${result.requestId || '—'}`)
  console.log(`返回条数：${result.pages.length}`)

  if (!result.pages.length) {
    console.log('\n调用通了，但没返回结果。换个更常见的检索词再试。')
    process.exit(0)
  }

  result.pages.slice(0, 3).forEach((page, i) => {
    console.log(`\n${i + 1}. ${page.title || '(无标题)'}`)
    console.log(`   ${page.site || '未知站点'}｜${page.date || '无日期'}｜score ${page.score ?? '—'}`)
    console.log(`   ${(page.passage || '').slice(0, 80)}`)
  })

  console.log('\n本次消耗 1 次调用额度。')
} catch (err) {
  console.error(`\n失败 [${err.code || 'UNKNOWN'}] ${err.message}`)
  if (err.code === 'AuthFailure' || err.code === 'AuthFailure_SignatureExpire') {
    console.error('提示：签名相关错误多为 SecretKey 不匹配，或本机时间与标准时间偏差超过 5 分钟。')
  }
  if (err.code === 'ResourceNotFound') {
    console.error('提示：需要先在腾讯云控制台开通元宝搜索服务。')
  }
  if (err.code === 'NO_API_KEY') {
    console.error('提示：.env 里还没有可用的密钥。')
  }
  process.exit(1)
}

// 语义层自检：只验证「能不能调通、能不能解析出 JSON」，不给真实数据
if (hy4Enabled()) {
  console.log(`\n──────── 语义提炼自检（${hy4Model()} × ${role.name}）────────`)
  if (personaKey && !PERSONAS.some((p) => p.key === personaKey)) {
    console.log(`提示：没有 ${personaKey} 这个角色，已退回 ${role.name}。可选：${PERSONAS.map((p) => p.key).join(' / ')}`)
  }
  try {
    const r = await enrichCandidate(
      {
        code: '000001',
        name: '样例标的',
        board: '主板',
        positives: [{ key: '业绩预增' }],
        negatives: [],
        sites: [
          {
            site: '样例站点',
            date: '2026-10-01',
            tier: 'B',
            title: '样例：三季报净利润同比增长',
            snippet:
              '公司三季报净利润同比增长 58%，在手订单 12.3 亿元，同时提示原材料价格上行压力。'
          }
        ]
      },
      { persona: role.key }
    )
    if (r?.ok) {
      console.log(`调用成功｜耗时 ${r.elapsedMs}ms｜置信度 ${r.confidence}`)
      console.log(`事件：${r.event || '—'}`)
      console.log(`结论：${r.verdict || '—'}`)
      console.log(`事实：${r.points.join('；') || '—'}`)
      console.log(`风险：${r.risks.join('；') || '—'}`)
      console.log(`换角色看差异：npm run doctor -- --persona=risk`)
    } else {
      console.error(`调用通了，但返回内容不是可解析的 JSON：${r?.error || '未知原因'}`)
      if (r?.raw) console.error(`原文片段：${r.raw}`)
      console.error('提示：检查 HY4_MODEL 是否写对，或该模型是否支持 JSON 输出。')
    }
  } catch (err) {
    console.error(`失败 [${err.code || 'UNKNOWN'}] ${err.message}`)
    if (err.code === 'HTTP_ERROR') {
      console.error('提示：检查 HY4_BASE_URL 与 HY4_MODEL 是否与控制台一致。')
    }
  }
} else {
  console.log('\n语义提炼未启用（.env 里没有 HY4_API_KEY），扫描将只走本地规则。')
}
