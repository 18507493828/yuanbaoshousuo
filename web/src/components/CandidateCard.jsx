import { useEffect, useRef, useState } from 'react'
import { Donut, SiteDots } from './Charts.jsx'
import KLine from './KLine.jsx'
import { fetchAnalyze, fetchKline } from '../api.js'

export const LEVEL = {
  strong: { label: '线索强', cls: 'lv-strong' },
  medium: { label: '线索中', cls: 'lv-medium' },
  weak: { label: '线索弱', cls: 'lv-weak' }
}

const RING_COLOR = { strong: '#cf2b45', medium: '#c08a2a', weak: '#b9c0cb' }

const TIER_TEXT = { A: '权威', B: '媒体', C: '线索' }
const CONF_TEXT = { high: '高', medium: '中', low: '低' }

function siteHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

function fmtPrice(v) {
  return v >= 100 ? v.toFixed(1) : v.toFixed(2)
}

function fmtCap(v) {
  if (v >= 10000) return `${(v / 10000).toFixed(2)} 万亿`
  return `${Math.round(v)} 亿`
}

export default function CandidateCard({ item, index }) {
  // 默认全展开：证据和 K 线都不需要再点一次
  const [open, setOpen] = useState(true)
  const [kOpen, setKOpen] = useState(true)
  const [kLine, setKLine] = useState(null)
  const [kLoading, setKLoading] = useState(false)
  const [kError, setKError] = useState('')
  // 按需 AI 分析：扫描时只提炼前几只，其余的点开再跑
  const [ai, setAi] = useState({ status: 'idle' })
  const loadingRef = useRef(false)
  const aiRef = useRef(false)
  const level = LEVEL[item.level] || LEVEL.weak

  const askAI = () => {
    if (aiRef.current || item.hy4?.ok) return
    aiRef.current = true
    setAi({ status: 'loading' })
    fetchAnalyze({
      scope: 'stock',
      stock: {
        code: item.code,
        market: item.market,
        name: item.name,
        board: item.board,
        industry: item.industry,
        price: item.price,
        changePct: item.changePct,
        pe: item.pe,
        pb: item.pb,
        marketCap: item.marketCap,
        turnover: item.turnover
      },
      messages: item.sites || []
    })
      .then((data) => {
        if (data?.ok) setAi({ status: 'ok', data })
        else if (data?.reason === 'NO_MODEL') setAi({ status: 'off', message: '没有配置模型 Key' })
        else setAi({ status: 'fail', message: data?.message || '模型没有给出结果' })
      })
      .catch((err) => setAi({ status: 'fail', message: err.message }))
      .finally(() => {
        aiRef.current = false
      })
  }

  // 点开证据 = 用户要看这一只，顺手把 AI 分析也拉起来
  const toggleEvidence = () => {
    const next = !open
    setOpen(next)
    if (next) askAI()
  }

  // 挂载即取日 K；失败保留原因，点一下「重试」再取
  useEffect(() => {
    if (!kOpen || kLine || kError || loadingRef.current) return
    loadingRef.current = true
    setKLoading(true)
    fetchKline(item.code, item.market, 120)
      .then((data) => setKLine(data))
      .catch((err) => setKError(err.message || '取 K 线失败'))
      .finally(() => {
        loadingRef.current = false
        setKLoading(false)
      })
  }, [kOpen, kLine, kError, item.code, item.market])

  const toggleKline = () => {
    if (!kOpen && kError) setKError('') // 重新展开时允许再试一次
    setKOpen((v) => !v)
  }

  return (
    <article className={`cand ${level.cls}`}>
      <div className="cand-head">
        <span className="rank">{index + 1}</span>

        <div className="cand-id">
          <h3>
            {item.name || kLine?.name || '名称待补'}
            <span className="code">
              {item.market} {item.code}
            </span>
          </h3>

          <div className="proof">
            {item.industry && <span className="tag-ind">{item.industry}</span>}
            <span>{item.board}</span>
            {item.price > 0 && (
              <span className="proof-quote">
                {fmtPrice(item.price)}
                <i className={item.changePct >= 0 ? 'is-up' : 'is-down'}>
                  {item.changePct >= 0 ? '+' : ''}
                  {item.changePct.toFixed(2)}%
                </i>
              </span>
            )}
            {item.marketCap > 0 && <span>市值 {fmtCap(item.marketCap)}</span>}
            {item.pe > 0 && <span>PE {item.pe.toFixed(1)}</span>}
            {item.pb > 0 && <span>PB {item.pb.toFixed(2)}</span>}
          </div>

          <div className="proof proof-ev">
            <SiteDots sites={item.sites} total={item.siteCount} />
            <span>{item.siteCount} 站点</span>
            {item.aTierCount > 0 && <span className="proof-a">权威 {item.aTierCount}</span>}
            {item.queryCount > 1 && <span>覆盖 {item.queryCount} 条检索</span>}
            {item.latest && <span>最新 {item.latest}</span>}
          </div>
        </div>

        <div className="cand-score">
          <span className={`badge ${level.cls}`}>{level.label}</span>
          <Donut
            size={52}
            thickness={5}
            max={24}
            center={item.score}
            centerClass="donut-score"
            segments={[{ value: item.score, color: RING_COLOR[item.level] || RING_COLOR.weak }]}
          />
        </div>
      </div>

      <div className="signals">
        {item.positives.map((p) => (
          <span className="sig sig-pos" key={p.key} title={p.words.join('、')}>
            {p.key}
          </span>
        ))}
        {item.negatives.map((n) => (
          <span className="sig sig-neg" key={n.key} title={n.words.join('、')}>
            风险 · {n.key}
          </span>
        ))}
      </div>

      {item.hy4?.ok && (
        <div className="hy4">
          <div className="hy4-head">
            {item.hy4.event && <span className="hy4-event">{item.hy4.event}</span>}
            <span className={`hy4-conf c-${item.hy4.confidence}`}>
              置信度 {CONF_TEXT[item.hy4.confidence] || item.hy4.confidence}
            </span>
            <span className="hy4-model">
              {item.hy4.persona?.name && `${item.hy4.persona.name} · `}
              {item.hy4.model}
            </span>
          </div>
          {item.hy4.verdict && <p className="hy4-verdict">{item.hy4.verdict}</p>}
          {item.hy4.points?.length > 0 && (
            <ul className="hy4-list">
              {item.hy4.points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
          {item.hy4.risks?.length > 0 && (
            <ul className="hy4-list hy4-risk">
              {item.hy4.risks.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!item.hy4?.ok && ai.status !== 'idle' && (
        <div className="hy4 hy4-ondemand">
          {ai.status === 'loading' && (
            <div className="ai-loading is-inline">
              <i />
              <span>正在读 {(item.sites || []).length} 条证据与近 120 日走势…</span>
            </div>
          )}
          {(ai.status === 'off' || ai.status === 'fail') && (
            <p className="ai-note">{ai.message || '这只没有分析出来，规则结果照旧看'}</p>
          )}
          {ai.status === 'ok' && ai.data?.analysis && (
            <>
              <div className="hy4-head">
                <span
                  className={`stance ${
                    ai.data.analysis.stance === '偏多'
                      ? 'is-bull'
                      : ai.data.analysis.stance === '偏空'
                        ? 'is-bear'
                        : 'is-flat'
                  }`}
                >
                  {ai.data.analysis.stance}
                </span>
                <span className={`hy4-conf c-${ai.data.analysis.confidence}`}>
                  置信度 {CONF_TEXT[ai.data.analysis.confidence] || ai.data.analysis.confidence}
                </span>
                <span className="hy4-model">
                  按需分析 · {ai.data.persona?.name ? `${ai.data.persona.name} · ` : ''}
                  {ai.data.model}
                </span>
              </div>
              {ai.data.analysis.headline && (
                <p className="hy4-verdict">{ai.data.analysis.headline}</p>
              )}
              {ai.data.analysis.drivers?.length > 0 && (
                <ul className="hy4-list">
                  {ai.data.analysis.drivers.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              )}
              {ai.data.analysis.risks?.length > 0 && (
                <ul className="hy4-list hy4-risk">
                  {ai.data.analysis.risks.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              )}
              {ai.data.analysis.flow && (
                <p className="ai-flow is-tight">
                  <em>价格位置</em>
                  {ai.data.analysis.flow}
                </p>
              )}
            </>
          )}
        </div>
      )}

      <div className="cand-actions">
        <button className={`toggle ${kOpen ? 'is-on' : ''}`} onClick={toggleKline}>
          {kOpen ? '收起 K 线' : kError ? '重试 K 线' : '看 K 线'}
        </button>
        <button className={`toggle ${open ? 'is-on' : ''}`} onClick={toggleEvidence}>
          {open ? '收起证据' : `查看 ${item.sites.length} 条证据`}
        </button>
        {!item.hy4?.ok && ai.status !== 'ok' && (
          <button className="toggle toggle-ai" onClick={askAI}>
            {ai.status === 'loading' ? 'AI 分析中' : 'AI 分析'}
          </button>
        )}
      </div>

      {kOpen && (
        <div className="kline-wrap">
          {kLoading && !kLine && <p className="kline-tip">正在取日 K…</p>}
          {kError && <p className="kline-tip is-err">{kError}</p>}
          {kLine && <KLine data={kLine} />}
        </div>
      )}

      {open && (
        <ul className="evidence">
          {item.sites.map((s) => (
            <li key={s.url || s.title}>
              <a href={s.url} target="_blank" rel="noreferrer">
                {s.title}
              </a>
              <p className="ev-meta">
                {s.site || siteHost(s.url)}｜{s.date || '无日期'}｜
                <em className={`tier t-${s.tier}`}>{TIER_TEXT[s.tier]}</em>
                {s.query && <span className="ev-query">｜{s.query}</span>}
              </p>
              {s.snippet && <p className="ev-snippet">{s.snippet}</p>}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}
