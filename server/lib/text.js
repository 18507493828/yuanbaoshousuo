/**
 * 文本裁切：优先断在标点处，不要拦腰切断。
 *
 * 之前所有摘要与模型结论都是 `slice(0, N)`，第 N 个字切在哪里完全看运气：
 * 证据摘要常停在「公司预计2026年前三」这种半句上，模型拿这段去提炼，
 * 出来的结论自然也是残句；界面上看起来就像内容被截断了。
 *
 * 这里的策略：在 max 之内找最后一个句末标点收尾，找不到就退到逗号，
 * 都没有才硬切，并补一个省略号 —— 至少让读者知道「这里是断开的」。
 */

const HARD_STOP = '。！？!?；;'
const SOFT_STOP = '，,、：:）)】」” '

export function clip(text, max = 200, mark = '…') {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  if (s.length <= max) return s

  const head = s.slice(0, max)

  let cut = -1
  for (let i = head.length - 1; i >= Math.floor(max * 0.5); i -= 1) {
    if (HARD_STOP.includes(head[i])) {
      // 句末标点保留在正文里，这种收尾本身就是完整的，不必再补省略号
      return head.slice(0, i + 1)
    }
  }

  for (let i = head.length - 1; i >= Math.floor(max * 0.6); i -= 1) {
    if (SOFT_STOP.includes(head[i])) {
      cut = i
      break
    }
  }

  const body = (cut > 0 ? head.slice(0, cut) : head).replace(/[，,、：:；;\s]+$/, '')
  return `${body}${mark}`
}
