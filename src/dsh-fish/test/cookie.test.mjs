import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeCookie, COOKIE_NAMES } from '../lib/cookie.js'

test('normalizeCookie: Netscape cookies.txt', () => {
  const raw = [
    '# Netscape HTTP Cookie File',
    '.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\tabc',
    '.bilibili.com\tTRUE\t/\tFALSE\t0\tbili_jct\tdef',
  ].join('\n')
  assert.equal(normalizeCookie(raw), 'SESSDATA=abc; bili_jct=def')
})

test('normalizeCookie: 普通串原样保留', () => {
  assert.equal(normalizeCookie('SESSDATA=x; bili_jct=y'), 'SESSDATA=x; bili_jct=y')
  assert.equal(normalizeCookie(''), '')
  assert.equal(normalizeCookie(null), '')
})

test('COOKIE_NAMES 含登录必需两项', () => {
  assert.ok(COOKIE_NAMES.includes('SESSDATA'))
  assert.ok(COOKIE_NAMES.includes('bili_jct'))
})
