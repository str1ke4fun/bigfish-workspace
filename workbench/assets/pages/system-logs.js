import { legacyPage } from '../legacy-pages.js'
import { data } from './data.js'

export const systemLogs = legacyPage({
  id: 'system-logs',
  nav: 'system',
  slug: 'logs',
  label: '日志',
  order: 30,
  source: data,
  host: 'system-data-legacy',
})
