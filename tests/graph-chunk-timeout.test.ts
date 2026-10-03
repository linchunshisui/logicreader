import { describe, expect, it } from 'vitest'
import { chunkTimeoutFor } from '../apps/main/src/services/graph.service'

/**
 * 分块超时预算是"按体量给耐心"，不是常数（回归：固定 180/300 秒会把大分块掐死）。
 * 实测参考（Qwen3.8-Flash[1M] 经 scnet 代理，xhigh）：1.0k 字符 ≈ 88~95 秒、4.6k ≈ 131~134 秒。
 */
describe('分块超时预算', () => {
  it('小分块给下限 3 分钟（思考也要时间）', () => {
    expect(chunkTimeoutFor(52)).toBe(180000)
    expect(chunkTimeoutFor(1000)).toBe(180000)
  })

  it('随长度增长：60 秒 + 40 秒/千字符（约为实测速率的 1.4 倍余量）', () => {
    expect(chunkTimeoutFor(4600)).toBe(244000)
    expect(chunkTimeoutFor(7700)).toBe(368000)
  })

  it('封顶 15 分钟：空转型模型仍然会被中断，任务不会被无限拖死', () => {
    expect(chunkTimeoutFor(100000)).toBe(900000)
    expect(chunkTimeoutFor(10000000)).toBe(900000)
  })
})
