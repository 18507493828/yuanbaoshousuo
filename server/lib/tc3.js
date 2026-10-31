/**
 * 腾讯云 API 3.0 的 TC3-HMAC-SHA256 签名
 * 文档：https://cloud.tencent.com/document/api/213/30654
 *
 * 只有走标准入口 wsa.tencentcloudapi.com 才需要签名；
 * 走 API KEY 兼容入口 api.wsa.cloud.tencent.com 不需要，一个 Bearer 头就够。
 */

import crypto from 'node:crypto'

const sha256hex = (input) => crypto.createHash('sha256').update(input, 'utf8').digest('hex')
const hmac256 = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest()

/**
 * @param {object} opts
 * @param {string} opts.secretId
 * @param {string} opts.secretKey
 * @param {string} opts.host          例：wsa.tencentcloudapi.com
 * @param {string} opts.service       例：wsa
 * @param {string} opts.action        例：SearchPro
 * @param {string} opts.version       例：2025-05-08
 * @param {object} opts.payload       请求体（不含 Action / Version）
 * @param {number} [opts.timestamp]   秒级时间戳，默认取当前时间
 */
export function buildTc3Request({ secretId, secretKey, host, service = 'wsa', action, version, payload, timestamp }) {
  const ts = Math.floor(timestamp ?? Date.now() / 1000)
  const date = new Date(ts * 1000).toISOString().slice(0, 10) // 必须是 UTC 日期
  const contentType = 'application/json; charset=utf-8'
  // 允许直接传字符串，便于按官方示例逐字节复算签名
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
  const hashedPayload = sha256hex(body)

  // 1. 拼接规范请求串
  // 注意第 3 个元素是「查询字符串」：本接口全走 POST body，查询串为空，
  // 但这一行必须存在（就是个空行）。漏掉它签名一定校验失败。
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`
  const signedHeaders = 'content-type;host;x-tc-action'
  const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n')

  // 2. 拼接待签名字符串
  const credentialScope = `${date}/${service}/tc3_request`
  const stringToSign = ['TC3-HMAC-SHA256', String(ts), credentialScope, sha256hex(canonicalRequest)].join('\n')

  // 3. 逐级派生签名密钥
  const kDate = hmac256(`TC3${secretKey}`, date)
  const kService = hmac256(kDate, service)
  const kSigning = hmac256(kService, 'tc3_request')

  // 4. 计算签名
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  return {
    url: `https://${host}/`,
    body,
    headers: {
      Authorization: authorization,
      'Content-Type': contentType,
      'X-TC-Action': action,
      'X-TC-Version': version,
      'X-TC-Timestamp': String(ts)
    }
  }
}
