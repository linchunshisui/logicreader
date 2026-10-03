import { describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { decodeZstdFrames, pickDshSessionHint } from '../apps/main/src/services/agent/dsh-session-log'

/**
 * dsh 的会话日志是**多帧拼接**的 zstd（Node 的 zstdDecompressSync 只解第一帧），
 * 而且它的 ACP `session/list` 不给标题 —— 标题与"第一句提问"只能从这份日志里读。
 * 用户的要求：**根据第一句提问给个默认标题**。
 */
describe('dsh 会话日志：分帧解压', () => {
  it('多帧拼接也能全部解出来', () => {
    const frames = ['{"type":"a"}\n', '{"type":"b"}\n', '{"type":"c"}\n'].map((text) => zstdCompressSync(Buffer.from(text, 'utf8')))
    const joined = Buffer.concat(frames)
    expect(decodeZstdFrames(joined)).toBe('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n')
  })
  it('被截断的最后一帧不影响前面的内容', () => {
    const frame = zstdCompressSync(Buffer.from('{"type":"a"}\n', 'utf8'))
    const truncated = Buffer.concat([frame, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01])])
    expect(decodeZstdFrames(truncated)).toBe('{"type":"a"}\n')
  })
})

describe('dsh 会话日志：挑标题与第一句提问', () => {
  const jsonl = [
    JSON.stringify({ type: 'session', id: 'x', cwd: 'D:\\逻辑阅读器\\' }),
    // 系统注入的用户消息（"审批策略变了"）不能当标题
    JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'The approval policy changed' }], source: { kind: 'user-approval' } } }),
    JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '阅读 逻辑阅读器-任务规划书.md 文件，执行其中的内容' }], source: { kind: 'user' } } }),
    JSON.stringify({ type: 'session/title', data: { title: '阅读 逻辑阅读器-任务规划书.m', source: { kind: 'fallback' } } }),
    JSON.stringify({ type: 'session/title', data: { title: '阅读并执行任务规划书', source: { kind: 'provider' } } })
  ].join('\n')

  it('取真正由人发出的第一句（跳过系统注入），标题优先 LLM 生成的那份', () => {
    expect(pickDshSessionHint(jsonl)).toEqual({
      title: '阅读并执行任务规划书',
      firstUserText: '阅读 逻辑阅读器-任务规划书.md 文件，执行其中的内容'
    })
  })

  it('只有 fallback 标题时也能用；没有用户消息就只给标题', () => {
    const onlyFallback = JSON.stringify({ type: 'session/title', data: { title: '某次阅读', source: { kind: 'fallback' } } })
    expect(pickDshSessionHint(onlyFallback)).toEqual({ title: '某次阅读', firstUserText: null })
  })

  it('坏行不影响解析', () => {
    const messy = 'not json\n' + jsonl
    expect(pickDshSessionHint(messy).firstUserText).toBe('阅读 逻辑阅读器-任务规划书.md 文件，执行其中的内容')
  })
})
