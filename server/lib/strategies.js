/**
 * 选股策略 → 检索式
 *
 * 一个策略 = 一组「信息角度」。每个角度对应一条可以直接丢给元宝搜索的检索式。
 * 角度选得准，后面抽出来的信号才有意义。
 */

const YEAR = new Date().getFullYear()

export const STRATEGIES = [
  {
    key: 'stock',
    name: '个股全维度',
    desc: '锁定一只标的，按公告、财报、机构、股东、风险、行业地位、估值七个方向铺开',
    angles: [
      { label: '最新公告', query: (t) => `${t} 最新公告 消息 ${YEAR}` },
      { label: '业绩财报', query: (t) => `${t} 财报 营收 净利润 同比` },
      { label: '机构观点', query: (t) => `${t} 机构 研报 评级 观点` },
      { label: '股东变动', query: (t) => `${t} 股东 增持 减持 回购 股权激励` },
      { label: '风险事项', query: (t) => `${t} 风险 诉讼 处罚 下滑 原因` },
      { label: '行业地位', query: (t) => `${t} 主营业务 行业地位 市占率 竞争格局` },
      { label: '估值走势', query: (t) => `${t} 股价 估值 市盈率 机构持仓` }
    ]
  },
  {
    key: 'earnings',
    name: '业绩预增',
    desc: '从业绩预告、财报口径里找净利润明显改善的公司',
    angles: [
      { label: '业绩预告', query: (t) => `${t} 业绩预增 公告 ${YEAR}` },
      { label: '预增名单', query: (t) => `${t} 三季报 业绩预增 名单` },
      { label: '净利润增长', query: (t) => `${t} 净利润 同比增长 超预期` }
    ]
  },
  {
    key: 'orders',
    name: '订单中标',
    desc: '中大额订单、重大合同、项目中标这类能直接改业绩预期的事件',
    angles: [
      { label: '项目中标', query: (t) => `${t} 中标 重大项目 公告` },
      { label: '重大合同', query: (t) => `${t} 签订 重大合同 金额` },
      { label: '订单梳理', query: (t) => `${t} 在手订单 订单饱满 名单` }
    ]
  },
  {
    key: 'institution',
    name: '机构动向',
    desc: '机构调研、评级调整、基金持仓变化',
    angles: [
      { label: '机构调研', query: (t) => `${t} 机构调研 名单 调研纪要` },
      { label: '评级上调', query: (t) => `${t} 券商 上调评级 目标价` },
      { label: '资金加仓', query: (t) => `${t} 基金 加仓 北向资金 持仓` }
    ]
  },
  {
    key: 'pricehike',
    name: '产品涨价',
    desc: '提价、供不应求、产能扩张等景气度信号',
    angles: [
      { label: '产品提价', query: (t) => `${t} 涨价 提价 涨价函` },
      { label: '涨价名单', query: (t) => `${t} 涨价 受益 名单 个股` },
      { label: '产能扩张', query: (t) => `${t} 扩产 投产 量产` }
    ]
  },
  {
    key: 'buyback',
    name: '回购增持',
    desc: '回购、股东增持、股权激励等内部人态度信号',
    angles: [
      { label: '股份回购', query: (t) => `${t} 回购股份 公告 金额` },
      { label: '股东增持', query: (t) => `${t} 股东 增持 计划 名单` },
      { label: '股权激励', query: (t) => `${t} 股权激励 员工持股 考核目标` }
    ]
  },
  {
    key: 'theme',
    name: '主题扫描',
    desc: '不确定具体事件时，先按产业链和受益标的铺开',
    angles: [
      { label: '产业链龙头', query: (t) => `${t} 产业链 龙头股 上市公司` },
      { label: '受益标的', query: (t) => `${t} 受益标的 名单 梳理` },
      { label: '行业景气', query: (t) => `${t} 行业景气度 需求 增长` }
    ]
  }
]

export const STRATEGY_MAP = new Map(STRATEGIES.map((s) => [s.key, s]))

/**
 * 常用主题，只是输入提示，用户可以随便写。
 * 按大类分组，因为一屏塞七十个词没法点；分组只是导航，不影响检索逻辑。
 */
