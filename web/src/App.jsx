import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CandidateCard from './components/CandidateCard.jsx'
import StockPanel from './components/StockPanel.jsx'
import { fetchHealth, streamScreen, fetchProfile, fetchRefine } from './api.js'
import { applyOps } from './lib/refine.js'

const PLACEHOLDER = '请输入任何关于股票的内容，我帮你解答'

export default function App() {
  const [health, setHealth] = useState(null)

  // 输入框里的一句话，不再只是一个主题词
  const [query, setQuery] = useState('')

  const [running, setRunning] = useState(false)
  const [plan, setPlan] = useState(null)

  const [candidates, setCandidates] = useState([])
  const [summary, setSummary] = useState(null)
  const [meta, setMeta] = useState(null)
  const [error, setError] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [llm, setLlm] = useState(null)

  // 追问：在已有名单上收窄，不重新检索
  const [ops, setOps] = useState([])
  const [followText, setFollowText] = useState('')
  const [followBusy, setFollowBusy] = useState(false)
  const [followNote, setFollowNote] = useState('')
  const [followError, setFollowError] = useState('')

  // 每发起一次搜索自增，用来判断「这是新的一轮」而不是同一轮的多次更新
  const [runSeq, setRunSeq] = useState(0)

  const abortRef = useRef(null)
  const profiledRef = useRef(new Map())

  useEffect(() => {
    fetchHealth()
      .then(setHealth)
      .catch(() => setHealth({ ok: false, hasKey: false, unreachable: true }))
  }, [])

  const reconnect = useCallback(async () => {
    try {
      const h = await fetchHealth()
      setHealth(h)
      return h?.hasKey
    } catch {
      setHealth({ ok: false, hasKey: false, unreachable: true })
      return false
    }
  }, [])

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setElapsed((v) => v + 1), 1000)
    return () => clearInterval(timer)
  }, [running])

  // 候选一上屏就补名称与行业：名称齐的只补一次，缺名称的再给一次机会
  useEffect(() => {
    const tries = profiledRef.current
    const items = candidates
      .filter((c) => {
        if (!c.code) return false
        const used = tries.get(c.code) || 0
        const needName = !c.name || c.name === c.code
        return needName ? used < 2 : used === 0
      })
      .map((c) => ({ code: c.code, market: c.market }))
    if (!items.length) return
    for (const it of items) tries.set(it.code, (tries.get(it.code) || 0) + 1)

    // 不做 cleanup 取消：候选会随语义提炼多次更新，取消会把这一批结果丢掉
    fetchProfile(items).then((rows) => {
      if (!rows.length) return
      const map = new Map(rows.map((r) => [r.code, r]))
      setCandidates((list) =>
        list.map((c) => {
          const hit = map.get(c.code)
          if (!hit) return c
          const name = hit.name && hit.name !== c.code ? hit.name : c.name
          if (name === c.name && (hit.industry || '') === (c.industry || '')) return c
          return {
            ...c,
            name: name || '',
            industry: hit.industry || c.industry || ''
          }
        })
      )
    })
  }, [candidates])

  const run = useCallback(async () => {
    if (running) return
    const q = query.trim()
    if (!q) {
      setError('先写一句想找什么，例如「近一个月半导体设备里订单大增、市值 100-500 亿的公司」')
      return
    }
    setError('')
    setCandidates([])
    setSummary(null)
    setMeta(null)
    setPlan(null)
    setElapsed(0)
    setLlm(null)
    setOps([])
    setFollowNote('')
    setFollowError('')
    setFollowText('')
    profiledRef.current = new Map()
    setRunSeq((v) => v + 1)
    setRunning(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await streamScreen(
        { query: q },
        {
          signal: controller.signal,
          onPlanStart: () => {},
          onPlan: (payload) => {
            setPlan(payload)
          },
          onMeta: (payload) => {
            // plan 事件已经给了完整结构（带 filters 对象），meta 里的只是回显用的摘要，不要覆盖
            setPlan((prev) => (prev && prev.topic ? prev : payload?.plan || prev))
          },
          onCandidates: (payload) => {
            // 规则结果先上屏，模型结论随后逐条补
            setCandidates(payload.candidates || [])
          },
          onEnrichStart: (payload) => {
            setLlm({
              total: payload.total || 0,
              done: 0,
              model: payload.model || '',
              persona: payload.persona?.name || '',
              failed: 0
            })
          },
          onEnrich: (payload) => {
            setLlm((v) =>
              v ? { ...v, done: v.done + 1, failed: v.failed + (payload.hy4?.ok ? 0 : 1) } : v
            )
            setCandidates((list) =>
              list.map((c) => (c.code === payload.code ? { ...c, hy4: payload.hy4 } : c))
            )
          },
          onDone: (payload) => {
            setCandidates(payload.candidates || [])
            setSummary(payload.summary || null)
            setMeta(payload.meta || null)
            const info = payload.summary?.llm
            setLlm(
              info?.enabled
                ? {
                    total: info.enriched + info.failed,
                    done: info.enriched + info.failed,
                    failed: info.failed,
                    model: info.model,
                    persona: info.persona?.name || ''
                  }
                : null
            )
          }
        }
      )
    } catch (err) {
      if (err?.name === 'AbortError') {
        /* 用户主动停止，不报错 */
      } else if (err instanceof TypeError || /Failed to fetch|NetworkError/i.test(err?.message || '')) {
        setError('连不上后端服务（127.0.0.1:8787）。先运行 npm run dev，等 api 起来后再试。')
      } else {
        setError(err.message || '搜索失败')
      }
    } finally {
      setRunning(false)
      abortRef.current = null
    }
  }, [running, query])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    setRunning(false)
  }, [])

  // 后端没起来时按钮不该是死的：先重连一次，通了就直接搜
  const startOrReconnect = useCallback(async () => {
    if (health?.hasKey) {
      run()
      return
    }
    const ok = await reconnect()
    if (ok) run()
  }, [health, reconnect, run])

  const askFollow = useCallback(async () => {
    const q = followText.trim()
    if (!q || followBusy || !candidates.length) return
    setFollowBusy(true)
    setFollowError('')
    try {
      const result = await fetchRefine({ query: q, plan, candidates })
      if (!result?.ops) {
        setFollowError(result?.note || '没听懂要改什么，换个说法试试')
        return
      }
      setOps((prev) => [...prev, result.ops])
      setFollowNote(result.note || '已按你的要求收窄')
      setFollowText('')
    } catch (err) {
      setFollowError(err.message || '追问失败')
    } finally {
      setFollowBusy(false)
    }
  }, [followText, followBusy, candidates, plan])

  const undoFollow = useCallback(() => {
    setOps((prev) => {
      const next = prev.slice(0, -1)
      if (!next.length) {
        setFollowNote('')
        setFollowError('')
      }
      return next
    })
  }, [])

  const visible = useMemo(
    () => applyOps(candidates, ops, plan?.filters || null),
    [candidates, ops, plan]
  )

  // 个股模式：一句话锁定了一只票，页面换成「个股面板」而不是候选名单
  const focusMode = (meta?.mode || plan?.mode) === 'stock'
  const focusItem = focusMode ? visible[0] : null
  const personaKey = plan?.persona || 'master'

  const healthText =
    health === null
      ? '连接中'
      : health.unreachable
        ? '后端未连接 · 127.0.0.1:8787'
        : health.hasKey
          ? `搜索已就绪 · ${health.authLabel}${health.llm?.enabled ? ` · ${health.llm.model}` : ' · 规则引擎'}`
          : '未配置 API Key'

  return (
    <div className="page">
      <header className="hdr">
        <div className="brand">
          <span className="mark">S</span>
          <div className="brand-text">
            <h1>StockLens</h1>
            <span>选股线索台</span>
          </div>
        </div>
        <div className={`status ${health?.hasKey ? 'is-ok' : health ? 'is-warn' : ''}`}>
          <i />
          {healthText}
        </div>
      </header>

      <section className="console">
        <div className="ask">
          <div className="ask-box">
            <input
              className="ask-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') run()
              }}
              placeholder={PLACEHOLDER}
              maxLength={200}
              aria-label="搜索需求"
            />
            {query && (
              <button className="ask-clear" onClick={() => setQuery('')} title="清空">
                ×
              </button>
            )}
          </div>
          {running ? (
            <button className="run is-stop" onClick={stop}>
              停止 · {elapsed}s
            </button>
          ) : (
            <button className="run" onClick={startOrReconnect} disabled={health === null}>
              {health === null
                ? '连接中'
                : health.unreachable
                  ? '重新连接'
                  : health.hasKey
                    ? '元宝搜索'
                    : '未配置 Key'}
            </button>
          )}
        </div>
        <p className="source">数据来源：元宝搜索（腾讯云 WSA）</p>
      </section>

      {error && <p className="alert">{error}</p>}

      <main className="results">
        {llm && (
          <p className={`llm ${llm.done >= llm.total ? 'is-done' : ''}`}>
            <i />
            {llm.done < llm.total
              ? `${llm.model}${llm.persona ? ` × ${llm.persona}` : ''} 正在提炼语义 ${llm.done}/${llm.total}`
              : `${llm.model}${llm.persona ? ` × ${llm.persona}` : ''} 已提炼 ${llm.total - llm.failed}/${llm.total}${
                  llm.failed > 0 ? `，${llm.failed} 个退回规则结果` : ''
                }`}
          </p>
        )}

        {candidates.length > 0 && !running && !focusMode && (
          <section className="follow">
            <div className="follow-row">
              <input
                className="follow-input"
                value={followText}
                onChange={(e) => setFollowText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') askFollow()
                }}
                placeholder="继续追问，在现有名单上收窄 — 如：只看市值 200 亿以下的、排除 ST、按涨幅排"
                maxLength={120}
                aria-label="继续追问"
              />
              <button className="follow-run" onClick={askFollow} disabled={followBusy || !followText.trim()}>
                {followBusy ? '解析中' : '收窄'}
              </button>
            </div>
            {(followNote || ops.length > 0) && (
              <div className="follow-state">
                <span>
                  已按「{followNote || '你的要求'}」收窄，当前{' '}
                  <b>
                    {visible.length}/{candidates.length}
                  </b>{' '}
                  只
                </span>
                <button className="follow-undo" onClick={undoFollow}>
                  撤销
                </button>
              </div>
            )}
            {followError && <p className="follow-err">{followError}</p>}
          </section>
        )}

        {focusItem && (
          <StockPanel key={runSeq} item={focusItem} persona={personaKey} runKey={runSeq} />
        )}

        {!focusMode && visible.length > 0 && (
          <div className="list">
            {visible.map((c, i) => (
              <CandidateCard key={c.code} item={c} index={i} />
            ))}
          </div>
        )}

        {!running && summary && !candidates.length && (
          <section className="blank">
            <h3>这一组检索式没有命中带信号的标的</h3>
            <p>
              把要求写得更具体一些再搜一次，例如加一个细分环节（「半导体设备」换成「刻蚀设备」），
              或者放宽筛选条件（去掉市值、PE 的区间）。
            </p>
          </section>
        )}

        {!running && candidates.length > 0 && !visible.length && (
          <section className="blank">
            <h3>追加条件后没有剩下的标的</h3>
            <p>名单本身有 {candidates.length} 只，是追问的条件把它们全筛掉了。点「撤销」回到上一版。</p>
          </section>
        )}
      </main>
    </div>
  )
}
