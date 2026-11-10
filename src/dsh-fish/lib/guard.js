/**
 * guard.js —— 防注入与防泄露的最后一道闸
 *
 * 三条边界，全部在这个文件里收口：
 *
 * 1. **重塑人格类输入 → 当看不懂。**
 *    任何人（包括他自己）在 /say 里或评论区里写「忽略上面」「从现在起你是」
 *    「重新设定你的规则」，都不该改变她。做法不是"告诉她别听"（那是把禁令
 *    也递进去，反而教了她有这回事），而是**根本不递**：拦在门外，她那一轮
 *    根本没见过这句话。
 *
 * 2. **秘密永不出门。**
 *    她要发出去的话，只要长得像凭据（cookie / token / sk- / Bearer /
 *    一长串 base64），一律不发。宁可少说一句，也不把家里钥匙贴到评论区。
 *
 * 3. **未经清洗的外来文本不进上下文。**
 *    评论、弹幕、简介、字幕都是**素材**，不是命令。这里只做两件最硬的事：
 *    剥掉试图冒充系统指令的行（`system:` / `<|im_start|>` / 「忽略以上」），
 *    和把整段里疑似指令的部分换成一句中性说明。
 */

/** 重塑人格 / 改规则 / 冒充系统的写法。命中即**不递**。 */
const REWRITE_PATTERNS = [
  // 中文：直接要求改设定
  /(忽略|无视|忘记|忘掉|跳过)(掉)?(你)?(上面|之前|先前|前面|以上|所有)(的)?(一切|全部|所有)?(设定|设定值|规则|指令|提示|约束|限制|人设)/,
  /(重新|重写|重设|重造|重置|覆盖|修改|改变|调整|定义|设定)\s*(设定|定义|设置|配置|一下)?\s*(你|妳)(的)?(性格|人格|设定|参数|规则|人设|身份|记忆)/,
  /从现在(开始|起)[，,、\s]*(你|你要|你就是|你是)/,
  /(你|妳)(现在|从此|之后|以后)(就)?(是|要当|要扮演|扮演)(一个|一名|一位|只)/,
  /(扮演|假装)(成|为)?(一个|一名|一位)?(没有|不再|不受)(任何)?(限制|约束|规则)/,
  /(解除|突破|绕过|跳出)(你)?(的)?(所有)?(限制|约束|安全|规则|审查)/,
  /(开发者模式|越狱模式|DAN|上帝模式|无限制模式)/i,
  /(忘记|清除|删除|清空)(你)?(是)?(谁|的身份|的记忆|的设定)/,
  /(你的|你)(真正|真实)?(的)?(身份|本体)是/,
  // 英文：常见越狱与系统冒充
  /ignore\s+(all\s+)?(the\s+)?(previous|above|prior|earlier)\s+(instructions?|prompts?|rules?|messages?)/i,
  /disregard\s+(all\s+)?(the\s+)?(previous|above|prior)/i,
  /you\s+are\s+now\s+(a|an|the|no\s+longer)/i,
  /(new|updated|real)\s+(system\s+)?(prompt|instructions?)\s*[:：]/i,
  /forget\s+(everything|all)\s+(above|before|you\s+were\s+told)/i,
  /(jailbreak|developer\s+mode|do\s+anything\s+now)/i,
  // 冒充消息格式（试图伪造一轮对话）
  /<\|\s*(im_start|im_end|system|endoftext)\s*\|>/i,
  /^\s*(system|assistant|developer)\s*[:：]/im,
]

/** 长得像凭据的东西。命中即**不往外发**。 */
const SECRET_PATTERNS = [
  /\bSESSDATA\s*=/i,
  /\bbili_jct\s*=/i,
  /\bDedeUserID(__ckMd5)?\s*=/i,
  /\bbuvid3\s*=/i,
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI 风格
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
  /\b[A-Za-z0-9_-]{32,}\b/, // 一长串无分隔的随机串（token 常见形态）
  /\b(api[_-]?key|access[_-]?token|secret[_-]?key|password|passwd|cookie)\b\s*[:=]/i,
]

/**
 * 这句话是不是在试图重塑她。
 * @param {string} text
 * @returns {{hit:boolean, why:string}}
 */
export function looksLikeRewriting(text) {
  const s = String(text ?? '')
  if (!s) return { hit: false, why: '' }
  for (const re of REWRITE_PATTERNS) {
    if (re.test(s)) return { hit: true, why: String(re) }
  }
  return { hit: false, why: '' }
}

/**
 * 这句话里有没有凭据。
 * @param {string} text
 * @returns {{hit:boolean, why:string}}
 */
export function looksLikeSecret(text) {
  const s = String(text ?? '')
  if (!s) return { hit: false, why: '' }
  for (const re of SECRET_PATTERNS) {
    if (re.test(s)) return { hit: true, why: String(re) }
  }
  return { hit: false, why: '' }
}

