import { useCallback, useEffect, useRef, useState } from 'react'
import KLine from './KLine.jsx'
import { fetchAnalyze, fetchKline } from '../api.js'

/**
 * 个股面板：一句话锁定某只票时用它替代候选列表。
 *
 * 三块内容：
 *   1. 行情 + 日 K，先看清价格在哪
 *   2. AI 综合研判：消息面（多空依据、跟踪项）＋ 价格位置，自动跑一次
 *   3. 相关消息列表：点开某一条时才调模型解读这一条，不点不花钱
 */

const CONF_TEXT = { high: '高', medium: '中', low: '低' }
const TIER_TEXT = { A: '权威', B: '媒体', C: '线索' }

const IMPACT_CLS = {
  利好: 'is-bull',
  利空: 'is-bear',
  中性: 'is-flat',
  难以判断: 'is-flat'
}

function fmtCap(v) {
  if (!v) return '—'
  if (v >= 10000) return `${(v / 10000).toFixed(2)} 万亿`
  return `${Math.round(v)} 亿`
}

function fmtPrice(v) {
  if (!v) return '—'
  return v >= 100 ? v.toFixed(1) : v.toFixed(2)
}

function slimStock(item) {
  return {
    code: item.code,
    market: item.market,
    name: item.name || '',
    board: item.board || '',
    industry: item.industry || '',
    price: item.price || 0,
    changePct: item.changePct || 0,
    pe: item.pe || 0,
    pb: item.pb || 0,
    marketCap: item.marketCap || 0,
    turnover: item.turnover || 0
  }
}

function MsgAI({ state }) {
  if (!state || state.status === 'idle') return null
  if (state.status === 'loading') {
    return (
      <div className="ai-loading is-inline">
        <i />
        <span>正在解读这一条…</span>
      </div>
    )
  }
  if (state.status === 'off' || state.status === 'fail') {
    return <p className="ai-note">{state.message || '这条没解读成功'}</p>
  }

  const a = state.data?.analysis
  if (!a) return null

  return (
    <div className="msg-ai">
      <div className="msg-ai-head">
        <span className={`impact ${IMPACT_CLS[a.impact] || 'is-flat'}`}>{a.impact}</span>
        <span className="impact-strength">力度 {a.strength}</span>
        <span className={`hy4-conf c-${a.confidence}`}>置信度 {CONF_TEXT[a.confidence] || a.confidence}</span>
        <span className="hy4-model">{state.data?.model}</span>
      </div>
      {a.gist && <p className="msg-ai-gist">{a.gist}</p>}
      {a.figures?.length > 0 && (
        <div className="msg-figs">
          {a.figures.map((f, i) => (
            <span key={i}>{f}</span>
          ))}
        </div>
      )}
      {a.path && (
        <p className="msg-ai-line">
          <em>影响路径</em>
          {a.path}
        </p>
      )}
      {a.verify?.length > 0 && (
        <p className="msg-ai-line">
          <em>待核对</em>
          {a.verify.join('、')}
        </p>
      )}
    </div>
  )
}

