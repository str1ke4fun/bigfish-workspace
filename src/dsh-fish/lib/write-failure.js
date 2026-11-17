/**
 * memory-service 的 `why` 是内部诊断信息，允许带错误码、路径与底层原因；
 * 工具回执另有一份面向她的文案契约，不能把前者直接透传出去。
 */

import { Reject } from './schema.js'

const SAFE_WRITE_MESSAGES = new Map([
  ['NOT_HER_TYPE', '这一类内容不能写。'],
  ['NOT_SYSTEM_TYPE', '这一类内容不能写。'],
  ['BAD_TYPE', '这一类内容不能写。'],
  ['BAD_SHAPE', '这条内容没写对。'],
  ['EMPTY_TEXT', '这句是空的，没写。'],
  ['TOO_LONG', '太长了，写短一点。'],
  ['BAD_PERSON', '这条关于人的内容没写全。'],
  ['BAD_SURFACE', '这里不能写这条。'],
  ['REVISE_NEEDS_REF', '要改以前的话，得先指回具体是哪一条。'],
  ['REF_NOT_FOUND', '没找到要指的那条。'],
  ['NARRATION_NEEDS_REF', '要说自己变成什么样，得先指回具体的事。'],
  ['BAD_REPLY', '这条回复没写全。'],
])

export const GENERIC_WRITE_FAILURE = '这次没写下来，等会儿再试。'

/** 已知校验失败换成固定人话；其它 I/O、未知错误一律收成通用写失败。 */
export function rejectMemoryWriteFailure(result) {
  const why = String(result?.why ?? '')
  const code = why.split(':')[0]
  const message = SAFE_WRITE_MESSAGES.get(code)
  if (message) throw new Reject(code, message)
  throw new Reject('WRITE_FAILED', GENERIC_WRITE_FAILURE)
}
