/**
 * owner-service.js —— `fishCore.owner`（A1.7）
 *
 * 设计 §7.6：read / credentials / write / mentionPrefix。
 *   - read 永不返回 cookie 原文，登录卡只拿 hasCookie / hasCsrf；
 *   - credentials 返回进程内可用的 CredentialHandle，但 JSON.stringify / 字符串化
 *     一律脱敏——它被顺手丢进日志、台账或模型消息时不会把钥匙带走；
 *   - 每次取用写一条不含值的审计日志。
 *
 * 为什么不直接暴露 cookie 字符串：dsh-bili 搬出去以后，取钥匙和用钥匙之间
 * 会跨进程边界。字符串一旦离开这个闭包就没有痕迹，handle 至少把"能序列化"
 * 这条路闸住了。
 */

import { readOwner } from './store.js'
import { saveOwner, publicOwner, mentionPrefix } from './owner.js'
import { DEFAULTS, loadConfig } from './settings.js'

const CSRF_RE = /(?:^|;\s*)bili_jct=([^;]*)/

/** 进程内凭据；序列化即脱敏。 */
export class CredentialHandle {
  #cookie
  #csrf

  constructor(cookie) {
    this.#cookie = String(cookie ?? '')
    const m = CSRF_RE.exec(this.#cookie)
    this.#csrf = m ? m[1] : ''
  }

  get cookie() { return this.#cookie }
  get csrf() { return this.#csrf }
  toJSON() { return '[redacted]' }
  toString() { return '[redacted]' }
}

/**
 * @param {{ root?: string, log?: Function }} [opts]
 */
export function createOwnerService({ root, log } = {}) {
  async function owner() {
    try {
      return await readOwner(root)
    } catch {
      return null
    }
  }

  return {
    async read() {
      return publicOwner(await owner())
    },

    async credentials() {
      const handle = new CredentialHandle((await owner())?.cookie)
      // 审计日志只记"取用过"，绝不记值。
      log?.('[dsh-fish] owner.credentials() 被取用（值不记录）')
      return handle
    },

    async write(patch = {}) {
      return saveOwner(patch, root)
    },

    async mentionPrefix() {
      const ow = await owner()
      let cfg = DEFAULTS
      try {
        cfg = (await loadConfig(root)).config ?? DEFAULTS
      } catch { /* 配置读不到时按默认的 atOwner=true 处理 */ }
      return mentionPrefix(ow, cfg)
    },
  }
}
