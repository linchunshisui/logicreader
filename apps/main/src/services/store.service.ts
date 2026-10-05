/**
 * 持久化服务（SQLite 主库）—— 规划书 §7.1。
 * 优先使用 Electron 内置的 node:sqlite（Node 22+ 自带，无需原生编译）；
 * 若运行环境缺失该模块，则降级为单文件 JSON 后端，保证阅读器核心功能可用。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type {
  AnchorRecord, AnnotationRecord, BlockRecord, DocumentRecord, SearchHit
} from '@logicreader/shared'
import { emptyStats, type EdgeKind, type GraphEdge, type GraphNode, type LogicGraph, type NodeKind } from '@logicreader/graph-schema'
import { logMain } from '../util/ipc'

type SqlValue = string | number | bigint | null | Uint8Array

interface Stmt {
  run: (...params: SqlValue[]) => { changes: number | bigint }
  all: (...params: SqlValue[]) => unknown[]
  get: (...params: SqlValue[]) => unknown
}

interface Db {
  exec: (sql: string) => void
  prepare: (sql: string) => Stmt
  close: () => void
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS documents (
    id            TEXT PRIMARY KEY,
    path          TEXT NOT NULL,
    format        TEXT NOT NULL,
    title         TEXT,
    doc_hash      TEXT NOT NULL,
    size_bytes    INTEGER,
    page_count    INTEGER,
    text_length   INTEGER NOT NULL,
    outline_json  TEXT,
    opened_at     INTEGER NOT NULL,
    last_page     INTEGER DEFAULT 1,
    meta_json     TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS blocks (
    id          TEXT PRIMARY KEY,
    doc_id      TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    kind        TEXT NOT NULL,
    level       INTEGER,
    text        TEXT NOT NULL,
    char_start  INTEGER NOT NULL,
    char_end    INTEGER NOT NULL,
    locator_json TEXT NOT NULL,
    parent_id   TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_blocks_doc_seq ON blocks(doc_id, seq)',
  `CREATE TABLE IF NOT EXISTS anchors (
    id          TEXT PRIMARY KEY,
    doc_id      TEXT NOT NULL,
    doc_hash    TEXT NOT NULL,
    block_ids   TEXT NOT NULL,
    char_start  INTEGER NOT NULL,
    char_end    INTEGER NOT NULL,
    quote       TEXT NOT NULL,
    quote_hash  TEXT NOT NULL,
    primary_json TEXT NOT NULL,
    extras_json TEXT,
    status      TEXT NOT NULL DEFAULT 'ok'
  )`,
  'CREATE INDEX IF NOT EXISTS idx_anchors_quote ON anchors(doc_id, quote_hash)',
  `CREATE TABLE IF NOT EXISTS graphs (
    id            TEXT PRIMARY KEY,
    doc_id        TEXT NOT NULL,
    doc_hash      TEXT,
    title         TEXT,
    agent_id      TEXT NOT NULL,
    agent_name    TEXT,
    model_id      TEXT,
    thinking_effort TEXT,
    prompt_version TEXT NOT NULL,
    precision     TEXT,
    scope         TEXT,
    status        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    stats_json    TEXT,
    ignored_edges_json TEXT,
    error         TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS graph_nodes (
    id          TEXT PRIMARY KEY,
    graph_id    TEXT NOT NULL,
    kind        TEXT NOT NULL,
    title       TEXT NOT NULL,
    summary     TEXT,
    anchor_ids  TEXT NOT NULL,
    parent_id   TEXT,
    cluster_id  TEXT,
    x REAL, y REAL,
    collapsed   INTEGER DEFAULT 0,
    meta_json   TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_nodes_graph ON graph_nodes(graph_id)',
  `CREATE TABLE IF NOT EXISTS graph_edges (
    id          TEXT PRIMARY KEY,
    graph_id    TEXT NOT NULL,
    from_id     TEXT NOT NULL,
    to_id       TEXT NOT NULL,
    kind        TEXT NOT NULL,
    label       TEXT,
    anchor_ids  TEXT NOT NULL,
    weight      REAL DEFAULT 1,
    meta_json   TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_edges_graph ON graph_edges(graph_id)',
  `CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    doc_id      TEXT NOT NULL,
    graph_id    TEXT,
    node_id     TEXT,
    agent_id    TEXT NOT NULL,
    mode        TEXT NOT NULL,
    remote_session_id TEXT,
    title       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    meta_json   TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    anchor_ids      TEXT,
    tool_calls_json TEXT,
    usage_json      TEXT,
    created_at      INTEGER NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at)',
  /**
   * 会话标题：历史会话列表的"人能看懂的名字"。
   *
   * 为什么要我们自己存：各通道给的名字参差不齐 —— Claude 有 summary/firstPrompt，
   * 而 dsh 的 ACP `session/list` **只回 sessionId 与 cwd**（实测），
   * 于是界面上只能显示一串 UUID（用户的原话："应支持总结命名，直观明了的知道内容是什么"）。
   * 这里存两类来源：用户手改（`manual`）与让 Agent 总结出来的（`ai`）。
   */
  `CREATE TABLE IF NOT EXISTS session_titles (
    agent_id   TEXT NOT NULL,
    session_id TEXT NOT NULL,
    title      TEXT NOT NULL,
    source     TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (agent_id, session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS annotations (
    id          TEXT PRIMARY KEY,
    doc_id      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    color       TEXT NOT NULL,
    anchor_id   TEXT NOT NULL,
    note        TEXT,
    created_at  INTEGER NOT NULL,
    extra_json  TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idx_annotations_doc ON annotations(doc_id)',
  'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  `CREATE TABLE IF NOT EXISTS agents (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    display_name TEXT NOT NULL,
    protocol    TEXT NOT NULL,
    executable  TEXT,
    args_json   TEXT,
    env_json    TEXT,
    enabled     INTEGER DEFAULT 1,
    capability_json TEXT,
    last_probe_at INTEGER
  )`
]

/**
 * 库级全文检索索引（跨文档搜索）。
 *
 * 为什么用 FTS5 而不是继续 `indexOf`：文档内查找可以在内存里扫，但"在所有打开过的文档里找一句话"
 * 只能靠索引 —— 把每个块都读进内存再扫一遍，文档一多就不可用。
 *
 * 为什么是 **trigram** 分词而不是默认的 unicode61：`unicode61` 会把一整串汉字当成**一个词**
 * （"逻辑阅读器"是一个 token），查"逻辑"就查不到；trigram 按三字滑窗建索引，得到的是**子串匹配**，
 * 中英文都能用 —— 也正好与用户已有的"文档内查找"手感一致（那里就是子串匹配）。
 *
 * 独立表（不是 external-content）：`saveBlocks` 本来就是"先删后插"整篇重写，
 * 这里跟着同一套动作同步，比挂触发器更好推理；而且 `block_id`/`doc_id`/`seq` 都存进来，
 * 命中后不必再回表取这几列。
 */
const FTS_SCHEMA = [
  `CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(
    block_id UNINDEXED,
    doc_id   UNINDEXED,
    seq      UNINDEXED,
    text,
    tokenize = 'trigram'
  )`
]

/**
 * trigram 索引最短只能匹配 3 个字符：比这短的词（"AI"、"熵"）走 LIKE 扫描兜底，
 * 否则用户会发现"两个字就是搜不到"——而这正是中文里最常见的情况。
 */
const FTS_MIN_QUERY = 3

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}
function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' ? v : v == null ? fallback : Number(v)
}
function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || v.length === 0) return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

/**
 * 老库补列：`CREATE TABLE IF NOT EXISTS` 不会给**已存在**的表加列，
 * 而 `graphs.title` / `graphs.doc_hash` 是后加的（关系图标签名与导出 JSON 都要用）。
 * 列已存在时 ALTER 会抛错，这里按"已经是目标形态"处理。
 */
function ensureColumn(db: Db, table: string, column: string, declaration: string): void {
  try {
    db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + declaration)
  } catch {
    /* 列已存在 */
  }
}

export class StoreService {
  private db: Db | null = null
  private file = ''
  private usingFallback = false
  /** FTS5 全文索引是否可用（不可用时跨文档检索退回逐行扫描） */
  private ftsReady = false

  open(file: string): void {
    this.file = file
    const mod = loadSqlite()
    if (!mod) {
      this.usingFallback = true
      logMain('warn', 'store', '未找到 node:sqlite，持久化降级为 JSON 单文件后端')
      return
    }
    try {
      const db = new mod.DatabaseSync(file)
      this.db = db as unknown as Db
      this.db.exec('PRAGMA journal_mode = WAL;')
      this.db.exec('PRAGMA foreign_keys = OFF;')
      for (const sql of SCHEMA) this.db.exec(sql)
      ensureColumn(this.db, 'graphs', 'doc_hash', 'TEXT')
      ensureColumn(this.db, 'graphs', 'title', 'TEXT')
      ensureColumn(this.db, 'graphs', StoreService.GEN_CONFIG_COLUMN, 'TEXT')
      /**
       * 消息的核心诉求摘要（历史回放显示"用户真正想问的那句"，实际提问保持完整原文——两者分开存）。
       * 旧库补列后历史消息 summary 为 NULL，回放退回显示 content。
       */
      ensureColumn(this.db, 'messages', 'summary', 'TEXT')
      this.ftsReady = this.initFts(this.db)
      logMain('info', 'store', 'SQLite 主库已就绪：' + file)
    } catch (error) {
      this.db = null
      this.usingFallback = true
      logMain('error', 'store', 'SQLite 打开失败，降级为 JSON 后端', String(error))
    }
  }

  backendName(): 'sqlite' | 'json' {
    return this.db ? 'sqlite' : 'json'
  }

  /**
   * 建全文索引，并做一次**自证式回填**。
   *
   * 为什么必须回填：索引是派生数据。老库升级上来时 `blocks` 里已经有几百篇文档的分块，
   * 而 `blocks_fts` 是刚建的、空的 —— 不回填的话"搜什么都搜不到"，而且**不报错**。
   * 判据用行数比对（派生数据必须能自证）：对不上就整批重建，与"锚点/文本层映射"同一套思路。
   *
   * 返回索引是否可用；建表失败（运行环境没编 FTS5）时返回 false，检索退回逐行扫描而不是静默失效。
   */
  private initFts(db: Db): boolean {
    try {
      for (const sql of FTS_SCHEMA) db.exec(sql)
    } catch (error) {
      logMain('warn', 'store', 'FTS5 不可用，跨文档检索退回逐行扫描', String(error))
      return false
    }
    try {
      const blocks = db.prepare('SELECT count(*) AS n FROM blocks').get() as { n?: number } | undefined
      const indexed = db.prepare('SELECT count(*) AS n FROM blocks_fts').get() as { n?: number } | undefined
      if (num(blocks?.n) !== num(indexed?.n)) {
        this.rebuildFts(db)
        logMain('info', 'store', '全文索引行数与 blocks 不一致，已整批重建')
      }
    } catch (error) {
      logMain('warn', 'store', '全文索引自检失败，整批重建', String(error))
      this.rebuildFts(db)
    }
    return true
  }

  /** 从 blocks 整批重建全文索引（首次建索引、自检不过、或索引写坏时用）。 */
  private rebuildFts(db: Db): void {
    db.exec('DELETE FROM blocks_fts')
    db.exec(
      `INSERT INTO blocks_fts (block_id, doc_id, seq, text)
       SELECT id, doc_id, seq, text FROM blocks`
    )
  }

  private requireDb(): Db {
    if (!this.db) throw new Error('持久化后端不可用')
    return this.db
  }

  // ------------------------------------------------------------- documents
  upsertDocument(doc: DocumentRecord): void {
    if (!this.db) return this.fallbackMutate((s) => upsertBy(s.documents, 'id', doc))
    this.requireDb().prepare(
      `INSERT INTO documents (id, path, format, title, doc_hash, size_bytes, page_count, text_length, outline_json, opened_at, last_page, meta_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         path=excluded.path, format=excluded.format, title=excluded.title, doc_hash=excluded.doc_hash,
         size_bytes=excluded.size_bytes, page_count=excluded.page_count, text_length=excluded.text_length,
         outline_json=excluded.outline_json, opened_at=excluded.opened_at, last_page=excluded.last_page,
         meta_json=excluded.meta_json`
    ).run(
      doc.id, doc.path, doc.format, doc.title, doc.docHash, doc.sizeBytes, doc.pageCount,
      doc.textLength, doc.outlineJson, doc.openedAt, doc.lastPage, doc.metaJson
    )
  }

  listDocuments(limit = 50): DocumentRecord[] {
    if (!this.db) return this.fallbackRead().documents.slice(0, limit)
    const rows = this.requireDb().prepare('SELECT * FROM documents ORDER BY opened_at DESC LIMIT ?').all(limit)
    return rows.map(rowToDocument)
  }

  getDocument(id: string): DocumentRecord | null {
    if (!this.db) return this.fallbackRead().documents.find((d) => d.id === id) ?? null
    const row = this.requireDb().prepare('SELECT * FROM documents WHERE id = ?').get(id)
    return row ? rowToDocument(row) : null
  }

  removeDocument(id: string): void {
    if (!this.db) {
      this.fallbackMutate((s) => {
        s.documents = s.documents.filter((d) => d.id !== id)
        s.blocks = s.blocks.filter((b) => b.docId !== id)
        s.anchors = s.anchors.filter((a) => a.docId !== id)
        s.annotations = s.annotations.filter((a) => a.docId !== id)
      })
      return
    }
    const db = this.requireDb()
    db.prepare('DELETE FROM blocks WHERE doc_id = ?').run(id)
    if (this.ftsReady) db.prepare('DELETE FROM blocks_fts WHERE doc_id = ?').run(id)
    db.prepare('DELETE FROM anchors WHERE doc_id = ?').run(id)
    db.prepare('DELETE FROM annotations WHERE doc_id = ?').run(id)
    db.prepare('DELETE FROM documents WHERE id = ?').run(id)
  }

  // ---------------------------------------------------------------- blocks
  saveBlocks(docId: string, blocks: BlockRecord[]): void {
    if (!this.db) {
      this.fallbackMutate((s) => {
        s.blocks = s.blocks.filter((b) => b.docId !== docId).concat(blocks)
      })
      return
    }
    const db = this.requireDb()
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM blocks WHERE doc_id = ?').run(docId)
      const stmt = db.prepare(
        'INSERT INTO blocks (id, doc_id, seq, kind, level, text, char_start, char_end, locator_json, parent_id) VALUES (?,?,?,?,?,?,?,?,?,?)'
      )
      for (const b of blocks) {
        stmt.run(b.id, b.docId, b.seq, b.kind, b.level, b.text, b.charStart, b.charEnd, b.locatorJson, b.parentId)
      }
      /**
       * 全文索引与 blocks 在**同一个事务**里同步：索引必须与正文同源，
       * 否则会出现"检索命中了一个已经不存在（或已改写）的块"，点进去跳转落空。
       * 整篇重写的代价可以接受 —— saveBlocks 本来就是"先删后插"。
       */
      if (this.ftsReady) {
        db.prepare('DELETE FROM blocks_fts WHERE doc_id = ?').run(docId)
        const ftsStmt = db.prepare('INSERT INTO blocks_fts (block_id, doc_id, seq, text) VALUES (?,?,?,?)')
        for (const b of blocks) ftsStmt.run(b.id, b.docId, b.seq, b.text)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  getBlocks(docId: string): BlockRecord[] {
    if (!this.db) return this.fallbackRead().blocks.filter((b) => b.docId === docId).sort((a, b) => a.seq - b.seq)
    return this.requireDb()
      .prepare('SELECT * FROM blocks WHERE doc_id = ? ORDER BY seq ASC')
      .all(docId)
      .map((r) => {
        const row = r as Record<string, unknown>
        return {
          id: str(row.id),
          docId: str(row.doc_id),
          seq: num(row.seq),
          kind: str(row.kind),
          level: row.level == null ? null : num(row.level),
          text: str(row.text),
          charStart: num(row.char_start),
          charEnd: num(row.char_end),
          locatorJson: str(row.locator_json),
          parentId: row.parent_id == null ? null : str(row.parent_id)
        } satisfies BlockRecord
      })
  }

  /**
   * 跨文档全文检索：在**所有打开过的文档**里找一段文字。
   *
   * 三条路径，优先级从好到兜底，但**结果形状完全一致**（调用方不需要知道走的是哪条）：
   *   ① FTS5 trigram 索引（最短 3 字符）—— 默认路径；
   *   ② 查询词太短（"AI"、"熵"）时，FTS5 的 trigram 索引根本建不出匹配项，退回 LIKE 扫描；
   *   ③ 整个 SQLite 后端都不可用（JSON 降级模式）时，在内存里扫。
   * 之所以短词要单独兜底而不是让它静默返回空：两个字的中文词太常见了，
   * "搜不到还不报错"是最难排查的一类问题。
   */
  searchBlocks(query: string, limit = 50): SearchHit[] {
    const q = query.trim()
    if (q.length === 0 || limit <= 0) return []
    const needle = q.toLowerCase()

    /** 命中位置用于把结果滚到正文里的那一处；大小写不敏感，与文档内查找同一口径。 */
    const toHit = (row: Record<string, unknown>): SearchHit => {
      const text = str(row.text)
      return {
        docId: str(row.doc_id),
        docTitle: str(row.doc_title),
        docPath: str(row.doc_path),
        blockId: str(row.block_id),
        blockKind: str(row.block_kind),
        seq: num(row.seq),
        text,
        charStart: num(row.char_start),
        charEnd: num(row.char_end),
        matchStart: text.toLowerCase().indexOf(needle)
      }
    }

    if (!this.db) {
      const state = this.fallbackRead()
      const hits: SearchHit[] = []
      for (const block of state.blocks) {
        if (!block.text.toLowerCase().includes(needle)) continue
        const doc = state.documents.find((d) => d.id === block.docId)
        hits.push(
          toHit({
            block_id: block.id,
            doc_id: block.docId,
            doc_title: doc?.title ?? '',
            doc_path: doc?.path ?? '',
            block_kind: block.kind,
            seq: block.seq,
            text: block.text,
            char_start: block.charStart,
            char_end: block.charEnd
          })
        )
        if (hits.length >= limit) break
      }
      return hits
    }

    const db = this.requireDb()
    if (this.ftsReady && q.length >= FTS_MIN_QUERY) {
      /**
       * 把用户输入整体当作**一个短语**（双引号包裹、内部引号转义）：
       * FTS5 的查询串有自己的语法（AND / OR / NEAR / 前缀 * / 列限定），
       * 用户随手输入的括号或减号会被当成语法，轻则结果诡异、重则直接抛错。
       * 用引号包起来就只剩"找这段连续文字"一种含义，也正好是子串匹配。
       */
      const phrase = '"' + q.replace(/"/g, '""') + '"'
      const rows = db
        .prepare(
          `SELECT blocks_fts.block_id AS block_id,
                  blocks_fts.doc_id   AS doc_id,
                  blocks_fts.seq      AS seq,
                  blocks_fts.text     AS text,
                  b.char_start AS char_start,
                  b.char_end   AS char_end,
                  b.kind       AS block_kind,
                  d.title      AS doc_title,
                  d.path       AS doc_path
             FROM blocks_fts
             JOIN blocks    b ON b.id = blocks_fts.block_id
             JOIN documents d ON d.id = blocks_fts.doc_id
            WHERE blocks_fts MATCH ?
            ORDER BY bm25(blocks_fts)
            LIMIT ?`
        )
        .all(phrase, limit)
      return rows.map((r) => toHit(r as Record<string, unknown>))
    }

    // LIKE 兜底：`\` `%` `_` 是 LIKE 的通配符，必须转义，否则用户输入的 % 会变成"匹配任意"，结果全中
    const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%'
    const rows = db
      .prepare(
        `SELECT b.id AS block_id, b.doc_id AS doc_id, b.seq AS seq, b.text AS text,
                b.char_start AS char_start, b.char_end AS char_end, b.kind AS block_kind,
                d.title AS doc_title, d.path AS doc_path
           FROM blocks b
           JOIN documents d ON d.id = b.doc_id
          WHERE b.text LIKE ? ESCAPE '\\'
          ORDER BY b.doc_id, b.seq
          LIMIT ?`
      )
      .all(like, limit)
    return rows.map((r) => toHit(r as Record<string, unknown>))
  }

  // --------------------------------------------------------------- anchors
  saveAnchors(anchors: AnchorRecord[]): void {
    if (!this.db) {
      this.fallbackMutate((s) => {
        for (const a of anchors) upsertBy(s.anchors, 'id', a)
      })
      return
    }
    const db = this.requireDb()
    const stmt = db.prepare(
      `INSERT INTO anchors (id, doc_id, doc_hash, block_ids, char_start, char_end, quote, quote_hash, primary_json, extras_json, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET doc_hash=excluded.doc_hash, block_ids=excluded.block_ids,
         char_start=excluded.char_start, char_end=excluded.char_end, quote=excluded.quote,
         quote_hash=excluded.quote_hash, primary_json=excluded.primary_json,
         extras_json=excluded.extras_json, status=excluded.status`
    )
    db.exec('BEGIN')
    try {
      for (const a of anchors) {
        stmt.run(a.id, a.docId, a.docHash, a.blockIds, a.charStart, a.charEnd, a.quote, a.quoteHash, a.primaryJson, a.extrasJson, a.status)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  getAnchor(id: string): AnchorRecord | null {
    if (!this.db) return this.fallbackRead().anchors.find((a) => a.id === id) ?? null
    const row = this.requireDb().prepare('SELECT * FROM anchors WHERE id = ?').get(id)
    return row ? rowToAnchor(row) : null
  }

  listAnchors(docId: string): AnchorRecord[] {
    if (!this.db) return this.fallbackRead().anchors.filter((a) => a.docId === docId)
    return this.requireDb().prepare('SELECT * FROM anchors WHERE doc_id = ?').all(docId).map(rowToAnchor)
  }

  updateAnchor(anchor: AnchorRecord): void {
    this.saveAnchors([anchor])
  }

  // ----------------------------------------------------------- annotations
  listAnnotations(docId: string): AnnotationRecord[] {
    if (!this.db) return this.fallbackRead().annotations.filter((a) => a.docId === docId)
    return this.requireDb().prepare('SELECT * FROM annotations WHERE doc_id = ? ORDER BY created_at ASC').all(docId).map((r) => {
      const row = r as Record<string, unknown>
      return {
        id: str(row.id),
        docId: str(row.doc_id),
        kind: str(row.kind),
        color: str(row.color),
        anchorId: str(row.anchor_id),
        note: row.note == null ? null : str(row.note),
        createdAt: num(row.created_at),
        extraJson: row.extra_json == null ? null : str(row.extra_json)
      } satisfies AnnotationRecord
    })
  }

  upsertAnnotation(a: AnnotationRecord): void {
    if (!this.db) {
      this.fallbackMutate((s) => upsertBy(s.annotations, 'id', a))
      return
    }
    this.requireDb().prepare(
      `INSERT INTO annotations (id, doc_id, kind, color, anchor_id, note, created_at, extra_json)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, color=excluded.color, anchor_id=excluded.anchor_id,
         note=excluded.note, extra_json=excluded.extra_json`
    ).run(a.id, a.docId, a.kind, a.color, a.anchorId, a.note, a.createdAt, a.extraJson ?? null)
  }

  deleteAnnotation(id: string): void {
    if (!this.db) {
      this.fallbackMutate((s) => {
        s.annotations = s.annotations.filter((a) => a.id !== id)
      })
      return
    }
    this.requireDb().prepare('DELETE FROM annotations WHERE id = ?').run(id)
  }

  // ----------------------------------------------------------- graphs
  /**
   * 生成配置扩展列（`graphs.gen_config_json`）：generation 里那些"后加"的字段
   * （chunkTokens / edgeKinds / concurrency / entityThreshold / nodeLimit / sectionIds / fromPage）。
   *
   * 为什么单独放一列而不是塞进 stats_json：stats 是"统计结果"、generation 是"复现配置"，
   * 两者生命周期不同（统计会被预估消费，配置会被增量重试复现），混在一起将来清理谁都碍事。
   * 旧库没有这一列 —— `ensureColumn` 补上后历史图的 `gen_config_json` 为 NULL，
   * 重试会落回"请求字段"语义（与旧行为一致，不比之前差）。
   */
  private static readonly GEN_CONFIG_COLUMN = 'gen_config_json'

  graphSave(graph: LogicGraph): void {
    const now = Date.now()
    if (!this.db) {
      this.fallbackMutate((s) => {
        s.graphs = s.graphs.filter((g) => g.id !== graph.id).concat([graph])
      })
      return
    }
    const db = this.requireDb()
    db.exec('BEGIN')
    try {
      const genConfig = graph.generation ?? ({} as LogicGraph['generation'])
      const genConfigJson = JSON.stringify({
        chunkTokens: genConfig.chunkTokens ?? null,
        edgeKinds: genConfig.edgeKinds ?? null,
        concurrency: genConfig.concurrency ?? null,
        entityThreshold: genConfig.entityThreshold ?? null,
        nodeLimit: genConfig.nodeLimit ?? null,
        sectionIds: genConfig.sectionIds ?? null,
        fromPage: genConfig.fromPage ?? null
      })
      db.prepare(
        `INSERT INTO graphs (id, doc_id, doc_hash, title, agent_id, agent_name, model_id, thinking_effort, prompt_version, precision, scope, status, created_at, updated_at, stats_json, ignored_edges_json, error, ${StoreService.GEN_CONFIG_COLUMN})
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET doc_id=excluded.doc_id, doc_hash=excluded.doc_hash, title=excluded.title,
           agent_id=excluded.agent_id, agent_name=excluded.agent_name,
           model_id=excluded.model_id, thinking_effort=excluded.thinking_effort, prompt_version=excluded.prompt_version,
           precision=excluded.precision, scope=excluded.scope, status=excluded.status,
           updated_at=excluded.updated_at, stats_json=excluded.stats_json,
           ignored_edges_json=excluded.ignored_edges_json, error=excluded.error, ${StoreService.GEN_CONFIG_COLUMN}=excluded.${StoreService.GEN_CONFIG_COLUMN}`
      ).run(
        graph.id, graph.docId, graph.docHash, graph.title,
        graph.generation.agentId, graph.generation.agentName, graph.generation.modelId,
        graph.generation.thinkingEffort, graph.generation.promptVersion, graph.generation.precision, graph.generation.scope,
        graph.status, graph.createdAt || now, graph.updatedAt || now,
        JSON.stringify(graph.stats ?? emptyStats()), JSON.stringify(graph.ignoredEdges ?? []), graph.error ?? null,
        genConfigJson
      )
      db.prepare('DELETE FROM graph_nodes WHERE graph_id = ?').run(graph.id)
      db.prepare('DELETE FROM graph_edges WHERE graph_id = ?').run(graph.id)
      const nStmt = db.prepare(
        'INSERT INTO graph_nodes (id, graph_id, kind, title, summary, anchor_ids, parent_id, cluster_id, x, y, collapsed, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
      )
      for (const n of graph.nodes) {
        nStmt.run(
          n.id, graph.id, n.kind, n.title, n.summary ?? '', JSON.stringify(n.anchorIds ?? []),
          n.parentId ?? null, n.clusterId ?? null, n.x ?? null, n.y ?? null, n.collapsed ? 1 : 0,
          JSON.stringify({ pinned: n.pinned ?? null, meta: n.meta ?? null })
        )
      }
      const eStmt = db.prepare(
        'INSERT INTO graph_edges (id, graph_id, from_id, to_id, kind, label, anchor_ids, weight, meta_json) VALUES (?,?,?,?,?,?,?,?,?)'
      )
      for (const e of graph.edges) {
        eStmt.run(e.id, graph.id, e.from, e.to, e.kind, e.label ?? '', JSON.stringify(e.anchorIds ?? []), e.weight ?? 1, JSON.stringify(e.meta ?? null))
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  graphList(docId: string): unknown[] {
    if (!this.db) {
      return this.fallbackRead().graphs.filter((g) => g.docId === docId).map(graphSummary)
    }
    return this.requireDb()
      .prepare('SELECT id, doc_id, doc_hash, title, agent_id, agent_name, model_id, thinking_effort, precision, status, created_at, updated_at, stats_json, error FROM graphs WHERE doc_id = ? ORDER BY updated_at DESC')
      .all(docId)
      .map((r) => {
        const row = r as Record<string, unknown>
        return {
          id: str(row.id),
          docId: str(row.doc_id),
          docHash: str(row.doc_hash ?? ''),
          title: str(row.title ?? ''),
          agentId: str(row.agent_id),
          agentName: str(row.agent_name ?? ''),
          modelId: row.model_id == null ? null : str(row.model_id),
          thinkingEffort: row.thinking_effort == null ? null : str(row.thinking_effort),
          precision: str(row.precision ?? 'structure'),
          status: str(row.status),
          createdAt: num(row.created_at),
          updatedAt: num(row.updated_at),
          stats: parseJson(row.stats_json, emptyStats()),
          error: row.error == null ? null : str(row.error)
        }
      })
  }

  graphGet(graphId: string): LogicGraph | null {
    if (!this.db) {
      const g = this.fallbackRead().graphs.find((x) => x.id === graphId)
      return g ? (JSON.parse(JSON.stringify(g)) as LogicGraph) : null
    }
    const db = this.requireDb()
    const g = db.prepare('SELECT * FROM graphs WHERE id = ?').get(graphId) as Record<string, unknown> | undefined
    if (!g) return null
    const nodes = db.prepare('SELECT * FROM graph_nodes WHERE graph_id = ?').all(graphId).map((r) => {
      const row = r as Record<string, unknown>
      const meta = parseJson<{ pinned?: GraphNode['pinned']; meta?: Record<string, unknown> }>(row.meta_json, {})
      return {
        id: str(row.id),
        graphId,
        kind: str(row.kind) as NodeKind,
        title: str(row.title),
        summary: str(row.summary ?? ''),
        anchorIds: parseJson<string[]>(row.anchor_ids, []),
        parentId: row.parent_id == null ? null : str(row.parent_id),
        clusterId: row.cluster_id == null ? null : str(row.cluster_id),
        x: row.x == null ? null : num(row.x),
        y: row.y == null ? null : num(row.y),
        collapsed: num(row.collapsed) === 1,
        pinned: meta.pinned ?? undefined,
        meta: meta.meta ?? undefined
      } satisfies GraphNode
    })
    const edges = db.prepare('SELECT * FROM graph_edges WHERE graph_id = ?').all(graphId).map((r) => {
      const row = r as Record<string, unknown>
      return {
        id: str(row.id),
        graphId,
        from: str(row.from_id),
        to: str(row.to_id),
        kind: str(row.kind) as EdgeKind,
        label: str(row.label ?? ''),
        anchorIds: parseJson<string[]>(row.anchor_ids, []),
        weight: num(row.weight, 1)
      } satisfies GraphEdge
    })
    this.attachAnchors(nodes, edges)
    const genConfig = parseJson<Partial<LogicGraph['generation']>>(g[StoreService.GEN_CONFIG_COLUMN as keyof typeof g] as string, {})
    return {
      id: str(g.id),
      docId: str(g.doc_id),
      docHash: str(g.doc_hash ?? ''),
      title: str(g.title ?? ''),
      version: 1,
      createdAt: num(g.created_at),
      updatedAt: num(g.updated_at),
      status: str(g.status) as LogicGraph['status'],
      generation: {
        agentId: str(g.agent_id),
        agentName: str(g.agent_name ?? ''),
        modelId: g.model_id == null ? null : str(g.model_id),
        thinkingEffort: g.thinking_effort == null ? null : str(g.thinking_effort),
        precision: str(g.precision ?? 'structure'),
        promptVersion: str(g.prompt_version),
        scope: str(g.scope ?? 'full'),
        // 生成配置扩展字段（增量重试按它复现同一套分块；旧图没有就是 undefined）
        chunkTokens: genConfig.chunkTokens ?? null,
        edgeKinds: genConfig.edgeKinds ?? null,
        concurrency: genConfig.concurrency ?? null,
        entityThreshold: genConfig.entityThreshold ?? null,
        nodeLimit: genConfig.nodeLimit ?? null,
        sectionIds: genConfig.sectionIds ?? null,
        fromPage: genConfig.fromPage ?? null
      },
      nodes,
      edges,
      stats: parseJson(g.stats_json, emptyStats()),
      ignoredEdges: parseJson(g.ignored_edges_json, []),
      error: g.error == null ? null : str(g.error)
    }
  }

  private attachAnchors(nodes: GraphNode[], edges: GraphEdge[]): void {
    const ids = new Set<string>()
    for (const n of nodes) n.anchorIds.forEach((a) => ids.add(a))
    for (const e of edges) e.anchorIds.forEach((a) => ids.add(a))
    if (ids.size === 0) return
    /**
     * **批量**取锚点：一张 200 节点 / 400 边的图带一千多个锚点引用，
     * 逐条 `getAnchor(id)` 就是上千次单行 SQL —— 生成完成后 reload 会实打实卡一下。
     * SQLite 的变量上限（老版 999）内分批 `IN` 查询，一两趟拿完；JSON 后端一次内存筛选。
     */
    const map = new Map<string, unknown>()
    const toView = (a: AnchorRecord): unknown => ({
      docId: a.docId,
      docHash: a.docHash,
      charStart: a.charStart,
      charEnd: a.charEnd,
      quote: a.quote,
      primary: parseJson(a.primaryJson, null),
      extras: parseJson(a.extrasJson, [])
    })
    if (!this.db) {
      const pool = new Map(this.fallbackRead().anchors.map((a) => [a.id, toView(a)]))
      for (const id of ids) {
        const view = pool.get(id)
        if (view) map.set(id, view)
      }
    } else {
      const all = [...ids]
      const batchSize = 500
      for (let offset = 0; offset < all.length; offset += batchSize) {
        const batch = all.slice(offset, offset + batchSize)
        const rows = this.requireDb()
          .prepare('SELECT * FROM anchors WHERE id IN (' + batch.map(() => '?').join(',') + ')')
          .all(...batch)
        for (const row of rows) {
          const a = rowToAnchor(row)
          map.set(a.id, toView(a))
        }
      }
    }
    for (const n of nodes) n.anchors = n.anchorIds.map((id) => map.get(id)).filter(Boolean) as GraphNode['anchors']
    for (const e of edges) e.anchors = e.anchorIds.map((id) => map.get(id)).filter(Boolean) as GraphEdge['anchors']
  }

  graphDelete(graphId: string): void {
    if (!this.db) {
      this.fallbackMutate((s) => {
        s.graphs = s.graphs.filter((g) => g.id !== graphId)
      })
      return
    }
    const db = this.requireDb()
    db.prepare('DELETE FROM graph_nodes WHERE graph_id = ?').run(graphId)
    db.prepare('DELETE FROM graph_edges WHERE graph_id = ?').run(graphId)
    db.prepare('DELETE FROM graphs WHERE id = ?').run(graphId)
  }

  /**
   * 某文档最近 N 次**成功**生成的耗时样本（旧的 JSON 后端返回空数组 —— 降级场景没有耗时预估也无妨）。
   * 供生成前的耗时预估做历史校准：elapsedMs / 波数 ≈ 单波真实耗时。
   */
  graphHistoryElapsed(docId: string, limit: number): { elapsedMs: number; chunkCount: number; concurrency: number }[] {
    if (!this.db) return []
    const rows = this.requireDb()
      .prepare(
        `SELECT stats_json FROM graphs
         WHERE doc_id = ? AND status IN ('done','partial') AND stats_json IS NOT NULL
         ORDER BY updated_at DESC LIMIT ?`
      )
      .all(docId, limit * 2) as Record<string, unknown>[]
    const out: { elapsedMs: number; chunkCount: number; concurrency: number }[] = []
    for (const row of rows) {
      const stats = parseJson<{ elapsedMs?: number; chunkCount?: number; waveCount?: number; concurrency?: number }>(row.stats_json, {})
      const elapsedMs = num(stats.elapsedMs, 0)
      const chunkCount = num(stats.chunkCount, 0)
      if (elapsedMs <= 0 || chunkCount <= 0) continue
      const waves = stats.waveCount != null && num(stats.waveCount, 0) > 0
        ? num(stats.waveCount, 0)
        : Math.ceil(chunkCount / Math.max(1, num(stats.concurrency, 3)))
      out.push({ elapsedMs, chunkCount, concurrency: Math.max(1, Math.round(chunkCount / Math.max(1, waves))) })
      if (out.length >= limit) break
    }
    return out
  }

  // --------------------------------------------------- conversations/messages
  conversationUpsert(payload: Record<string, unknown>): void {
    const row = {
      id: str(payload.id),
      doc_id: str(payload.docId),
      graph_id: payload.graphId == null ? null : str(payload.graphId),
      node_id: payload.nodeId == null ? null : str(payload.nodeId),
      agent_id: str(payload.agentId),
      mode: str(payload.mode ?? 'fulltext'),
      remote_session_id: payload.remoteSessionId == null ? null : str(payload.remoteSessionId),
      title: payload.title == null ? null : str(payload.title),
      created_at: num(payload.createdAt, Date.now()),
      updated_at: num(payload.updatedAt, Date.now())
    }
    if (!this.db) {
      this.fallbackMutate((s) => upsertBy(s.conversations, 'id', row))
      return
    }
    this.requireDb().prepare(
      `INSERT INTO conversations (id, doc_id, graph_id, node_id, agent_id, mode, remote_session_id, title, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET graph_id=excluded.graph_id, node_id=excluded.node_id, agent_id=excluded.agent_id,
         mode=excluded.mode, remote_session_id=excluded.remote_session_id, title=excluded.title, updated_at=excluded.updated_at`
    ).run(row.id, row.doc_id, row.graph_id, row.node_id, row.agent_id, row.mode, row.remote_session_id, row.title, row.created_at, row.updated_at)
  }

  conversationList(docId: string): unknown[] {
    if (!this.db) return this.fallbackRead().conversations.filter((c) => c.doc_id === docId)
    return this.requireDb().prepare('SELECT * FROM conversations WHERE doc_id = ? ORDER BY updated_at DESC').all(docId)
  }

  conversationGet(id: string): unknown | null {
    if (!this.db) return this.fallbackRead().conversations.find((c) => c.id === id) ?? null
    return this.requireDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) ?? null
  }

  messageAppend(payload: Record<string, unknown>): void {
    const summary = payload.summary == null ? null : str(payload.summary)
    const row = {
      id: str(payload.id),
      conversation_id: str(payload.conversationId),
      role: str(payload.role),
      content: str(payload.content),
      anchor_ids: JSON.stringify(payload.anchorIds ?? []),
      tool_calls_json: payload.toolCalls ? JSON.stringify(payload.toolCalls) : null,
      usage_json: payload.usage ? JSON.stringify(payload.usage) : null,
      created_at: num(payload.createdAt, Date.now()),
      summary
    }
    if (!this.db) {
      this.fallbackMutate((s) => upsertBy(s.messages, 'id', row))
      return
    }
    this.requireDb().prepare(
      `INSERT INTO messages (id, conversation_id, role, content, anchor_ids, tool_calls_json, usage_json, created_at, summary)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET content=excluded.content, tool_calls_json=excluded.tool_calls_json, usage_json=excluded.usage_json, summary=excluded.summary`
    ).run(row.id, row.conversation_id, row.role, row.content, row.anchor_ids, row.tool_calls_json, row.usage_json, row.created_at, row.summary)
  }

  messageList(conversationId: string): unknown[] {
    if (!this.db) return this.fallbackRead().messages.filter((m) => m.conversation_id === conversationId)
    return this.requireDb().prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC').all(conversationId)
  }

  // ---------------------------------------------------------------- agents
  agentUpsert(payload: Record<string, unknown>): void {
    const row = {
      id: str(payload.id),
      kind: str(payload.kind),
      display_name: str(payload.displayName),
      protocol: str(payload.protocol),
      executable: payload.executable == null ? null : str(payload.executable),
      args_json: JSON.stringify(payload.args ?? []),
      env_json: JSON.stringify(payload.env ?? {}),
      enabled: payload.enabled === false ? 0 : 1,
      capability_json: JSON.stringify(payload.capability ?? null),
      last_probe_at: num(payload.lastProbeAt, 0)
    }
    if (!this.db) {
      this.fallbackMutate((s) => upsertBy(s.agents, 'id', row))
      return
    }
    this.requireDb().prepare(
      `INSERT INTO agents (id, kind, display_name, protocol, executable, args_json, env_json, enabled, capability_json, last_probe_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, display_name=excluded.display_name, protocol=excluded.protocol,
         executable=excluded.executable, args_json=excluded.args_json, env_json=excluded.env_json,
         enabled=excluded.enabled, capability_json=excluded.capability_json, last_probe_at=excluded.last_probe_at`
    ).run(row.id, row.kind, row.display_name, row.protocol, row.executable, row.args_json, row.env_json, row.enabled, row.capability_json, row.last_probe_at)
  }

  agentList(): unknown[] {
    if (!this.db) return this.fallbackRead().agents
    return this.requireDb().prepare('SELECT * FROM agents ORDER BY display_name ASC').all()
  }

  // ------------------------------------------------------- 会话标题（历史列表用）
  /**
   * 记一个会话标题。来源：
   *  - `manual`：用户自己改的（最高优先级，永远盖过其它来源）；
   *  - `ai`：让 Agent 用一句话概括出来的（"总结命名"）。
   */
  sessionTitleSet(payload: Record<string, unknown>): void {
    const row = {
      agent_id: str(payload.agentId),
      session_id: str(payload.sessionId),
      title: str(payload.title),
      source: payload.source == null ? 'manual' : str(payload.source),
      updated_at: num(payload.updatedAt, Date.now())
    }
    if (!this.db) {
      this.fallbackMutate((s) => {
        const list = s.sessionTitles ?? (s.sessionTitles = [])
        const idx = list.findIndex((item) => item.agent_id === row.agent_id && item.session_id === row.session_id)
        if (idx >= 0) list[idx] = row
        else list.push(row)
      })
      return
    }
    this.requireDb()
      .prepare(
        `INSERT INTO session_titles (agent_id, session_id, title, source, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(agent_id, session_id) DO UPDATE SET title=excluded.title, source=excluded.source, updated_at=excluded.updated_at`
      )
      .run(row.agent_id, row.session_id, row.title, row.source, row.updated_at)
  }

  sessionTitleList(agentId?: string | null): unknown[] {
    if (!this.db) {
      const list = this.fallbackRead().sessionTitles ?? []
      return agentId ? list.filter((item) => item.agent_id === agentId) : list
    }
    return agentId
      ? this.requireDb().prepare('SELECT * FROM session_titles WHERE agent_id = ?').all(agentId)
      : this.requireDb().prepare('SELECT * FROM session_titles').all()
  }

  /** 取一个会话存下来的标题（没有就 null）。 */
  sessionTitleGet(agentId: string, sessionId: string): string | null {
    if (!agentId || !sessionId) return null
    if (!this.db) {
      const hit = (this.fallbackRead().sessionTitles ?? []).find(
        (item) => item.agent_id === agentId && item.session_id === sessionId
      )
      const title = hit ? String(hit.title ?? '').trim() : ''
      return title.length > 0 ? title : null
    }
    const row = this.requireDb()
      .prepare('SELECT title FROM session_titles WHERE agent_id = ? AND session_id = ?')
      .get(agentId, sessionId) as { title?: unknown } | undefined
    const title = row ? String(row.title ?? '').trim() : ''
    return title.length > 0 ? title : null
  }

  /**
   * 我们自己的会话（conversations.title 里存着"用户第一条提问的前 40 字"）按远端会话 id 反查。
   * 这条链要靠 conversations.remote_session_id —— 会话一建立就会写进去（见 setConversationRemoteSession）。
   */
  conversationTitleForRemoteSession(agentId: string, remoteSessionId: string): string | null {
    const match = (rows: Record<string, unknown>[]): string | null => {
      const hit = rows.find(
        (item) => item.remote_session_id === remoteSessionId && item.agent_id === agentId && typeof item.title === 'string'
      )
      const title = hit ? String(hit.title ?? '').trim() : ''
      return title.length > 0 ? title : null
    }
    if (!this.db) return match(this.fallbackRead().conversations)
    const rows = this.requireDb()
      .prepare('SELECT title FROM conversations WHERE agent_id = ? AND remote_session_id = ? ORDER BY updated_at DESC LIMIT 1')
      .all(agentId, remoteSessionId) as Record<string, unknown>[]
    const title = rows.length > 0 ? String(rows[0].title ?? '').trim() : ''
    return title.length > 0 ? title : null
  }

  /** 把远端会话 id 写到我们自己的会话行上（仅在还没有值时写，别覆盖）。 */
  setConversationRemoteSession(conversationId: string, remoteSessionId: string): void {
    if (!conversationId || !remoteSessionId) return
    if (!this.db) {
      this.fallbackMutate((s) => {
        const row = s.conversations.find((item) => item.id === conversationId)
        if (row && !row.remote_session_id) row.remote_session_id = remoteSessionId
      })
      return
    }
    this.requireDb()
      .prepare('UPDATE conversations SET remote_session_id = ? WHERE id = ? AND (remote_session_id IS NULL OR remote_session_id = \'\')')
      .run(remoteSessionId, conversationId)
  }

  // ------------------------------------------------------------ key/value
  setSetting(key: string, value: string): void {
    if (!this.db) {
      this.fallbackMutate((s) => {
        s.kv[key] = value
      })
      return
    }
    this.requireDb().prepare(
      'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    ).run(key, value)
  }

  getSetting(key: string): string | null {
    if (!this.db) return this.fallbackRead().kv[key] ?? null
    const row = this.requireDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: unknown } | undefined
    return row && row.value != null ? str(row.value) : null
  }

  stats(): Record<string, number> {
    if (!this.db) {
      const s = this.fallbackRead()
      return {
        documents: s.documents.length,
        blocks: s.blocks.length,
        anchors: s.anchors.length,
        annotations: s.annotations.length,
        graphs: s.graphs.length,
        conversations: s.conversations.length,
        messages: s.messages.length
      }
    }
    const db = this.requireDb()
    const count = (table: string): number => {
      const row = db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n?: unknown } | undefined
      return row ? num(row.n) : 0
    }
    return {
      documents: count('documents'),
      blocks: count('blocks'),
      anchors: count('anchors'),
      annotations: count('annotations'),
      graphs: count('graphs'),
      conversations: count('conversations'),
      messages: count('messages')
    }
  }

  close(): void {
    try {
      this.db?.close()
    } catch {
      /* 忽略 */
    }
    this.db = null
  }

  // ------------------------------------------------------------ JSON 兜底
  private jsonCache: FallbackShape | null = null

  private fallbackRead(): FallbackShape {
    if (this.jsonCache) return this.jsonCache
    const file = this.file + '.json'
    try {
      if (existsSync(file)) {
        this.jsonCache = JSON.parse(readFileSync(file, 'utf8')) as FallbackShape
      }
    } catch {
      /* 忽略 */
    }
    if (!this.jsonCache) this.jsonCache = emptyFallback()
    return this.jsonCache
  }

  private fallbackMutate(fn: (state: FallbackShape) => void): void {
    const state = this.fallbackRead()
    fn(state)
    try {
      writeFileSync(this.file + '.json', JSON.stringify(state))
    } catch (error) {
      logMain('error', 'store', 'JSON 后端写入失败', String(error))
    }
  }
}

interface FallbackShape {
  documents: DocumentRecord[]
  blocks: BlockRecord[]
  anchors: AnchorRecord[]
  annotations: AnnotationRecord[]
  graphs: LogicGraph[]
  conversations: Record<string, unknown>[]
  messages: Record<string, unknown>[]
  agents: Record<string, unknown>[]
  /** 会话标题（按 agent + 远端会话 id 存；用户手改或让 Agent 总结命名） */
  sessionTitles: Record<string, unknown>[]
  kv: Record<string, string>
}

function emptyFallback(): FallbackShape {
  return {
    documents: [],
    blocks: [],
    anchors: [],
    annotations: [],
    graphs: [],
    conversations: [],
    messages: [],
    agents: [],
    sessionTitles: [],
    kv: {}
  }
}

function upsertBy<T extends object>(list: T[], key: string, value: T): void {
  const read = (item: T): unknown => (item as Record<string, unknown>)[key]
  const target = read(value)
  const idx = list.findIndex((x) => read(x) === target)
  if (idx >= 0) list[idx] = value
  else list.push(value)
}

function graphSummary(g: LogicGraph): unknown {
  return {
    id: g.id,
    docId: g.docId,
    agentId: g.generation.agentId,
    agentName: g.generation.agentName,
    modelId: g.generation.modelId,
    thinkingEffort: g.generation.thinkingEffort,
    precision: g.generation.precision,
    status: g.status,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    stats: g.stats,
    error: g.error ?? null
  }
}

function rowToDocument(r: unknown): DocumentRecord {
  const row = r as Record<string, unknown>
  return {
    id: str(row.id),
    path: str(row.path),
    format: str(row.format),
    title: str(row.title),
    docHash: str(row.doc_hash),
    sizeBytes: num(row.size_bytes),
    pageCount: row.page_count == null ? null : num(row.page_count),
    textLength: num(row.text_length),
    outlineJson: row.outline_json == null ? null : str(row.outline_json),
    openedAt: num(row.opened_at),
    lastPage: num(row.last_page, 1),
    metaJson: row.meta_json == null ? null : str(row.meta_json)
  }
}

function rowToAnchor(r: unknown): AnchorRecord {
  const row = r as Record<string, unknown>
  return {
    id: str(row.id),
    docId: str(row.doc_id),
    docHash: str(row.doc_hash),
    blockIds: str(row.block_ids),
    charStart: num(row.char_start),
    charEnd: num(row.char_end),
    quote: str(row.quote),
    quoteHash: str(row.quote_hash),
    primaryJson: str(row.primary_json),
    extrasJson: row.extras_json == null ? null : str(row.extras_json),
    status: str(row.status) === 'stale' ? 'stale' : 'ok'
  }
}

interface SqliteModule {
  DatabaseSync: new (file: string) => { exec: (sql: string) => void; prepare: (sql: string) => Stmt; close: () => void }
}

function loadSqlite(): SqliteModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('node:sqlite') as SqliteModule
    if (mod && typeof mod.DatabaseSync === 'function') return mod
  } catch {
    /* 运行环境没有 node:sqlite */
  }
  return null
}

export const storeService = new StoreService()
