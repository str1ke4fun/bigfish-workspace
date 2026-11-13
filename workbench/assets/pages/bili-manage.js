import { legacyPage } from '../legacy-pages.js'
import { bili } from './bili.js'

export const biliManage = legacyPage({
  id: 'bili-manage',
  nav: 'bili',
  slug: 'manage',
  label: '管理',
  order: 30,
  source: bili,
  host: 'bili-legacy',
})
