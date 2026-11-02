/**
 * dsh-cairn — skill 自注册。
 *
 * 为什么不让 skill 落在 `<DSH_HOME>/skills/context-checkpoint/`：
 *   那份是**独立于插件的第二份状态**。插件卸载/升级后它会原地残留，
 *   成为"没人维护的孤儿 skill"。
 *   用户的要求是：**skill 随插件注册、随插件卸载**。
 *
 * 做法：用 `ctx.skills.registerProvider()` 注册本插件自己的 provider，
 * 候选 `source: 'runtime'`，正文从插件包内的 `skill/context-checkpoint/SKILL.md`
 * 读入内存。生命周期完全绑在插件 fiber 上 —— 插件卸载，provider 一起消失。
 *
 * ⚠ 两个需要注意的实现细节：
 *   1. provider 候选**不会**被补 `invocation` 默认值；下游
 *      `dsh-api-session-controller` 无保护地读 `invocation.modelInvocable`，
 *      缺失即 TypeError，会把技能目录整块拖崩。必须显式给。
 *   2. 必须用 `ctx.inject(['skills'], ...)` 而不是属性访问，否则服务未就绪时抛错。
 *
 * @module dsh-cairn/skill-provider
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本 provider 的注册名。 */
export const PROVIDER_NAME = 'context-checkpoint'

/** 技能名（必须满足官方 kebab-case 语法）。 */
export const SKILL_NAME = 'context-checkpoint'

/** 与官方 `custom` 档一致的候选 rank（dsh-skill-filesystem 的 CUSTOM_RANK = 300）。 */
const CANDIDATE_RANK = 300

/** provider 候选必须显式提供的调用策略。 */
const DEFAULT_INVOCATION = Object.freeze({ modelInvocable: true, userInvocable: true })

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SKILL_PATH = join(PACKAGE_ROOT, 'skill', 'context-checkpoint', 'SKILL.md')

/** 缓存正文（进程内只读一次；文件是包内静态资源）。 */
let cached = null

/**
 * 从 SKILL.md 里解析 frontmatter 与正文。
 * 只处理本插件自己写的格式，不引 YAML 库（保持零依赖）。
 * @returns { description, content } 或 undefined（文件缺失/损坏）
 */
function loadSkill() {
  if (cached !== null) return cached
  let raw
  try {
    raw = readFileSync(SKILL_PATH, 'utf8')
  } catch {
    cached = undefined
    return undefined
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  let description = ''
  let content = raw
  if (match !== null) {
    const front = match[1]
    content = match[2]
    const line = front.split(/\r?\n/).find((l) => l.startsWith('description:'))
    if (line !== undefined) description = line.slice('description:'.length).trim().replace(/^["']|["']$/g, '')
  }
  if (description.length === 0) description = '上下文检查点：落盘项目工作状态，压缩后续读'
  cached = { description, content }
  return cached
}

/**
 * 注册 skill provider。绑在插件 fiber 上：插件卸载即注销。
 *
 * @param ctx  插件上下文
 * @param logger 可选 logger
 * @returns true 表示已注册
 */
export function registerSkillProvider(ctx, logger) {
  let registered = false
  try {
    ctx.inject(['skills'], (sctx) => {
      const skill = loadSkill()
      if (skill === undefined) {
        logger?.warn?.('skill/context-checkpoint/SKILL.md 读不到；skill 未注册（工具与注入不受影响）')
        return
      }

      const provider = {
        name: PROVIDER_NAME,
        /** 列出候选（正文按需 get，避免每次 discovery 都搬运全文）。 */
        list() {
          return {
            candidates: [{
              name: SKILL_NAME,
              description: skill.description,
              source: 'runtime',
              provider: PROVIDER_NAME,
              rank: CANDIDATE_RANK,
              // ⚠ 必须显式给：provider 候选不补默认值，缺失会让技能目录崩。
              invocation: { ...DEFAULT_INVOCATION },
              locator: SKILL_NAME,
            }],
            complete: true,
          }
        },
        /** 取回完整定义。 */
        get(candidate) {
          if (candidate?.locator !== SKILL_NAME) return Promise.resolve(undefined)
          return Promise.resolve({
            name: SKILL_NAME,
            description: skill.description,
            content: skill.content,
            source: 'runtime',
            provider: PROVIDER_NAME,
            invocation: { ...DEFAULT_INVOCATION },
          })
        },
      }

      const dispose = sctx.skills.registerProvider((_control) => provider)
      // 用 sctx.effect 绑定回收，确保插件 fiber 销毁时注销。
      sctx.effect(() => () => {
        try { dispose?.() } catch { /* 已失效 */ }
      }, `${PROVIDER_NAME}: skills provider`)

      registered = true
      logger?.info?.(`已注册 skill provider「${PROVIDER_NAME}」（来源 runtime，随插件卸载）`)
    })
  } catch (error) {
    logger?.warn?.(`skill provider 注册失败：${String(error?.message ?? error)}`)
  }
  return registered
}

/** 仅供测试：清掉正文缓存。 */
export function _resetCache() { cached = null }

/** 仅供测试：返回解析结果。 */
export function _loadSkillForTest() { return loadSkill() }
