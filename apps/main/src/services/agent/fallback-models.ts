/**
 * 各 Agent 的**兜底模型清单** —— 只在"还没建立会话、拿不到真实清单"时使用。
 *
 * 单独成文件的原因：这份清单是"界面在空态下告诉用户能选什么"的唯一依据，
 * 需要一个不依赖 electron 的入口（单测直接钉住它），避免像 dsh 那样写着
 * `deepseek-chat` / `deepseek-reasoner` 两个在 DSH 里根本不存在的模型。
 */
import type { AgentKind, ModelOption } from './types'

export const FALLBACK_MODELS: Record<AgentKind, ModelOption[]> = {
  'claude-code': [
    // 不传 --model，沿用用户 Claude Code 自身的模型配置
    { id: 'default', name: '默认（跟随 CLI 配置）' },
    { id: 'sonnet', name: 'Sonnet', thoughtLevels: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }], defaultThoughtLevel: 'medium' },
    { id: 'opus', name: 'Opus', thoughtLevels: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }, { id: 'high', name: '高' }, { id: 'max', name: '最高' }], defaultThoughtLevel: 'high' },
    { id: 'haiku', name: 'Haiku', thoughtLevels: [{ id: 'low', name: '低' }, { id: 'medium', name: '中' }], defaultThoughtLevel: 'low' },
    { id: 'opusplan', name: 'Opus Plan' }
  ],
  codex: [
    { id: 'gpt-5-codex', name: 'gpt-5-codex', thoughtLevels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].map((id) => ({ id, name: id })), defaultThoughtLevel: 'medium' },
    { id: 'gpt-5', name: 'gpt-5', thoughtLevels: ['none', 'low', 'medium', 'high'].map((id) => ({ id, name: id })), defaultThoughtLevel: 'medium' }
  ],
  /**
   * DSH 只用得着这份清单的**一种情况**：还没建立过 ACP 会话（真清单来自 `session/new`
   * 的 configOptions）。所以这里必须写 DSH 官方 provider 路由 `deepseek-official` 真实存在的
   * 模型与思考强度 —— 旧版写的 `deepseek-chat` / `deepseek-reasoner` 在 DSH 里根本不存在，
   * 用户照它选会在 `session/set_config_option` 上撞"未知模型"，看起来就像"这个 Agent 坏了"。
   *
   * 依据（实机 `dsh --profile acp` 的 `session/new` 报文 + `@deepseek-ai/dsh-llm-deepseek`）：
   *  - 模型目录默认 `deepseek-v4-flash` / `deepseek-v4-pro`（`model` 项是 `[provider, model]` 路由，
   *    这里只列模型名，provider 由 config-value.ts 在提交时补上）；
   *  - `reasoning_effort [thought_level]` 可选 `off|low|high|max`，默认 `high`
   *    （`low`/`medium` 在服务端被折叠成 `high`，但 dsh 仍然把它列出来，所以照实列出）。
   */
  dsh: [
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek-V4-Flash',
      description: 'DSH 默认路由（快）',
      thoughtLevels: [
        { id: 'off', name: '关闭' },
        { id: 'low', name: '低（服务端按高处理）' },
        { id: 'high', name: '高' },
        { id: 'max', name: '最高' }
      ],
      defaultThoughtLevel: 'high'
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      description: 'DSH 上的更强档',
      thoughtLevels: [
        { id: 'off', name: '关闭' },
        { id: 'low', name: '低（服务端按高处理）' },
        { id: 'high', name: '高' },
        { id: 'max', name: '最高' }
      ],
      defaultThoughtLevel: 'high'
    }
  ],
  gemini: [{ id: 'default', name: 'Default' }],
  custom: [{ id: 'default', name: 'Default' }]
}
