import { legacyPage } from '../legacy-pages.js'
import { overview } from './overview.js'

export const herToday = legacyPage({
  id: 'her-today',
  nav: 'her',
  slug: 'today',
  label: '今天',
  order: 10,
  source: overview,
  host: 'her-legacy',
})
