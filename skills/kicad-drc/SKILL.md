---
name: kicad-drc
description: KiCad PCB DRC 完整工作指引——后端选型（auto/local/remote/ipc）、pcblint 内置规则口径、失败与回退处理、报告完整性判定与结果解读。需要解释或排查 kicad_drc_run 的行为、选择后端、配置 drcRules 或判断 DRC 结论是否可信时加载。
---

# KiCad DRC 任务指引

本文件承载 `kicad_drc_run` / `kicad_drc_backends` 的详细领域流程。工具描述里只保留调用规则与跨后端不变量；以下是需要进入该领域时才加载的完整说明。

## 1. 何时加载本指引

- 需要决定用哪个后端，或解释为什么这次结果来自某个后端。
- 需要配置 `drcRules`、排查"为什么内置检查项没有违规"。
- 需要判断报告是否完整、两次 DRC 的数字能否比较。
- 远程调用失败、回退、取消、报告没生成后的处理。
- 只是对一块板跑一次常规 DRC 并读结果时，不必加载：直接调 `kicad_drc_run`（`mode` 留空），按工具输出字段解读即可。

## 2. 工作原理

- `local` / `ipc`：直接跑
  `kicad-cli pcb drc <pcb文件> --output drc.json --format json --severity-all --refill-zones`。
- `remote`：把 `.kicad_pcb` 以 multipart 上传到 pcblint DRC 服务
  （`POST /api/s/upload` → `POST /api/s/lint-drc`），服务端运行
  「语义规则引擎（NATIVE）+ 本地 kicad-cli 原生检查（EDA_DRC）」并合并返回。

## 3. 三种后端

| 后端 | 执行方式 | 前提 | 特点 |
| --- | --- | --- | --- |
| `local` | 本机 subprocess 调 kicad-cli | 本机安装 KiCad | 约 1~2 秒；能读取工程级规则；可执行文件按「插件配置 → 环境变量 `KICAD_CLI_PATH` → PATH → Windows 注册表 → 常见安装目录」自动探测；只有 `remote` 不可用或失败时才会被选到 |
| `remote` | 上传 pcblint 服务 | 本机无需 KiCad | 约 3~10 秒；除 kicad-cli 原生检查外还跑服务端规则引擎，每条违规带 `confidence`（HIGH/MEDIUM/LOW）与 `ruleId`；只上传单个 `.kicad_pcb`，工程级规则（`.kicad_pro`）带不过去，违规数通常与 `local` 不同 |
| `ipc` | 让正在运行的 KiCad 直接执行 | 华秋定制版 KiCad 提供 `RunDrc` | 作用于未保存的板、不产生 marker |

### pcblint 内置规则陷阱（remote）

- 新版默认**只启用被锁定的 `clearance`**：59 条内置规则里其余 58 条是关闭的，所以结果里主要是服务端自研规则。
- 要检查其它内置项（`silk_edge_clearance`、`lib_footprint_issues` 等），必须用 `drcRules` 参数**显式打开**。
- 内置规则走 kicad-cli 通道；服务端 kicad-cli 跑不起来时，打开也不会产生新条目。
- 判断内置规则有没有参与判定，看 `drcRules.enabledKeys` / `lockedKeys`，**不要看 `drcRulesCount`**（实测恒为固定值、与开关无关）。

## 4. auto 模式的选择与回退

- 按**固定优先序列分层**（默认 `remote → local → ipc`），前一层不可用或执行失败才降级到下一层。
- 同一层内才按历史耗时排序，所以 `local` 更快也不会插队抢在 `remote` 前面。
- 失败自动回退到下一个后端，并在结果的 `verifiedBy` 里标注实际执行的后端与 `fallbackFrom`。
- 同一块板在会话内会保持在首次成功的后端上，保证多次结果可比。
- `mode` 显式指定 `local` / `remote` / `ipc` 时**不回退**，该后端失败即报错。需要可复现的固定环境时才显式指定，其余情况留空。
- 非法 `mode` 会被收敛回 `auto` 并打印一条警告日志。

## 5. 参数口径

