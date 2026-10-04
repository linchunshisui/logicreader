import { describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { decodeZstdFrames, pickDshSessionHint, pickDshTranscript } from '../apps/main/src/services/agent/dsh-session-log'

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

describe('dsh 会话日志：还原全部对话（历史会话点开时的回放）', () => {
  /** 与本机真实日志同构的记录（user/message 只认 source.kind=user；assistant/message 带 reasoning 块）。 */
  const jsonl = [
    JSON.stringify({ type: 'session', id: 'x', seq: 1, time: 1000 }),
    // 系统注入（审批策略变更）不是用户说的话
    JSON.stringify({
      type: 'user/message', seq: 2, time: 1100,
      data: { content: [{ type: 'text', text: 'The approval policy changed' }], source: { kind: 'user-approval' } }
    }),
    JSON.stringify({
      type: 'user/message', seq: 3, time: 1200,
      data: { content: [{ type: 'text', text: '解释 GRPO 的损失函数' }], source: { kind: 'user' } }
    }),
    JSON.stringify({
      type: 'assistant/message', seq: 4, time: 1300,
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '用户在问强化学习…' },
            { type: 'text', text: 'GRPO 的损失是带组内相对优势的策略梯度。' }
          ]
        }
      }
    }),
    JSON.stringify({
      type: 'user/message', seq: 5, time: 1400,
      data: { content: [{ type: 'text', text: '那 SFT 呢？' }], source: { kind: 'user' } }
    }),
    JSON.stringify({
      type: 'assistant/message', seq: 6, time: 1500,
      data: { message: { role: 'assistant', content: [{ type: 'text', text: 'SFT 是监督微调…' }] } }
    })
  ].join('\n')

  it('按时间序还原全部 user/assistant（系统注入跳过、reasoning 进 thinking）', () => {
    const transcript = pickDshTranscript(jsonl)
    expect(transcript).toEqual([
      { role: 'user', text: '解释 GRPO 的损失函数', thinking: '', at: 1200 },
      { role: 'assistant', text: 'GRPO 的损失是带组内相对优势的策略梯度。', thinking: '用户在问强化学习…', at: 1300 },
      { role: 'user', text: '那 SFT 呢？', thinking: '', at: 1400 },
      { role: 'assistant', text: 'SFT 是监督微调…', thinking: '', at: 1500 }
    ])
  })

  it('空正文也没有思考的 assistant 记录被跳过', () => {
    const withEmpty = jsonl + '\n' + JSON.stringify({ type: 'assistant/message', seq: 7, time: 1600, data: { message: { content: [] } } })
    expect(pickDshTranscript(withEmpty)).toHaveLength(4)
  })

  it('坏行不影响解析；时间乱序时按 time 排回', () => {
    const shuffled = [
      jsonl.split('\n')[3], // assistant 先出现（乱序）
      ...jsonl.split('\n').slice(0, 3),
      ...jsonl.split('\n').slice(4)
    ].join('\n')
    const transcript = pickDshTranscript(shuffled)
    expect(transcript[0]?.role).toBe('user')
    expect(transcript[0]?.at).toBe(1200)
  })
})
