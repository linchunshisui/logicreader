/** 主题解析：light / dark / system。 */
import type { ThemeSetting } from './settings'

export type ResolvedTheme = 'light' | 'dark'

export function resolveTheme(setting: ThemeSetting, systemPrefersDark: boolean): ResolvedTheme {
  if (setting === 'system') return systemPrefersDark ? 'dark' : 'light'
  return setting
}

/** VS Code 风格的设计令牌（阅读器与关系图专用部分）。 */
export const READER_TOKENS = {
  light: {
    '--reader-page-background': '#ffffff',
    '--reader-page-shadow': 'rgba(0,0,0,.18)',
    '--reader-text': '#1f1f1f',
    '--reader-canvas': '#f3f3f3',
    '--reader-selection': 'rgba(0,122,204,.28)',
    '--reader-highlight': 'rgba(255, 214, 102, .55)',
    '--reader-search-hit': 'rgba(255, 145, 0, .45)',
    '--reader-search-active': 'rgba(255, 90, 0, .7)'
  },
  dark: {
    '--reader-page-background': '#1a1a1a',
    '--reader-page-shadow': 'rgba(0,0,0,.6)',
    '--reader-text': '#e6e6e6',
    '--reader-canvas': '#121212',
    '--reader-selection': 'rgba(0,127,212,.35)',
    '--reader-highlight': 'rgba(255, 214, 102, .30)',
    '--reader-search-hit': 'rgba(255, 145, 0, .45)',
    '--reader-search-active': 'rgba(255, 90, 0, .75)'
  }
} as const

export const GRAPH_TOKENS = {
  light: {
    '--graph-node-bg': '#ffffff',
    '--graph-node-border': '#d4d4d4',
    '--graph-node-title': '#1f1f1f',
    '--graph-node-subtitle': '#6b6b6b',
    '--graph-edge-causal': '#c98a2e',
    '--graph-edge-support': '#3f9e46',
    '--graph-edge-refute': '#d64545',
    '--graph-edge-elaborate': '#3d7fd1',
    '--graph-edge-contrast': '#8a5cd1',
    '--graph-edge-sequence': '#5b7f95',
    '--graph-edge-define': '#2aa5a5',
    '--graph-edge-reference': '#8a8a8a',
    '--graph-edge-inquiry': '#e0713a',
    '--graph-canvas': '#fafafa'
  },
  dark: {
    '--graph-node-bg': '#2d2d30',
    '--graph-node-border': '#3e3e42',
    '--graph-node-title': '#e6e6e6',
    '--graph-node-subtitle': '#9d9d9d',
    '--graph-edge-causal': '#e0a458',
    '--graph-edge-support': '#6fbf73',
    '--graph-edge-refute': '#e06c75',
    '--graph-edge-elaborate': '#61afef',
    '--graph-edge-contrast': '#c678dd',
    '--graph-edge-sequence': '#7f9fb5',
    '--graph-edge-define': '#56b6c2',
    '--graph-edge-reference': '#9a9a9a',
    '--graph-edge-inquiry': '#e5925f',
    '--graph-canvas': '#1a1a1a'
  }
} as const
