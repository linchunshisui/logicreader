/**
 * 一个节点/连线可能有**多处出处** —— 同一概念在原文出现多次时，`anchors` 保留全部位置
 * （见 store.service 的锚点回填）。"跳到它"时必须在这些位置里挑一个，这里定义挑法。
 *
 * 挑**离当前阅读位置最近**的那处，而不是数组里的第一处。为什么：从 A 跳过来、再顺着
 * 右侧逻辑链跳 B 时，B 的第一次出现往往远在几十页之前 —— 跳过去得自己往回找"这一段的 B"；
 * 取最近的一处，跳转才是"接着往下读"。用户原话："A 节点跳转后在右上角选择跳转 B 节点
 * 的时候，选择最靠近 A 节点的目的地进行跳转"。
 *
 * 抽成纯函数是为了能用单测钉住这条规则（见 tests/anchor-pick.test.ts）。
 */

export interface PositionedAnchor {
  charStart: number
  charEnd: number
}

/**
 * 取离 `reference` 最近的一处出处。
 *
 * 距离只看 **charStart**：区间长度与目标位置无关，"这一段在原文的哪儿"由起点决定。
 * 距离相同取数组里靠前的那个（`<` 而非 `<=`）；空数组返回 null，由调用方决定怎么处理。
 */
export function pickNearestAnchor<T extends PositionedAnchor>(
  anchors: readonly T[],
  reference: number
): T | null {
  let best: T | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const anchor of anchors) {
    const distance = Math.abs(anchor.charStart - reference)
    if (distance < bestDistance) {
      best = anchor
      bestDistance = distance
    }
  }
  return best
}
