// ocr-messages 的 TSV 解析：低置信度行不能进入拼行。
import assert from 'node:assert/strict'
import { parseMessageTsv } from './lib/ocr-messages.mjs'

const header = 'level\tpage\tblock\tpar\tline\tword\tleft\ttop\twidth\theight\tconf\ttext'
const tsv = [
  header,
  '5\t1\t1\t1\t1\t0\t10\t20\t300\t20\t-1\tjunk',
  '5\t1\t1\t1\t1\t1\t10\t20\t300\t20\t88\thello',
].join('\n')

const lines = parseMessageTsv(tsv)
assert.equal(lines.length, 1, '置信度 -1 的单词不应成行')
assert.equal(lines[0].text, 'hello')
console.log('ocr-messages: 全部通过')
