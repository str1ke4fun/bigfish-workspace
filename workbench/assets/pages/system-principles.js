import { legacyPage } from '../legacy-pages.js'
import { principles } from './principles.js'

export const systemPrinciples = legacyPage({
  id: 'system-principles',
  nav: 'system',
  slug: 'principles',
  label: '原理',
  order: 50,
  source: principles,
})
