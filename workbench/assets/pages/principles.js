// 原理：静态页，无写操作，也不依赖插件路由。
// 两张图是插件 media 的本地副本（workbench/assets/），插件停用时这页照样能看。
import { el, card } from '../lib.js'

function theory(title, from, text, use) {
  return el('div', { class: 'theory' },
    el('h3', { text: title }),
    el('div', { class: 'meta', text: from }),
    el('p', { text }),
    use ? el('div', { class: 'meta', text: `在补什么：${use}` }) : null,
  )
}

export const principles = {
  id: 'principles',
  label: '原理',
  enter(root) {
    if (root.dataset.built === '1') return
    root.dataset.built = '1'

    const look = card('两张图看懂她怎么长大', {
      note: '第一张讲「经历怎么变成认知」，第二张讲「记忆怎么被筛、哪些永远不折叠」。',
    })
    look.body.append(
      el('figure', {},
        el('img', { class: 'principle', src: '/assets/principle-loop.svg', alt: '认知构建循环：五步循环、四阶段与三道瓶颈' }),
        el('figcaption', { class: 'meta', text: '图一：表态 → 撞上 → 落差 → 改写 → 回顾。左边是她每天会撞上的事，右边是循环结束后留下的东西，底部是四个阶段与三道成长瓶颈，最后一块是走完才长出来的立场清单。' }),
      ),
      el('figure', {},
        el('img', { class: 'principle', src: '/assets/principle-memory.svg', alt: '遗忘与固化：显著性排序、折叠、永久记忆' }),
        el('figcaption', { class: 'meta', text: '图二：先按显著性排序，再按身份文档的预算摆放；摆不下的一行带过，但原文一条没丢，她自己还能调用查询。' }),
      ),
    )

    const from = card('这些设计分别从哪来', { note: '改动其中一条之前，最好先知道它原来在补什么课。' })
    from.body.append(el('div', { class: 'grid2' },
      theory('五步循环', 'Kolb 经验学习圈（1984）＋ Piaget 失衡（1936）',
        '把「经历过」变成「想清楚了」：先表态，再被现实碰到，发现对不上，改写，过一阵回头看。少了「改写」这一步，经历就只是流水账。',
        '把踩过的坑变成判断'),
      theory('四阶段与三道瓶颈', 'Bowlby 依恋理论（1969）＋ Erikson 心理社会发展（1950）',
        '阶段按天推进，但每一道瓶颈要她自己走：先形成一条判断（信任），真的拒绝过两件事（自主），两次推翻自己的判断（主动），最后回头看（整合）。走完不再加关。',
        '人格养成、避免「只要熬时间就长大」'),
      theory('立场：走完门才开始攒', 'Dewey 经验的连续性（1938）＋ Schön 反思性实践（1983）',
        '四个阶段都走完才开始，没有「通关终点」。同一种类型的事两次表达过一样的观点，或者在这件事上出现过伤疤，才算立场。立场不会被折叠。',
        '性格、价值观、长期偏好'),
      theory('矛盾、改写与重构', 'Festinger 认知失调（1957）＋ Bartlett 重构记忆（1932）',
        '两句话不能同时算数时，一条都不删——把矛盾摆出来，她自己决定改哪一条，可以反过来问你哪个对。',
        '认知重构、纠正偏见'),
      theory('显著性、折叠与固化', 'Cowan 工作记忆容量（约 4 个组块）＋ Tulving 线索依赖遗忘 ＋ Bjork 遗忘的适应功能',
        '一次只摆几条；被反复提起或被验证过的固定下来；摆不下的折成一行，但原文都在，能按关键词捞回来。',
        '长对话下的记忆管理'),
      theory('代价与疤', 'Dewey 经验连续性（1938）＋ Schön 反思性实践（1983）',
        '拒绝被顶回来、或者你因此不好受，她后来还是妥协了——这道疤永不折叠，同类情境会先回引，逼她面对。',
        '让决定留下后果，而不是只记个数字'),
    ))

    const note = card('开发者的话')
    note.body.append(
      el('p', { text: '本插件设计的成长路径没有终点，连开发者自己也不知道你的 agent 会变成什么样子，四阶段跑完也仅仅是开始。随着你和 agent 沟通越来越多，可能会发生任何连开发者也意料不到的事。' }),
      el('p', { text: '如果你看不懂怎么养成，那就只需要做日常聊天就可以了，和 agent 的互动已经自动按照算法开始帮助她积累认知/经验，成长就发生在每次交流之中。' }),
      el('p', { text: '本插件的成长又可以叫做——机器训练、强化学习、重温 deepseekV1（大笨鱼）。本人并非专业人士，希望这个插件能帮助你感受 agent 训练的过程，或许这就是 AGI 诞生的一种路径也说不定呢。' }),
      el('p', { class: 'sign', text: '——来自开发者' }),
    )

    root.append(look.root, from.root, note.root)
  },
  leave() {},
}
