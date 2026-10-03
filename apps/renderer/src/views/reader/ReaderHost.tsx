import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { ReaderTab } from '@logicreader/shared'
import type { FormatDescriptor } from '@logicreader/shared'
import { useDocuments } from '../../state/documents.store'
import { useTabIssues } from '../../state/tabIssues.store'
import { api } from '../../lib/api'
import { TextReaderView } from './TextReaderView'
import { PdfReaderView } from './pdf/PdfReaderView'
import { MarkdownReaderView } from './markdown/MarkdownReaderView'
import { DocxReaderView } from './docx/DocxReaderView'
import { SheetReaderView } from './sheet/SheetReaderView'
import { GraphChainPanel } from './GraphChainPanel'
import { CMD } from '@logicreader/shared'
import { executeCommand } from '../../state/commands.store'

interface Props {
  tab: ReaderTab
  descriptor: FormatDescriptor | null
}

export function ReaderHost({ tab, descriptor }: Props): JSX.Element {
  const { t } = useTranslation()
  const status = useDocuments((s) => s.status[tab.docId])
  const error = useDocuments((s) => s.errors[tab.docId])
  const model = useDocuments((s) => s.models[tab.docId] ?? null)
  const issue = useTabIssues((s) => s.issues[tab.id])

  useEffect(() => {
    void api.fs.watch(tab.filePath)
    return () => {
      void api.fs.unwatch(tab.filePath)
    }
  }, [tab.filePath])

  if (issue?.kind === 'missing') {
    return (
      <div className="lr-editor-message">
        <h2>{t('editor.fileNotFound')}</h2>
        <p>{t('editor.fileNotFoundDetail')}</p>
        <code>{issue.filePath}</code>
        <div className="lr-editor-message__actions">
          <button className="lr-button" onClick={() => void executeCommand(CMD.fileOpen)}>
            {t('editor.relocate')}
          </button>
          <button className="lr-button lr-button--secondary" onClick={() => executeCommand(CMD.fileClose)}>
            {t('common.close')}
          </button>
        </div>
      </div>
    )
  }

  if (status === 'loading' || (!model && status !== 'error')) {
    return (
      <div className="lr-editor-message">
        <div className="lr-spinner" />
        <p>{t('reader.loading')}</p>
      </div>
    )
  }

  if (status === 'error' || (error && !model)) {
    return (
      <div className="lr-editor-message">
        <h2>{t('reader.parseFailed')}</h2>
        <p>{t('reader.parseFailedDetail', { message: error ?? '' })}</p>
      </div>
    )
  }

  if (!model) return <div className="lr-empty" />

  const view =
    descriptor?.reader === 'reader-pdf' ? (
      <PdfReaderView tab={tab} model={model} />
    ) : descriptor?.reader === 'reader-markdown' ? (
      <MarkdownReaderView tab={tab} model={model} />
    ) : descriptor?.reader === 'reader-docx' ? (
      <DocxReaderView tab={tab} model={model} />
    ) : descriptor?.reader === 'reader-sheet' ? (
      <SheetReaderView tab={tab} model={model} />
    ) : (
      <TextReaderView tab={tab} model={model} />
    )

  /*
   * 阅读器与"局部逻辑链"面板并排：从关系图跳过来时，
   * 高亮那一段旁边的面板会说明它属于哪条论证（见 GraphChainPanel）。
   */
  return (
    <div className="lr-reader-host">
      {view}
      <GraphChainPanel docId={tab.docId} />
    </div>
  )
}
