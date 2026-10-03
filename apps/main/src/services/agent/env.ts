/**
 * Agent 子进程的环境变量：把注册表里的 env 规格解析成真正要传给子进程的环境。
 *
 * 取值形态只有两种：
 *  - `secret:<key>`：从 safeStorage 加密的密钥库取（桌面端唯一的密钥落点，见 settings.service）；
 *  - 其余按**字面量**原样传给子进程。
 *
 * 为什么需要这一层：`AgentDefinition.env` 从第一天就有字段与落库列（`agents.env_json`），
 * 但没有任何一条启动路径把它传下去 —— 于是"给 dsh 配 DEEPSEEK_API_KEY"这件事在程序里
 * 根本做不到（见 docs/deepseek-harness.md §3）。
 *
 * 本模块**不依赖 electron**（密钥读取由调用方注入），所以可以被单测直接 import。
 */

import { DEEPSEEK_API_KEY_ENV, DEEPSEEK_API_KEY_SECRET } from '@logicreader/shared'

export const SECRET_PREFIX = 'secret:'

// 常量只有一份（packages/shared/src/settings.ts）：主进程注入、渲染进程写入的必须是同一个键名。
export { DEEPSEEK_API_KEY_ENV, DEEPSEEK_API_KEY_SECRET }

/** 合法环境变量名（不合法的一律丢弃，避免拼出奇怪的子进程环境）。 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 密钥读取回调：拿不到返回 null。 */
export type SecretLookup = (key: string) => string | null

/**
 * 解析单个环境变量的值。
 * 取不到密钥时返回 null（**该变量干脆不注入**，而不是注入空串 —— DSH 对空密钥会启动即报错）。
 */
export function resolveEnvValue(value: unknown, getSecret: SecretLookup): string | null {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (!text.startsWith(SECRET_PREFIX)) return text
  const key = text.slice(SECRET_PREFIX.length).trim()
  if (key.length === 0) return null
  const secret = getSecret(key)
  return secret == null || secret.length === 0 ? null : secret
}

/** 注册表 env 规格 → 子进程环境（丢弃非法键名与取不到的密钥引用）。 */
export function resolveAgentEnv(
  spec: Record<string, string> | null | undefined,
  getSecret: SecretLookup
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(spec ?? {})) {
    if (!ENV_NAME.test(name)) continue
    const resolved = resolveEnvValue(value, getSecret)
    if (resolved == null || resolved.length === 0) continue
    out[name] = resolved
  }
  return out
}

/**
 * 内置 Agent 的默认环境变量。
 * 目前只有 dsh 需要：它是"自带模型路由"的 harness，密钥不从我们的设置里读就没人给它。
 */
export function defaultAgentEnv(kind: string, getSecret: SecretLookup): Record<string, string> {
  if (kind !== 'dsh') return {}
  const key = getSecret(DEEPSEEK_API_KEY_SECRET)
  return key != null && key.length > 0 ? { [DEEPSEEK_API_KEY_ENV]: key } : {}
}

/** 合并"内置默认 + 用户配置"，用户配置优先。 */
export function mergeAgentEnv(
  kind: string,
  spec: Record<string, string> | null | undefined,
  getSecret: SecretLookup
): Record<string, string> {
  return { ...defaultAgentEnv(kind, getSecret), ...resolveAgentEnv(spec, getSecret) }
}

/** 日志友好的描述：只列变量名，绝不带值。 */
export function describeEnvNames(env: Record<string, string>): string {
  const names = Object.keys(env)
  return names.length === 0 ? '（无）' : names.join(', ')
}
