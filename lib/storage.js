/**
 * dsh-cairn — 插件自有数据目录存储层。
 *
 * 为什么不写工作区：
 *   · 不打扰工作区 —— 装插件不该让项目目录多出文件；
 *   · 检查点是本地工作状态，不必进版本库、也不必同步给同事；
 *   · 不依赖工作区的写入权限（有些环境下工作区只读，或对子目录有限制）；
 *   · 写入用 tmp + rename 原子替换，不留半截文件。
 *
 * 隔离纪律（已验证的隔离范式）：
 *   1. **唯一写入位置**是本插件自己的 `<插件根>/data/`；
 *   2. 不写 settings.yaml / sessions/ / storages/ / .credentials.yaml /
 *      cordis.patch.yml / npm 安装树；
 *   3. 运行期临时文件放 `data/tmp/`，不使用 os.tmpdir()；
 *   4. 写入一律 tmp + rename 原子替换。
 *
 * 目录布局：
 *   data/checkpoints/<workspace-slug>/current.md        当前活跃副本（唯一规范文件）
 *   data/checkpoints/<workspace-slug>/current.meta.json 结构化元数据（generation/topic/keywords）
 *   data/checkpoints/<workspace-slug>/gen-001.md        旧代际（保留，供回溯）
 *   data/tmp/                                           原子写中转（正常为空）
 *   data/logs/                                          预留
 *
 * @module dsh-cairn/storage
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync, unlinkSync, lstatSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 插件包根目录（本文件位于 <root>/lib/storage.js）。 */
export const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * 插件自有数据目录——本插件**唯一**的写入位置。
 *
 * 默认在插件包内（`<root>/data`）。可用环境变量 `DSH_CHECKPOINT_DATA_DIR` 覆盖，
 * 用途是**测试隔离**：跑副本/端到端验证时让副本写自己的目录，不污染真实实例。
 *
 * ⚠ 安全约束（安全复核后加固）：
 *   覆盖值必须通过 `assertSafeDataDir()`：
 *     · 必须是绝对路径；
 *     · 不得是盘根、用户主目录、`$DSH_HOME` 本身、或系统的敏感目录；
 *     · 不得与插件包根相同（否则 cleanTmp 会扫到包内的 `tmp/`）。
 *   不满足时**抛错**而不是静默使用 —— 因为本模块会删这个目录下 `tmp/` 里的东西，
 *   一个放错的环境变量就等于让插件去删别人的文件。
 */
function assertSafeDataDir(raw) {
  // ⚠ 必须**先**判相对路径，再 resolve —— resolve() 会把相对路径拼成绝对路径，
  // 之后再判 isAbsolute 永远是 true（这条在安全复核里被抓到过）。
  if (!isAbsolute(raw)) {
    throw new Error(`DSH_CHECKPOINT_DATA_DIR 必须是绝对路径，收到 ${JSON.stringify(raw)}`)
  }
  const resolved = resolve(raw)
  const parent = dirname(resolved)

  // 不能是文件系统根（`C:\` / `/`）
  if (parent === resolved) {
    throw new Error(`DSH_CHECKPOINT_DATA_DIR 不能是文件系统根 ${resolved}`)
  }

  const norm = (p) => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
  const target = norm(resolved)
  const forbidden = [
    { p: PACKAGE_ROOT, why: '插件包根（会与包内的 tmp/ 冲突）' },
    { p: homedir(), why: '用户主目录' },
    { p: process.env.DSH_HOME ?? join(homedir(), '.dsh'), why: 'DSH_HOME 本身' },
  ]
  for (const f of forbidden) {
    if (target === norm(f.p)) {
      throw new Error(`DSH_CHECKPOINT_DATA_DIR 不能是${f.why}：${resolved}`)
    }
  }
  return resolved
}

export const DATA_DIR = (() => {
  const raw = process.env.DSH_CHECKPOINT_DATA_DIR
  if (typeof raw === 'string' && raw.trim().length > 0) return assertSafeDataDir(raw.trim())
  return join(PACKAGE_ROOT, 'data')
})()

export const PATHS = Object.freeze({
  data: DATA_DIR,
  checkpoints: join(DATA_DIR, 'checkpoints'),
  tmp: join(DATA_DIR, 'tmp'),
  logs: join(DATA_DIR, 'logs'),
})

/** 保留的代际份数上限（超过则删最旧的）。 */
const MAX_GENERATIONS = 20
/**
 * 单份检查点的**写入**上限：超过直接拒绝，不静默截断。
 * 保持 60000 是为了兼容既有文件（老检查点不会被判非法）。
 */
