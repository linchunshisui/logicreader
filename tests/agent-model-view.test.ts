import { describe, expect, it } from 'vitest'
import { mapSdkModel } from '../apps/main/src/services/agent/model-view'

describe('SDK 模型条目映射', () => {
  it('supportedEffortLevels 映射为界面消费的 thoughtLevels', () => {
    const view = mapSdkModel({
      value: 'sonnet',
      displayName: 'Sonnet',
      resolvedModel: 'claude-sonnet-4-5',
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high']
    })
    expect(view.thoughtLevels?.map((level) => level.id)).toEqual(['low', 'medium', 'high'])
    expect(view.effortLevels).toEqual(['low', 'medium', 'high'])
  })

  it('没有思考档位声明时 thoughtLevels 为空（界面显示未声明而非崩溃）', () => {
    const view = mapSdkModel({ value: 'sonnet', displayName: 'Sonnet' })
    expect(view.thoughtLevels).toBeUndefined()
  })

  it('显示名优先真实模型名，id 保持提交给 CLI 的值', () => {
    const view = mapSdkModel({ value: 'sonnet', resolvedModel: 'glm-5.3-flash' })
    expect(view.id).toBe('sonnet')
    expect(view.name).toBe('glm-5.3-flash')
    expect(view.resolvedModel).toBe('glm-5.3-flash')
  })
})
