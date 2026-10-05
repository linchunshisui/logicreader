/// <reference lib="webworker" />
/**
 * 布局 Worker：ELK 分层 / 力导向（d3-force）在 Worker 中计算，
 * 主线程只接收最终坐标（规划书 §4.4 / §5.5.9）。
 */
import ELK from 'elkjs/lib/elk-api.js'
import { forceCenter, forceLink, forceManyBody, forceSimulation, type SimulationNodeDatum } from 'd3-force'

interface LayoutNode {
  id: string
  width: number
  height: number
  parentId?: string | null
}

interface LayoutEdge {
  id: string
  source: string
  target: string
}

interface LayoutRequest {
  mode: 'layered' | 'force' | 'radial'
  direction?: 'RIGHT' | 'DOWN'
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  /** 冻结的坐标（增量布局时保留人工摆放） */
  frozen?: Record<string, { x: number; y: number }>
}

/**
 * ELK 的 bundled 版本在打包环境下依赖 `require` 加载内部 worker，会失效。
 * 这里按官方推荐方式使用 elk-api，并显式提供一个真正的 Worker 实例。
 */
let elkInstance: InstanceType<typeof ELK> | null = null

function getElk(): InstanceType<typeof ELK> {
  if (!elkInstance) {
    const worker = new Worker(new URL('elkjs/lib/elk-worker.min.js', import.meta.url))
    elkInstance = new ELK({ workerFactory: () => worker, workerUrl: undefined })
  }
  return elkInstance
}

async function layered(request: LayoutRequest): Promise<Record<string, { x: number; y: number }>> {
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': request.direction ?? 'RIGHT',
      /**
       * 分层布局的可读性参数（键名已按本机 elkjs 0.12 的 `org.eclipse.elk.*` 选项表核对过，
       * 写错会被 ELK 静默忽略 —— 图看起来"没变"但没人知道为什么）。
       *
       * 三个方向：
       * 1. **少交叉**：交叉数是节点连线图可读性最核心的指标（每条交叉都是视线的一次断裂）。
       * 2. **多直边、少折点**：折线越多越难从 A 跟到 B，去掉无谓拐点、优先直边。
       * 3. **留白**：节点、连线、连线标签之间都要留缝，否则标签会压在框上互相盖住。
       */
      'elk.layered.spacing.nodeNodeBetweenLayers': '140',
      'elk.spacing.nodeNode': '56',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.nodePlacement.favorStraightEdges': 'true',
      'elk.layered.unnecessaryBendpoints': 'true',
      'elk.spacing.edgeNode': '24',
      'elk.spacing.edgeEdge': '10',
      'elk.layered.spacing.edgeNodeBetweenLayers': '24',
      // 连线标签是 10px 的小底色块，和边挤在一起时最先被压掉
      'elk.spacing.edgeLabel': '6',
      'elk.edgeRouting': 'SPLINES'
    },
    children: request.nodes.map((node) => ({
      id: node.id,
      width: node.width,
      height: node.height
    })),
    edges: request.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] }))
  }
  const result = await getElk().layout(graph as never)
  const out: Record<string, { x: number; y: number }> = {}
  for (const child of (result.children ?? []) as { id: string; x?: number; y?: number }[]) {
    out[child.id] = { x: child.x ?? 0, y: child.y ?? 0 }
  }
  return out
}

function forceLayout(request: LayoutRequest): Record<string, { x: number; y: number }> {
  interface Node extends SimulationNodeDatum {
    id: string
  }
  const nodes: Node[] = request.nodes.map((node) => ({
    id: node.id,
    x: request.frozen?.[node.id]?.x,
    y: request.frozen?.[node.id]?.y,
    fx: request.frozen?.[node.id] ? request.frozen[node.id].x : undefined,
    fy: request.frozen?.[node.id] ? request.frozen[node.id].y : undefined
  }))
  const links = request.edges.map((edge) => ({ source: edge.source, target: edge.target }))
  const simulation = forceSimulation(nodes)
    .force('charge', forceManyBody().strength(-420))
    .force('link', forceLink(links).id((node) => (node as Node).id).distance(180).strength(0.4))
    .force('center', forceCenter(0, 0))
    .stop()
  for (let i = 0; i < 320; i += 1) simulation.tick()
  const out: Record<string, { x: number; y: number }> = {}
  for (const node of nodes) out[node.id] = { x: node.x ?? 0, y: node.y ?? 0 }
  return out
}

function radialLayout(request: LayoutRequest): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {}
  const roots = request.nodes.filter((node) => !node.parentId)
  const children = request.nodes.filter((node) => node.parentId)
  roots.forEach((node, index) => {
    out[node.id] = { x: index * 320, y: 0 }
  })
  const perRoot = new Map<string, number>()
  for (const node of children) {
    const index = perRoot.get(node.parentId as string) ?? 0
    perRoot.set(node.parentId as string, index + 1)
    const angle = (index / Math.max(1, children.length)) * Math.PI * 2
    const radius = 260 + Math.floor(index / 8) * 160
    out[node.id] = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
  }
  return out
}

self.onmessage = async (event: MessageEvent<LayoutRequest>): Promise<void> => {
  const request = event.data
  try {
    let positions: Record<string, { x: number; y: number }>
    if (request.mode === 'force') positions = forceLayout(request)
    else if (request.mode === 'radial') positions = radialLayout(request)
    else positions = await layered(request)
    if (request.frozen) {
      for (const [id, point] of Object.entries(request.frozen)) positions[id] = point
    }
    self.postMessage({ ok: true, positions })
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

export {}