| 参数 | 说明 |
| --- | --- |
| `pcbPath` | 必填。`.kicad_pcb` 的绝对路径，文件必须存在于本机文件系统。 |
| `mode` | `auto`（默认）/ `local` / `remote` / `ipc`。 |
| `severityAll` | 启用所有严重级别（error/warning/exclusion），默认 `true`。 |
| `refillZones` | DRC 前重绘填充区，默认 `true`。 |
| `allTrackErrors` | 报告所有走线错误（不仅是第一个），默认 `false`。 |
| `drcRules` | KiCad 内置规则开关，格式 `key=severity,key=severity`（severity ∈ `error`/`warning`/`ignore`），例 `silk_edge_clearance=error,unconnected_items=ignore`。仅 `remote` 生效。未提到的 key 保持服务端当前值——**开关按板持久化，不传是沿用上次而非回到默认**。锁定的 key（DRU 依赖的约束类型）由服务端忽略。只想看某几类问题时用它收窄口径，不要与 `local` 的全量结果直接比数字。非法项会被跳过并留日志，其余项仍生效。 |
| `includeFullJson` | 在输出中包含 `drc.json` 原始 JSON 字符串（可能数百 KB），默认 `false`。 |
| `timeoutSeconds` | 超时秒数，默认 `600`（插件配置 `defaultTimeoutSeconds`）。 |

## 6. 结果解读

- 工具返回 `stdout`、`drcSummary`（错误/警告数量、按类型分类、示例错误）和 `drcJsonPath`（完整报告持久化在 PCB 文件同目录，可直接读取明细）。
- `reportFormat` 标明报告格式：`kicad-cli`（原生，severity 小写）或 `pcblint`（severity 大写 + confidence）。**两种格式的数字不可直接比较**。
- `success` 表示 DRC 运行是否正常完成，**不代表板子没有违规**；有无违规判断 `drcSummary.totalIssues`。
- 默认输出不含原始 JSON，避免撑爆上下文。只关心概况优先读 `drcSummary`；需要完整明细时传 `includeFullJson=true` 或直接读 `drcJsonPath` 指向的文件。
- `drcRules` 字段：`status` = `applied` / `observed` / `unsupported` / `failed`。`observed` 表示没传 `drcRules`、只读取了当前状态；`unsupported` 表示服务端太旧没有 `/api/s/drc-rules` 接口、开关未生效。
- `reportComplete=false` 时**不能当完整 DRC 结论，也不能与 `local` 的条数比较**，分两种原因：
  - `reportIncomplete='kicad-cli'`：服务端根本没执行 kicad-cli 原生检查，本次只有 pcblint 规则引擎结果。
  - `reportIncomplete='rules'`：kicad-cli 已执行，但内置 DRC 检查项只剩被锁定的项参与（其余默认关闭），缺这部分原生结果。
  - 字段缺失表示结果完整，或后端未给出可判定的口径。
- `verifiedBy`：本次验证实际由哪个后端执行（`backend`、`endpoint`、`elapsedMs`、`reasons`、回退时的 `fallbackFrom`）。**跨后端结果不可直接比较**，比较两次 DRC 前先看这个字段。
- `projectRules`：规则口径。`injected` 表示已把工程板级约束注入会话（`applied`/`skipped` 为条数）；`skipped`/`failed` 表示按服务端默认工程判定，**线宽/间距类结论不可直接采信**；`not-applicable` 表示 `local`/`ipc` 由 kicad-cli 直接读工程目录、无需注入。
- `viewUrl`：`/drc-report/api/report?key=…`，浏览器半边拉取该地址并在对话尾部渲染分页报告卡片，调用方无需处理。无 `webServer` 环境时字段不存在。

## 7. 失败、取消与探测

- 执行器错误（PCB 不存在、kicad-cli 未找到、HTTP 失败等）会转成结构化失败输出：`success=false`、`exitCode=-1`、错误信息在 `stderr`，而不是裸异常。
- 工具被取消时 `signal` 会传给执行器，进程/HTTP 能真的停下来；超时由 `timeoutSeconds` 控制。
- `ipc` 正常会带回结构化结果；若 `RunDrcResponse` 为空，正文会提示「已在 KiCad 中执行 DRC，但没取回结构化结果」，此时**改用 `local` 后端复核**，不要把它当成"未生成报告"或成功。
- `kicad_drc_backends` 列出各后端的 `available` / `endpoint` / `estimatedMs` / `reason`，**不执行 DRC、无副作用**。典型用途：跑 DRC 前确认本机是否有可用的本地 kicad-cli；或上一次远程调用失败后确认它是否处于降级冷却期。探测本身失败时返回 `backends: []` 与 `error`。一般情况下直接调 `kicad_drc_run`（`mode` 留空）即可，无需先探测。

## 8. 用户面向的行为契约（不可省略）

- 以结构化工具结果为权威；不要把进度、耗时或"任务已提交/正在运行"当成完成。
- 绝不编造项目身份、元件数据、连通性、ERC/DRC 发现、库信息或操作成功。
- 没有权威结果时不要宣称 DRC 通过、板子无违规或违规数是多少；信息拿不到就如实报告。
- 报告不完整（`reportComplete=false`）时必须把这一限制说清楚，不能只报一个数字。
- 不把不同后端、不同报告格式的违规数放在一起比较后下结论。
