/**
 * context-checkpoint — 跨会话相关性 gate（LOCAL-PATCH #2）。
 *
 * 为什么需要这一层：
 *   原插件把检查点正文**无条件、全量**注入为 systemPrompt section。
 *   于是每个新会话（哪怕主题完全无关）第一轮都要付一次全额未命中的
 *   15K~35K token，并且把上一个任务的状态当成"当前指令"送给模型。
 *
 *   SKILL.md 里写的正确做法（"两阶段载入 + 相关性 gate"、"不相干就忽略，
 *   哪怕它是 3 分钟前写的"）原先只在"模型自己记得去执行"这一层存在；
 *   插件侧完全没有实现。本模块把它落到代码里。
 *
 * 三档模式：
 *   full    — 同一会话：注入全文（这是"压缩后重注入"的正题，不许降级）
 *   card    — 跨会话但仍在可信期内、且主题有交集：只注入摘要卡片（≤ CARD_MAX_CHARS）
 *   pointer — 其余（跨会话且不相关 / 过期）：只注入一行提示，告知可主动 read
 *
 * 成本（实测口径，见 06-gate-cost.mjs）：
 *   full 上限 60,000 字符；card 上限 900 字符；pointer 上限 160 字符；missing 不注入。
 *
 * @module dsh-cairn/gate
 */

/** 摘要卡片字符上限。 */
export const CARD_MAX_CHARS = 900
/** 指针提示字符上限。 */
export const POINTER_MAX_CHARS = 160
/** 跨会话卡片模式的可信期。 */
export const CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 关键词至少命中几个才认为"主题相关"。 */
export const MIN_KEYWORD_HITS = 1

/** 停顿词：这些词出现在任务描述里不构成"主题相关"的证据。 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'your', 'what',
  'dsh', 'plugin', 'plugins', 'file', 'files', 'code', 'task', 'work', 'fix',
  '修复', '插件', '文件', '任务', '问题', '工作', '这个', '那个', '一下',
])

/** 把任意文本切成候选关键词（ASCII 词 + 中文二元组）。 */
export function tokenize(text, limit = 32) {
  if (typeof text !== 'string' || text.length === 0) return []
  const out = new Set()
  const lower = text.toLowerCase()

  // ASCII / 数字标识符（含 - . _），长度 >= 3
  for (const m of lower.matchAll(/[a-z][a-z0-9_.-]{2,}/g)) {
    const w = m[0].replace(/[.-]+$/, '')
    if (w.length >= 3 && !STOPWORDS.has(w)) out.add(w)
  }
  // 中文连续段 → 相邻二元组（不引第三方分词，够用且确定）
  for (const seg of text.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const s = seg[0]
    for (let i = 0; i + 1 < s.length; i += 1) {
      const bi = s.slice(i, i + 2)
      if (!STOPWORDS.has(bi)) out.add(bi)
      if (out.size >= limit * 4) break
    }
  }
  return [...out].slice(0, limit)
}

