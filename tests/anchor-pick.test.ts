/**
 * 「从 A 跳到 B 时挑 B 的哪处出处」—— 用户原话：
 * "关系图中某 A 节点连接的某 B 节点有多个跳转目的地，A 节点跳转后在右上角选择跳转
 *  B 节点的时候，选择最靠近 A 节点的目的地进行跳转。"
 * 这条规则在这里被钉成回归断言。
 */
import { describe, expect, it } from 'vitest'
import { pickNearestAnchor } from '../apps/renderer/src/lib/anchorPick'

const at = (charStart: number, charEnd = charStart + 10) => ({ charStart, charEnd })

describe('pickNearestAnchor', () => {
  it('取起点离参照位置最近的那处（不是数组里的第一处）', () => {
    const anchors = [at(1200), at(4800), at(900)]
    expect(pickNearestAnchor(anchors, 1000)).toEqual(at(900))
  })

  it('参照位置在中间时取前后更近的一侧', () => {
    expect(pickNearestAnchor([at(100), at(5000), at(3000)], 3200)).toEqual(at(3000))
  })

  it('前后的距离相同 → 取靠前的那个（保持稳定，不随机挑）', () => {
    expect(pickNearestAnchor([at(100), at(500)], 300)).toEqual(at(100))
  })

  it('只看起点：区间更长的出处不会因为"覆盖到参照位置"而被优先', () => {
    expect(pickNearestAnchor([at(0, 1000), at(1400)], 1005)).toEqual(at(1400))
  })

  it('只有一处出处时直接给这一处（原行为不变）', () => {
    expect(pickNearestAnchor([at(2600)], 0)).toEqual(at(2600))
  })

  it('没有出处时返回 null，由调用方决定（当前是不跳）', () => {
    expect(pickNearestAnchor([], 500)).toBeNull()
  })

  it('参照位置为 0 / 越界也不炸：仍取最近的一处', () => {
    expect(pickNearestAnchor([at(50), at(900)], 0)).toEqual(at(50))
    expect(pickNearestAnchor([at(50), at(900)], 999999)).toEqual(at(900))
  })
})
