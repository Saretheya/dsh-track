/**
 * cairn — 运行时仲裁（同一份数据目录只允许一个实例生效）。
 *
 * 背景：
 *   本包体同时以多个包名分发（同一份代码与文档），每个都可独立安装。
 *   若在同一 profile 里启用多个，**只允许优先级最高的那个真正生效**，
 *   其余必须**静默休眠**（不注册工具、不注入提示词段、不注册 skill）。
 *
 * 优先级见 {@link VARIANT_ORDER}。
 *
 * 实现选择：**数据目录里的独占锁文件**，而不是 `ctx.registry` 内省。
 *   理由：
 *     1. `ctx.registry` 是 cordis 内部结构，跨版本不稳定；锁文件只用 node:fs。
 *     2. 锁文件天然支持"另一个进程先到"的情形（两个 DSH 实例指向同一 data 目录）。
 *     3. 判定结果可被 `context_status` 如实报告，便于用户理解"为什么没生效"。
 *
 * ⚠ 关键：**不能让后到的变体"报错"**。用户明确要求"静默休眠"。
 *   所以 apply() 在检测到更高优先级已激活时，直接 return —— 不抛错、不注册任何东西。
 *
 * @module dsh-cairn/variant
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 变体优先级（数组顺序即优先级，靠前更高）。 */
export const VARIANT_ORDER = Object.freeze(['dsh-cairn', 'dsh-flashback', 'dsh-ctx', 'dsh-track'])

/** 锁文件里记录的活性窗口：超过这个时长没心跳，视为陈旧锁。 */
const LEASE_MS = 30_000
/** 心跳间隔。 */
const HEARTBEAT_MS = 10_000

/** 判断某包名在优先级里的位置（未知名字排最后）。 */
export function rankOf(name) {
  const i = VARIANT_ORDER.indexOf(name)
  return i === -1 ? VARIANT_ORDER.length : i
}

/** 锁文件路径。放在 data 根，不按工作区隔离（互斥是 profile 级的）。 */
const lockPath = (dataDir) => join(dataDir, 'active-variant.lock')

/** 读锁；不存在或损坏返回 undefined。 */
function readLock(dataDir) {
  const p = lockPath(dataDir)
  try {
    const raw = readFileSync(p, 'utf8')
    const v = JSON.parse(raw)
    if (v === null || typeof v !== 'object') return undefined
    if (typeof v.name !== 'string' || typeof v.pid !== 'number' || typeof v.beatAt !== 'number') return undefined
    return v
  } catch {
    return undefined
  }
}

/** 锁是否仍有活性（心跳未过期）。 */
function isLive(lock, now = Date.now()) {
  if (lock === undefined) return false
  return now - lock.beatAt <= LEASE_MS
}

/** 进程是否还活着（同机）。 */
function pidAlive(pid) {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程存在但无权限（也算活着）
    return e?.code === 'EPERM'
  }
}

/**
 * 判断一个锁是否真的"仍有主人"。
 *
 * ⚠ 这是修复"子进程退出后锁变僵尸"的关键：
 *   进程被 kill / 崩溃 / `process.exit()` 时，`ctx.effect` 的 dispose **不保证执行**，
 *   锁文件会留下来，且 `pidAlive(pid)` 在 PID 被系统复用前后两种结果都不可靠。
 *
 *   三道判定，任一不满足即视为陈旧：
 *     1. 心跳未过期（`LEASE_MS`）；
 *     2. 进程仍存在（`pidAlive`）；
 *     3. 同进程身份可确认时（锁里记了 `instanceId`），与本次进程的 instanceId 相同。
 */
function lockIsAlive(lock, myInstanceId, now = Date.now()) {
  if (lock === undefined) return false
  if (!isLive(lock, now)) return false
  // 同一进程内的不同变体：靠 instanceId 区分"这是本进程的上一次 claim"
  if (lock.pid === process.pid) {
    if (typeof lock.instanceId === 'string' && lock.instanceId !== myInstanceId) return false
    return true
  }
  return pidAlive(lock.pid)
}

/** 本进程的身份标识（防止 PID 复用导致误判为"自己的锁"）。 */
const PROCESS_INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** 全局登记：进程退出时释放所有持有的锁。 */
const heldLocks = new Set()
let exitHookInstalled = false
function installExitHook() {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const cleanup = () => {
    for (const fn of heldLocks) {
      try { fn() } catch { /* 忽略 */ }
    }
    heldLocks.clear()
  }
  process.once('exit', cleanup)
  // SIGINT/SIGTERM 也要清（进程被杀时 'exit' 不一定触发）
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.once(sig, () => { cleanup(); process.exit(0) })
    } catch { /* 平台不支持该信号 */ }
  }
}

