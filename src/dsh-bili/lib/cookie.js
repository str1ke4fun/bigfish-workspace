/**
 * cookie.js —— B 站 cookie 的归一化与键名白名单
 *
 * 为什么单独一层：owner.js 需要整理 cookie，bili.js 也需要整理 cookie。
 * 以前 owner.js 反过来 import bili.js，A0 把这条反向依赖解掉：
 * 两边都只依赖这个纯函数模块。
 */

/** B 站登录需要的 cookie 键；只保存这几个，别把整段浏览器 cookies 存进来。 */
export const COOKIE_NAMES = Object.freeze([
  'SESSDATA',
  'bili_jct',
  'buvid3',
  'DedeUserID',
  'DedeUserID__ckMd5',
  'sid',
])

/**
 * 把 cookie 串整理干净（允许从 Netscape cookies.txt 或 "a=1; b=2" 传入）。
 * @param {string} raw
 * @returns {string}
 */
export function normalizeCookie(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (s.includes('\t')) {
    const pairs = []
    for (const line of s.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue
      const p = line.split('\t')
      if (p.length >= 7 && p[5]) pairs.push(`${p[5]}=${p[6]}`)
    }
    return pairs.join('; ')
  }
  return s
}
