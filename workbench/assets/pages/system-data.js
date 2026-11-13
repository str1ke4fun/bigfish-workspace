import { legacyPage } from '../legacy-pages.js'
import { data } from './data.js'

export const systemData = legacyPage({
  id: 'system-data',
  nav: 'system',
  slug: 'data',
  label: '数据',
  order: 40,
  source: data,
  host: 'system-data-legacy',
})
