import { legacyPage } from '../legacy-pages.js'
import { bili } from './bili.js'

export const biliFootprint = legacyPage({
  id: 'bili-footprint',
  nav: 'bili',
  slug: 'footprint',
  label: '足迹',
  order: 20,
  source: bili,
  host: 'bili-legacy',
})