/**
 * 尝试成为生效变体。
 *
 * 语义（重要）：
 *   · **同一时刻只允许一个变体生效。**
 *   · 若已有活性锁：
 *       - 对方优先级更高或相同 → 本变体休眠（不注册任何东西）；
 *       - 本变体优先级更高 → 抢占：改写锁，并返回 `evicted` 告知调用方
 *         "刚被你顶掉的是谁"。**被顶掉的那个必须自己退场**，靠 `heartbeat()`
 *         检测到自己不再是锁主时调用 `onLost`。
 *   · 陈旧锁（心跳过期或进程已死）直接接管。
 *
 * @param dataDir 插件数据目录
 * @param myName  本次加载的包名（必须 ∈ VARIANT_ORDER，否则视为最低优先级）
 * @param onLost  可选：当本变体被更高优先级顶掉时回调（插件应在回调里清理已注册的能力）
 * @returns { active: true, release, heartbeat, evicted? } | { active: false, by, reason }
 */
export function claimVariant(dataDir, myName, onLost) {
  const myRank = rankOf(myName)
  try { mkdirSync(dataDir, { recursive: true }) } catch { /* 交给调用方兜底 */ }
  installExitHook()

  let evicted
  const existing = readLock(dataDir)
  // 用 lockIsAlive：能识别"上一个同进程变体（或已退出的子进程）留下的僵尸锁"
  const existingLive = existing !== undefined && existing.name !== myName && lockIsAlive(existing, PROCESS_INSTANCE_ID)
  if (existingLive) {
    const theirRank = rankOf(existing.name)
    // 已有更高（或同级但更早）的变体在跑 → 本变体休眠
    if (theirRank <= myRank) {
      return { active: false, by: existing.name, reason: `higher-priority variant "${existing.name}" is already active` }
    }
    // 本变体优先级更高 → 抢占
    evicted = existing.name
  }

  const lock = {
    name: myName,
    pid: process.pid,
    instanceId: PROCESS_INSTANCE_ID,
    beatAt: Date.now(),
    rank: myRank,
  }
  try {
    writeFileSync(lockPath(dataDir), JSON.stringify(lock), 'utf8')
  } catch (error) {
    // 写不了锁不阻断插件（宁可多开一个，也不要起不来），但要说清楚
    return { active: true, degraded: true, reason: `lock write failed: ${String(error?.message ?? error)}`, release() {}, heartbeat() {}, isLost: () => false }
  }

  let lost = false
  /**
   * 即时判定自己是否已被夺权（不只读缓存），被夺权则触发 onLost。
   * 为什么需要即时：心跳周期 10 秒，光靠心跳会让"抢占后立刻查询"拿到过期结果。
   *
   * 身份判定用 `instanceId` 而不只是 pid —— 同进程内测试多个变体时，
   * 后者写的锁 pid 相同，光看 pid 会误判成"还是我的锁"。
   */
  const isMine = (cur) =>
    cur !== undefined
    && cur.name === myName
    && cur.pid === process.pid
    && cur.instanceId === PROCESS_INSTANCE_ID

  const checkLost = () => {
    if (lost) return true
    const cur = readLock(dataDir)
    if (cur === undefined) return false
    if (isMine(cur)) return false
    if (rankOf(cur.name) < myRank) {
      lost = true
      clearInterval(timer)
      heldLocks.delete(release)
      try { onLost?.(cur.name) } catch { /* 回调失败不影响判定 */ }
      return true
    }
    return false
  }

  const heartbeat = () => {
    if (lost) return
    const cur = readLock(dataDir)
    if (cur === undefined) return
    // 自己仍是锁主 → 续期
    if (isMine(cur)) {
      try { writeFileSync(lockPath(dataDir), JSON.stringify({ ...cur, beatAt: Date.now() }), 'utf8') } catch { /* 忽略 */ }
      return
    }
    // 被别人抢走 → 退场
    checkLost()
  }
  const timer = setInterval(heartbeat, HEARTBEAT_MS)
  if (typeof timer.unref === 'function') timer.unref()

  const release = () => {
    clearInterval(timer)
    heldLocks.delete(release)
    const cur = readLock(dataDir)
    if (isMine(cur)) {
      try { unlinkSync(lockPath(dataDir)) } catch { /* 已被清 */ }
    }
  }
  // 进程退出时自动释放，避免留下僵尸锁挡住下次启动
  heldLocks.add(release)

  return { active: true, release, heartbeat, evicted, isLost: () => lost || checkLost() }
}

/** 供 context_status / 排错用：当前锁状态快照。 */
export function describeLock(dataDir) {
  const p = lockPath(dataDir)
  const lock = readLock(dataDir)
  let mtimeMs = null
  try { mtimeMs = statSync(p).mtimeMs } catch { /* 不存在 */ }
  if (lock === undefined) return { present: false, path: p }
  return {
    present: true,
    path: p,
    name: lock.name,
    pid: lock.pid,
    rank: rankOf(lock.name),
    beatAgoMs: Date.now() - lock.beatAt,
    live: isLive(lock) && pidAlive(lock.pid),
    mtimeMs,
  }
}
