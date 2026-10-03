import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentModelView, GraphPrecision } from '@logicreader/shared'
import { EDGE_KINDS, PRECISION_PROFILES, edgeLabel, type EdgeKind } from '@logicreader/graph-schema'
import { api } from '../../lib/api'
import { useAgent } from '../../state/agent.store'
import { useSettings } from '../../state/settings.store'
import type { GenerateRequest } from '../../state/graph.store'
import i18n from '../../i18n'

interface Estimate {
  chunkCount: number
  documentTokens: number
  totalTokens: number
  minutes: [number, number]
  nodes: [number, number]
  edges: [number, number]
}

interface Props {
  open: boolean
  docId: string
  docTitle: string
  onClose: () => void
  onStart: (request: GenerateRequest) => Promise<void>
}

export function GenerationDialog({ open, docId, docTitle, onClose, onStart }: Props): JSX.Element | null {
  const { t } = useTranslation()
  const { settings, patch } = useSettings()
  const agent = useAgent()
  const [precision, setPrecision] = useState<GraphPrecision>(settings.graph.precision)
  const [agentId, setAgentId] = useState<string | null>(agent.selectedAgentId)
  const [modelId, setModelId] = useState<string | null>(agent.modelId)
  const [effort, setEffort] = useState<string | null>(agent.thinkingEffort)
  const [advanced, setAdvanced] = useState(false)
  const [scope, setScope] = useState<'full' | 'section' | 'from-page'>('full')
  const [nodeLimit, setNodeLimit] = useState(settings.graph.targetNodeLimit)
  const [chunkTokens, setChunkTokens] = useState(settings.graph.chunkTokens)
  const [concurrency, setConcurrency] = useState(settings.graph.concurrency)
  const [threshold, setThreshold] = useState(settings.graph.entityResolutionThreshold)
  const [edgeKinds, setEdgeKinds] = useState<EdgeKind[]>(settings.graph.edgeKinds as EdgeKind[])
  const [estimate, setEstimate] = useState<Estimate | null>(null)
  /** 对话框里临时切换到非当前 Agent 时，单独探测来的真实模型清单（当前 Agent 的由 ensureModels 负责） */
  const [probedModels, setProbedModels] = useState<Record<string, AgentModelView[]>>({})
  const [presets, setPresets] = useState<{ name: string; precision: GraphPrecision; agentId: string; modelId: string | null; effort: string | null }[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void useAgent.getState().init()
  }, [])

  useEffect(() => {
    if (!open) return
    void api.graph.presets().then((list) => setPresets(list as never)).catch(() => undefined)
  }, [open])

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => {
      void api.graph
        .estimate({
          docId,
          agentId: agentId ?? 'mock',
          modelId,
          thinkingEffort: effort,
          precision,
          nodeLimit,
          chunkTokens,
          concurrency,
          entityThreshold: threshold,
          edgeKinds
        })
        .then((value) => setEstimate(value as Estimate))
        .catch(() => setEstimate(null))
    }, 120)
    return () => clearTimeout(timer)
  }, [open, docId, agentId, modelId, effort, precision, nodeLimit, chunkTokens, concurrency, threshold, edgeKinds])

  const capability = useMemo(
    () => agent.agents.find((item) => item.id === agentId)?.capability ?? null,
    [agent.agents, agentId]
  )
  const availableAgents = agent.agents.filter((item) => item.capability?.available)
  /**
   * 模型清单以「CLI 亲口说的真实清单」为准（与 Agent 面板同一来源），拿不到时退到能力探测的兜底档位名。
   * 兜底清单只有 opus/sonnet/haiku 档位名；用户把 Claude Code 指向第三方代理后，
   * 真实模型名只能从 supportedModels() 探测来。真实清单不带思考档位（thoughtLevels），
   * 按 id 从兜底清单补回来，避免思考强度选择器退化。
   */
  const models = useMemo(() => {
    const base = capability?.models ?? []
    const resolved = agentId === agent.selectedAgentId ? agent.resolvedModels : (probedModels[agentId ?? ''] ?? [])
    if (resolved.length === 0) return base
    return resolved.map((item) => {
      const fallback = base.find((entry) => entry.id === item.id)
      return {
        ...item,
        description: item.description ?? fallback?.description,
        thoughtLevels: item.thoughtLevels ?? fallback?.thoughtLevels,
        defaultThoughtLevel: item.defaultThoughtLevel ?? fallback?.defaultThoughtLevel
      }
    })
  }, [capability, agent.resolvedModels, probedModels, agentId, agent.selectedAgentId])
  const thoughtLevels = useMemo(() => models.find((item) => item.id === modelId)?.thoughtLevels ?? [], [models, modelId])

  useEffect(() => {
    if (models.length === 0) return
    // 真实清单异步到达后当前选择可能不在清单里（例如兜底档位的 default）—— 落到第一项，避免选择器空白
    if (!modelId || !models.some((item) => item.id === modelId)) setModelId(models[0].id)
  }, [models, modelId])

  /**
   * 打开对话框即探测真实模型清单（与 Agent 面板同一来源）：
   * 当前选中的 Agent 走 store 的 ensureModels；对话框里换成别的 Agent 时单独起探测进程。
   */
  useEffect(() => {
    if (!open || !agentId) return
    if (agentId === agent.selectedAgentId) {
      void useAgent.getState().ensureModels()
      return
    }
    if (probedModels[agentId]) return
    let cancelled = false
    void api.agent
      .probeModels(agentId)
      .then((list) => {
        if (!cancelled && list.length > 0) setProbedModels((prev) => ({ ...prev, [agentId]: list }))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [open, agentId, agent.selectedAgentId, probedModels])

  useEffect(() => {
    if (thoughtLevels.length === 0) {
      setEffort(null)
      return
    }
    if (!effort || !thoughtLevels.some((level) => level.id === effort)) {
      // 真实清单没声明默认档位时优先落到 medium（最低档跑全文抽取容易丢边），没有再退第一档
      const declared = models.find((item) => item.id === modelId)?.defaultThoughtLevel
      setEffort(declared ?? (thoughtLevels.some((level) => level.id === 'medium') ? 'medium' : thoughtLevels[0].id))
    }
  }, [thoughtLevels, effort, modelId, models])

  if (!open) return null

  const start = async (): Promise<void> => {
    if (!agentId) return
    setBusy(true)
    try {
      await patch({ graph: { precision, chunkTokens, concurrency, entityResolutionThreshold: threshold, edgeKinds, targetNodeLimit: nodeLimit } })
      await onStart({
        docId,
        graphId: null,
        agentId,
        modelId,
        thinkingEffort: effort,
        precision,
        scope,
        nodeLimit,
        chunkTokens,
        concurrency,
        entityThreshold: threshold,
        edgeKinds
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lr-overlay" onMouseDown={onClose}>
      <div className="lr-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div className="lr-dialog__title">{t('graph.configureTitle')}</div>
        <div className="lr-dialog__subtitle">{docTitle}</div>

        <div className="lr-dialog__row">
          <label>{t('graph.agent')}</label>
          <select value={agentId ?? ''} onChange={(event) => setAgentId(event.target.value || null)}>
            <option value="">{t('graph.selectAgentRequired')}</option>
            {availableAgents.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
                {item.capability?.version ? ' ' + item.capability.version : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="lr-dialog__row">
          <label>{t('graph.model')}</label>
          <select value={modelId ?? ''} onChange={(event) => setModelId(event.target.value || null)}>
            {models.length === 0 ? <option value="">{t('graph.manualModel')}</option> : null}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.resolvedModel
                  ? model.id.toLowerCase() === model.resolvedModel.toLowerCase()
                    ? model.name
                    : model.name + '（' + t('agent.modelAliasHint', { alias: model.id, real: model.resolvedModel }) + '）'
                  : model.name}
              </option>
            ))}
          </select>
        </div>

        <div className="lr-dialog__row">
          <label>{t('graph.effort')}</label>
          <select value={effort ?? ''} disabled={thoughtLevels.length === 0} onChange={(event) => setEffort(event.target.value || null)}>
            {thoughtLevels.length === 0 ? <option value="">{t('graph.effortUnsupported')}</option> : null}
            {thoughtLevels.map((level) => (
              <option key={level.id} value={level.id}>
                {level.name}
              </option>
            ))}
          </select>
          {thoughtLevels.length === 0 && modelId ? (
            <span className="lr-setting__hint">{t('graph.effortUnsupportedReason', { model: modelId })}</span>
          ) : null}
        </div>

        <div className="lr-dialog__precision">
          {(Object.keys(PRECISION_PROFILES) as GraphPrecision[]).map((id) => (
            <label key={id} className="lr-dialog__precision-item" data-active={precision === id}>
              <input type="radio" checked={precision === id} onChange={() => setPrecision(id)} />
              <span>
                {t('graph.precision' + id.charAt(0).toUpperCase() + id.slice(1))}
                <span className="lr-setting__hint">
                  {PRECISION_PROFILES[id].targetNodes[0]}–{PRECISION_PROFILES[id].targetNodes[1]}
                </span>
              </span>
            </label>
          ))}
        </div>

        {estimate ? (
          <div className="lr-dialog__estimate">
            <div>
              <span className="lr-setting__hint">{t('graph.estimateNodes')}</span>
              <strong>
                {t('graph.estimateNodesValue', { min: estimate.nodes[0], max: estimate.nodes[1], edges: estimate.edges[0] })}
              </strong>
            </div>
            <div>
              <span className="lr-setting__hint">{t('graph.estimateCost')}</span>
              <strong>
                {t('graph.estimateCostValue', {
                  tokens: estimate.totalTokens.toLocaleString(),
                  minutes: estimate.minutes[0] + '–' + estimate.minutes[1]
                })}
              </strong>
            </div>
          </div>
        ) : null}

        <button className="lr-dialog__advanced-toggle" onClick={() => setAdvanced((value) => !value)}>
          {advanced ? '▾' : '▸'} {t('graph.advanced')}
        </button>

        {advanced ? (
          <div className="lr-dialog__advanced">
            <div className="lr-dialog__row">
              <label>{t('graph.scope')}</label>
              <select value={scope} onChange={(event) => setScope(event.target.value as 'full')}>
                <option value="full">{t('graph.scopeFull')}</option>
                <option value="section" disabled>
                  {t('graph.scopeSection')}
                </option>
                <option value="from-page" disabled>
                  {t('graph.scopeFromPage')}
                </option>
              </select>
            </div>
            <div className="lr-dialog__row">
              <label>{t('graph.nodeLimit')}</label>
              <input type="number" value={nodeLimit} min={20} max={2000} onChange={(event) => setNodeLimit(Number(event.target.value))} />
            </div>
            <div className="lr-dialog__row">
              <label>{t('graph.chunkSize')}</label>
              <input type="number" value={chunkTokens} min={500} step={100} onChange={(event) => setChunkTokens(Number(event.target.value))} />
              <span className="lr-setting__hint">{t('graph.chunkSizeUnit')}</span>
            </div>
            <div className="lr-dialog__row">
              <label>{t('graph.concurrency')}</label>
              <input type="number" value={concurrency} min={1} max={6} onChange={(event) => setConcurrency(Number(event.target.value))} />
            </div>
            <div className="lr-dialog__row">
              <label>{t('graph.entityThreshold')}</label>
              <input type="number" value={threshold} min={0.5} max={1} step={0.01} onChange={(event) => setThreshold(Number(event.target.value))} />
            </div>
            <div className="lr-dialog__row lr-dialog__row--wrap">
              <label>{t('graph.edgeKinds')}</label>
              <div className="lr-dialog__chips">
                {EDGE_KINDS.map((kind) => (
                  <label key={kind} className="lr-chip" data-active={edgeKinds.includes(kind)}>
                    <input
                      type="checkbox"
                      checked={edgeKinds.includes(kind)}
                      onChange={() =>
                        setEdgeKinds((current) =>
                          current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind]
                        )
                      }
                    />
                    {edgeLabel(kind, i18n.language)}
                  </label>
                ))}
              </div>
            </div>
            <div className="lr-dialog__row">
              <label>{t('graph.presets')}</label>
              <div className="lr-dialog__presets">
                {presets.map((preset) => (
                  <button
                    key={preset.name}
                    className="lr-chip"
                    onClick={() => {
                      setPrecision(preset.precision)
                      setAgentId(preset.agentId)
                      setModelId(preset.modelId)
                      setEffort(preset.effort)
                    }}
                  >
                    {preset.name}
                  </button>
                ))}
                <button
                  className="lr-chip"
                  onClick={async () => {
                    const name = await api.dialog.message({
                      type: 'question',
                      message: t('graph.presetName'),
                      buttons: [t('common.save'), t('common.cancel')],
                      cancelId: 1
                    })
                    if (name !== 0) return
                    const fallback = capability?.displayName ?? 'preset'
                    const next = await api.graph.savePreset({
                      name: t('graph.presets') + ' ' + (presets.length + 1) + ' · ' + fallback,
                      precision,
                      agentId,
                      modelId,
                      effort
                    })
                    setPresets(next as never)
                  }}
                >
                  ＋ {t('graph.savePreset')}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {!agentId ? <div className="lr-dialog__warning">{t('graph.selectAgentRequired')}</div> : null}

        <div className="lr-dialog__actions">
          <button className="lr-button" disabled={!agentId || busy} onClick={() => void start()}>
            {t('graph.startGenerate')}
          </button>
          <button className="lr-button lr-button--secondary" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