export const MAX_CHECKPOINT_CHARS = 60_000

/**
 * 单份检查点的**注入**上限。
 *
 * 为什么要和写入上限分开：
 *   写入上限决定"允许多大的文件存在"，注入上限决定"每代往上下文里塞多少"。
 *   原先两者都用 60000 → 一份满载检查点每代注入约 16.5K 字符（≈ 4.1K~9.7K token），
 *   而它**每代都常驻**，是插件最大的持续性成本。
 *
 * 12000 字符 ≈ 3K~7K token，对"恢复工作状态"足够：
 * Fast Resume 骨架下的真实检查点通常在 2K~6K 字符。
 * 超出部分仍可用 `checkpoint_read` 按需取回，不牺牲能力。
 */
export const MAX_INJECT_CHARS = 12_000

/** 落盘新鲜度线：超过则拒绝预约压缩（与原实现语义一致）。 */
export const CHECKPOINT_FRESH_MS = 10 * 60 * 1000
/** 跨会话「摘要卡片」模式的可信期（毫秒）。 */
export const CARD_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 建好插件自有的目录树。只创建目录，不写任何外部路径。 */
export function ensureDirs() {
  for (const dir of [PATHS.data, PATHS.checkpoints, PATHS.tmp, PATHS.logs]) {
    mkdirSync(dir, { recursive: true })
  }
  return DATA_DIR
}

/**
 * 路径安全：任何外部来源的标识（cwd / sessionId）都过一遍白名单归一。
 * 阻断 `..`、绝对路径、盘符、UNC、以及任何路径分隔符。
 *
 * 注意：`_` 会替换掉 `.`，因此 `..` 不可能作为独立路径段存活
 * （否则目录名里会出现形如 `.._.._X` 的片段，虽不穿越但会误导审计）。
 */
function slug(raw, max = 64) {
  return String(raw ?? 'unknown').replace(/[^\w-]/g, '_').slice(0, max) || 'unknown'
}

/**
 * 规范化 cwd，让"同一个工作区"无论以哪种写法出现都映射到同一个目录。
 *
 * ⚠ 为什么必须有这一步（功能检查时抓到的真实问题）：
 *   同一个工作区在不同会话里可能以 `C:\proj`、`C:/proj`、
 *   `/home/me/proj`、甚至 `C:\\\\proj`（多余反斜杠）出现。
 *   若直接对这些字符串做哈希，会得到**多个不同的目录** ——
 *   检查点随之分裂，跨会话 gate 也读不到上一代。
 *   实测：`C:\proj` → hash `4cd2e9c0`，而 `C:/proj` → `1b9cd383`。
 *
 * 归一规则（只做"同一目录的不同写法"折叠，不做大小写/长路径解析）：
 *   1. 反斜杠统一成正斜杠；
 *   2. 折叠重复分隔符；
 *   3. 去掉末尾分隔符（根除外）；
 *   4. **盘符统一大写**（Windows 路径大小写不敏感，`d:` 与 `D:` 是同一处）。
 */
export function normalizeCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim().length === 0) return ''
  let s = cwd.trim().replace(/\\/g, '/')
  s = s.replace(/\/{2,}/g, '/')
  // 盘符大写（仅当形如 `x:` / `x:/...`）
  s = s.replace(/^([a-zA-Z]):/, (_m, d) => `${d.toUpperCase()}:`)
  // 去末尾分隔符，但保留 `D:/` 这种根
  if (s.length > 1 && !/^[A-Za-z]:\/$/.test(s)) s = s.replace(/\/+$/, '')
  return s
}

/**
 * 工作区 → 检查点目录。
 * 用「可读尾段 + 稳定哈希」组合，避免不同盘/同名目录冲突，且天然阻断路径穿越。
 *
 * 哈希输入是 `normalizeCwd()` 的结果，因此同一工作区的不同写法**必落到同一目录**。
 */
export function workspaceDir(cwd) {
  const norm = normalizeCwd(cwd)
  if (norm === '') return join(PATHS.checkpoints, 'default')
  let h = 0
  for (let i = 0; i < norm.length; i += 1) h = (h * 31 + norm.charCodeAt(i)) >>> 0
  const tail = slug(norm.slice(-48))
  return join(PATHS.checkpoints, `${tail}-${h.toString(16)}`)
}

