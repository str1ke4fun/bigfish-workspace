import { legacyPage } from '../legacy-pages.js'
import { env } from './env.js'

export const systemSettings = legacyPage({
  id: 'system-settings',
  nav: 'system',
  slug: 'settings',
  label: '设置',
  order: 10,
  source: env,
})
