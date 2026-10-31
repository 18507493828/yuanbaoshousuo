/**
 * 元宝搜索（Tencent Yuanbao Search / wsa）客户端
 *
 * 支持两种鉴权，按 .env 里配了哪组自动选：
 *  1) API KEY  → POST https://api.wsa.cloud.tencent.com/SearchPro   （Authorization: Bearer sk-xxx，不签名）
 *  2) SecretId + SecretKey → POST https://wsa.tencentcloudapi.com/  （TC3-HMAC-SHA256 签名）
 *
 * 官方文档：https://cloud.tencent.com/document/product/1806/121811
 */

import { buildTc3Request } from './tc3.js'

const VERSION = '2025-05-08'
const ACTION = 'SearchPro'
const MAX_QUERY_BYTES = 1500
const CNT_STEPS = [10, 20, 30, 40, 50]

const APIKEY_ENDPOINT = 'https://api.wsa.cloud.tencent.com/SearchPro'
const TC3_HOST = 'wsa.tencentcloudapi.com'

const ERROR_TEXT = {
  InvalidParameter: '检索参数不合法（常见原因：Query 为空或超长、Cnt 不在 10/20/30/40/50 之内、Freshness 格式错误）',
  RequestLimitExceeded: '触发频率限制，请降低并发或稍后重试',
  ResourceNotFound: '该账号未开通元宝搜索服务，请先在腾讯云控制台开通',
  ResourceUnavailable: '元宝搜索服务当前不可用',
  UnauthorizedOperation: '密钥无权限或已失效，请检查 SecretId/SecretKey 或服务 API KEY',
  AuthFailure: '签名校验失败，常见原因是 SecretKey 不匹配或本机时间偏差超过 5 分钟',
  AuthFailure_SignatureExpire: '签名已过期，请检查本机系统时间',
  InternalError: '服务端内部错误，可稍后重试'
}

export class WsaError extends Error {
  constructor(code, message, status = 0) {
    super(message)
    this.name = 'WsaError'
    this.code = code
    this.status = status
  }
}

const envValue = (key) => (process.env[key] || '').trim()

/** 当前生效的鉴权方式 */
export function authMode() {
  if (envValue('WSA_API_KEY')) return 'apikey'
  const hasId = Boolean(envValue('WSA_SECRET_ID'))
  const hasKey = Boolean(envValue('WSA_SECRET_KEY'))
  if (hasId && hasKey) return 'tc3'
  if (hasId && !hasKey) return 'tc3-incomplete'
  return 'none'
}

export function authLabel() {
  const mode = authMode()
  if (mode === 'apikey') return '服务 API KEY'
  if (mode === 'tc3') return 'SecretId + SecretKey（TC3 签名）'
  if (mode === 'tc3-incomplete') return 'SecretId 已配置，但缺少 SecretKey'
  return '未配置'
}

export function hasKey() {
  const mode = authMode()
  return mode === 'apikey' || mode === 'tc3'
}

/** 把任意条数向上取到接口允许的档位 */
export function normalizeCnt(cnt) {
  const n = Number(cnt)
  if (!Number.isFinite(n)) return 10
  for (const step of CNT_STEPS) {
    if (n <= step) return step
  }
  return CNT_STEPS[CNT_STEPS.length - 1]
}

function safeParsePage(page) {
  if (page && typeof page === 'object') return page
  if (typeof page !== 'string') return null
  try {
    const parsed = JSON.parse(page)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function buildPayload(query, { mode, cnt, freshness, industry, site }) {
  const payload = {
    Query: query,
    Mode: Number(mode),
    Cnt: normalizeCnt(cnt)
  }
  if (freshness) payload.Freshness = String(freshness)
  if (industry) payload.Industry = String(industry)
  if (site) payload.Site = String(site)
  return payload
}

/**
 * 调用 SearchPro
 * @returns {Promise<{query, pages, version, requestId, msg, elapsedMs, auth}>}
 */
export async function searchPro({
  query,
  mode = 2,
  cnt = 10,
  freshness,
  industry,
  site,
  timeoutMs = 15000
}) {
  const auth = authMode()
  if (auth === 'none' || auth === 'tc3-incomplete') {
    throw new WsaError(
      'NO_API_KEY',
      `${authLabel()}。请在 .env 里填 WSA_API_KEY（服务 API KEY，sk- 开头），或同时填 WSA_SECRET_ID 与 WSA_SECRET_KEY`,
      400
    )
  }

  const q = String(query || '').trim()
  if (!q) throw new WsaError('InvalidParameter', '检索词为空', 400)
  if (Buffer.byteLength(q, 'utf8') > MAX_QUERY_BYTES) {
    throw new WsaError('InvalidParameter', `检索词超过 ${MAX_QUERY_BYTES} 字节上限，请精简`, 400)
  }

  const payload = buildPayload(q, { mode, cnt, freshness, industry, site })

  let url
  let headers
  let body

  if (auth === 'apikey') {
    url = envValue('WSA_ENDPOINT') || APIKEY_ENDPOINT
    body = JSON.stringify({ Action: ACTION, Version: VERSION, ...payload })
    headers = {
      Authorization: `Bearer ${envValue('WSA_API_KEY')}`,
      'Content-Type': 'application/json; charset=utf-8'
    }
  } else {
    // 标准入口的 Action / Version 走 header，不进请求体
    const host = envValue('WSA_TC3_HOST') || TC3_HOST
    const signed = buildTc3Request({
      secretId: envValue('WSA_SECRET_ID'),
      secretKey: envValue('WSA_SECRET_KEY'),
      host,
      service: 'wsa',
      action: ACTION,
      version: VERSION,
      payload
    })
    url = envValue('WSA_TC3_ENDPOINT') || signed.url
    headers = signed.headers
    body = signed.body
  }

  const started = Date.now()

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    throw new WsaError(
      timeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      timeout ? `请求元宝搜索超时（${timeoutMs}ms）` : `无法连接元宝搜索：${err?.message || err}`
    )
  }

  const rawText = await res.text()
  let data
  try {
    data = JSON.parse(rawText)
  } catch {
    throw new WsaError('BAD_RESPONSE', `元宝搜索返回了非 JSON 内容（HTTP ${res.status}）`, res.status)
  }

  const responseBody = data?.Response || {}
  if (responseBody.Error) {
    const code = responseBody.Error.Code || 'UNKNOWN'
    throw new WsaError(code, ERROR_TEXT[code] || responseBody.Error.Message || code, res.status)
  }
  if (!res.ok) {
    throw new WsaError('HTTP_ERROR', `元宝搜索返回 HTTP ${res.status}`, res.status)
  }

  const pages = (Array.isArray(responseBody.Pages) ? responseBody.Pages : [])
    .map(safeParsePage)
    .filter(Boolean)

  return {
    query: q,
    pages,
    version: responseBody.Version || '',
    requestId: responseBody.RequestId || '',
    msg: responseBody.Msg || '',
    elapsedMs: Date.now() - started,
    auth
  }
}