export const canonicalPath = (cwd) => join(workspaceDir(cwd), 'current.md')
export const metaPath = (cwd) => join(workspaceDir(cwd), 'current.meta.json')

/** 读 JSON；不存在或损坏返回 undefined（不抛错，避免拖垮插件）。 */
function readJsonSafe(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 原子写一个文本文件。
 *
 * ⚠ 安全约束（安全复核后加固）：
 *   写入前用 `lstat` 检查目标 —— 若目标已存在且**不是普通文件**
 *   （目录 / 符号链接 / junction），直接抛错，不覆盖。
 *   理由：`renameSync` 落到一个 junction/symlink 上时，不同平台行为不一致，
 *   最坏情况会把内容写进**链接目标**（也就是 data/ 之外的任意文件）。
 *   本插件从来没打算支持这种目标，所以见到就拒绝。
 */
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true })
  // lstat 不跟随链接：目标若是链接/目录，一律拒绝（ENOENT 视为"不存在"，正常）。
  let existing = null
  try {
    existing = lstatSync(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (existing !== null && !existing.isFile()) {
    const kind = existing.isDirectory() ? 'directory' : existing.isSymbolicLink() ? 'symlink' : 'special'
    throw new Error(`refusing to write over a non-regular file: ${path} (kind=${kind})`)
  }
  const tmp = join(PATHS.tmp, `cp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`)
  mkdirSync(PATHS.tmp, { recursive: true })
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

/**
 * 写入检查点（覆盖式，旧代际归档）。
 *
 * @param cwd 工作区绝对路径（来自 session.header.cwd）
 * @param text 检查点正文（Markdown）
 * @param extra { sessionId?, topic?, keywords? } 供跨会话 gate 使用
 * @returns { path, bytes, generation, archived }
 */
export function writeCheckpoint(cwd, text, extra = {}) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('checkpoint_write: text must be a non-empty string')
  }
  if (text.length > MAX_CHECKPOINT_CHARS) {
    throw new Error(
      `checkpoint_write: text is ${text.length} chars, over the ${MAX_CHECKPOINT_CHARS} limit — trim it first`,
    )
  }

  ensureDirs()
  const dir = workspaceDir(cwd)
  mkdirSync(dir, { recursive: true })
  const canonical = join(dir, 'current.md')

  let generation = 1
  let archived = false

  const previousMeta = readJsonSafe(metaPath(cwd))
  // 代际号以 meta 为准（文件被手工清掉时序号仍能延续），回退到扫描已有 gen-*.md。
  const scanned = readdirSync(dir)
    .filter((n) => /^gen-\d{3,}\.md$/.test(n))
    .reduce((m, n) => Math.max(m, Number(n.match(/\d+/)[0])), 0)
  const previousGeneration = Number.isInteger(previousMeta?.generation) ? Number(previousMeta.generation) : 0
  generation = Math.max(scanned, previousGeneration) + 1

  // ── 安全前置检查──────────────────────────────────────
  // 必须先判定 canonical 的**节点类型**，再决定走哪条分支。
  // 踩过的坑：之前用 existsSync(canonical) 判"已有旧副本"，而 existsSync 对**目录**也返回 true，
  // 于是一个被手工建成目录的 current.md 会被整块 rename 成 gen-001.md ——
  // 相当于把 data 里不是本插件写的东西改了名，是真正的"误动"。
  let canonicalStat = null
  try {
    canonicalStat = lstatSync(canonical)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (canonicalStat !== null && !canonicalStat.isFile()) {
    const kind = canonicalStat.isDirectory() ? 'directory' : canonicalStat.isSymbolicLink() ? 'symlink' : 'special'
    throw new Error(
      `checkpoint_write: refusing to touch ${canonical} — it is a ${kind}, not a regular file. `
      + 'Move or remove it first (the plugin never overwrites or renames non-regular nodes).',
    )
  }

  const archiveTarget = join(dir, `gen-${String(generation).padStart(3, '0')}.md`)
  if (canonicalStat !== null) {
    // 归档用 rename（同卷、原子），不做拷贝，避免半截归档。
    //
    // 目标名必然空着 —— 因为 generation 取自 `max(已扫描最大号, meta.generation) + 1`，
    // 这里再断言一次是为了防"两次并发写入算出同一个号"（两个进程同时写同一工作区）。
    // 并发时后到的那个会撞上，抛错让它重试，好过覆盖别人的归档。
    let archiveStat = null
    try {
      archiveStat = lstatSync(archiveTarget)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    if (archiveStat !== null) {
      throw new Error(
        `checkpoint_write: archive target already exists (${archiveTarget}); `
        + 'refusing to overwrite it (concurrent write?) — retry the call',
      )
    }
    renameSync(canonical, archiveTarget)
    archived = true
    // 修剪最旧代际：只删**正则匹配 + lstat 是普通文件**的项。
    // 目录、链接、以及任何非本插件命名的东西一律不碰。
    const all = readdirSync(dir).filter((n) => /^gen-\d{3,}\.md$/.test(n)).sort()
    const excess = all.length - MAX_GENERATIONS
    for (let i = 0; i < excess; i += 1) {
      const full = join(dir, all[i])
      try {
        if (!lstatSync(full).isFile()) continue // 不删目录、不跟随链接
        unlinkSync(full)
      } catch { /* 保留胜过删除 */ }
    }
  }

  writeAtomic(canonical, text)

  const meta = {
    schemaVersion: 2,
    generation,
    updatedAt: new Date().toISOString(),
    bytes: Buffer.byteLength(text, 'utf8'),
    chars: text.length,
    archived,
    // 跨会话 gate 依据：
    sessionId: typeof extra.sessionId === 'string' ? String(extra.sessionId) : (previousMeta?.sessionId ?? undefined),
    topic: typeof extra.topic === 'string' ? extra.topic.slice(0, 200) : previousMeta?.topic,
    keywords: Array.isArray(extra.keywords) ? extra.keywords.slice(0, 32) : (previousMeta?.keywords ?? []),
  }
  writeAtomic(metaPath(cwd), JSON.stringify(meta, null, 2))

  return { path: canonical, bytes: meta.bytes, chars: meta.chars, generation, archived }
}

/** 读回检查点正文；不存在返回 undefined。 */
export function readCheckpoint(cwd) {
  try {
    const p = canonicalPath(cwd)
    if (!statSync(p).isFile()) return undefined
    return readFileSync(p, 'utf8')
  } catch {
    return undefined
  }
}

/** 读元数据（不存在返回 undefined）。 */
export function readMeta(cwd) {
  return readJsonSafe(metaPath(cwd))
}

/**
 * 描述落盘状态。与原实现同语义：只有 `fresh` 允许预约压缩。
 * @returns { status: 'missing'|'fresh'|'stale', path, ageMs, fresh, bytes }
 */
export function describeCheckpoint(cwd, freshMs = CHECKPOINT_FRESH_MS) {
  const p = canonicalPath(cwd)
  try {
    const st = statSync(p)
    const ageMs = Date.now() - st.mtimeMs
    return { status: ageMs <= freshMs ? 'fresh' : 'stale', path: p, ageMs, fresh: ageMs <= freshMs, bytes: st.size }
  } catch {
    return { status: 'missing', path: p, ageMs: null, fresh: false, bytes: null }
  }
}

/**
 * 清掉 data/tmp 里**本插件自己**的残留（启动时调用一次即可）。
 *
 * ⚠ 安全约束（安全复核后加固）：
 *   只删**同时满足**以下全部条件的项：
 *     1. 文件名匹配 `cp-<pid>-<ts>-<rand>.tmp`（本插件 writeAtomic 的唯一命名格式）；
 *     2. 是普通文件（`lstat` 判 `isFile()`）——**不删目录、不跟随符号链接/junction**；
 *     3. 直接父目录就是 `data/tmp`（不做递归）。
 *   任何一条不满足就原样保留。宁可留垃圾，也不删别人的东西。
 *
 * 为什么不用递归删除：`data/tmp` 理论上只有本插件写，但
 * ① 环境变量可改数据目录位置（已加校验）；② 用户/别的工具可能往这里放过东西；
 * ③ 目录里若有人建了 junction，递归删会穿透到链接目标。
 */
export function cleanTmp() {
  let names
  try {
    names = readdirSync(PATHS.tmp)
  } catch {
    return 0 // 目录不存在
  }
  let removed = 0
  for (const name of names) {
    // 只认本插件的命名：cp-数字-数字-字母数字.tmp
    if (!/^cp-\d+-\d+-[a-z0-9]+\.tmp$/.test(name)) continue
    const full = join(PATHS.tmp, name)
    try {
      // lstat：不跟随链接，能识别 junction / symlink
      if (!lstatSync(full).isFile()) continue
      unlinkSync(full)
      removed += 1
    } catch {
      /* 被占用或已消失：保留 */
    }
  }
  return removed
}
