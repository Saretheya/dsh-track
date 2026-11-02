/**
 * dsh-cairn
 *
 * 闭环：**达限 → 总结落盘 → 自动压缩 → 压缩后把总结重新注入为静态上下文**。
 *
 * 与 DSH 原生机制的分工：
 *  1. **压缩** 由 DSH 原生提供（宿主的压缩能力，接近窗口上限时自动触发）。
 *     本插件**不自行压缩**。
 *  2. **总结落盘** 由 `context_compact` 工具 + skill 的「交付点」规则驱动，
 *     模型调用 `checkpoint_write` 把项目状态写进插件自有数据目录。
 *  3. **压缩后注入** 由本插件的系统提示词段承担：每代读一次检查点文件，
 *     把内容作为**静态上下文**注入。同一代内逐字不变（保证 prompt 缓存命中），
 *     跨代（压缩发生）自动换新 —— 这正是"压缩后注入静态提示词"。
 *
 * 成本铁律（用 $97 换来）：**同一 context generation 内，提示词段必须逐字相同**。
 * 任何每步变化的数字都不能进提示词段；精确用量只在模型主动调用 `context_status` 时给出。
 */
/**
 * 本插件刻意 **零外部依赖**（只用 node: 内置模块）。
 *
 * 原因（实测教训）：插件经 junction 暴露给 profile 后，Node 按 **realpath** 解析依赖，
 * 而插件目录没有 node_modules，`import '@deepseek-ai/dsh-llm'` 会 ERR_MODULE_NOT_FOUND；
 * 更重要的是，一旦模块级 import 失败，apply 永不执行、fiber 永久 pending ——
 * 表现为"插件卡住、DSH 起不来"。为零依赖后，加载路径与最小控制实验完全一致。
 */
import { randomUUID } from 'node:crypto'
// 读自身 package.json 以确定"我是哪个变体"
import { readFileSync } from 'node:fs'

// ── / #2：存储层与跨会话 gate ────────────────────────────────
// 原实现直接 readdirSync/readFileSync 工作区根，本版全部改走插件自有 data/。
import {
  DATA_DIR,
  MAX_CHECKPOINT_CHARS,
  MAX_INJECT_CHARS,
  CHECKPOINT_FRESH_MS,
  canonicalPath,
  cleanTmp,
  describeCheckpoint as describeCheckpointOnDisk,
  ensureDirs,
  readCheckpoint,
  readMeta,
  writeCheckpoint,
  workspaceDir,
} from './storage.js'
import {
  buildCard,
  decideInjection,
  renderPointer,
  taskTextFromSession,
  tokenize,
} from './gate.js'
// skill 随插件自注册（不落 <DSH_HOME>/skills/，卸载即消失）
import { registerSkillProvider } from './skill-provider.js'
// 多变体互斥（四个包名共用同一份代码，只让优先级最高者生效）
import { claimVariant, describeLock, rankOf, VARIANT_ORDER } from './variant.js'

/**
 * 本包的名字。
 *
 * 同一份代码以 4 个包名分发，互斥逻辑靠它判断优先级。
 * 取值顺序：
 *   1. 环境变量 `CAIRN_PKG_NAME` —— 仅用于**同进程多包名测试**；
 *   2. `package.json` 的 name —— 运行时从模块自身路径读回，**唯一真源**；
 *   3. 兜底 `'dsh-cairn'`。
 *
 * 为什么不写死：四个包共用同一份 lib/，写死就无法区分它们。
 *
 * ⚠ env 优先是**故意**的：模块按 realpath 缓存，同一进程里 `import.meta.url` 不变，
 *   测试要模拟不同包名只能靠 env。真实运行时没人设这个变量，所以走 package.json。
 */
const PKG_NAME = (() => {
  const fromEnv = process.env.CAIRN_PKG_NAME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  try {
    // lib/index.js → ../package.json
    const url = new URL('../package.json', import.meta.url)
    const pkg = JSON.parse(readFileSync(url, 'utf8'))
    if (typeof pkg?.name === 'string' && pkg.name.length > 0) return pkg.name
  } catch { /* 读不到就走兜底 */ }
  return 'dsh-cairn'
})()

/**
 * 本插件在会话里的**生产者标识**。
 *
 * ⚠ 注意（崩溃事故的直接原因）：
 *   DSH 会话格式 v4 的 `assertV4MessageSources` 显式拒绝字面量 `kind === 'plugin'`：
 *
 *     if (... || value["kind"] === "plugin") throw new SessionFormatError(
 *       "format v4 message requires a producer-owned source kind")
 *
 *   而本插件原先三处注入都用 `{ kind: 'plugin', plugin: '...' }` —— 于是任何一次
 *   注入（越线提醒 / followup 唤醒）都会让整个会话的持久化校验失败，
 *   表现为前台报 "format v4 message requires a producer-owned source kind"、
 *   整轮操作作废（该消息不落盘），甚至进程被迫重启。
 *
 *   官方约定是 `source.kind` 用**生产者自己命名的标识**（如 `goal` / `plan-mode` /
 *   `time-context`），任何非空字符串都通过。故改用 `context-checkpoint`。
 *
 * 另：`user/message` 还必须带**顶层** `surfaceOp: "append"`（字符串，不是对象），
 * 否则报 "user/message surfaceOp requires an object"。本函数已统一补上。
 */
const PRODUCER_KIND = 'context-checkpoint'

/**
 * 构造一条 v4 合法的 user 角色消息。
 *
 * 与官方 `createUserMessage` 的差异：官方那个**不写 surfaceOp**（它只用于内存态，
 * 由 session 追加时补），而插件注入的消息会直接进入持久化通道，所以要自己带。
 *
 * @param {object} input
 * @param {Array} input.content 内容块
 * @param {object} [input.source] 覆盖默认 source（必须非空 kind，且不得为 'plugin'）
 * @returns 冻结的 user 消息
 */
function createUserMessage({ content, source }) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content,
    source: source ?? { kind: PRODUCER_KIND, form: 'notice' },
    // v4 对 user/message 的硬要求：顶层 surfaceOp 必须是字符串 "append"
    surfaceOp: 'append',
  })
}

/**
 * 声明一个工具（等价于 dsh-tools 的 defineTool，只保留本插件用到的字段）。
 * parameters 直接使用 JSON Schema —— 注册表本身就是按 JSON Schema 读取的。
 */
function defineTool({ name, description, parameters, output, execute }) {
  return {
    name,
    description,
    parameters: parameters ?? { type: 'object', properties: {} },
    output: {
      schema: output.schema,
      render: (args, value) => output.render(args, value)
    },
    execute
  }
}

/**
 * 插件在装配层的名字。
 *
 * 同一份代码以 4 个包名分发，所以这里**不能写死**。取模块自身 package.json 的 name，
 * 与 cordis.patch.yml 里的 `name:` 保持一致。读不到时兜底 `dsh-cairn`。
 *
 * ⚠ 为什么是 `export const` 而不是函数：DSH 装载器按约定读取 `name` 属性，
 *   必须是字符串。模块按 realpath 缓存，因此**一个进程里只会有一个值**——
 *   这对真实使用没有影响（一个 profile 只装一个变体），只在同进程测试多包名时需要隔离。
 */
export const name = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    if (typeof pkg?.name === 'string' && pkg.name.length > 0) return pkg.name
  } catch { /* 读不到走兜底 */ }
  return 'dsh-cairn'
})()

/**
 * 硬依赖：这三个服务在 web 平面与 host 平面都存在，可以安全声明。
 *
 * `llm` 必须在列表里 —— 插件的 `readPressure` / `resolveWindow` 用它解析窗口容量。
 * 曾经漏掉它，结果 `context_compact` 一调用就抛
 * `cannot get property "llm" without inject`（与 tokenMeter 那次是同一类错误）。
 *
 * ⚠️ 仍然**不能**把 `tokenMeter` / `compaction` 写进这里：
 * 它们只挂在 host 平面，写进来会让本平面 fiber 永久 pending → DSH 起不来。
 * 那两个一律走 `ctx.get()` 软解析 + 降级分支。
 */
export const inject = ['tools', 'systemPrompt', 'llm']

/** 中文最坏密度（字符/token）；DSH 自己的估价是 4 字符/token。 */
const CJK_CHARS_PER_TOKEN = 1.7

