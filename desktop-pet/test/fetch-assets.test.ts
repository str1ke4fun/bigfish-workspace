import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CACHE_DIR,
  UPSTREAM_ASSETS_SUBPATH,
  UPSTREAM_REPO,
  UPSTREAM_TAG,
  parseArgs,
} from '../scripts/fetch-assets.mjs'

test('默认从上游 v0.4.9 取素材，保留已有文件', () => {
  assert.deepEqual(parseArgs([]), { from: null, force: false, help: false })
  assert.equal(UPSTREAM_REPO, 'https://github.com/PC2005-cloud/dsh-pet.git')
  assert.equal(UPSTREAM_TAG, 'v0.4.9')
  assert.equal(UPSTREAM_ASSETS_SUBPATH, 'dsh-pet/assets/webm')
  assert.ok(CACHE_DIR.includes('bigfish-pet-assets'))
  assert.ok(CACHE_DIR.includes('v0.4.9'))
})

test('--from 指定本地素材目录', () => {
  assert.deepEqual(parseArgs(['--from', 'D:\\assets\\webm']), {
    from: 'D:\\assets\\webm',
    force: false,
    help: false,
  })
})

test('--force 覆盖已有文件', () => {
  assert.equal(parseArgs(['--force']).force, true)
})

test('--help 只打印用法', () => {
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['-h']).help, true)
})

test('未知参数和缺值的 --from 都报错', () => {
  assert.throws(() => parseArgs(['--unknown']), /未知参数/)
  assert.throws(() => parseArgs(['--from']), /--from 需要一个素材目录/)
  assert.throws(() => parseArgs(['--from', '--force']), /--from 需要一个素材目录/)
})
