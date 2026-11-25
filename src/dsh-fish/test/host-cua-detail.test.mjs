import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HOST_CUA_DETAILS, HOST_CUA_INPUTS, normalizeAppKey,
  resolveDetail, resolveInput, isStableDriverPath, redactElements,
} from '../lib/host-cua-detail.js'

test('常量与归一', () => {
  assert.deepEqual([...HOST_CUA_DETAILS], ['full', 'structure', 'image', 'none'])
  assert.deepEqual([...HOST_CUA_INPUTS], ['allow', 'deny'])
  assert.equal(normalizeAppKey(' Code.exe '), 'code')
  assert.equal(normalizeAppKey('CHROME'), 'chrome')
  assert.equal(normalizeAppKey(null), '')
})

test('detail：显式映射优先，未列出的走 defaultDetail', () => {
  const cfg = { detail: { 'Code.exe': 'full', 'weixin.exe': 'structure' }, defaultDetail: 'structure' }
  assert.equal(resolveDetail('Code.exe', cfg), 'full')
  assert.equal(resolveDetail(' code ', cfg), 'full')
  assert.equal(resolveDetail('Weixin.exe', cfg), 'structure')
  assert.equal(resolveDetail('chrome.exe', cfg), 'structure')
  assert.equal(resolveDetail('chrome.exe', { defaultDetail: 'bogus' }), 'structure')
})

test('input：显式 allow 优先，未列出的走 defaultInput=deny', () => {
  const cfg = { input: { 'Code.exe': 'allow', 'chrome.exe': 'deny' }, defaultInput: 'deny' }
  assert.equal(resolveInput('Code.exe', cfg), 'allow')
  assert.equal(resolveInput(' code ', cfg), 'allow')
  assert.equal(resolveInput('chrome.exe', cfg), 'deny')
  assert.equal(resolveInput('notepad.exe', cfg), 'deny')
  assert.equal(resolveInput('notepad.exe', { defaultInput: 'allow' }), 'allow')
  assert.equal(resolveInput('notepad.exe', { defaultInput: 'bogus' }), 'deny')
})

test('driver 注册路径只认稳定目录', () => {
  assert.equal(isStableDriverPath('C:\\Users\\ASUS\\AppData\\Local\\bigfish\\host-cua\\0.55.0\\cua-driver.exe'), true)
  assert.equal(isStableDriverPath('/mnt/c/Users/A/bigfish/host-cua/0.55.0/cua-driver.exe'), true)
  assert.equal(isStableDriverPath('C:\\Users\\ASUS\\evil\\cua-driver.exe'), false)
  assert.equal(isStableDriverPath('/tmp/cua-driver.exe'), false)
})

test('structure 脱敏：控制角色 label 保留，正文/值替换，token 保留', () => {
  const out = redactElements([
    { role: 'button', label: '发送', value: '', frame: { x: 1 }, element_token: 's1:2' },
    { role: 'text', label: '晚上吃什么', value: '', frame: { x: 2 }, element_token: 's1:3' },
    { role: 'edit', label: '输入', value: '秘密内容', frame: { x: 3 }, element_token: 's1:4' },
    null,
  ])
  assert.equal(out.length, 3)
  assert.equal(out[0].label, '发送')
  assert.equal(out[0].value, '')
  assert.equal(out[1].label, '[text:5]')
  assert.equal(out[2].label, '[text:2]')
  assert.equal(out[2].value, '[text:4]')
  assert.equal(out[2].element_token, 's1:4')
  assert.deepEqual(out[0].frame, { x: 1 })
})
