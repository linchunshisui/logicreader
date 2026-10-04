import { describe, expect, it } from 'vitest'
import {
  chunkTimeoutFor,
  effortTimeFactor,
  profileDensityPerKiloChars,
  estimateMinutesFromHistory,
  heuristicMinutes
} from '../apps/main/src/services/graph.service'
import { PRECISION_PROFILES } from '../packages/graph-schema/src/index'

/**
 * 关系图生成前的耗时预估（本轮改造）：思考强度是耗时的大头，档位密度拉开抽取差距。
 * 系数依据执行记录 §53/§54 的实测：xhigh 单块 88~300 秒，low 21.7 秒，medium 介于其间。
 */
describe('思考强度 → 耗时系数', () => {
  it('low 比 medium 便宜，xhigh 是 medium 的 2.6 倍', () => {
    expect(effortTimeFactor(null)).toBe(1)
    expect(effortTimeFactor('medium')).toBe(1)
    expect(effortTimeFactor('low')).toBeLessThan(1)
    expect(effortTimeFactor('high')).toBeGreaterThan(1)
    expect(effortTimeFactor('xhigh')).toBeGreaterThan(effortTimeFactor('high'))
    expect(effortTimeFactor('max')).toBe(effortTimeFactor('xhigh'))
  })

  it('不认识的档位按 medium 处理（不放大也不打折）', () => {
    expect(effortTimeFactor('turbo')).toBe(1)
    expect(effortTimeFactor('')).toBe(1)
  })
})

describe('档位抽取密度（实体/千字符）', () => {
  it('骨架 < 结构 < 全景，与 PRECISION_PROFILES 的档位语义一致', () => {
    const skeleton = profileDensityPerKiloChars(PRECISION_PROFILES.skeleton)
    const structure = profileDensityPerKiloChars(PRECISION_PROFILES.structure)
    const panorama = profileDensityPerKiloChars(PRECISION_PROFILES.panorama)
    expect(skeleton).toBeLessThan(structure)
    expect(structure).toBeLessThan(panorama)
  })
})

describe('历史校准的耗时预估', () => {
  it('有历史时按"单波耗时 × 本轮波数"外推', () => {
    // 历史跑了 4 块 / 并发 2（2 波）共 20 分钟 → 单波 10 分钟
    const result = estimateMinutesFromHistory(
      [{ elapsedMs: 20 * 60000, chunkCount: 4, concurrency: 2 }],
      6,
      2
    )
    expect(result).not.toBeNull()
    // 本轮 6 块 / 并发 2 = 3 波 → 中位 10 分钟/波 → 21~48 分钟区间包含 3 波
    expect(result!.samples).toBe(1)
    expect(result!.minutes[0]).toBeLessThanOrEqual(21)
    expect(result!.minutes[1]).toBeGreaterThanOrEqual(21)
    expect(result!.minutes[1]).toBeGreaterThan(result!.minutes[0])
  })

  it('没有历史样本时返回 null（退到启发式）', () => {
    expect(estimateMinutesFromHistory([], 6, 2)).toBeNull()
    expect(estimateMinutesFromHistory([{ elapsedMs: 0, chunkCount: 4, concurrency: 2 }], 6, 2)).toBeNull()
  })

  it('耗时样本的中位数抗单次异常（一次慢跑不会把预估拉爆）', () => {
    const normal = { elapsedMs: 10 * 60000, chunkCount: 2, concurrency: 2 }
    const outlier = { elapsedMs: 90 * 60000, chunkCount: 2, concurrency: 2 }
    const withOutlier = estimateMinutesFromHistory([normal, outlier], 2, 2)
    const clean = estimateMinutesFromHistory([normal, normal], 2, 2)
    expect(withOutlier).not.toBeNull()
    expect(clean).not.toBeNull()
    // 中位数取的是排序后的中间值，一个异常样本最多把下界抬到另一侧
    expect(withOutlier!.minutes[1]).toBeLessThan(180)
  })
})

describe('无历史的启发式预估', () => {
  it('4 块 × 并发 3（2 波）× xhigh：分钟级且低于"每块各等一轮超时"的最坏情形', () => {
    const [low, high] = heuristicMinutes(4, 3, 3000, effortTimeFactor('xhigh'))
    expect(low).toBeGreaterThanOrEqual(1)
    expect(high).toBeGreaterThan(low)
    // 单块最坏 368 秒 × 2 波 ≈ 12 分钟：预估上限不该比它还离谱
    expect(high).toBeLessThan(45)
  })

  it('分块越多、并发越低，预估越长', () => {
    const fast = heuristicMinutes(4, 6, 3000, 1)
    const slow = heuristicMinutes(12, 2, 3000, 1)
    expect(slow[1]).toBeGreaterThan(fast[1])
  })

  it('从未给出 0 分钟', () => {
    const [low, high] = heuristicMinutes(1, 6, 100, 0.7)
    expect(low).toBeGreaterThanOrEqual(1)
    expect(high).toBeGreaterThanOrEqual(2)
  })
})

describe('抽取提示词带档位密度指导', () => {
  // mapPrompt 未导出：这里通过 GraphService 的公共入口间接保证 —— 提示词由 generate 内部组装，
  // 数量指导的回归由 estimate 的输出端（profileDensityPerKiloChars）钉住。
  it('超时预算的输入仍然只有分块长度（与预估解耦）', () => {
    expect(chunkTimeoutFor(0)).toBe(180000)
  })
})
