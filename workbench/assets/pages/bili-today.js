import { legacyPage } from '../legacy-pages.js'
import { bili } from './bili.js'

export const biliToday = legacyPage({
  id: 'bili-today',
  nav: 'bili',
  slug: 'today',
  label: '今天',
  order: 10,
  source: bili,
  host: 'bili-legacy',
})
