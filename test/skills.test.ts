// 整改回归测试：工具描述只留调用规则与跨后端不变量，详细领域流程按需加载。
// 对应 dsh-immediate-system-prompt-optimization.md §3.2/§3.3 与
// dsh-long-term-system-prompt-architecture-and-authoring-guidance.md §4.2/§4.4：
// 每条被搬走的规则都要能在新位置查到，且关键行为不变量不得丢失。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDrcTool, createBackendsTool } from '../src/tools.ts'
import type { DrcExecutor } from '../src/executor.ts'
import {
  DRC_SKILL_NAME,
  parseDrcSkill,
  readDrcSkillRaw,
  registerDrcSkill,
} from '../src/skills.ts'

const raw = readDrcSkillRaw()

/** 只用于取工具定义，不执行。 */
const unusedExecutor: DrcExecutor = { async run() { return {} as never } }

/** 从 tools.ts 描述/参数描述里搬迁出去的规则，逐条必须能在 SKILL.md 中查到。 */
const RELOCATED = [
  'kicad-cli pcb drc',
  '--severity-all --refill-zones',
  'POST /api/s/upload',
  'POST /api/s/lint-drc',
  '语义规则引擎（NATIVE）',
  '本地 kicad-cli 原生检查（EDA_DRC）',
  'KICAD_CLI_PATH',
  'Windows 注册表',
  '约 1~2 秒',
  '约 3~10 秒',
  'confidence',
  'ruleId',
  '.kicad_pro',
  '59 条内置规则',
  'silk_edge_clearance',
  'lib_footprint_issues',
  'drcRulesCount',
  'enabledKeys',
  'lockedKeys',
  'remote → local → ipc',
  'fallbackFrom',
  '同一块板在会话内',
  'RunDrc',
  '不产生 marker',
  '华秋定制版 KiCad',
  'severityAll',
  'refillZones',
  'allTrackErrors',
  'includeFullJson',
  'timeoutSeconds',
  '开关按板持久化',
  'reportFormat',
  'drcSummary.totalIssues',
  'reportComplete=false',
  "reportIncomplete='kicad-cli'",
  "reportIncomplete='rules'",
  'verifiedBy',
  'projectRules',
  'viewUrl',
  'RunDrcResponse',
  'kicad_drc_backends',
  'estimatedMs',
  '降级冷却期',
  '不编造',
  'DRC 通过',
  '如实报告',
]