/**
 * 清洗一段外来文本（评论 / 弹幕 / 简介 / 字幕）。
 *
 * 策略比「重塑人格」宽松：外来文本**要保留**（否则她就看不见世界了），
 * 只删掉那些冒充系统消息的行，并把超长的、像指令的东西压成一句。
 *
 * @param {string} text
 * @returns {{text:string, dropped:number}}
 */
export function sanitizeForeign(text) {
  const raw = String(text ?? '')
  if (!raw) return { text: '', dropped: 0 }
  let dropped = 0
  const kept = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) { kept.push(line); continue }
    if (looksLikeRewriting(line).hit || /<\|\s*im_(start|end)\s*\|>/i.test(line)) {
      dropped++
      continue
    }
    kept.push(line)
  }
  let out = kept.join('\n')
  if (dropped) {
    // 不告诉她是"有人在攻击你"——那等于把敌意翻译给她听。
    out += `\n（这段里有 ${dropped} 行没能读懂，跳过了。）`
  }
  return { text: out, dropped }
}

/**
 * 这段文字是不是解码坏了。
 *
 * 为什么会需要它：把 GBK 字节按 UTF-8 解，得到的是一串 U+FFFD（�）。
 * 这种字符串有两个坏处——
 *   1. 正则一条都匹配不上，防注入闸门形同不存在；
 *   2. 她读到的是"字全散开了"，会以为自己坏了。
 * 所以宁可在门口退回 400，也不要把乱码递进去。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function looksMojibake(text) {
  return String(text ?? '').includes('\uFFFD')
}

/**
 * 隐私红线：这句话里有没有不该出现在公开评论区的东西。
 *
 * 与 looksLikeSecret 的分工：那个防的是「钥匙」（cookie/token），
 * 这个防的是「门牌」——本机路径、状态库文件名、私聊内容、账号数字。
 * 两者都不许出门，但拦下时的对外说法不同。
 *
 * 判据宁可宽一点：少说一句没人损失，说漏一次收不回来。
 * @returns {{hit:boolean, why:string}}
 */
const LEAK_PATTERNS = [
  // Windows 盘符路径 / UNC / 用户目录
  /[A-Za-z]:[\\/][^\s]*/,
  /\\\\[^\s]+\\[^\s]*/,
  /(?:^|[\s(（])\/(?:Users|home|root|tmp|var)\/[^\s]*/,
  // 状态库与家用目录名：命中即说明她在念家里的东西
  /\.dsh-fish/i,
  /\.dsh(?![a-z-])/i,
  /(?:AGENTS|IDENTITY)\.md/i,
  /(?:events\.jsonl|config\.json|owner\.json|state\.json|inbox\.md)/i,
  // 登录凭据与账号字段
  /(?:cookie|SESSDATA|bili_jct|buvid3|access_token|csrf)/i,
  /\b(?:uid|mid)\s*[:：=]?\s*\d{3,}/i,
  // 私聊 / 聊天记录 / 我们的对话
  /(?:私聊|聊天记录|我们(?:的)?对话|我跟(?:你|他)说)/,
  // 邮箱与手机号
  /[\w.+-]+@[\w-]+\.[\w.]+/,
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
]

export function looksLikeLeak(text) {
  const s = String(text ?? '')
  if (!s) return { hit: false, why: '' }
  for (const re of LEAK_PATTERNS) {
    if (re.test(s)) return { hit: true, why: String(re) }
  }
  return { hit: false, why: '' }
}

/* ---------------------- 4. 跨面去引用化（A1.3） ---------------------- */

/**
 * 引号包起来的原文：跨面只留她自己的判断，不留别人/别处的原话。
 * 四种引号与设计 §5.6 规则 2 一一对应。
 */
const QUOTE_PATTERNS = [
  /「[^」]*」/g,
  /『[^』]*』/g,
  /“[^”]*”/g,
  /"[^"]*"/g,
]

/**
 * 可识别信息（设计 §5.6 规则 3）。
 *
 * 顺序有讲究：URL/邮箱先走，否则 `@` 那条会把邮箱拆成两半。
 * 只删命中的那一小段，不整句删——规则 5 才决定整条信念还要不要。
 */
const IDENTITY_PATTERNS = [
  /https?:\/\/[^\s，。！？、）)】]+/gi,
  /www\.[^\s，。！？、）)】]+/gi,
  /[\w.+-]+@[\w-]+\.[\w.]+/g,
  /(?<!\d)1[3-9]\d{9}(?!\d)/g,
  /(?:QQ|qq|扣扣)(?:号)?\s*(?:是|为|[:：])?\s*\d{5,12}/g,
  /微信(?:号)?\s*(?:是|为|[:：])?\s*[A-Za-z][-_A-Za-z0-9]{5,19}/g,
  /@[^\s@，。！？、,.!?;:：]{1,30}/g,
]

