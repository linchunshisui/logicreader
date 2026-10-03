import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentRegistrationView } from '@logicreader/shared'
import { api } from '../../lib/api'
import { useAgent } from '../../state/agent.store'
import { notify } from '../../state/notifications.store'

/** 协议 → 文案键（与 Agent 面板选择器同一套说法）。 */
const PROTOCOL_KEY: Record<string, string> = {
  sdk: 'agent.protocolSdk',
  'app-server': 'agent.protocolAppServer',
  acp: 'agent.protocolAcp',
  cli: 'agent.protocolCli',
  mock: 'agent.protocolMock'
}

interface Draft {
  executable: string
  args: string
}

/**
 * Agent 管理器（设置 → Agent）。
 *
 * 它存在的理由：Agent 能不能用，取决于"程序有没有找到那个可执行文件" ——
 * 而这件事对用户是**不可见**的（探测失败只在能力里留一句 error）。
 * 这里把每个 Agent 摊开：走哪条协议、什么版本、可用不可用（附原因）、有没有配密钥，
 * 并且可以直接改可执行文件与启动参数（例如 dsh 装在非 PATH 目录、或者要固定用某个版本）。
 *
 * 不改的规矩：协议仍以内置定义为准（registry 会忽略历史里的协议覆盖），
 * 判定与探测都走主进程那一条链路，这里只负责展示与提交。
 */
export function AgentManager(): JSX.Element {
  const { t } = useTranslation()
  const [agents, setAgents] = useState<AgentRegistrationView[]>([])
  const [draft, setDraft] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async (): Promise<void> => {
    try {
      const list = await api.agent.list()
      setAgents(list)
      setDraft((current) => {
        const next: Record<string, Draft> = { ...current }
        for (const item of list) {
          if (!next[item.id]) next[item.id] = { executable: item.executable ?? '', args: (item.args ?? []).join('\n') }
        }
        return next
      })
      setError(null)
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const probeAll = async (): Promise<void> => {
    setBusy('__all__')
    try {
      await api.agent.probeAll(true)
      await load()
      await useAgent.getState().refreshAgents(true)
    } finally {
      setBusy(null)
    }
  }

  const save = async (agent: AgentRegistrationView): Promise<void> => {
    const value = draft[agent.id]
    if (!value) return
    setBusy(agent.id)
    try {
      const args = value.args
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      await api.agent.upsert({
        id: agent.id,
        kind: agent.kind,
        displayName: agent.displayName,
        protocol: agent.protocol,
        executable: value.executable.trim().length > 0 ? value.executable.trim() : null,
        args,
        // env 原样带回：里面有用户/程序写进去的密钥引用（不清空它）
        env: agent.env ?? {},
        enabled: true
      })
      await api.agent.probe(agent.id, true).catch(() => undefined)
      await load()
      await useAgent.getState().refreshAgents(true)
      notify(t('settings.agent.saved'), 'success')
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="lr-agent-manager">
      <div className="lr-agent-manager__head">
        <div>
          <div className="lr-agent-manager__title">{t('settings.agent.managerTitle')}</div>
          <div className="lr-setting__hint">{t('settings.agent.managerHint')}</div>
        </div>
        <button className="lr-button lr-button--secondary" disabled={busy !== null} onClick={() => void probeAll()}>
          {busy === '__all__' ? t('settings.agent.probing') : t('settings.agent.probeAll')}
        </button>
      </div>

      {error ? <div className="lr-agent-manager__error">{error}</div> : null}
      {agents.length === 0 ? <div className="lr-setting__hint">{t('settings.agent.noneDetected')}</div> : null}

      {agents.map((agent) => {
        const value = draft[agent.id] ?? { executable: agent.executable ?? '', args: (agent.args ?? []).join('\n') }
        const capability = agent.capability
        return (
          <div className="lr-agent-manager__item" key={agent.id} data-available={capability?.available === true}>
            <div className="lr-agent-manager__row">
              <span className="lr-agent-manager__name">{agent.displayName}</span>
              <span className="lr-agent-manager__badge">
                {t(PROTOCOL_KEY[agent.protocol] ?? 'agent.protocolCli')}
              </span>
              <span className="lr-setting__hint">{capability?.version ?? '—'}</span>
              <span
                className="lr-agent-manager__status"
                data-ok={capability?.available === true}
                title={capability?.error ?? undefined}
              >
                {capability?.available ? t('settings.agent.available') : t('settings.agent.unavailable')}
              </span>
              {agent.builtin ? <span className="lr-setting__hint">{t('settings.agent.builtin')}</span> : null}
            </div>

            {capability && !capability.available && capability.error ? (
              <div className="lr-setting__hint">{t('settings.agent.probeFailed', { reason: capability.error })}</div>
            ) : null}
            {agent.credentialOk === false ? (
              <div className="lr-setting__hint">{t('settings.agent.credentialMissing')}</div>
            ) : null}
            {agent.credentialOk === true ? (
              <div className="lr-setting__hint">{t('settings.agent.credentialOk')}</div>
            ) : null}

            <div className="lr-agent-manager__fields">
              <label>
                <span>{t('settings.agent.executable')}</span>
                <input
                  type="text"
                  spellCheck={false}
                  placeholder={t('settings.agent.executablePlaceholder')}
                  value={value.executable}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [agent.id]: { ...value, executable: event.target.value } }))
                  }
                />
              </label>
              <label>
                <span>{t('settings.agent.args')}</span>
                <textarea
                  rows={2}
                  spellCheck={false}
                  value={value.args}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, [agent.id]: { ...value, args: event.target.value } }))
                  }
                />
              </label>
            </div>

            <div className="lr-agent-manager__actions">
              <button className="lr-button lr-button--secondary" disabled={busy !== null} onClick={() => void save(agent)}>
                {busy === agent.id ? t('settings.agent.probing') : t('settings.agent.saveAndProbe')}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