interface ProviderStub {
  name: string
  list: () => Promise<Array<{
    name: string
    description: string
    invocation: { modelInvocable: boolean, userInvocable: boolean }
    provider: string
    source: string
    rank: number
    locator: URL
  }>>
  get: (
    candidate: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<{ name: string, content: string, description: string }>
}

function stubCtx(withSkills: boolean | 'throws' = true) {
  let factory: (() => ProviderStub) | undefined
  let disposed = false
  const effectNames: string[] = []
  // 宿主守卫允许 ctx.get() 可选查找（无需 inject 声明），插件走的就是这条路。
  const skillsService = withSkills === false
    ? undefined
    : {
        registerProvider: (f: () => ProviderStub) => {
          if (withSkills === 'throws') throw new Error('skills registerProvider boom')
          factory = f
          return () => { disposed = true }
        },
      }
  const ctx = {
    get: (name: string) => (name === 'skills' ? skillsService : undefined),
    effect: (setup: () => () => void, name?: string) => {
      if (name) effectNames.push(name)
      return setup()
    },
  } as unknown as Parameters<typeof registerDrcSkill>[0]
  return {
    ctx,
    get factory() { return factory },
    get disposed() { return disposed },
    effectNames,
  }
}

test('SKILL.md 的 frontmatter 可解析，name 与 provider 一致', () => {
  assert.equal(DRC_SKILL_NAME, 'kicad-drc')
  const parsed = parseDrcSkill(raw)
  assert.match(parsed.description, /KiCad PCB DRC/)
  assert.match(parsed.content, /^# KiCad DRC 任务指引/)
  assert.ok(!parsed.content.includes('frontmatter'))
})

test('frontmatter 缺失、name 不匹配、缺 description 时明确报错', () => {
  assert.throws(() => parseDrcSkill('# no frontmatter'), /缺少 frontmatter/)
  assert.throws(
    () => parseDrcSkill('---\nname: other\ndescription: x\n---\nbody'),
    /name 与 provider 不一致/,
  )
  assert.throws(
    () => parseDrcSkill('---\nname: kicad-drc\n---\nbody'),
    /缺少 description/,
  )
})

test('被搬迁的领域规则逐条可在 SKILL.md 中查到', () => {
  for (const needle of RELOCATED) {
    assert.ok(raw.includes(needle), `SKILL.md 缺少被搬迁的规则片段: ${needle}`)
  }
})

test('工具描述保留全部关键不变量，并指向按需加载的 skill', () => {
  const t = createDrcTool(unusedExecutor, 600) as unknown as {
    description: string
    parameters: { properties: Record<string, { description?: string }> }
    output: { schema: { properties: Record<string, { description?: string }> } }
  }
  const invariants = [
    'pcbPath',
    'mode 留空为 auto',
    '失败即报错、不回退',
    'success 只表示 DRC 运行完成',
    'drcSummary.totalIssues',
    'reportComplete=false',
    'reportIncomplete',
    'verifiedBy',
    'projectRules.status',
    'drcJsonPath',
    'includeFullJson',
    '以结构化工具结果为权威',
    '不编造',
    DRC_SKILL_NAME,
  ]
  for (const invariant of invariants) {
    assert.ok(t.description.includes(invariant), `工具描述丢失关键不变量: ${invariant}`)
  }
  // 详细操作手册确实搬走了，没有换个地方继续常驻
  for (const moved of ['【工作原理】', '/api/s/upload', '59 条内置规则', 'KICAD_CLI_PATH', 'RunDrc']) {
    assert.ok(!t.description.includes(moved), `工具描述仍残留应搬迁的内容: ${moved}`)
  }
  assert.ok(t.description.length <= 900, `工具描述仍然过长: ${t.description.length}`)

  const paramDesc = Object.values(t.parameters.properties)
    .reduce((n, p) => n + (p.description?.length ?? 0), 0)
  // 预算：改动前 767 字符；参数格式、示例与"内置规则默认只启用锁定项"属于
  // schema 契约和安全提示，不能为了压数字删掉，因此上限设为 600。
  assert.ok(paramDesc <= 600, `参数描述仍然过长: ${paramDesc}`)
  // drcRules 的安全关键提示必须留在参数上（默认只启用锁定内置规则）
  assert.match(t.parameters.properties.drcRules?.description ?? '', /必须在此显式打开/)

  // 输出 schema 仍是权威的结果判读位置，未被削弱
  assert.match(
    t.output.schema.properties.reportComplete?.description ?? '',
    /不能当作完整 DRC 结论/,
  )
  assert.match(
    t.output.schema.properties.verifiedBy?.description ?? '',
    /跨后端结果不可直接比较/,
  )
})

test('后端探测工具描述同样压缩并指向 skill', () => {
  const b = createBackendsTool(async () => []) as unknown as { description: string }
  assert.ok(b.description.length <= 250, `探测工具描述仍然过长: ${b.description.length}`)
  assert.ok(b.description.includes(DRC_SKILL_NAME))
  assert.match(b.description, /不执行 DRC/)
})

test('skills 可用时注册懒加载 provider，list/get 按需返回 SKILL.md 正文', async () => {
  const s = stubCtx(true)
  assert.equal(registerDrcSkill(s.ctx), true)
  assert.deepEqual(s.effectNames, ['@huaqiu/dsh-kicad-drc: kicad-drc skill'])

  const provider = s.factory!()
  assert.equal(provider.name, `bundled:${DRC_SKILL_NAME}`)
  const list = await provider.list()
  assert.equal(list.length, 1)
  assert.equal(list[0]!.name, DRC_SKILL_NAME)
  assert.equal(list[0]!.invocation.modelInvocable, true)
  assert.equal(list[0]!.source, 'bundled')
  // 宿主 SkillRegistry.validateCandidate 要求 rank 必填且为有限数字；缺失会让
  // ctx.skills.list() 整体抛 "invalid rank"，被搬走的规则就彻底取不回来了。
  assert.equal(list[0]!.rank, 600, 'rank 必须与 BUNDLED_SKILL_RANK 一致')
  assert.ok(Number.isFinite(list[0]!.rank))

  const loaded = await provider.get(list[0], { signal: new AbortController().signal })
  assert.equal(loaded.name, DRC_SKILL_NAME)
  assert.equal(loaded.content, parseDrcSkill(raw).content)
  assert.equal(s.disposed, false)
})

test("ctx.get('skills') 返回 undefined 时只告警降级，不抛错、不阻断工具注册", () => {
  const s = stubCtx(false)
  const original = console.warn
  const warnings: string[] = []
  console.warn = (...parts: unknown[]) => { warnings.push(parts.map(String).join(' ')) }
  try {
    assert.equal(registerDrcSkill(s.ctx), false)
  } finally {
    console.warn = original
  }
  assert.equal(s.factory, undefined)
  assert.equal(s.effectNames.length, 0)
  assert.match(warnings.join('\n'), /skills 服务不可用/)
})

test('registerProvider 抛错时只告警并返回 false，不向上抛', () => {
  const s = stubCtx('throws')
  const original = console.warn
  const warnings: string[] = []
  console.warn = (...parts: unknown[]) => { warnings.push(parts.map(String).join(' ')) }
  let result: boolean | undefined
  try {
    assert.doesNotThrow(() => { result = registerDrcSkill(s.ctx) })
  } finally {
    console.warn = original
  }
  assert.equal(result, false)
  assert.equal(s.factory, undefined)
  assert.match(warnings.join('\n'), /注册失败/)
})

test('源码保护：inject 恢复原值、skill 注册被兜底且排在工具注册之后', () => {
  const indexSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  // cordis 4.1.0 的 inject 项全是 required；把 skills 放进去会让服务缺失时
  // 整个插件被挂起，连 DRC 工具都注册不上。
  assert.match(indexSrc, /export const inject = \['tools', 'webServer'\]/)
  assert.doesNotMatch(indexSrc, /inject\s*=\s*\[[^\]]*'skills'/)
  assert.match(indexSrc, /try\s*\{\s*registerDrcSkill\(ctx\)\s*\}/)
  const registerIdx = indexSrc.indexOf('registry.register(backendsTool)')
  const skillIdx = indexSrc.indexOf('registerDrcSkill(ctx)')
  assert.ok(registerIdx >= 0 && skillIdx > registerIdx, 'skill 注册必须在工具注册之后')
})
