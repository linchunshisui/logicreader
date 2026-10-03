import type { EditorTab } from '@logicreader/shared'
import { describeFormat } from '@logicreader/shared'
import { WelcomeView } from './welcome/WelcomeView'
import { SettingsView } from './settings/SettingsView'
import { ReaderHost } from './reader/ReaderHost'
import { GraphTabView } from './graph/GraphTabView'

export function EditorTabView({ tab }: { tab: EditorTab }): JSX.Element {
  switch (tab.kind) {
    case 'welcome':
      return <WelcomeView />
    case 'settings':
      return <SettingsView />
    case 'graph':
      return <GraphTabView tab={tab} />
    case 'reader': {
      const descriptor = describeFormat(tab.filePath)
      return <ReaderHost tab={tab} descriptor={descriptor} />
    }
    default:
      return <div className="lr-empty" />
  }
}
