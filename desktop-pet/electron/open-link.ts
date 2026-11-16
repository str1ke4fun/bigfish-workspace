/** 工作台「打开桌宠」链接的协议名和判断；纯函数，不依赖 Electron，便于单测。 */
export const OPEN_PROTOCOL = 'bigfishpet'
export const OPEN_URL = `${OPEN_PROTOCOL}://open`

/** 命令行里有没有工作台下发的打开链接（第二实例启动时由系统带进来）。 */
export function hasOpenLink(argv: readonly string[]): boolean {
  return argv.some((a) => typeof a === 'string' && a.toLowerCase().startsWith(`${OPEN_PROTOCOL}://`))
}

/**
 * 登记协议用的可执行文件与参数。
 * portable 包运行时 execPath 指向临时解包目录，下次启动就失效，要用 PORTABLE_EXECUTABLE_FILE；
 * 开发态（electron . ）要把应用目录当第一个参数带上。
 */
export function protocolTarget(opts: {
  execPath: string
  portableFile?: string
  defaultApp?: boolean
  appArg?: string
}): { exec: string; args: string[] } {
  if (opts.portableFile) return { exec: opts.portableFile, args: [] }
  if (opts.defaultApp && opts.appArg) return { exec: opts.execPath, args: [opts.appArg] }
  return { exec: opts.execPath, args: [] }
}
