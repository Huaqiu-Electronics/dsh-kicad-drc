/**
 * `kicad-drc` 任务指引的懒加载注册。
 *
 * 工具描述里只保留调用规则与跨后端不变量；完整的工作原理、后端选型、
 * 内置规则口径、失败/回退处理与结果解读流程放在 skills/kicad-drc/SKILL.md。
 * 该文件**不进入系统提示词，也不进入工具 schema**，只在模型通过 skill
 * 工具显式进入 DRC 领域时才由 provider.get() 返回。
 *
 * 说明：@deepseek-ai/dsh-skill 未随本插件安装，这里用本地最小结构化类型，
 * 不新增运行时依赖；provider API 对齐 dsh-tool-kicad-schematic-gen 的
 * registerProvider 模式，但服务通过 ctx.get() 可选查找而非 inject 声明。
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** skill 名（唯一来源；工具描述里的加载提示与测试都引用它）。 */
export const DRC_SKILL_NAME = 'kicad-drc'

const providerName = `bundled:${DRC_SKILL_NAME}`
const skillDir = fileURLToPath(new URL(`../skills/${DRC_SKILL_NAME}/`, import.meta.url))
const skillFile = new URL(`../skills/${DRC_SKILL_NAME}/SKILL.md`, import.meta.url)

/** SKILL.md frontmatter 的解析结果。 */
export interface DrcSkillContent {
  description: string
  content: string
}

/** 解析并校验 frontmatter；name 不匹配或缺 description 时明确报错，避免静默注册空指引。 */
export function parseDrcSkill(raw: string): DrcSkillContent {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (!frontmatter) throw new Error(`${DRC_SKILL_NAME}: SKILL.md 缺少 frontmatter`)
  const field = (key: string) => new RegExp(`^${key}: (.+)$`, 'm').exec(frontmatter[1]!)?.[1]?.trim()
  if (field('name') !== DRC_SKILL_NAME) {
    throw new Error(`${DRC_SKILL_NAME}: SKILL.md 的 name 与 provider 不一致`)
  }
  const description = field('description')
  if (!description) throw new Error(`${DRC_SKILL_NAME}: SKILL.md 缺少 description`)
  return { description, content: raw.slice(frontmatter[0].length).trim() }
}

/** 读 SKILL.md 全文（测试与 provider 共用），找不到时抛出可定位的错误。 */
export function readDrcSkillRaw(): string {
  return readFileSync(skillFile, 'utf8')
}

interface SkillCandidateLike {
  name: string
  description: string
  invocation: { modelInvocable: boolean, userInvocable: boolean }
  provider: string
  source: string
  // 宿主 SkillRegistry.validateCandidate 要求 rank 必填且为有限数字，
  // 缺失会让 ctx.skills.list() 整体抛 "invalid rank"（不只是本 skill 取不到）。
  rank: number
  resourceBase: { kind: string, path: string }
  locator: URL
}

interface LoadedSkillLike {
  name: string
  description: string
  invocation: SkillCandidateLike['invocation']
  provider: string
  source: string
  resourceBase: SkillCandidateLike['resourceBase']
  content: string
}

interface SkillProviderLike {
  name: string
  list: () => Promise<SkillCandidateLike[]>
  get: (
    candidate: SkillCandidateLike,
    options?: { signal?: AbortSignal },
  ) => Promise<LoadedSkillLike>
}

interface SkillsServiceLike {
  registerProvider: (factory: () => SkillProviderLike) => () => void
}

/**
 * 注册懒加载 provider。返回是否注册成功。
 *
 * `skills` 通过 ctx.get() 可选查找（**不**放进 inject，避免服务缺失时 cordis
 * 挂起整个插件）；这里对 API 形态与 SKILL.md 是否随包分发做特性探测，
 * 异常时只告警并返回 false——工具功能与工具描述里的关键不变量都不依赖 skill。
 */
export function registerDrcSkill(ctx: Context): boolean {
  const skills = ctx.get('skills') as SkillsServiceLike | undefined
  if (!skills || typeof skills.registerProvider !== 'function') {
    console.warn('[@huaqiu/dsh-kicad-drc] skills 服务不可用，kicad-drc 任务指引未注册（工具功能不受影响）')
    return false
  }

  let parsed: DrcSkillContent
  try {
    parsed = parseDrcSkill(readDrcSkillRaw())
  } catch (e) {
    console.warn(
      `[@huaqiu/dsh-kicad-drc] kicad-drc 任务指引加载失败: ${e instanceof Error ? e.message : String(e)}`,
    )
    return false
  }

  const resourceBase = { kind: 'directory', path: skillDir }
  // 600 = @deepseek-ai/dsh-skill 的 BUNDLED_SKILL_RANK，与
  // dsh-tool-kicad-schematic-gen 的 bundled provider 保持一致。
  const candidate: SkillCandidateLike = {
    name: DRC_SKILL_NAME,
    description: parsed.description,
    invocation: { modelInvocable: true, userInvocable: true },
    provider: providerName,
    source: 'bundled',
    rank: 600,
    resourceBase,
    locator: skillFile,
  }

  try {
    ctx.effect(
      () => skills.registerProvider(() => ({
        name: providerName,
        list: () => Promise.resolve([candidate]),
        async get(_candidate, options) {
          const loaded = parseDrcSkill(await readFile(skillFile, {
            encoding: 'utf8',
            ...(options?.signal ? { signal: options.signal } : {}),
          }))
          return {
            name: DRC_SKILL_NAME,
            description: loaded.description,
            invocation: candidate.invocation,
            provider: providerName,
            source: candidate.source,
            resourceBase,
            content: loaded.content,
          }
        },
      })),
      '@huaqiu/dsh-kicad-drc: kicad-drc skill',
    )
  } catch (e) {
    console.warn(
      `[@huaqiu/dsh-kicad-drc] kicad-drc 任务指引注册失败: `
      + `${e instanceof Error ? e.message : String(e)}`,
    )
    return false
  }
  return true
}
