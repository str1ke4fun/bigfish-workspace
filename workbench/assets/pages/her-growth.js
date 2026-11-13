import { legacyPage } from '../legacy-pages.js'
import { overview } from './overview.js'

export const herGrowth = legacyPage({
  id: 'her-growth',
  nav: 'her',
  slug: 'growth',
  label: '成长',
  order: 30,
  source: overview,
  host: 'her-legacy',
})