export const TOPIC_GROUPS = [
  {
    key: 'tech',
    name: '科技硬件',
    items: ['半导体设备', '半导体材料', '存储芯片', '光模块', 'PCB', '面板', '被动元件', '消费电子']
  },
  {
    key: 'ai',
    name: 'AI 与软件',
    items: ['AI 算力', '算力租赁', '液冷', 'AI 应用', '国产软件', '信创', '数据要素', '网络安全']
  },
  {
    key: 'manufacture',
    name: '高端制造',
    items: ['人形机器人', '工业母机', '减速器', '激光设备', '3D 打印', '工程机械', '自动化设备', '轴承']
  },
  {
    key: 'energy',
    name: '新能源',
    items: ['光伏', '储能', '固态电池', '锂电材料', '风电', '氢能', '核电', '充电桩']
  },
  {
    key: 'pharma',
    name: '医药',
    items: ['创新药', 'CXO', '医疗器械', '中药', '疫苗', '减肥药', '血制品', '连锁药店']
  },
  {
    key: 'consumer',
    name: '消费',
    items: ['白酒', '预制菜', '免税', '宠物经济', '化妆品', '家电', '食品饮料', '纺织服装', '旅游酒店']
  },
  {
    key: 'cyclical',
    name: '周期资源',
    items: ['有色金属', '黄金', '稀土', '煤炭', '化工', '钢铁', '水泥', '锂矿', '磷化工']
  },
  {
    key: 'finance',
    name: '金融地产',
    items: ['券商', '银行', '保险', '地产', 'REITs']
  },
  {
    key: 'defense',
    name: '军工低空',
    items: ['军工电子', '航空发动机', '低空经济', '卫星互联网', '船舶']
  },
  {
    key: 'utility',
    name: '农业公用',
    items: ['种业', '养殖', '转基因', '电力', '水务', '港口航运', '快递']
  }
]

/** 扁平版本，兼容只需要一串词的调用方 */
export const TOPIC_PRESETS = TOPIC_GROUPS.flatMap((g) => g.items)

export function getStrategy(key) {
  return STRATEGY_MAP.get(key) || STRATEGY_MAP.get('theme')
}

/** 单选或多选都接受，去重、剔除无效 key，全空时退回主题扫描 */
export function getStrategies(input) {
  const keys = Array.isArray(input) ? input : [input]
  const picked = []
  const seen = new Set()
  for (const k of keys) {
    const s = STRATEGY_MAP.get(String(k || '').trim())
    if (s && !seen.has(s.key)) {
      picked.push(s)
      seen.add(s.key)
    }
  }
  return picked.length ? picked : [STRATEGY_MAP.get('theme')]
}

/** 单次扫描最多铺开的检索式条数，防止角度全选把额度打穿 */
const MAX_QUERIES = 20

/**
 * 生成检索式列表
 * @param {{strategies?:string[]|string, strategy?:string, topic:string, extra?:string, extras?:string[]}} input
 * @returns {{id:string,label:string,group:string,queryLabel:string,query:string}[]}
 */
export function buildQueries({ strategies, strategy, topic, extra, extras }) {
  const list = getStrategies(strategies ?? strategy)
  const t = String(topic || '').trim() || 'A股'
  const extraText = String(extra || '').trim()

  const seenQuery = new Set()
  const queries = []

  for (const s of list) {
    for (const [i, a] of s.angles.entries()) {
      const query = a.query(t)
      if (seenQuery.has(query)) continue
      seenQuery.add(query)
      queries.push({
        id: `${s.key}-${i}`,
        label: a.label,
        group: s.name,
        queryLabel: list.length > 1 ? `${s.name}·${a.label}` : a.label,
        query
      })
    }
  }

  // 解析出来的自定义检索式：贴着用户原话补，排在模板之后
  const custom = (Array.isArray(extras) ? extras : [])
    .map((q) => String(q || '').trim())
    .filter((q) => q.length >= 4)

  for (const [i, q] of custom.entries()) {
    const query = q.slice(0, 80)
    if (seenQuery.has(query) || queries.length >= MAX_QUERIES) continue
    seenQuery.add(query)
    queries.push({
      id: `custom-${i}`,
      label: '自定义检索',
      group: '自定义',
      queryLabel: '自定义检索',
      query
    })
  }

  // 额外的自定义条件作为独立一条检索，拼在最后
  if (extraText && queries.length < MAX_QUERIES) {
    const query = `${t} ${extraText}`.slice(0, 120)
    if (!seenQuery.has(query)) {
      queries.push({
        id: 'extra',
        label: '自定义条件',
        group: '附加',
        queryLabel: '自定义条件',
        query
      })
    }
  }

  return queries.slice(0, MAX_QUERIES)
}