/** 应当落盘的安全线：真实占用不超过窗口的 90%。 */
const SAFE_REAL_RATIO = 0.9

/**
 * 值得压缩的最低占用：低于窗口的这个比例时，`context_compact` **只落盘、不预约**。
 *
 * 为什么必须有这道闸：本工具的语义是"上下文将尽时落盘 + 压缩"。若在一个 12 万 token、
 * 还远没满的会话里也强行压一次，会把仍在使用的历史白白压掉（破坏性 + 白烧一次摘要调用）。
 */
const MIN_TRIGGER_RATIO = 0.5

/**
 * 执行前的复核线：实测占用若已跌到"预约时"的这个比例以下，说明期间别处已经压过一次
 * （DSH 的 overflow 兜底 / 用户手动 /compact / 另一条路径先跑了）——
 * 这次请求作废，**避免刚压完又压一次**。
 */
const STALE_RATIO = 0.5

/**
 * 落盘新鲜度线：检查点文件最后修改时间距今超过这个时长，就**拒绝预约**。
 *
 * 为什么必须有这道闸（这是闭环里最容易丢结论的一个缺口）：
 * 压缩由 pre-step 在**下一个步骤边界**执行，也就是「模型调用 `context_compact` 之后的第一步」。
 * 模型**没有机会**在调用之后补写文件 —— 一旦预约，压缩就会照常跑。
 * 所以如果此刻磁盘上的检查点还是上一代写的（或根本不存在），压缩会压掉尚未落盘的最新结论，
 * 而新代注入的是那份**旧**总结 —— 恰好就是用户最怕的"结论丢失"。
 *
 * 因此：文件缺失或陈旧时，`context_compact` 只返回明确的"先落盘"指令，不预约。
 * 模型更新文件后再调一次即可通过（mtime 立即变新）。
 * 只有显式 `force: true`（应急重置 / 实机验证）才绕过这道闸，并在返回文案里如实标注。
 *
 * 常量已迁到 `./storage.js`（那里与写入端、meta 端共用），本处只 import。
 */

/**
 * 用户**显式**要求检查点 / 压缩 / 开始项目的信号词。
 *
 * 为什么要把"用户显式要求"和"模型自主判断"分开：
 *   · **用户显式要求**（"总结一下本轮"、"写个 checkpoint"、"开始项目"）—— 用户要的是
 *     "把当前状态固化下来，然后换一个干净的上下文起点"，**与当前占用多少无关**。
 *     这时还拿"占用没到窗口 50%"把人挡回来，就是把用户的明确指令降级成建议。
 *   · **模型自主判断**（上下文将尽自己决定压）—— 继续受门槛约束，
 *     避免在一个还很短的会话里白烧一次摘要、白压掉还在用的历史。
 * 所以命中信号词后的窗口内，`context_compact` **跳过占用校验**（floor）。
 *
 * ⚠️ 落盘闸**不在**豁免范围内：它守的是"② 落盘必须在 ③ 压缩之前完成"，
 *    与上下文用量无关，豁免它就等于允许压掉尚未落盘的结论。
 *
 * ⚠️ 判定不看模型传了什么参数 —— 只看**用户自己说过什么**。
 *    让模型每次自己判断"这次该不该传 force"，等于把稳定性交给模型的记性。
 */
const DEFAULT_USER_INTENT_WINDOW_MS = 15 * 60 * 1000

const USER_CHECKPOINT_INTENT = [
  // 检查点 / 压缩（明确的术语）
  'checkpoint', '检查点', 'compact', '压缩上下文', '上下文压缩', '落盘', '归档',
  // 总结（带限定词，避免把"总结一下这个函数"这种无关请求也算进来）
  '总结一下本轮', '总结本轮', '总结进度', '阶段总结', '做个总结', '总结一下上下文', '总结会话',
  // 项目启动：consult-then-guide 流程里"指南定稿 → 用户确认开始"这一步
  '开始项目', '开始实施', '开工', '确认开始', '开始吧', '开始做'
]

/** 把消息内容（blocks 或裸字符串）折成纯文本，用于识别用户意图。 */
function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join(' ')
}

/** 返回命中的信号词（没命中就返回 undefined）。 */
function matchedIntent(text) {
  if (typeof text !== 'string' || text.length === 0) return undefined
  const lower = text.toLowerCase()
  return USER_CHECKPOINT_INTENT.find((word) => lower.includes(word.toLowerCase()))
}

/**
 * 占用条 / 检查点所在提示词段的顺序。
 *
 * 原值 9000 与官方 `DELIVERABLE_FILE_REFERENCES`（9000）撞车，
 * 同值时按 section name 的 code-unit 排序，位置不可控。改到 9250，落在
 * `DELIVERABLE_FILE_REFERENCES`(9000) 与 `STRUCTURED_OUTPUT`(9900) 之间，
 * 与"工具用法"区隔开。
 */
const SECTION_ORDER = 9250

/**
 * 表层 `replace` 次数（把一段事件合并成单个节点）。
 *
 * ⚠️ 这**不是压缩次数**：`dsh-session/lib/index.js:412-414` 的 `applySurfacePlan`
 * 对任何 `kind === "replace"` 都自增，压缩只是其中一种来源。
 * 最初我把这个数字标成"已压缩 N 次"，实测发现一个 40 轮、0 次 `compaction/summary`
 * 的会话里它也涨到 10 —— 属于误标，现改为如实表述。
 */
function surfaceReplaceCount(session) {
  const value = session?.surface?.replaceGeneration
  return typeof value === 'number' ? value : 0
}

/**
 * 解析当前真实占用。**没有计量服务时返回 null**（调用方必须降级，不能编数字）。
 * `measure()` 的基线在可用时就是 provider 上报的真实 usage，`totalTokens` 即真实占用；
 * 只有在 provider 还没有回过一次 usage 时才是纯启发式估价。
 */
function readPressure(meter, session, llm, signal) {
  if (meter === undefined) return Promise.resolve(null)
  const measured = meter.measure(session)
  const header = session.requestHeader?.()
  const route = header?.config
  const result = {
    totalTokens: measured.totalTokens,
    baselineKind: measured.baseline?.kind ?? 'unknown',
    contextWindow: undefined,
    surfaceReplace: surfaceReplaceCount(session),
    provider: route?.provider,
    model: route?.model
  }
  // contextWindow 需要异步解析；无法解析时保持 undefined，占用条退化为"只有已用量"。
  if (route?.provider && route?.model && llm?.resolveModelInfo) {
    return llm
      .resolveModelInfo(route.provider, route.model, signal)
      .then((info) => {
        const window = info?.context?.contextWindow
        if (typeof window === 'number' && window > 0) result.contextWindow = window
        return result
      })
      .catch(() => result)
  }
  return Promise.resolve(result)
}

/**
 * 档位：把连续占用值折叠成离散状态。仅用于**越线时的一次性提醒**，不做每步播报。
 */
function pressureStage(pressure) {
  if (pressure === null || pressure === undefined) return 'unknown'
  const used = pressure.totalTokens
  const window = pressure.contextWindow
  if (typeof window !== 'number' || window <= 0) return 'usage-only'
  const ratio = used / window
  if (ratio >= SAFE_REAL_RATIO) return 'over'
  if (ratio >= 0.8) return 'near'
  if (ratio >= 0.5) return 'warm'
  return 'healthy'
}

/**
 * 固定文案：压缩由 DSH 的原生压缩引擎执行，本插件只负责**落盘锚点 + 触发时机**。
 *
 * ⚠ 注意（成本审计）：
 *   这段 369 字符（约 92~217 token）原先是**每一档注入都带**，包括跨会话的 card 模式。
 *   但它讲的是"本会话内怎么配合 `context_compact`"，对**跨会话的历史卡片毫无意义**
 *   —— 拿到卡片时用户根本不在那个会话里，也不该去调它的 `context_compact`。
 *   故把规则拆成两条短句，仅 full 模式附带；card / pointer 不带。
 */
const STATIC_RULES = [
  '- 本段是**本会话**的权威副本；与项目文档或 repo 冲突时以 repo 为准，其余以本段为准。',
  '- 顺序：上下文紧张时**先** `checkpoint_write` 落盘，**再** `context_compact`；',
  '  压缩在下一步自动执行，那时你已没有补写机会，所以它会在落盘不新鲜时拒绝预约。',
].join('\n')

