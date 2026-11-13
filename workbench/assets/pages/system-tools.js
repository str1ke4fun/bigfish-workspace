import { legacyPage } from '../legacy-pages.js'
import { tools } from './tools.js'

export const systemTools = legacyPage({
  id: 'system-tools',
  nav: 'system',
  slug: 'tools',
  label: '工具与规则',
  order: 20,
  source: tools,
})
