/**
 * 把一次选股扫描渲染成 Markdown 报告。
 * 报告是给人看的，每条结论都要能点回原文。
 */

import { LEVEL_META } from './score.js'
import { TIER_LABEL } from './trust.js'

const ENGINE_LABEL = '元宝搜索 · 公开信息聚合'

function fmtDate(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function cell(text) {
  return String(text || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

export function buildReport({ candidates, summary, meta, startedAt }) {
  const lines = []
  const levels = summary?.levels || { strong: 0, medium: 0, weak: 0 }

  lines.push('# 选股线索报告')
  lines.push('')
  lines.push(`生成时间：${fmtDate(startedAt || Date.now())}`)
  lines.push(`信息源：${ENGINE_LABEL}`)
  lines.push(`策略：${meta?.strategyName || '—'}｜主题：${meta?.topic || '—'}`)
  lines.push(
    `规模：${meta?.queries || 0} 条检索式｜筛出 ${candidates.length} 个标的｜耗时 ${((summary?.elapsedMs || 0) / 1000).toFixed(1)}s`
  )
  lines.push(
    `线索分布：强 ${levels.strong}｜中 ${levels.medium}｜弱 ${levels.weak}`
  )
  if (meta?.filters) {
    lines.push(`筛选条件：${meta.filters}`)
  }
  if (summary?.llm?.enabled) {
    const role = summary.llm.persona?.name ? `${summary.llm.persona.name} · ` : ''
    lines.push(
      `语义提炼：${role}${summary.llm.model}｜${summary.llm.enriched} 个标的${
        summary.llm.failed ? `｜${summary.llm.failed} 个失败已退回规则结果` : ''
      }`
    )
  }

  const industries = [...new Set(candidates.map((c) => c.industry).filter(Boolean))]
  if (industries.length) {
    lines.push(`行业覆盖：${industries.length} 个（${industries.join('、')}）`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')

  lines.push('## 一、候选清单')
  lines.push('')
  if (!candidates.length) {
    lines.push('本次没有筛出符合条件的标的。可以换一个策略、放宽主题词，或补充自定义条件后重跑。')
  } else {
    lines.push('| # | 代码 | 名称 | 行业 | 板块 | 线索 | 得分 | 信源数 | 最新信源 | 主要信号 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    candidates.forEach((c, i) => {
      const label = LEVEL_META[c.level]?.label || c.level
      const sig = c.positives.map((p) => p.key).join('、') || '—'
      const warn = c.negatives.length ? `（风险：${c.negatives.map((n) => n.key).join('、')}）` : ''
      lines.push(
        `| ${i + 1} | ${c.code} | ${cell(c.name || c.code)} | ${cell(c.industry) || '—'} | ${c.board} | ${label} | ${c.score} | ${c.siteCount} | ${c.latest || '—'} | ${cell(sig + warn)} |`
      )
    })
  }
  lines.push('')
  lines.push('## 二、逐条证据')
  lines.push('')

  candidates.forEach((c, i) => {
    const label = LEVEL_META[c.level]?.label || c.level
    lines.push(`### ${i + 1}. ${c.name || c.code}（${c.market} ${c.code}）｜${label}｜${c.score} 分`)
    lines.push('')
    lines.push(
      c.industry ? `- 行业：${c.industry}｜板块：${c.board}` : `- 板块：${c.board}`
    )

    const quoteBits = []
    if (c.price > 0) {
      quoteBits.push(`股价 ${c.price}（${c.changePct >= 0 ? '+' : ''}${c.changePct}%）`)
    }
    if (c.marketCap > 0) quoteBits.push(`总市值 ${c.marketCap} 亿`)
    if (c.pe > 0) quoteBits.push(`PE ${c.pe}`)
    if (c.pb > 0) quoteBits.push(`PB ${c.pb}`)
    if (quoteBits.length) lines.push(`- 行情：${quoteBits.join('｜')}`)
    lines.push(
      `- 信源：${c.siteCount} 个独立站点，其中权威来源 ${c.aTierCount} 个${
        c.queryCount ? `｜覆盖 ${c.queryCount} 条检索式` : ''
      }`
    )
    lines.push(`- 最新信源：${c.latest || '未标注日期'}`)
    if (c.positives.length) {
      lines.push(
        `- 正面信号：${c.positives.map((p) => `${p.key}（${p.words.join('、')}）`).join('；')}`
      )
    }
    if (c.negatives.length) {
      lines.push(
        `- 风险信号：${c.negatives.map((p) => `${p.key}（${p.words.join('、')}）`).join('；')}`
      )
    }
    if (c.hy4?.ok) {
      const tag = c.hy4.event ? `事件：${cell(c.hy4.event)}｜` : ''
      const who = c.hy4.persona?.name ? `${c.hy4.persona.name} · ` : ''
      lines.push(`- 语义提炼：${who}${tag}置信度 ${c.hy4.confidence}`)
      if (c.hy4.verdict) lines.push(`- 一句话结论：${cell(c.hy4.verdict)}`)
      if (c.hy4.points?.length) {
        lines.push(`- 摘要中的事实：${c.hy4.points.map((p) => cell(p)).join('；')}`)
      }
      if (c.hy4.risks?.length) {
        lines.push(`- 摘要中的风险：${c.hy4.risks.map((p) => cell(p)).join('；')}`)
      }
    }
    lines.push('')
    c.sites.forEach((s, j) => {
      lines.push(`${j + 1}. **${cell(s.title)}**`)
      lines.push(
        `   ${s.site || '未知站点'}｜${s.date || '无日期'}｜${TIER_LABEL[s.tier] || s.tier}｜[原文](${s.url})`
      )
      if (s.snippet) lines.push(`   > ${cell(s.snippet)}`)
      lines.push('')
    })
  })

  if (meta?.queryList?.length) {
    lines.push('## 三、本次使用的检索式')
    lines.push('')
    meta.queryList.forEach((q, i) => {
      lines.push(`${i + 1}. ${q.label}：\`${q.query}\``)
    })
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(
    '本报告由元宝搜索返回的公开网页信息聚合而成，仅用于信息检索与研究，不构成任何投资建议。'
  )
  lines.push(
    '信号来自媒体标题与摘要的关键词命中，未核实公告原文与财务数据；据此决策前请自行查阅上市公司公告。'
  )
  lines.push('')

  return lines.join('\n')
}