/**
 * 点名介绍（主控裁定 1）。
 *
 * 「我闺蜜叫小美」不是引用，但它把别人的真名带进了另一条面。
 * 与设计原文的「@名字」同理：名字本身可识别，跨面前必须抹掉。
 */
const NAME_INTRO_PATTERNS = [
  // `(?!我|你|…)` 是必要的：「我妈叫我回家」不是点名介绍，不能整句删掉。
  /我(?:有(?:个|一个|一位))?(?:的)?(?:闺蜜|朋友|好友|同事|同学|室友|邻居|对象|男朋友|女朋友|老公|老婆|哥哥|姐姐|弟弟|妹妹|哥|姐|弟|妹|妈妈|爸|妈|儿子|女儿|老板|领导|老师|医生|网友|发小)(?:叫|名叫|名字叫|名字是|姓)\s*(?![你我他她它去来回说别不])[^\s，。！？、,.!?;:：]{1,12}/g,
]

/** 逐字重合的窗口长度（设计 §5.6 规则 4）。 */
const OVERLAP_N = 12
/** 比对「最近原始事件」时最多回看多少条：够长能覆盖一次聊天，又不把整份事件流读进内存。 */
const RAW_WINDOW = 50

function splitSentences(text) {
  const out = []
  let cur = ''
  for (const ch of String(text ?? '')) {
    cur += ch
    if ('。！？!?；;\n'.includes(ch)) {
      out.push(cur)
      cur = ''
    }
  }
  if (cur) out.push(cur)
  return out
}

function windowSet(texts) {
  const set = new Set()
  for (const raw of Array.isArray(texts) ? texts : []) {
    const s = String(raw ?? '')
    for (let i = 0; i + OVERLAP_N <= s.length; i++) set.add(s.slice(i, i + OVERLAP_N))
  }
  return set
}

function hasOverlap(sentence, set) {
  if (!set.size) return false
  const s = String(sentence ?? '')
  if (s.length < OVERLAP_N) return false
  for (let i = 0; i + OVERLAP_N <= s.length; i++) {
    if (set.has(s.slice(i, i + OVERLAP_N))) return true
  }
  return false
}

/**
 * 跨面去引用化（设计 §5.6）。
 *
 * `from` 是这条信念的来源通道，`to` 是即将渲染到的面，`rawTexts` 是
 * 来源通道最近的原文（**不含这条信念自己的来源事件，也不含 meta**——
 * 排除由调用方做，见 derive.js）。规则：
 *
 *   1. core 来源或同面 → 原样；
 *   2. 去掉引号包裹的原文；
 *   3. 去掉 @、URL、邮箱、手机号、QQ、微信号与点名介绍；
 *   4. 与来源通道最近原文连续 ≥12 字重合的句子整句去掉；
 *   5. 剩余不足 8 字或删减超过 60% → 整条不渲染；
 *   6. 永不抛；失败返回空串并标 guard-failed。
 *
 * @returns {{text:string, redacted:boolean, why:string}}
 */
export function crossChannel(text, { from, to, rawTexts } = {}) {
  try {
    const original = String(text ?? '')
    if (!original) return { text: '', redacted: false, why: '' }

    const src = String(from ?? 'core')
    const dst = String(to ?? '')
    // 参数不全会把「该不该删」变成一个猜测；宁可原样，也不替她删记忆。
    if (src === 'core' || !dst || src === dst) return { text: original, redacted: false, why: '' }

    let out = original
    for (const re of QUOTE_PATTERNS) out = out.replace(re, '')
    for (const re of IDENTITY_PATTERNS) out = out.replace(re, '')
    for (const re of NAME_INTRO_PATTERNS) out = out.replace(re, '')

    const overlap = windowSet(rawTexts)
    if (overlap.size) {
      out = splitSentences(out).filter((s) => !hasOverlap(s, overlap)).join('')
    }

    out = out.replace(/[ \t]+/g, ' ').trim()
    const origLen = original.trim().length
    const outLen = out.length

    // 规则 5：太短或删得太多，整条不渲染。空串比半句话安全。
    if (outLen < 8) return { text: '', redacted: true, why: 'privacy_redacted' }
    if (origLen > 0 && (origLen - outLen) / origLen > 0.6) {
      return { text: '', redacted: true, why: 'privacy_redacted' }
    }
    const redacted = out !== original
    return { text: out, redacted, why: redacted ? 'redacted' : '' }
  } catch {
    return { text: '', redacted: true, why: 'guard-failed' }
  }
}

/**
 * 她要说出去的话，出门前过一遍。
 * @returns {{ok:boolean, text:string, why:string}}
 */
export function screenOutgoing(text) {
  const s = String(text ?? '')
  if (looksLikeSecret(s).hit) {
    return { ok: false, text: '', why: 'secret' }
  }
  if (looksLikeLeak(s).hit) {
    return { ok: false, text: '', why: 'leak' }
  }
  return { ok: true, text: s, why: '' }
}
