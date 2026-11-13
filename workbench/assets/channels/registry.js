// 通道注册表：新增通道只加一个模块和一行 import，外壳按 order 排序。
import { qq } from './qq.js'
import { wx } from './wx.js'

export const CHANNELS = [qq, wx].sort((a, b) => a.order - b.order)
