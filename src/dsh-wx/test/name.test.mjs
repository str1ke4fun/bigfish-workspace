// src/dsh-wx/test/name.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeName, displayName, foldedKey, skeleton, chatIdSeed,
  graphemeLength, cleanTruncated, hasNameCharacter, sameName, matchOne,
} from '../lib/name.js'

test('foldedKey 折叠 VS16，但保留 ZWJ 与肤色', () => {
  assert.equal(foldedKey('❤️'), foldedKey('❤'))
  assert.equal(foldedKey('1️⃣'), foldedKey('1⃣'))
  assert.notEqual(foldedKey('👨‍👩‍👧'), foldedKey('👨‍👩‍👦'))
  assert.notEqual(foldedKey('👍🏽'), foldedKey('👍'))
})

test('hasNameCharacter 接受纯旗帜、keycap、©，拒绝问号/标点', () => {
  assert.equal(hasNameCharacter('🇨🇳'), true)
  assert.equal(hasNameCharacter('1️⃣'), true)
  assert.equal(hasNameCharacter('©'), true)
  assert.equal(hasNameCharacter('?'), false)
  assert.equal(hasNameCharacter('，'), false)
})

test('skeleton 只留字母/数字，旗帜和纯 emoji 为空', () => {
  assert.equal(skeleton('🌊周末海边🏖️'), '周末海边')
  assert.equal(skeleton('🇨🇳群'), '群')
  assert.equal(skeleton('🇨🇳'), '')
  assert.equal(skeleton('👨‍👩‍👧'), '')
})

test('sanitizeName 去掉孤立代理/U+FFFD/控制符/bidi，保留 ZWJ/VS', () => {
  assert.equal(sanitizeName('a\u0000b'), 'ab')
  assert.equal(sanitizeName('😀\uD83D'), '😀')
  assert.equal(sanitizeName('😀�'), '😀')
  assert.equal(sanitizeName('群‮名'), '群名')
  assert.equal(sanitizeName('👨‍👩‍👧'), '👨‍👩‍👧')
  assert.equal(sanitizeName('❤️'), '❤️')
})

test('displayName 不改写完整名字的尾部', () => {
  for (const s of ['❤️', '👍🏽', '1️⃣', '🇨🇳', '🏴󠁧󠁢󠁳󠁣󠁴󠁿']) {
    assert.equal(displayName(s), s)
  }
})

test('cleanTruncated 只处理截断串的尾巴', () => {
  assert.equal(cleanTruncated('👨‍👩...'), '👨‍👩')
  assert.equal(cleanTruncated('🇨...'), '')
  assert.equal(cleanTruncated('🏴󠁧...'), '🏴')
  assert.equal(cleanTruncated('🌊周末海...'), '🌊周末海')
  assert.equal(cleanTruncated('😀\uD83D'), '😀')
})

test('graphemeLength 按字素计数', () => {
  assert.equal(graphemeLength('😀'), 1)
  assert.equal(graphemeLength('🇨🇳'), 1)
  assert.equal(graphemeLength('🇨🇳🇺🇸'), 2)
  assert.equal(graphemeLength('👨‍👩‍👧'), 1)
  assert.equal(graphemeLength('1️⃣'), 1)
})

test('chatIdSeed 只做 trim + 压空白，不做 NFC', () => {
  assert.equal(chatIdSeed('  a   b '), 'a b')
  assert.equal(chatIdSeed('é'), 'é')
})

test('matchOne 先精确、再折叠、撞名回 ambiguous', () => {
  assert.deepEqual(matchOne('❤️读书群', ['❤️读书群', '别的群']), {
    status: 'exact', match: '❤️读书群', matches: ['❤️读书群'],
  })
  assert.equal(matchOne('❤读书群', ['❤️读书群']).status, 'folded')
  assert.equal(matchOne('❤读书群', ['❤️读书群', '❤读书群']).status, 'ambiguous')
  assert.equal(matchOne('不存在', ['❤️读书群']).status, 'unknown')
  assert.equal(matchOne('周末海边', ['🌊周末海边🏖️'], { tiers: ['exact', 'folded', 'skeleton'] }).status, 'resolved')
  assert.equal(sameName('❤️读书群', '❤️读书群'), true)
})

test('matchOne 的 candidate 前缀只接受候选更长，skeleton 需要非空且 ≥2 字素', () => {
  const tiers = ['exact', 'folded', 'skeleton']
  // 候选比输入长：OCR 截断的正常补全
  assert.equal(matchOne('星晓家园10号楼', ['星晓家园10号楼1302'], { tiers, prefix: 'candidate' }).status, 'exact')
  // 输入比候选长：不能反向缩成白名单里的短名
  assert.equal(matchOne('读书群2', ['读书群'], { tiers, prefix: 'candidate' }).status, 'unknown')
  // 显式对称 prefix 仍保留旧语义（目前没有调用方依赖它）
  assert.equal(matchOne('读书群2', ['读书群'], { tiers, prefix: true }).status, 'exact')
  // 纯 emoji/符号名的 skeleton 为空，不能互相改写
  assert.equal(matchOne('😀', ['🌊'], { tiers }).status, 'unknown')
  assert.equal(matchOne('???', ['🌊'], { tiers }).status, 'unknown')
  assert.equal(matchOne('周末海边', ['🌊'], { tiers }).status, 'unknown')
  // 1 个字素的骨架不参与
  assert.equal(matchOne('群', ['群'], { tiers: ['skeleton'] }).status, 'unknown')
})
