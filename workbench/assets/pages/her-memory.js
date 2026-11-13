import { legacyPage } from '../legacy-pages.js'
import { memory } from './memory.js'

export const herMemory = legacyPage({
  id: 'her-memory',
  nav: 'her',
  slug: 'memory',
  label: '记忆',
  order: 20,
  source: memory,
})
