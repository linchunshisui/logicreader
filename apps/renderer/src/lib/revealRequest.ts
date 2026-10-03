/**
 * 阅读器共用的"外部定位请求"消费器。
 *
 * 谁在用它：关系图节点/连线跳转、目录、查找结果、标注列表 —— 凡是"从别处跳到某段原文"的入口。
 *
 * 为什么不能"收到就处理一次"（本次修复的根因）：
 * 编辑器区只渲染当前标签页（`workbench/EditorArea` 取 `group.tabs[group.activeIndex]`），
 * 所以从关系图点节点跳过去时，阅读器是**重新挂载**的：此刻 PDF 的文档还在异步加载
 * （页面上根本没有 `.lr-pdf-page`）、DOCX 还在 docx-preview 渲染、表格还没切到目标 Sheet。
 * 一次性消费必然落空，而且**不报错** —— 用户看到的就是"点了节点没反应、跳转功能像是没有"。
 *
 * 因此这里做三件事：
 * 1. 在时间窗口内按帧重试（默认 6 秒，可由 `RevealRequest.timeoutMs` 覆盖），拿到目标才停；
 * 2. 同一份请求只消费一次：按**对象身份**判断（不是时间戳 —— 时钟回拨或同毫秒都不会误判），
 *    否则每次切回阅读器标签都会重新滚一次、再闪一次；
 * 3. 确实没落地时写一条 warn 日志（`定位请求未落地`）—— 宁可留痕，也不要静默失败。
 */
import { useEffect, useRef } from 'react'
import { useUiStore, type RevealRequest } from '../state/ui.store'
import { api } from './api'

/** 重试间隔：比一帧略长，避免和渲染抢时间；6 秒足够覆盖大 PDF 首次加载 */
const RETRY_INTERVAL_MS = 100
const DEFAULT_TIMEOUT_MS = 6000

/** 已消费的请求（按对象身份比较，见文件头注释） */
let consumed: RevealRequest | null = null

/**
 * 消费"外部定位请求"。
 *
 * @param docId 本阅读器的文档 id（请求发往别的文档时直接忽略）
 * @param apply 尝试定位：返回 true 表示**已经落到目标上**（滚动 + 高亮都做完）；
 *              返回 false 就等下一轮重试。`attempt` 从 0 开始，供"降级策略"使用
 *              （例如文本层始终没建好时，先粗定位到页，而不是一直等到超时）。
 */
export function useRevealRequest(
  docId: string,
  apply: (request: RevealRequest, attempt: number) => boolean
): void {
  const request = useUiStore((state) => state.revealRequest)
  const applyRef = useRef(apply)
  applyRef.current = apply

  useEffect(() => {
    if (!request || request.docId !== docId || consumed === request) return
    const target = request
    const deadline = Date.now() + (target.readyTimeoutMs ?? DEFAULT_TIMEOUT_MS)
    let attempt = 0
    let timer: number | undefined
    let stopped = false

    const finish = (ok: boolean): void => {
      consumed = target
      if (!ok) {
        void api.log.write(
          'warn',
          'reader',
          '定位请求未落地：doc=' + docId + ' 区间=' + target.charStart + '-' + target.charEnd
        )
      }
    }

    const run = (): void => {
      if (stopped) return
      let ok = false
      try {
        ok = applyRef.current(target, attempt)
      } catch (error) {
        ok = false
        void api.log.write(
          'warn',
          'reader',
          '定位请求处理异常：' + (error instanceof Error ? error.message : String(error))
        )
      }
      if (ok) {
        finish(true)
        return
      }
      attempt += 1
      if (Date.now() >= deadline) {
        finish(false)
        return
      }
      timer = window.setTimeout(run, RETRY_INTERVAL_MS)
    }

    run()
    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [request, docId])
}