/** 从检查点正文里抽 `# 标题` 与 `## Current Goal` 等小节，做摘要卡片。 */
export function buildCard(text, meta) {
  if (typeof text !== 'string' || text.trim().length === 0) return ''
  const lines = text.split(/\r?\n/)
  const wanted = []
  const HEADING = /^#{1,3}\s+(.*)$/
  const NAMED_SECTION = /^(current goal|current state|next action|当前目标|当前状态|下一步|已定结论|决策|blocker|阻塞)/i

  // 先用一级标题（通常是任务名），再抓几个关键小节的前 3 行。
  const h1 = lines.find((l) => /^#\s+/.test(l))
  if (h1) wanted.push(h1.replace(/^#\s+/, '').trim())

  let capturing = false
  let captured = 0
  for (const line of lines) {
    const h = HEADING.exec(line)
    if (h) {
      capturing = NAMED_SECTION.test(h[1].trim())
      if (capturing) wanted.push(`· ${h[1].trim()}`)
      continue
    }
    if (capturing && line.trim().length > 0 && !line.startsWith('---')) {
      if (captured >= 9) { capturing = false; continue }
      wanted.push('  ' + line.trim().replace(/^[-*]\s*/, ''))
      captured += 1
    }
  }

  const head = meta?.topic ? `[跨会话检查点] ${meta.topic}` : '[跨会话检查点]'
  const when = meta?.updatedAt ? `（${String(meta.updatedAt).slice(0, 16).replace('T', ' ')}）` : ''
  const body = wanted.join('\n').slice(0, CARD_MAX_CHARS - head.length - 40)
  return `${head}${when}\n${body}`
}

/**
 * 决定这份检查点该怎么注入。
 *
 * @param meta  current.meta.json 的内容
 * @param ctx   { sessionId, taskText, now? }
 * @returns { mode: 'missing'|'full'|'card'|'pointer', reason, hits }
 */
export function decideInjection(meta, ctx = {}) {
  if (meta === undefined || meta === null) {
    return { mode: 'missing', reason: 'no checkpoint on disk', hits: 0 }
  }
  const sessionId = ctx.sessionId
  const now = typeof ctx.now === 'number' ? ctx.now : Date.now()

  // ① 同一会话 → 永远全量（压缩后重注入的正题，任何情况下都不许降级）
  if (typeof meta.sessionId === 'string' && sessionId !== undefined && meta.sessionId === sessionId) {
    return { mode: 'full', reason: 'same session', hits: 0 }
  }

  const ageMs = typeof meta.updatedAt === 'string' ? now - Date.parse(meta.updatedAt) : Number.POSITIVE_INFINITY
  const fresh = Number.isFinite(ageMs) && ageMs <= CARD_TTL_MS

  // ② 跨会话但过期 → 只给指针
  if (!fresh) {
    return { mode: 'pointer', reason: 'cross-session and older than 7d', hits: 0, ageMs }
  }

  // ③ 跨会话、未过期 → 看主题交集
  const mine = tokenize(ctx.taskText ?? '', 24)
  const theirs = new Set(Array.isArray(meta.keywords) ? meta.keywords.map((k) => String(k).toLowerCase()) : [])
  let hits = 0
  for (const w of mine) if (theirs.has(w)) hits += 1

  if (hits >= MIN_KEYWORD_HITS) {
    return { mode: 'card', reason: `cross-session, ${hits} keyword overlap`, hits, ageMs }
  }
  return { mode: 'pointer', reason: 'cross-session, unrelated topic', hits: 0, ageMs }
}

/** 指针模式文案。 */
export function renderPointer(meta) {
  const topic = meta?.topic ? `topic="${String(meta.topic).slice(0, 60)}"` : 'topic unknown'
  const when = meta?.updatedAt
    ? `${Math.max(0, Math.round((Date.now() - Date.parse(String(meta.updatedAt))) / 86400000))}d ago`
    : 'date unknown'
  const text = `（本工作区存在一份历史检查点：${topic}，${when}。若与当前任务相关，调用 checkpoint_read 载入。）`
  return text.length > POINTER_MAX_CHARS ? text.slice(0, POINTER_MAX_CHARS) + '…' : text
}

/**
 * 从用户消息里提取"当前任务文本"，供关键词召回。
 * 只看最近一条真实用户消息，避免历史噪声。
 */
export function taskTextFromSession(session, maxChars = 600) {
  try {
    const events = session?.events
    if (!Array.isArray(events)) return ''
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i]
      if (e?.type !== 'user/message') continue
      if (e?.data?.source?.kind !== 'user') continue
      const content = e?.data?.content
      if (!Array.isArray(content)) continue
      const text = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
      if (text.length > 0) return text.slice(0, maxChars)
    }
  } catch { /* 结构变了就退化为空 */ }
  return ''
}