/**
 * 渲染**完整静态提示词段**。
 *
 * 这里有一条用钱换来的铁律：**同一代之内，本函数的返回值必须逐字不变。**
 * 曾经的实现把"已用 N token / surface 计数"放进来，提示词每步都变 →
 * 新 request series → prompt 缓存全失效，实测一小时未命中缓存输入 40.5M、当日 $96.97。
 * 因此：内容**每代只读一次**并缓存；跨代（压缩发生）才重新读。
 *
 *（成本闸）：**没有检查点时返回空字符串。**
 * 原实现即使在 `missing` 状态也注入 468 字符（含整段 STATIC_RULES），
 * 于是每个会话、每一轮都白付 117~275 token。`systemPrompt.section` 的
 * `text` 返回 `''` 时不贡献任何 token（官方文档：Empty text contributes nothing）。
 *
 * card / pointer 不再附带 STATIC_RULES（那是本会话的操作纪律，
 * 对跨会话历史卡片无意义，白付 92~217 token）。
 */
function renderStaticSection(view) {
  if (view === null || view === undefined || view.mode === 'missing') return ''

  const head = '## 项目检查点（context-checkpoint）'

  // 跨会话但主题不相关 → 只给一行指针，不注入正文。
  // 也不带 STATIC_RULES。
  if (view.mode === 'pointer') {
    return [head, '', renderPointer(view.meta)].join('\n')
  }

  // 跨会话且主题相关 → 只注入摘要卡片（≤ CARD_MAX_CHARS）。
  // 不带 STATIC_RULES。
  if (view.mode === 'card') {
    return [
      head,
      '',
      '同一工作区里的**历史**检查点（跨会话，非本会话；与 repo/Git 冲突时以 repo 为准）：',
      '',
      view.text,
      '',
      '若与当前任务无关，忽略；需要全文时调用 `checkpoint_read`。'
    ].join('\n')
  }

  // mode === 'full'：本会话的权威副本，全量注入。
  if (view.status === 'too-large') {
    return [
      head,
      '',
      `来源：插件数据目录 \`${view.path}\`（每代读取一次；**本会话的权威副本**）`,
      '',
      `⚠️ **内容超出可注入上限（${MAX_INJECT_CHARS} 字符），下面只注入了前 ${MAX_INJECT_CHARS} 字符。**`,
      '请在下一次 `checkpoint_write` 时精简 —— 优先保留 Current Goal / Current State / Next Action。',
      '',
      view.text,
      '',
      '（内容在此截断：原文超限，此处之后的部分没有被注入。）',
      '',
      '---',
      '',
      STATIC_RULES
    ].join('\n')
  }
  if (view.status === 'unreadable') {
    return [head, '', '检查点存在但读取失败（权限或编码问题）。请用 `checkpoint_status` 检查。', '', STATIC_RULES].join('\n')
  }
  // 不再注入完整绝对路径（162 字符 ≈ 40~95 token，且模型从不需要它）。
  return [
    head,
    '',
    '（本会话的权威副本；与 repo/Git 冲突时以 repo 为准）',
    '',
    view.text,
    '',
    '---',
    '',
    STATIC_RULES
  ].join('\n')
}

/**
 * 每代解析一次注入视图（带跨会话 gate）。
 *
 * 缓存键仍是 `session` 对象（WeakMap 合法键），读盘源换成插件 data 目录。
 *
 * ⚠ 注意（真实工具调用测试抓到的缺陷）：
 *   原先只用 `generation`（= surface replace 次数）做缓存键。但 `checkpoint_write`
 *   **不改变 surface generation** —— 于是在同一代内写完检查点，注入段仍是旧的
 *   （首次是空字符串），必须等下一次压缩才会刷新。
 *   实测症状：先 text() 拿到 ""（missing 并缓存），再 checkpoint_write 成功，
 *   随后 text() 仍返回 "" —— 检查点写了但注入端读不到。
 *
 *   修复：缓存键加入 `meta.updatedAt`。写入必然更新它 → 缓存失效 → 立刻注入新内容。
 *   搜索也保留原语义：**状态不变时多次组装返回同一个对象**（缓存仍生效），
 *   prompt 前缀缓存不被破坏。
 *
 * @returns { mode: 'missing'|'full'|'card'|'pointer', status, path, text, meta, reason }
 */
const checkpointCache = new WeakMap()

function resolveCheckpoint(session, generation) {
  const cwd = session?.header?.cwd
  const meta = readMeta(cwd)
  // 缓存指纹：代际 + 检查点自身时间戳 + 会话。三者都不变才复用。
  const stamp = `${generation}|${meta?.updatedAt ?? 'none'}|${session?.id ?? ''}`

  const hit = checkpointCache.get(session)
  if (hit !== undefined && hit.stamp === stamp) return hit

  const decision = decideInjection(meta, {
    sessionId: session?.id,
    taskText: taskTextFromSession(session)
  })

  let next
  if (decision.mode === 'missing') {
    next = { stamp, generation, mode: 'missing', status: 'missing', path: canonicalPath(cwd), text: '', meta: undefined }
  } else if (decision.mode === 'pointer') {
    next = { stamp, generation, mode: 'pointer', status: 'ok', path: canonicalPath(cwd), text: '', meta }
  } else {
    const raw = readCheckpoint(cwd)
    if (raw === undefined) {
      next = { stamp, generation, mode: 'missing', status: 'missing', path: canonicalPath(cwd), text: '', meta: undefined }
    } else if (decision.mode === 'card') {
      next = { stamp, generation, mode: 'card', status: 'ok', path: canonicalPath(cwd), text: buildCard(raw, meta), meta }
    } else if (raw.length > MAX_INJECT_CHARS) {
      next = { stamp, generation, mode: 'full', status: 'too-large', path: canonicalPath(cwd), text: raw.slice(0, MAX_INJECT_CHARS), meta }
    } else {
      next = { stamp, generation, mode: 'full', status: 'ok', path: canonicalPath(cwd), text: raw, meta }
    }
  }
  // 决策理由只进日志，不写进提示词（不影响缓存）。
  next.reason = decision.reason
  checkpointCache.set(session, next)
  return next
}

/**
 * 越过提醒的文案（**只在跨越档位时注入一次**，不做每步播报）。
 *
 * 为什么不做每步播报：注入消息每步都追加，等于每步都在尾部长内容；
 * 而且它并不解决用户要的"压缩后注入总结"这件事。占用信息只需在**越线时**提醒一次。
 */
const CROSSING_NOTICE = {
  warm: '【上下文占用】已过半。**先**调用 `checkpoint_write` 把本轮结论落盘，再调用 `context_compact`；'
    + '压缩会在你的**下一步**自动执行（不必等交付点、不必结束本轮）。',
  near: '【上下文占用】接近窗口上限。**立刻**调用 `checkpoint_write` 更新检查点并调用 `context_compact`'
    + '（压缩在下一步自动执行）。别等 DSH 自动压缩 —— 那时请求可能已经被拒。',
  over: '【上下文占用】已越过安全线。**立即**调用 `checkpoint_write` 更新检查点并调用 `context_compact`；'
    + '压缩会在下一步自动执行，避免自动压缩时丢失结论。'
}

/** 档位高低序，用于判断"是往上跨"还是"降回来了"。 */
const RANK = { unknown: -1, 'usage-only': 0, healthy: 1, warm: 2, near: 3, over: 4 }

/**
 * 描述落盘状态（改从插件 data 目录读）。
 *
 * 语义与原实现一致：`missing` / `stale` / `fresh`，只有 `fresh` 允许预约压缩。
 * 文件被删/不可读时如实降级为 `missing`（宁可不压，也不要在没有锚点的情况下压）。
 */
