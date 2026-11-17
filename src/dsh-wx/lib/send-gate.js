import { WxToolError } from './tool-error.js'

function reason(...parts) {
  return parts
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('；')
}

/**
 * 构造生产发送闸。闸门本身只依赖外部只读/记账函数，既能在插件里包住 GUI 状态，
 * 也能在测试里走同一条真实拒绝路径，而不是另造一份错误判断。
 */
export function createSendGate({
  policy,
  hostBlocksSend,
  look,
  isStale,
  staleDetail,
  allowedCurrent,
  sameName,
  canSpeak,
  readMentions,
  loadState,
  decideProactive,
  consumeProactive,
  saveState,
  logInbound,
  now = Date.now,
}) {
  return async function gateSend({ consume = false, expected = '', target = null } = {}) {
    const p = policy()
    if (!p.enabled) {
      throw new WxToolError('WX_DISABLED', '[微信现在没开]', '发送闸：微信通道已关闭。')
    }
    if (hostBlocksSend()) {
      throw new WxToolError(
        'WX_HOST_BLOCKED',
        '[这句是在这儿说的，不是发到微信]',
        '发送闸：主机最近在对话，且这轮没有微信意图（hostState.intent=false）。',
      )
    }

    const s = await look()
    if (!s.parsed.ok) {
      throw new WxToolError('WX_WINDOW_UNAVAILABLE', '[没看清。屏幕可能慢半拍]', '发送闸：当前无障碍树不可用。')
    }
    if (isStale()) {
      throw new WxToolError(
        'WX_TREE_STALE',
        '[没看清。屏幕可能慢半拍]',
        reason('发送闸：无障碍树可能落后。', staleDetail?.()),
      )
    }
    if (!s.parsed.current) {
      throw new WxToolError('WX_CHAT_UNKNOWN', '[没看清。屏幕可能慢半拍]', '发送闸：当前会话名为空。')
    }

    // 目录别名可以改变导航名，但不能绕过名单：只有 target.chat 本身仍在策略里，
    // 且当前窗口已经切到 canonicalChat，才把策略名当作 hit。
    const policyChat = String(target?.chat ?? '').trim()
    const canonicalChat = String(target?.canonicalChat ?? '').trim()
    const policyHit = policyChat
      ? (p.allowChats.find((n) => sameName(n, policyChat)) ??
        p.noMentionChats.find((n) => sameName(n, policyChat)) ?? null)
      : null
    const targetHit = policyHit && canonicalChat && sameName(s.parsed.current, canonicalChat)
      ? policyHit
      : null
    // 「这些会话不用 @」是最高权限：既不用等 @，也不用先进允许名单——它自己就是白名单。
    const exempt = p.noMentionChats.find((n) => sameName(n, s.parsed.current)) ??
      (targetHit && p.noMentionChats.some((n) => sameName(n, targetHit)) ? targetHit : null)
    const hit = targetHit || allowedCurrent(s.parsed, p.allowChats) || exempt
    if (!hit) {
      throw new WxToolError(
        'WX_NOT_ALLOWED',
        '[这个会话现在说不了]',
        p.allowChats.length === 0
          ? reason(`发送闸：allowChats 为空，当前会话是「${s.parsed.current}」。`)
          : reason(
              `发送闸：当前会话「${s.parsed.current}」不在 allowChats/noMentionChats 里。`,
              `allowChats=${p.allowChats.length}`,
            ),
      )
    }

    // 调用方知道目标会话时必须在这里复核：频率闸等待期间窗口可能被切走，
    // 不能在切换后的会话上扣掉另一群/另一个人的主动额度。
    const wanted = policyChat || String(expected ?? '').trim()
    if (wanted && !sameName(hit, wanted)) {
      throw new WxToolError(
        'WX_CHAT_CHANGED',
        '[没做成，过会儿再试]',
        `发送闸：expected=${wanted}；actual=${hit}`,
      )
    }

    // @ 才回：只有最近被 @ 过的会话才开口（QQ 那边是同一条规矩，按条判；微信只能按会话判）。
    // 没被 @ 时还可以用当天主动额度，由 proactive.js 统一判定。
    const mentionChat = targetHit && canonicalChat ? canonicalChat : hit
    const verdict = p.requireMention && !exempt
      ? canSpeak(readMentions(), mentionChat, now(), p.mentionWindowMinutes)
      : { ok: true }
    const state = loadState()
    const dec = decideProactive({ policy: p, state, chat: hit, mention: verdict, exempt, now: now() })
    if (!dec.ok) {
      if (dec.why === '主动额度状态读不出来') {
        throw new WxToolError(
          'WX_PROACTIVE_STATE',
          '[没做成，过会儿再试]',
          reason('发送闸：主动额度状态不可信。', state?.why || dec.why, `chat=${hit}`),
        )
      }
      throw new WxToolError(
        'WX_PROACTIVE_LIMIT',
        '[这个群今天先不主动开口]',
        reason('发送闸：主动额度不足。', dec.why, `chat=${hit}`),
      )
    }

    let left = dec.left
    if (dec.proactive && consume) {
      // 一次发送只在这里扣一次：前面的 gateSend 都只是检查，避免一道闸扣三次额度。
      // 记不下来就不发：否则每轮都读到“今天用了 0 条”，额度等于无限。
      const next = consumeProactive(p, state, hit)
      if (!saveState(next.state)) {
        throw new WxToolError(
          'WX_PROACTIVE_STATE',
          '[没做成，过会儿再试]',
          `发送闸：saveState 写入失败；chat=${hit}`,
        )
      }
      left = next.left
      logInbound({ type: 'proactive-send', chat: hit, remaining: left })
    }
    return { chat: hit, snap: s, proactive: dec.proactive, proactiveLeft: left }
  }
}
