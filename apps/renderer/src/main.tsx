import React from 'react'
import { createRoot } from 'react-dom/client'
import './i18n'
import './theme/tokens.css'
import './theme/base.css'
import './styles/workbench.css'
import './styles/views.css'
import './styles/pdf.css'
import './styles/readers.css'
import './styles/graph.css'
import { App } from './App'

const container = document.getElementById('root')
if (!container) throw new Error('缺少 #root 容器')

createRoot(container).render(
  React.createElement(React.StrictMode, null, React.createElement(App))
)