function describeCheckpoint(cwd) {
  return describeCheckpointOnDisk(cwd)
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger?.('cairn')

  // ── 数据目录自举 ─────────────────────────────────────────
  // 建好 data/{checkpoints,tmp,logs}，并清掉上次异常退出留下的 tmp 残留。
  // 失败不阻挡插件加载（宁可降级成"只测占用"，也不要让 fiber 卡住）。
  try {
    ensureDirs()
    cleanTmp()
    logger?.info?.(`数据目录就绪（唯一写入位置）`)
  } catch (error) {
    logger?.warn?.(`数据目录初始化失败：${String(error?.message ?? error)}；检查点读写将不可用`)
  }

  // ── 多变体互斥 ──────────────────────────────────────────
  // 本包以 4 个名字分发（dsh-cairn / dsh-flashback / dsh-ctx / dsh-trace），
  // 共用同一份代码。同时启用多个时，**只有优先级最高的那个真正生效**，
  // 其余**静默休眠** —— 不注册工具、不注入提示词段、不注册 skill、不打日志噪音。
  //
  // 为什么在 apply() 最前面做：休眠必须在任何副作用之前返回，
  // 否则会出现"两个变体都注册了 context_status 工具"→ 工具重名/行为错乱。
  const variant = claimVariant(DATA_DIR, PKG_NAME)
  if (!variant.active) {
    // 静默：只留一条 info（便于排错时确认为什么是它），不 warn 不报错。
    logger?.info?.(`休眠：${variant.reason}（本变体 ${PKG_NAME} 不注册任何能力）`)
    return
  }
  // 进程退出时释放锁，避免留下陈旧锁挡住下次启动。
  ctx.effect(() => () => {
    try { variant.release?.() } catch { /* 已释放 */ }
  }, `${PKG_NAME}: variant lock`)
  logger?.info?.(`生效变体：${PKG_NAME}（优先级 ${rankOf(PKG_NAME)}）`)

  // ── skill 自注册 ──────────────────────────────────────────
  // 放在工具注册之前：即使后续某个工具注册失败，skill 仍可用（它只描述纪律，不依赖服务）。
  // 故意**不**把 `skills` 写进模块级 inject：用 ctx.inject() 软挂载，服务缺席时静默跳过，
  // 避免 fiber 永久 pending 导致 DSH 起不来。
  //
  // ⚠ 这一行曾经在"src → lib 同步"时被旧版 src 覆盖掉，导致 provider 从未注册、
  //   技能目录里看不到本插件。该测试只覆盖了
  //   registerSkillProvider 函数本身，没测"它是否真的被 apply() 调用" —— 测试盲区。
  registerSkillProvider(ctx, logger)

  /**
   * 每 agent 的"已落盘"内存标记。
   *
   * 为什么不用 mtime 判新鲜度：`mtime` 是文件系统事实，模型可以用空 `write`
   * 甚至 `touch` 伪造。改成"只有 `checkpoint_write` 成功返回后才置位"，
   * 模型无法伪造。压缩执行后清掉，要求重新落盘。
   */
  const writtenAt = new WeakMap()

  /** 软解析结果缓存（进程生命周期内稳定）。 */
  const resolved = { meter: undefined, compactor: undefined }

  /**
   * 软解析一个可选服务。
   *
   * ⚠️ 这里**只能**用 `ctx.get()`，绝不能写 `ctx.tokenMeter`：
   * cordis 对未在 `inject` 中声明的服务，属性访问会直接抛
   * `cannot get property "tokenMeter" without inject`。
   * 而 `tokenMeter` / `compaction` 只在 host 平面存在，若把它们写进 inject，
   * 本平面的 fiber 又会永久等不到 —— 所以两者都写进 inject 也不可行。
   * `ctx.get()` 是唯一安全的读取方式：服务不存在时返回 undefined。
   */
  const tryService = (key) => {
    try {
      return typeof ctx.get === 'function' ? (ctx.get(key) ?? undefined) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * 解析一次并记住结果。软解析结果在进程生命周期内稳定，缓存可避免每步重复尝试。
   * 返回 true 表示该服务在本平面可用。
   */
  const resolveService = (key, field) => {
    if (resolved[field] !== undefined) return true
    const value = tryService(key)
    if (value === undefined) return false
    resolved[field] = value
    return true
  }
  const meter = () => (resolveService('tokenMeter', 'meter') ? resolved.meter : undefined)
  const compactorSvc = () => (resolveService('compaction', 'compactor') ? resolved.compactor : undefined)

  /** 当前平面是否有真实计量 / 压缩能力（每个平面不一样，必须运行时软解析）。 */
  const caps = { get meter() { return meter() }, get compactor() { return compactorSvc() } }

  /** 每个 agent 的最近一次测量（供 context_status 与越线判断复用）。 */
  const latest = new WeakMap()
  /** 每个会话最近一次越线档位（用于"只提醒一次"）。 */
  const crossingState = new WeakMap()
  /**
   * 已预约的压缩请求：agent → { scheduledTokens, scheduledAt }。
   *
   * ⚠️ 必须是可迭代的 `Map`，**不能是 WeakMap/WeakSet**：
   *   · WeakSet 不可迭代（`[...weakSet]` 抛 "not iterable"，回归测试抓到过）；
   *   · WeakMap 虽然可迭代键，但键必须是对象 —— 这里键确实是 agent（对象），可用；
   *     保留 Map 是因为要顺带存 scheduledTokens（执行前的复核线要用它做比较）。
   * 代价：强引用 agent，所以**每条路径都必须把它从集合里删除**（见 runScheduledCompaction）。
   */
  const pendingCompact = new Map()
  /** 正在执行压缩的 agent（避免并发重复压缩同一个）。 */
  const compacting = new WeakSet()
  /**
   * 用户**显式**要求检查点 / 压缩 / 开始项目的最近一次时间戳。
   *
   * 键是 `session.id`（**字符串**）→ 必须是普通 Map（`WeakMap.set(string, …)` 会抛
   * `Invalid value used as weak map key`）。只记"什么时候说过、命中了哪个词"，
   * 不记内容；窗口过期由读取端惰性判断，不需要定时器。
   */
  const userIntent = new Map()

  /**
   * 用户意图的**有效期**。走 config（`userIntentWindowMs`）而不是写死，
   * 一是不同项目节奏不同，二是回归测试要能构造"已过期"的路径 ——
   * 传 0 表示关闭这条豁免（生效条件是 `ageMs < 窗口`，所以 0 永远不成立），
   * 非数字 / 负数则回落到默认值。
   */
  const intentWindowMs = typeof config?.userIntentWindowMs === 'number'
    && Number.isFinite(config.userIntentWindowMs) && config.userIntentWindowMs >= 0
    ? config.userIntentWindowMs
    : DEFAULT_USER_INTENT_WINDOW_MS

  /**
   * 取窗口内命中的用户意图（过期即视为没说过）。
   *
   * ⚠️ 必须是**严格小于**：写成 `ageMs <= intentWindowMs` 时，同一毫秒内记录的消息
   * 会让 `0 <= 0` 成立 —— 于是 `userIntentWindowMs: 0` 这个"关闭豁免"的开关失效，
   * 回归测试（5j 窗口过期）当场抓到了这个边界。
   */
  const userIntentHit = (session) => {
    const hit = userIntent.get(session?.id)
    if (hit === undefined) return undefined
    const ageMs = Date.now() - hit.at
    return ageMs < intentWindowMs ? { word: hit.word, ageMs } : undefined
  }
  /**
   * 每个会话的请求路由。
   * 键是 `session.id`（**字符串**），所以必须是普通 Map —— WeakMap 只接受对象键，
   * `WeakMap.set(string, …)` 会抛 `Invalid value used as weak map key` 并毒化插件树。
   */
  const routeBySession = new Map()
  /** provider/model → 上下文窗口容量。键是字符串，同样必须是 Map。 */
  const windowByRoute = new Map()

  /** 解析并缓存某条路由的窗口容量；失败返回 undefined（占用条退化为"只有已用量"）。 */
  const resolveWindow = async (provider, model, signal) => {
    if (provider === undefined || model === undefined) return undefined
    const key = `${provider}/${model}`
    const hit = windowByRoute.get(key)
    if (hit !== undefined) return hit
    if (ctx.llm?.resolveModelInfo === undefined) return undefined
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model, signal)
      const value = info?.context?.contextWindow
      if (typeof value === 'number' && value > 0) {
        windowByRoute.set(key, value)
        return value
      }
    } catch { /* 容量未知 */ }
    return undefined
  }

  /** 取当前会话的路由（先看会话自身 header，再退回 llm/stream 抓到的）。 */
  const routeOf = (session) => {
    const config = session?.requestHeader?.()?.config
    const seen = routeBySession.get(session?.id)
    return { provider: config?.provider ?? seen?.provider, model: config?.model ?? seen?.model }
  }

  /**
   * 用 ctx.effect 挂载一个注册动作，并**校验它确实返回了可回收对象**。
   *
   * 为什么必须这样：cordis 的 `ctx.on()` 在被 `internal/listener` 取消时返回的是
   * 布尔 `true`（见 cordis `on()` 的 `if (result) return result`）。这类原始值一旦进入
   * cordis 内部的 `DisposableList`，`weak.set(true, sn)` 就会抛
   * `Invalid value used as weak map key`，并且会毒化整个插件树。
   * 包一层之后：注册失败会变成一条**指向本插件、可读的**错误，而不是框架级崩溃。
   */
  const register = (label, action) => {
    ctx.effect(() => {
      const disposer = action()
      if (typeof disposer !== 'function' && typeof disposer !== 'object') {
        throw new TypeError(
          `context-checkpoint: ${label} did not return a disposer (got ${typeof disposer}); ` +
          'refusing to hand a primitive to cordis (it would crash the DisposableList WeakMap)'
        )
      }
      return disposer
    }, label)
    logger?.info?.(`registered ${label}`)
  }

  // ── 观察面 1：压缩代际变化（surface 替换 = 压缩发生过） ──────────────
  register('context-checkpoint:session-event', () => ctx.on('session/event', (session, event) => {
    const state = latest.get(session)
    const surfaceReplace = surfaceReplaceCount(session)
    if (state !== undefined && surfaceReplace !== state.surfaceReplace) {
      latest.set(session, { ...state, surfaceReplace })
    }
    // 压缩会让 surface 代际前进；检查点段靠它自动换成新内容，无需手动失效。
    if (event?.type === 'compaction/end' && event.data?.error === undefined) {
      logger?.info?.(`compaction finished for session ${session.id}; checkpoint section will refresh on next assembly`)
    }
    // 用户**显式**要求（"总结一下本轮" / "写个 checkpoint" / "开始项目"…）→ 记时间戳。
    //
    // 判据只看 `source.kind === 'user'`。实测本会话里的非用户来源各有自己的 kind
    // （`compact`、`agent-instructions`、`skill-catalog`、`@scope/pkg` 形式的系统注入），
    // 所以"不是 user 就不算用户要求"。方向上是**故意选保守的那一边**：
    // 漏判只会退回旧行为（受门槛约束），误判却会在用户没要求时白压一个还很短的会话。
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      const word = matchedIntent(messageText(event.data?.content))
      if (word !== undefined) {
        userIntent.set(session.id, { at: Date.now(), word })
        logger?.info?.(`user intent recorded (session ${session.id}): "${word}" — the next context_compact skips the usage floor`)
      }
    }
  }))

  // ── 观察面 2：捕获真实路由（waterfall 必须委托 next()） ──────────────
  register('context-checkpoint:llm-stream', () => ctx.on('llm/stream', (options, next) => {
    if (options?.sessionId !== undefined) routeBySession.set(options.sessionId, { provider: options.provider, model: options.model })
    return next()
  }))

  // ── ②③ 连用：落盘之后**确定性地**压缩 ─────────────────────────────────
  //
  // 设计依据（读的是 DSH 自己的代码，不是猜）——`dsh-compaction-basic/lib/index.js`：
  //
  //   · `compactIfNeeded(agent, trigger, signal)` 有两条分支（L873-920）：
  //       - trigger === 'pressure'        → 先比阈值：`measurement.totalTokens < thresholdTokens`
  //                                         就 `return null`（阈值 = contextWindow × 0.8）；
  //       - trigger === 'context-overflow' → **完全绕过阈值**，注释原文：
  //         "overflow bypasses the normal threshold and retained-tail policy so it can force
  //          one useful balanced reduction"。
  //   · `compactNow()`（L944）走 `agent.runMaintenance()`，**只在真正空闲时可用**，
  //     回合内必抛 `busy / requires an idle agent`。
  //
  // 用 `compactNow()` + 等 `agent/status → idle` 来压缩是走不通的：模型调用 context_compact 后
  // 继续在同一回合里干活 → 空闲窗口永不出现 → 预约的压缩一直没执行，直到请求被服务端
  // 以 CONTEXT_WINDOW_EXCEEDED 拒绝（会话 #4230/#4231 就是这次事故）。
  //
  // 所以执行点放在 **agent/pre-step（回合内的步骤边界）**，用 'context-overflow' 强制压缩：
  //   · 不依赖 800k 阈值（模型配置的 maxTokens 会占掉真实输入上限，阈值可能永远够不到）；
  //   · 不依赖"模型自觉结束本轮"这种碰运气的事 —— 预约后的**下一个步骤**就执行；
  //   · 回合真的已经结束时（模型把 context_compact 当最后一个动作），由 idle 兜底执行并唤醒继续。
  register('context-checkpoint:pre-step-compact', () => ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    // 先压缩再放行：下游（含 DSH 自己的 pressure 判定与越线采样）看到的才是压缩后的占用。
    if (pendingCompact.has(agent)) await runScheduledCompaction(agent, { signal, wake: false })
    return next()
  }))

  register('context-checkpoint:idle-watch', () => ctx.on('agent/status', ({ status }) => {
    if (status !== 'idle') return
    // 不依赖事件里的 agent 字段（全局监听拿不到 agent），直接遍历已预约的集合。
    for (const agent of [...pendingCompact.keys()]) {
      void runScheduledCompaction(agent, { signal: undefined, wake: true })
    }
  }))

  /**
   * 执行一次"已预约"的压缩。**两条触发路径共用**（pre-step 回合内 / idle 回合边界）。
   *
   * @param agent 目标 agent
   * @param options.signal 取消信号；idle 路径传 undefined 时自建
   * @param options.wake 成功后是否 `followup()` 唤醒继续（回合内不需要：本回合会自己继续）
   */
  async function runScheduledCompaction(agent, options = {}) {
    const scheduled = pendingCompact.get(agent)
    if (scheduled === undefined) return
    if (compacting.has(agent)) return
    const compactor = compactorSvc()
    if (compactor === undefined || typeof compactor.compactIfNeeded !== 'function') {
      pendingCompact.delete(agent)
      logger?.warn?.('compaction scheduled but this plane exposes no compactIfNeeded; request dropped')
      return
    }

    // 复核：期间若别处已经压过一次（占用大幅下降），这次请求就是多余的 —— 刚压完又压一次只会白烧一次摘要。
    let current
    try { current = meter()?.measure(agent.session)?.totalTokens } catch { current = undefined }
    if (typeof current === 'number' && scheduled.scheduledTokens > 0 && current <= scheduled.scheduledTokens * STALE_RATIO) {
      pendingCompact.delete(agent)
      logger?.info?.(
        `scheduled compaction skipped: usage already dropped ${scheduled.scheduledTokens} -> ${current} ` +
        '(another compaction happened meanwhile); request cleared'
      )
      return
    }

    pendingCompact.delete(agent)
    compacting.add(agent)
    try {
      const signal = options.signal ?? new AbortController().signal
      const result = await compactor.compactIfNeeded(agent, 'context-overflow', signal)
      if (result === null) {
        logger?.info?.('scheduled compaction: no safe compactable range right now; request cleared')
        return
      }
      logger?.info?.(
        `scheduled compaction done: ${result.shadowedSeqs?.length ?? 0} nodes, ~${result.shadowedTokenCount ?? 0} tokens ` +
        `(surface generation -> ${surfaceReplaceCount(agent.session)})`
      )
    } catch (error) {
      logger?.warn?.(`scheduled compaction failed: ${String(error?.message ?? error)}; request cleared`)
      return
    } finally {
      compacting.delete(agent)
    }

    // 唤醒放在压缩**之后**：反过来 followup 自己就成了"待处理的唤醒工作"，会把压缩窗口顶掉。
    // 回合内（wake=false）不需要唤醒 —— 本回合本来就会继续。
    if (options.wake !== true) return
    const session = agent.session
    const cp = describeCheckpoint(session?.header?.cwd)
    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: [
          '【context-checkpoint】检查点已落盘，历史已压缩，继续同一任务。',
          cp.status === 'missing'
            ? '- 注意：磁盘上没有检查点，结论可能未落盘；如需保留请先调用 `checkpoint_write`。'
            : `- 权威副本：\`${cp.path}\`（已作为静态上下文注入，与项目文档冲突时以它为准）。`,
          '- 直接从刚才在做的事情继续，不要重述已完成的工作，也不要问用户"要做什么"。'
        ].join('\n')
      }],
      source: { kind: PRODUCER_KIND, form: 'notice' }
    }))
  }

  // ── 核心：把「当前代的检查点内容」注入为**静态**系统提示词 ──────────────
  // 同一代内逐字不变（缓存友好）；跨代（压缩发生）自动换成新内容 ——
  // 这就是"压缩后把总结重新注入为静态提示词"。
  //
  // order 从 9000 挪到 9250。
  // 官方 SECTION_ORDERS 里 9000 已被 DELIVERABLE_FILE_REFERENCES 占用，
  // 9900 是 STRUCTURED_OUTPUT。检查点属于"项目状态"而非"工具用法"，
  // 放在两者之间可避免与工具说明混在一起被当成当前指令。
  register('context-checkpoint:checkpoint-section', () => ctx.systemPrompt.section({
    name: 'context-checkpoint:checkpoint',
    order: SECTION_ORDER,
    text: ({ agent }) => {
      const session = agent?.session
      if (session === undefined) return ''
      try {
        const generation = surfaceReplaceCount(session)
        return renderStaticSection(resolveCheckpoint(session, generation))
      } catch (error) {
        logger?.warn?.(`checkpoint section failed: ${String(error)}`)
        return renderStaticSection(null)
      }
    }
  }))

  // ── 越线提醒：**只在跨越档位时注入一次**（不做每步播报）─────────────────
  register('context-checkpoint:pre-step', () => ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const session = agent?.session
    const meterSvc = meter()
    if (session === undefined || meterSvc === undefined) return next()

    let stage = 'unknown'
    try {
      const { provider, model } = routeOf(session)
      const measured = meterSvc.measure(session)
      const contextWindow = await resolveWindow(provider, model, signal)
      const pressure = {
        totalTokens: measured.totalTokens,
        baselineKind: measured.baseline?.kind ?? 'unknown',
        contextWindow,
        surfaceReplace: surfaceReplaceCount(session)
      }
      latest.set(session, pressure)
      stage = pressureStage(pressure)
    } catch (error) {
      logger?.warn?.(`pressure sample failed: ${String(error)}`)
    }

    // 这是 waterfall：必须把下游决定原样传回去，否则决策链断在这里。
    const downstream = await next()
    if (downstream?.kind !== 'enter') return downstream

    // 只提醒"刚跨过去"的那一次；同一档位内不重复。
    const previous = crossingState.get(session)
    crossingState.set(session, stage)
    const notice = CROSSING_NOTICE[stage]
    if (notice === undefined || previous === stage) return downstream
    if (previous !== undefined && previous !== 'unknown' && previous !== 'usage-only'
      && RANK[stage] <= RANK[previous]) return downstream

    const alreadyPresent = (downstream.messages ?? []).some((m) => {
      const blocks = Array.isArray(m?.content) ? m.content : []
      return blocks.some((b) => typeof b?.text === 'string' && b.text.startsWith('【上下文占用】'))
    })
    if (alreadyPresent) return downstream

    logger?.info?.(`pressure crossing ${previous ?? '(none)'} -> ${stage}; injecting one-time notice`)
    return {
      ...downstream,
      messages: [
        ...(downstream.messages ?? []),
        createUserMessage({
          content: [{ type: 'text', text: notice }],
          source: { kind: PRODUCER_KIND, form: 'notice' }
        })
      ]
    }
  }))

  // ── 工具 0：写入检查点（ —— 取代模型用 write 工具在工作区造文件）──
  register('context-checkpoint:tool-checkpoint-write', () => ctx.tools.register(defineTool({
    name: 'checkpoint_write',
    description:
      'Persist the project checkpoint (current goal, settled decisions, rejected approaches, blockers, ' +
      'evidence, next action). This REPLACES writing a file: the content is stored inside this plugin\'s own ' +
      'data directory, versioned (old generation archived), and re-injected into your system prompt after every ' +
      'compaction. Do NOT create a file in the workspace for this. Call it at delivery points, before long work, ' +
      'and whenever context is getting tight — and always BEFORE context_compact (compaction runs at your next ' +
      'step, so you get no chance to write afterwards).',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'Full Markdown body of the checkpoint. Overwrites the current generation; the previous one is ' +
            'archived as gen-NNN.md. Max 60000 chars. Prefer the Fast Resume skeleton: Current Goal / ' +
            'Current State / Next Action / Settled Decisions / Rejected Approaches / Blockers / Evidence.'
        },
        topic: {
          type: 'string',
          description:
            'Short stable topic label, e.g. "审计 context-checkpoint 插件". Used by the cross-session relevance ' +
            'gate so a later session on an unrelated task does not get this checkpoint injected in full. ' +
            'Required on the first write; kept from the previous generation when omitted.'
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional 3-10 distinctive terms for the same gate (file names, plugin names, error codes). ' +
            'Kept from the previous generation when omitted.'
        },
        note: { type: 'string', description: 'Optional short reason, recorded in the plugin log.' }
      }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      const agent = exec.agent
      const session = agent?.session
      if (session === undefined) return 'no session bound to this tool call'
      const cwd = session.header?.cwd
      const text = typeof args?.text === 'string' ? args.text : ''
      const topic = typeof args?.topic === 'string' && args.topic.trim().length > 0 ? args.topic.trim() : undefined
      const keywords = Array.isArray(args?.keywords) && args.keywords.length > 0
        ? args.keywords.map((k) => String(k).trim().toLowerCase()).filter((k) => k.length > 0).slice(0, 32)
        : (topic === undefined ? undefined : tokenize(topic, 16))
      const note = typeof args?.note === 'string' && args.note.length > 0 ? args.note : '(none)'

      let result
      try {
        result = writeCheckpoint(cwd, text, { sessionId: session.id, topic, keywords })
      } catch (error) {
        return `checkpoint_write FAILED: ${String(error?.message ?? error)}`
      }

      // 内存标记：只有走到这里才算"刚写过"，mtime 伪造不了。
      writtenAt.set(agent, Date.now())
      // 清掉本代理此前的"待落盘"预约校验缓存，让下一次 context_compact 立刻放行。
      logger?.info?.(
        `checkpoint written: gen=${result.generation} bytes=${result.bytes} chars=${result.chars} ` +
        `archived=${result.archived} topic=${topic ?? '(kept)'} note=${note}`
      )

      return [
        `✅ 检查点已写入（第 ${result.generation} 代，${result.chars} 字符 / ${result.bytes} 字节）。`,
        result.archived ? `上一代已归档为 gen-${String(result.generation).padStart(3, '0')}.md。` : '这是本工作区第一份检查点。',
        `- 落盘位置：${result.path}（插件自有数据目录；**不要**再在工作区里建同类文件）`,
        `- 注入：本会话会把它作为静态系统提示词段，在每次压缩后自动刷新`,
        `- 下一步：需要现在就压缩时调用 \`context_compact\``
      ].join('\n')
    }
  })))

  // ── 工具 0b：读回检查点 ────────────────────────────────────────────────
  register('context-checkpoint:tool-checkpoint-read', () => ctx.tools.register(defineTool({
    name: 'checkpoint_read',
    description:
      'Read back the persisted checkpoint for this workspace. Use it after a compaction, at task start, or ' +
      'before answering "what did we decide" — instead of relying on memory. Cross-session checkpoints are ' +
      'only summarized or pointed at in the system prompt; call this to get the full text.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional substring filter; omit to get the whole checkpoint.' }
      }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session?.header?.cwd
      const raw = readCheckpoint(cwd)
      if (raw === undefined) return 'no checkpoint on disk for this workspace yet'
      const query = typeof args?.query === 'string' && args.query.length > 0 ? args.query : undefined
      if (query === undefined) return raw
      const lines = raw.split(/\r?\n/).filter((l) => l.includes(query))
      return lines.length === 0 ? `(no line matched "${query}" in the checkpoint)` : lines.join('\n')
    }
  })))

  // ── 工具 1：真实占用查询 ────────────────────────────────────────────
  register('context-checkpoint:tool-status', () => ctx.tools.register(defineTool({
    name: 'context_status',
    description:
      'Read the REAL context usage of this session (provider-reported tokens, window size, remaining headroom, ' +
      'how many times history has been compacted). Use this instead of estimating how full the context is. ' +
      'The same numbers are already injected into your system prompt each step, so call this only when you need ' +
      'a fresh reading (for example right before deciding whether to checkpoint).',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(_args, exec) {
      const session = exec.agent?.session
      if (session === undefined) return 'no session bound to this tool call'
      const pressure = await readPressure(meter(), session, ctx.llm, exec.signal)
      // 改从插件 data 目录读（原先是 findCheckpoint 扫工作区根）。
      const cpState = describeCheckpoint(session.header?.cwd)
      const checkpoint = cpState.status === 'missing' ? undefined : cpState.path
      const cpMeta = readMeta(session.header?.cwd)
      const cpView = resolveCheckpoint(session, surfaceReplaceCount(session))
      // 能力探针：直接回答"这个进程到底组合了哪些服务"，不再靠推测。
      const probe = {}
      for (const key of [
        'tokenMeter', 'compaction', 'llm', 'tools', 'systemPrompt',
        'sessions', 'sessionProjections', 'agents', 'commands', 'loader'
      ]) {
        probe[key] = tryService(key) === undefined ? 'absent' : 'present'
      }
      // ③ 的实际执行入口探针：服务在 != 方法在。只有 'compactIfNeeded' 这条分支绕过阈值，
      // 用它之前先如实回报它在不在（不在就说明这台的 DSH 版本 API 变了，必须降级而不是瞎试）。
      const compactorProbe = compactorSvc()
      // 当前是否处于"用户显式要求"的豁免窗口内。
      // 暴露出来有两个用处：一是重启后据此确认**新版本真的生效了**（旧模块没有这两个字段），
      // 二是回答"为什么这次没豁免"（词没命中 / 窗口过了 / 消息不是用户发的）。
      const intentNow = userIntentHit(session)
      probe['compaction.compactIfNeeded'] = typeof compactorProbe?.compactIfNeeded === 'function' ? 'present' : 'absent'
      probe['compaction.compactNow'] = typeof compactorProbe?.compactNow === 'function' ? 'present' : 'absent'
      if (pressure === null) {
        return JSON.stringify({
          available: false,
          plane: 'this plane has no ctx.tokenMeter (it is composed on the host plane only)',
          capabilityProbe: probe,
          usage: null,
          surfaceReplace: surfaceReplaceCount(session),
          scheduledCompactions: pendingCompact.size,
          checkpointFile: checkpoint ?? null,
          checkpointBytes: cpState.bytes,
          checkpointAgeMs: cpState.ageMs,
          checkpointFresh: cpState.fresh,
          // 暴露 gate 决策，便于排查"为什么这份没被注入"。
          // 如实报告本变体身份与互斥状态。
          variant: {
            name: PKG_NAME,
            rank: rankOf(PKG_NAME),
            order: VARIANT_ORDER,
            active: true,
            lock: describeLock(DATA_DIR),
          },
          injectionMode: cpView.mode,
          injectionReason: cpView.reason ?? null,
          checkpointTopic: cpMeta?.topic ?? null,
          checkpointGeneration: cpMeta?.generation ?? null,
          userIntentWindowMs: intentWindowMs,
          recentUserIntent: intentNow === undefined ? null : { word: intentNow.word, ageMs: intentNow.ageMs },
          guidance: [
            'Do not estimate a percentage — no measurement is available here.',
            'DSH\'s own auto-compaction still applies (it compacts near 80% of the window).',
            'Use the milestone rule instead: call context_compact at a delivery point.'
          ]
        }, null, 2)
      }
      // 回填同步缓存，让占用条立刻反映这次读数（否则查询完提示词条还是旧的）。
      latest.set(session, { ...pressure })
      return JSON.stringify({
        available: true,
        capabilityProbe: probe,
        usedTokens: pressure.totalTokens,
        baseline: pressure.baselineKind,
        contextWindow: pressure.contextWindow ?? null,
        utilization: typeof pressure.contextWindow === 'number' ? Number((pressure.totalTokens / pressure.contextWindow).toFixed(4)) : null,
        safeLine: typeof pressure.contextWindow === 'number' ? Math.floor(pressure.contextWindow * SAFE_REAL_RATIO) : null,
        tokensOverSafeLine: typeof pressure.contextWindow === 'number' ? Math.max(0, pressure.totalTokens - Math.floor(pressure.contextWindow * SAFE_REAL_RATIO)) : null,
        surfaceReplaceCount: pressure.surfaceReplace,
        scheduledCompactions: pendingCompact.size,
        scheduledTokens: pendingCompact.get(exec.agent)?.scheduledTokens ?? null,
        compactionFloorTokens: typeof pressure.contextWindow === 'number' ? Math.floor(pressure.contextWindow * MIN_TRIGGER_RATIO) : null,
        checkpointFile: checkpoint ?? null,
        checkpointBytes: cpState.bytes,
        checkpointAgeMs: cpState.ageMs,
        checkpointFresh: cpState.fresh,
        // 暴露 gate 决策。
        // 如实报告本变体身份与互斥状态。
        variant: {
          name: PKG_NAME,
          rank: rankOf(PKG_NAME),
          order: VARIANT_ORDER,
          active: true,
          lock: describeLock(DATA_DIR),
        },
        injectionMode: cpView.mode,
        injectionReason: cpView.reason ?? null,
        checkpointTopic: cpMeta?.topic ?? null,
        checkpointGeneration: cpMeta?.generation ?? null,
        userIntentWindowMs: intentWindowMs,
        recentUserIntent: intentNow === undefined ? null : { word: intentNow.word, ageMs: intentNow.ageMs },
        guidance: [
          cpState.fresh
            ? 'Checkpoint is fresh on disk; context_compact can schedule compaction.'
            : 'Checkpoint is missing or stale: context_compact will REFUSE to schedule until you write it (compaction runs at your next step, so you get no chance afterwards).',
          intentNow === undefined
            ? `No user-requested checkpoint in the last ${Math.round(intentWindowMs / 1000)}s: the 50% floor applies.`
            : `The user asked for a checkpoint ("${intentNow.word}", ${Math.round(intentNow.ageMs / 1000)}s ago): context_compact skips the usage floor (the on-disk gate still applies).`
        ]
      }, null, 2)
    }
  })))

  // ── 工具 2：预约 checkpoint + 压缩 + 自动继续 ────────────────────────
  register('context-checkpoint:tool-compact', () => ctx.tools.register(defineTool({
    name: 'context_compact',
    description:
      'Checkpoint the durable project state and then compact older conversation history: the checkpoint file is ' +
      'written first, and compaction is SCHEDULED so it runs automatically at the next step boundary of this turn ' +
      '(you do NOT have to end the turn for it to happen). Call it when the injected usage bar shows you are past ' +
      'the safe line, when context is near exhaustion, at a delivery point where the project state must survive ' +
      'compaction, OR whenever the user explicitly asks for a summary / checkpoint / compaction or confirms ' +
      'starting the project: a user-requested checkpoint skips the usage floor on its own — the plugin reads that ' +
      'from the user\'s own message — so you never need to pass force for it. IMPORTANT ORDER: write/refresh the ' +
      'checkpoint file BEFORE calling this — compaction runs at your next step, so you get no chance to write it ' +
      'afterwards; if the file is missing or not freshly written, the call refuses to schedule and tells you to write ' +
      'it first (this gate holds even for a user-requested checkpoint). When nobody asked for a compaction and ' +
      'usage is still far below the window (under 50%), only the checkpoint is recorded and nothing is compacted. ' +
      'After compaction the injected checkpoint section refreshes itself, so you never need to restate what you ' +
      'already did.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: 'Optional short note recorded in the plugin log, e.g. why you are checkpointing now.' },
        force: {
          type: 'boolean',
          description:
            'Bypass the 50%-of-window floor and compact even on a small context. ONLY for a deliberate forced ' +
            'compaction: live end-to-end verification of the checkpoint→compact→refresh loop, or an emergency ' +
            'reset. It really does compact history away, so do not pass it casually.'
        }
      }
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    async execute(args, exec) {
      const agent = exec.agent
      const session = agent?.session
      if (agent === undefined || session === undefined) return 'no agent bound to this tool call'

      const cwd = session.header?.cwd
      const pressure = await readPressure(meter(), session, ctx.llm, exec.signal)
      const note = typeof args?.note === 'string' && args.note.length > 0 ? args.note : '(none)'
      const usageText = pressure === null
        ? 'unavailable on this plane'
        : `${pressure.totalTokens.toLocaleString('en-US')} token${typeof pressure.contextWindow === 'number' ? ` / ${pressure.contextWindow.toLocaleString('en-US')}` : ''}`
      const compactorAvailable = compactorSvc() !== undefined
      const checkpoint = describeCheckpoint(cwd)
      const file = checkpoint.status === 'missing' ? undefined : checkpoint.path

      // 新鲜度优先看**插件内存标记**（checkpoint_write 成功后才置位），
      // mtime 只作为"跨进程重启后"的兜底 —— 模型无法用空 write 伪造。
      const markedAt = writtenAt.get(agent)
      const freshByMark = typeof markedAt === 'number' && Date.now() - markedAt <= CHECKPOINT_FRESH_MS
      const fresh = checkpoint.fresh || freshByMark
      const checkpointView = { ...checkpoint, fresh }

      // ②③连用：把本 agent 登记为"已预约"，由 pre-step（回合内步骤边界）或 idle（回合边界）执行压缩。
      // 三道闸，职责各不相同：
      //   1. 门槛：占用得先到"值得压"的量级（窗口的 MIN_TRIGGER_RATIO）—— 否则只落盘、不压缩；
      //      **用户显式要求时豁免**（D-006）：用户要的是"固化状态 + 换干净起点"，与占用无关；
      //   2. 落盘：检查点文件必须是**刚写过**的（CHECKPOINT_FRESH_MS）——
      //      压缩在下一个步骤边界就执行，模型没有补写的机会，陈旧内容会被原样注入新代。
      //      **这道闸不豁免**（用户 22:47 亲自确认保留）：它守的是"② 必须发生在 ③ 之前"；
      //   3. `force: true` 显式绕过前两道（实机验证 / 应急重置），会在返回文案里如实标注。
      const force = args?.force === true
      const window = pressure?.contextWindow
      const usedTokens = pressure?.totalTokens
      const worthCompacting = typeof usedTokens === 'number' && usedTokens > 0
        && typeof window === 'number' && window > 0 && usedTokens >= window * MIN_TRIGGER_RATIO
      const asked = userIntentHit(session)
      const scheduled = compactorAvailable
        && (force || ((worthCompacting || asked !== undefined) && checkpointView.fresh))
      if (scheduled) {
        pendingCompact.set(agent, { scheduledTokens: usedTokens, scheduledAt: Date.now(), forced: force })
        logger?.info?.(
          `checkpoint recorded, compaction scheduled`
          + `${force && !worthCompacting ? ' (FORCED, floor bypassed)' : ''}`
          + `${force !== true && asked !== undefined && !worthCompacting
            ? ` (on user intent "${asked.word}" ${Math.round(asked.ageMs / 1000)}s ago, floor bypassed)` : ''}`
          + `${force && !checkpointView.fresh ? ` (FORCED, ${checkpoint.status} checkpoint bypassed)` : ''}: `
          + `used=${usedTokens} window=${window} checkpoint=${file ?? 'MISSING'} note=${note}`
        )
      } else {
        logger?.info?.(
          `checkpoint recorded, compaction NOT scheduled ` +
          `(compactor=${compactorAvailable ? 'yes' : 'NO'}, used=${usedTokens ?? 'unknown'}, window=${window ?? 'unknown'}, ` +
          `intent=${asked === undefined ? 'none' : `"${asked.word}"`}): ` +
          `checkpoint=${file ?? 'MISSING'} note=${note}`
        )
      }

      const ratioText = typeof usedTokens === 'number' && typeof window === 'number' && window > 0
        ? `${(100 * usedTokens / window).toFixed(1)}% of the window`
        : 'unknown'

      // 预约**理由**必须如实写出来：占用没到线却照样压，不说明原因就等于
      // 让模型（和看日志的人）以为"占用到了" —— 归因会错，复盘就无从谈起。
      const scheduledNote = force && !worthCompacting
        ? ' (FORCED: the 50% floor was bypassed on explicit request)'
        : force !== true && asked !== undefined && !worthCompacting
          ? ` (on the user's explicit request: "${asked.word}" — a user-requested checkpoint skips the usage floor)`
          : ''

      // 文件不新鲜时的**独立警告行**：无论最终是否预约都要出现（低占用下也一样），
      // 否则模型会以为"工具已收下"，而磁盘上其实什么都没有。
      const staleLine = checkpointView.fresh
        ? ''
        : `- ⚠️ 检查点文件${checkpointView.status === 'missing'
          ? '不存在（NOT FOUND）'
          : `最后修改于 ${Math.round((checkpointView.ageMs ?? 0) / 60000)} 分钟前（陈旧）`}：`
        + '此刻压缩会压掉尚未落盘的内容。**先**调用 `checkpoint_write` 落盘，再调用一次本工具。'

      return [
        scheduled
          ? `Checkpoint recorded. **Compaction scheduled**${scheduledNote}`
            + `${force && !checkpointView.fresh ? ` (FORCED: the ${checkpoint.status} checkpoint was bypassed too — nothing fresh is on disk)` : ''}`
            + ' and runs automatically at the next step boundary of this turn — you do NOT need to end the turn for it to happen.'
          : !compactorAvailable
            ? 'Checkpoint recorded. This plane has NO compaction service, so nothing will compact (DSH auto-compaction still applies near 80%).'
            : (worthCompacting || asked !== undefined) && !checkpointView.fresh
              ? `Compaction is NOT scheduled — checkpoint ${checkpoint.status === 'missing' ? 'NOT FOUND' : 'looks STALE'}. `
                + `${asked !== undefined ? `The user explicitly asked for a checkpoint ("${asked.word}"), and that does skip the usage floor — but ` : ''}`
                + `${checkpoint.status === 'missing' ? 'there is nothing on disk yet' : `the last write was ${Math.round((checkpointView.ageMs ?? 0) / 60000)} min ago`},`
                + ' and compaction runs at the next step boundary: you would have no chance to write it afterwards.'
              : `Checkpoint recorded. Current usage is ${ratioText} — below the compaction floor (${Math.round(MIN_TRIGGER_RATIO * 100)}%), so nothing will be compacted now (checkpoint anchor only). `
                + 'A user who explicitly asks for a summary/checkpoint/start skips this floor automatically — you never need to pass force for that.',
        `- real usage now: ${usageText}`,
        `- checkpoint file: ${file ?? 'NOT FOUND — write it before you finish this turn'}`,
        staleLine,
        '',
        'No further action needed from you:',
        scheduled
          ? `- 压缩会在本回合的**下一个步骤边界**自动执行（若你正好结束本轮，则改在回合边界执行，随后插件唤醒你继续同一任务）；`
          : compactorAvailable
            ? '- 本次不压缩（占用还没到阈值）；等占用上来后越线提醒会提示你再次调用本工具；'
            : '- 压缩不可用；接近 80% 时 DSH 原生自动压缩仍会生效；',
        '- 压缩后插件的静态提示词段会**自动重新读取该检查点文件并注入新内容**（跨代刷新）；',
        '- 你**不要**声称自己压缩了任何东西 —— 压缩不是你执行的。',
        '',
        '继续正常工作即可，不需要为了触发压缩而结束本轮。',
        scheduled ? '（压缩会在你的下一步之前自动发生，无需你再做任何事。）' : ''
      ].filter(Boolean).join('\n')
    }
  })))

  logger?.info?.(
    `context-checkpoint ready: meter=${meter() === undefined ? 'NO (degraded)' : 'yes'} ` +
    `compactor=${compactorSvc() === undefined ? 'NO (degraded)' : 'yes'}`
  )
}
