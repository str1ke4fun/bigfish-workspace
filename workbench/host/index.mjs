/**
 * host —— 工作台和「那台跑微信/QQ/她的机器」之间的唯一接口。
 *
 * 为什么要这一层：工作台现在跑在 Windows 上，脏活都在 WSL 里；以后要整搬到
 * 树莓派当服务器，脏活就在本机。上层（server.mjs 的路由和页面）不该知道
 * 这些差别，只调 host.sh / host.image / host.notify。
 *
 * 约定：每个 host 都实现
 *   name                        'windows' | 'linux'
 *   sh(cmd, {timeout})          -> {ok, out, err}      普通命令
 *   root(cmd, {timeout})        -> {ok, out, err}      需要 root 的命令
 *   image(cmd, {timeout})       -> {ok, buf, err}      命令输出二进制（截图/二维码）
 *   notify(title, text)                               桌面通知（拿不到就静默）
 *   keepalive.start() / .stop()                       让那台机器别在空闲时被回收
 */
export { createHost } from './pick.mjs'