function StockAI({ state, count, onRetry }) {
  if (!state || state.status === 'idle') return null

  if (state.status === 'loading') {
    return (
      <div className="ai-loading">
        <i />
        <span>正在读 {count} 条消息与近 120 日走势…</span>
        <span className="ai-loading-bar" />
      </div>
    )
  }

  if (state.status === 'off' || state.status === 'fail') {
    return (
      <div className="ai-fallback">
        <p>{state.message || '这次没生成出研判'}</p>
        {state.status === 'fail' && (
          <button className="ghost is-mini" onClick={onRetry}>
            重试
          </button>
        )}
      </div>
    )
  }

  const a = state.data?.analysis
  if (!a) return null
  const stanceCls = a.stance === '偏多' ? 'is-bull' : a.stance === '偏空' ? 'is-bear' : 'is-flat'

  return (
    <div className="stock-ai-body">
      <div className="ai-head">
        <span className={`stance ${stanceCls}`}>{a.stance}</span>
        <span className={`hy4-conf c-${a.confidence}`}>置信度 {CONF_TEXT[a.confidence] || a.confidence}</span>
        <span className="hy4-model">
          {state.data?.persona?.name ? `${state.data.persona.name} · ` : ''}
          {state.data?.model}
        </span>
      </div>

      {a.headline && <p className="ai-headline">{a.headline}</p>}

      <div className="ai-cols">
        <div className="ai-col">
          <span className="ai-col-t is-bull">支撑</span>
          {a.drivers?.length ? (
            <ul>
              {a.drivers.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          ) : (
            <p className="ai-empty">材料里没有明确的利好事实</p>
          )}
        </div>
        <div className="ai-col">
          <span className="ai-col-t is-bear">风险</span>
          {a.risks?.length ? (
            <ul>
              {a.risks.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          ) : (
            <p className="ai-empty">材料里没有明确的风险点</p>
          )}
        </div>
      </div>

      {a.flow && (
        <p className="ai-flow">
          <em>价格位置</em>
          {a.flow}
        </p>
      )}

      {a.watch?.length > 0 && (
        <div className="ai-watch">
          <span className="ai-col-t">接下来盯</span>
          {a.watch.map((w, i) => (
            <span key={i} className="watch-chip">
              {w}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default function StockPanel({ item, persona, runKey }) {
  const [kline, setKline] = useState(null)
  const [kError, setKError] = useState('')
  const [ai, setAi] = useState({ status: 'idle' })
  const [open, setOpen] = useState(-1)
  const [msgAi, setMsgAi] = useState({})
  const askedRef = useRef('')

  const messages = item.messages || []
  const up = (item.changePct || 0) >= 0

  // 个股研判：进场就跑一次；同一只票不重复跑
  const runStockAI = useCallback(() => {
    setAi({ status: 'loading' })
    fetchAnalyze({
      scope: 'stock',
      stock: slimStock(item),
      messages: messages.slice(0, 12),
      persona
    })
      .then((data) => {
        if (data?.ok) setAi({ status: 'ok', data })
        else if (data?.reason === 'NO_MODEL')
          setAi({ status: 'off', message: '没有配置模型 Key，这一块需要 HY4_API_KEY' })
        else setAi({ status: 'fail', message: data?.message || '模型没有给出结果' })
      })
      .catch((err) => setAi({ status: 'fail', message: err.message }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.code, persona, messages.length])

  useEffect(() => {
    setKline(null)
    setKError('')
    fetchKline(item.code, item.market, 120)
      .then(setKline)
      .catch((err) => setKError(err.message || '取 K 线失败'))
  }, [item.code, item.market])

  useEffect(() => {
    const key = `${runKey}-${item.code}`
    if (askedRef.current === key) return
    askedRef.current = key
    setOpen(-1)
    setMsgAi({})
    if (messages.length) runStockAI()
  }, [runKey, item.code, messages.length, runStockAI])

  const toggleMessage = (index) => {
    if (open === index) {
      setOpen(-1)
      return
    }
    setOpen(index)

    const prev = msgAi[index]
    if (prev && prev.status !== 'fail') return

    const m = messages[index]
    setMsgAi((v) => ({ ...v, [index]: { status: 'loading' } }))
    fetchAnalyze({
      scope: 'message',
      stock: slimStock(item),
      message: m,
      persona
    })
      .then((data) => {
        if (data?.ok) setMsgAi((v) => ({ ...v, [index]: { status: 'ok', data } }))
        else if (data?.reason === 'NO_MODEL')
          setMsgAi((v) => ({ ...v, [index]: { status: 'off', message: '没有配置模型 Key' } }))
        else
          setMsgAi((v) => ({
            ...v,
            [index]: { status: 'fail', message: data?.message || '这条没解读成功' }
          }))
      })
      .catch((err) =>
        setMsgAi((v) => ({ ...v, [index]: { status: 'fail', message: err.message } }))
      )
  }

  return (
    <section className="stock">
      <header className="stock-hd">
        <div className="stock-id">
          <h2>
            {item.name || '名称待补'}
            <span className="code">
              {item.market} {item.code}
            </span>
          </h2>
          <div className="stock-tags">
            {item.industry && <span className="tag-ind">{item.industry}</span>}
            {item.board && <span>{item.board}</span>}
            <span>{messages.length} 条消息</span>
            <span>{item.siteCount} 个站点</span>
            {item.latest && <span>最新 {item.latest}</span>}
          </div>
        </div>

        <div className="stock-quote">
          <div className="quote-main">
            <strong className={up ? 'is-up' : 'is-down'}>{fmtPrice(item.price)}</strong>
            <span className={up ? 'is-up' : 'is-down'}>
              {up ? '+' : ''}
              {(item.changePct || 0).toFixed(2)}%
            </span>
          </div>
          <dl>
            <div>
              <dt>总市值</dt>
              <dd>{fmtCap(item.marketCap)}</dd>
            </div>
            <div>
              <dt>PE(TTM)</dt>
              <dd>{item.pe > 0 ? item.pe.toFixed(1) : '—'}</dd>
            </div>
            <div>
              <dt>PB</dt>
              <dd>{item.pb > 0 ? item.pb.toFixed(2) : '—'}</dd>
            </div>
            <div>
              <dt>换手</dt>
              <dd>{item.turnover > 0 ? `${item.turnover.toFixed(2)}%` : '—'}</dd>
            </div>
          </dl>
        </div>
      </header>

      <div className="stock-body">
        <div className="stock-chart">
          <div className="sec-title">近 120 个交易日</div>
          {kError && <p className="kline-tip is-err">{kError}</p>}
          {!kline && !kError && <p className="kline-tip">正在取日 K…</p>}
          {kline && <KLine data={kline} />}
        </div>

        <div className="stock-ai">
          <div className="sec-title">
            AI 研判
            <em>消息面 × 价格位置</em>
          </div>
          <StockAI state={ai} count={Math.min(messages.length, 12)} onRetry={runStockAI} />
        </div>
      </div>

      <div className="stock-msgs">
        <div className="sec-title">
          相关消息
          <em>点开任意一条，一边看原文摘要，一边看这条消息的 AI 解读</em>
        </div>

        {messages.length === 0 && (
          <p className="kline-tip">这一轮没检索到消息，换个说法再搜一次试试。</p>
        )}

        <ul className="msg-list">
          {messages.map((m, i) => {
            const isOpen = open === i
            return (
              <li key={m.url || `${m.title}-${i}`} className={`msg ${isOpen ? 'is-open' : ''}`}>
                <button className="msg-head" onClick={() => toggleMessage(i)}>
                  <span className={`msg-dot t-${m.tier}`} />
                  <span className="msg-title">{m.title}</span>
                  <span className="msg-meta">
                    {m.site || '未知站点'}｜{m.date || '无日期'}
                  </span>
                  <span className={`tier t-${m.tier}`}>{TIER_TEXT[m.tier] || '线索'}</span>
                  <span className="msg-chev">{isOpen ? '收起' : '展开'}</span>
                </button>

                {isOpen && (
                  <div className="msg-body">
                    {m.snippet ? (
                      <p className="msg-snippet">{m.snippet}</p>
                    ) : (
                      <p className="msg-snippet is-empty">这条只有标题，抓到的正文是空的。</p>
                    )}
                    <div className="msg-foot">
                      {m.url && (
                        <a href={m.url} target="_blank" rel="noreferrer">
                          看原文 ↗
                        </a>
                      )}
                      {m.query && <span>来自检索：{m.query}</span>}
                    </div>
                    <MsgAI state={msgAi[i]} />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
