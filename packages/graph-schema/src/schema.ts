/** 关系图导出/导入 JSON Schema —— 规划书 §7.2。 */
export const GRAPH_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'LogicGraph',
  type: 'object',
  required: ['version', 'docId', 'docHash', 'nodes', 'edges'],
  properties: {
    version: { const: 1 },
    docId: { type: 'string' },
    docHash: { type: 'string' },
    title: { type: 'string' },
    generatedAt: { type: 'string', format: 'date-time' },
    agent: { type: 'string' },
    nodes: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'kind', 'title', 'anchors'],
        properties: {
          id: { type: 'string' },
          kind: {
            enum: ['claim', 'conclusion', 'evidence', 'definition', 'data', 'method', 'inquiry', 'selection']
          },
          title: { type: 'string', maxLength: 40 },
          summary: { type: 'string', maxLength: 200 },
          anchors: { type: 'array', minItems: 1, items: { $ref: '#/$defs/anchor' } },
          parentId: { type: ['string', 'null'] },
          clusterId: { type: ['string', 'null'] },
          position: {
            type: 'object',
            properties: { x: { type: 'number' }, y: { type: 'number' } }
          }
        }
      }
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'from', 'to', 'kind'],
        properties: {
          id: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          kind: {
            enum: ['causes', 'supports', 'refutes', 'elaborates', 'contrasts', 'sequences', 'defines', 'references', 'inquiry']
          },
          label: { type: 'string', maxLength: 24 },
          anchors: { type: 'array', items: { $ref: '#/$defs/anchor' } },
          weight: { type: 'number', default: 1 }
        }
      }
    }
  },
  $defs: {
    anchor: {
      type: 'object',
      required: ['docId', 'docHash', 'charStart', 'charEnd', 'quote'],
      properties: {
        docId: { type: 'string' },
        docHash: { type: 'string' },
        charStart: { type: 'integer' },
        charEnd: { type: 'integer' },
        quote: { type: 'string', maxLength: 400 },
        primary: { type: 'object' },
        extras: { type: 'array', items: { type: 'object' } }
      }
    }
  }
} as const

/** Map 阶段要求 Agent 返回的严格 JSON 结构（规划书 §5.5.2 步骤 3）。 */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  required: ['entities', 'relations'],
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'type', 'summary', 'evidence', 'spans'],
        properties: {
          name: { type: 'string' },
          type: {
            enum: ['claim', 'conclusion', 'evidence', 'definition', 'data', 'method']
          },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          spans: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['charStart', 'charEnd'],
              properties: { charStart: { type: 'integer' }, charEnd: { type: 'integer' } }
            }
          }
        }
      }
    },
    relations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['from', 'to', 'type', 'evidence', 'spans'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          type: { type: 'string' },
          label: { type: 'string' },
          /** 原文对这一关系的断言强度 1..10；缺省时按"未给出"处理（不影响任何过滤，只影响渲染粗细） */
          strength: { type: 'integer', minimum: 1, maximum: 10 },
          evidence: { type: 'string' },
          spans: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['charStart', 'charEnd'],
              properties: { charStart: { type: 'integer' }, charEnd: { type: 'integer' } }
            }
          }
        }
      }
    }
  }
} as const

/**
 * 抽取提示词的版本号，随图落库（`generation.promptVersion`），用于分辨"这张图是哪一版提示词抽的"。
 *
 * 1.1.0 相对 1.0.0 的两处契约变化：
 *  - 提交给模型的片段文本可能是**源文件原文切片**，spans 改按**片段内相对偏移**解释；
 *  - relations 增加 `strength`（1..10）。
 */
export const PROMPT_VERSION = 'lr-graph-1.1.0'
