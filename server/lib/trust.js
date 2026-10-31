/**
 * 信源分级。三档，规则明确、可解释 —— 这是「结果是否可信」的地基。
 *  A = 一手/权威：政府、教育科研机构、品牌官方文档与官网
 *  B = 主流媒体与开发者社区：可作为交叉印证，但不是一手出处
 *  C = 其他：只当线索
 */

const A_SUFFIX = ['.gov.cn', '.gov', '.edu.cn', '.edu', '.ac.cn', '.mil', '.gov.hk', '.gov.tw']

// 腾讯系（元宝搜索官方口径把腾讯内容生态视作优质信源）
const A_HOST_SUFFIX = [
  'tencent.com',
  'tencentcloud.com',
  'tencent.cool',
  'qq.com',
  'gtimg.cn'
]

// 交易所与法定信息披露平台 —— 公告原文就在这里，属于一手来源
const DISCLOSURE_HOSTS = [
  'cninfo.com.cn', // 巨潮资讯
  'sse.com.cn', // 上交所
  'szse.cn', // 深交所
  'bse.cn', // 北交所
  'csrc.gov.cn' // 证监会
]

// 在 A 类域名下，这些子域才算「官方文档/官方说明」
const OFFICIAL_SUB = /^(docs|doc|developer|developers|api|dev|cloud|console|help|support|open|official|www\d?)\./

const B_HOSTS = [
  '36kr.com', 'geekpark.net', 'ifeng.com', '163.com', 'sina.com.cn', 'sina.cn',
  'sohu.com', 'thepaper.cn', 'jiqizhixin.com', 'infoq.cn', 'oschina.net',
  'juejin.cn', 'zhihu.com', 'csdn.net', 'ithome.com', 'techweb.com.cn',
  '51cto.com', 'segmentfault.com', 'cnblogs.com', '51cto.com', 'leiphone.com',
  'tmtpost.com', 'huxiu.com', 'qbitai.com', 'baijiahao.baidu.com',
  'baike.baidu.com', 'wikipedia.org', 'github.com', 'npmjs.com', 'pypi.org',
  'python.org', 'nodejs.org', 'developer.mozilla.org', 'w3.org', 'stackoverflow.com',
  'medium.com', 'substack.com', 'sspai.com', 'ifanr.com', 'pingwest.com',
  'mp.weixin.qq.com', 'weixin.qq.com',
  // 财经媒体与行情平台
  'stcn.com', 'cs.com.cn', 'cnstock.com', 'eastmoney.com', '10jqka.com.cn',
  'yicai.com', 'cls.cn', 'jiemian.com', 'nbd.com.cn', '21jingji.com',
  'wallstreetcn.com', 'xueqiu.com', 'gelonghui.com', 'futunn.com',
  'hexun.com', 'jrj.com.cn', 'cnfol.com', 'smm.cn'
]

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

const MULTI_PART_TLD = /\.(com|net|org|gov|edu)\.cn$/

/**
 * 独立站点标识：同一家媒体的不同子域（guba.eastmoney.com 与 caifuhao.eastmoney.com）
 * 算作同一个信源，不重复计入交叉印证。
 */
export function siteKeyOf(url) {
  const host = hostOf(url)
  if (!host) return ''
  const parts = host.split('.')
  if (MULTI_PART_TLD.test(host) && parts.length > 3) return parts.slice(-3).join('.')
  return parts.slice(-2).join('.')
}

function endsWithAny(host, list) {
  return list.some((suffix) => host === suffix || host.endsWith(`.${suffix}`) || host.endsWith(suffix))
}

/**
 * @returns {{tier: 'A'|'B'|'C', reason: string}}
 */
export function tierOf(url, siteName = '') {
  const host = hostOf(url)
  if (!host) return { tier: 'C', reason: '链接无法解析' }

  if (endsWithAny(host, A_SUFFIX)) {
    return { tier: 'A', reason: '政府/教育科研机构域名' }
  }
  if (endsWithAny(host, DISCLOSURE_HOSTS)) {
    return { tier: 'A', reason: '交易所/法定信息披露平台' }
  }
  if (endsWithAny(host, A_HOST_SUFFIX)) {
    return { tier: 'A', reason: '腾讯官方生态域名' }
  }
  if (OFFICIAL_SUB.test(host)) {
    return { tier: 'A', reason: '官方文档/开发者站点' }
  }
  if (endsWithAny(host, B_HOSTS)) {
    return { tier: 'B', reason: '主流媒体或开发者社区' }
  }
  if (/官方|官网|政府|人民政府|研究院|大学/.test(siteName)) {
    return { tier: 'A', reason: `站点名包含「${siteName.match(/官方|官网|政府|人民政府|研究院|大学/)[0]}」` }
  }
  return { tier: 'C', reason: '未识别的站点，仅作线索' }
}

export const TIER_LABEL = { A: '权威', B: '媒体', C: '线索' }
