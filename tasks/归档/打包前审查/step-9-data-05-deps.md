# Step 9 · Data 05 · 依赖审计报告

> **执行时间**：2026-07-19
> **执行模式**：big-tree-grower 模式 10（依赖审计）
> **审查范围**：memora 内核（`f:\zooique\memora\`）+ sprite 宿主（`f:\zooique\memora\hosts\memora-sprite\`）
> **关键约束**：
> - memora `dependencies` 必须为空（[project-rules.md §1.6](../../.trae/rules/project-rules.md) 零依赖内核硬约束）
> - sprite 禁止升级 major 版有 breaking changes（big-tree-grower DON'T 清单）
> - Electron major 升级需额外评估（影响 native ABI：better-sqlite3 / nut-js / sharp）
> - 仅审查记录，不修改 package.json 或运行 npm install

---

## 一、执行摘要

| 维度 | memora 内核 | sprite 宿主 | 状态 |
|------|-------------|-------------|------|
| `dependencies` 是否为空 | `{}` ✅ | `@nut-tree-fork/nut-js` + `better-sqlite3` | 内核满足 §1.6 |
| 漏洞总数 | 0 | 7（全 moderate） | sprite 需关注 |
| 高危/严重漏洞 | 0 | 0 | ✅ |
| 过期依赖数 | 16（全 dev） | 9（含 electron / TS 等 major） | 需分级处理 |
| 核心依赖状态 | N/A | electron/better-sqlite3/nut-js 均 latest 内 | ✅ |

**总体结论**：
- 🔴 无高危漏洞，可继续打包流程
- 🟡 sprite 存在 7 个 moderate 漏洞，根因在 `@nut-tree-fork/nut-js` → `jimp` → `file-type` 传递依赖链，上游未修，需风险接受或换库
- 🟡 多个 major 版本过期（typescript 5→7、electron 40→43、eslint 9→10、lefthook 1→2、pino 9→10、pino-pretty 11→13、@types/node 22/24→26），按用户规则禁止 major 升级
- 🟢 大量 patch/minor 过期可批量升级（仅 devDeps，无运行时风险）

---

## 二、memora 内核依赖审计

### 2.1 `dependencies` 硬约束验证（§1.6）

```json
"dependencies": {},
"peerDependencies": { "pino": ">=9.0.0" },
"peerDependenciesMeta": { "pino": { "optional": true } }
```

✅ **满足零依赖内核硬约束**：
- `dependencies` 为空对象
- `pino` 仅作为 optional peerDependency，由宿主注入
- `npm audit` 报告 `prod: 6` 实为 peerDep 解析计数，非实际打包依赖

### 2.2 漏洞扫描结果

```
npm audit --json
→ vulnerabilities: {}
→ metadata.vulnerabilities: { info:0, low:0, moderate:0, high:0, critical:0, total:0 }
→ dependencies: { prod:6, dev:420, optional:79, peer:10, total:433 }
```

✅ **零漏洞**。

### 2.3 devDependencies 使用核查（无冗余）

| 依赖 | 用途 | 引用位置 | 必需性 |
|------|------|----------|--------|
| `@commitlint/cli` + `@commitlint/config-conventional` | commit-msg 规范校验 | `lefthook.yml` commit-msg 段 | ✅ 必需 |
| `@types/node` | Node 类型定义 | 全量 TS 编译 | ✅ 必需 |
| `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` | ESLint TS 支持 | `lefthook.yml` pre-commit | ✅ 必需 |
| `@vitest/coverage-v8` | 测试覆盖率 | `test:cov` 脚本 | ✅ 必需 |
| `eslint` | lint 框架 | `lint` / `lint:fix` 脚本 + lefthook | ✅ 必需 |
| `lefthook` | git hooks 框架 | `prepare` 脚本 + `lefthook.yml` | ✅ 必需 |
| `msw` | Mock LLM（HTTP 拦截） | `src/llm/__tests__/openaiCompatible.test.ts` | ✅ 必需 |
| `pino-pretty` | pino 日志美化（开发期） | 仅 `package.json` 声明（peer `pino` 的开发配套） | 🟡 未在 src/ 引用，仅作开发期日志可读性配套，**保留** |
| `prettier` | 代码格式化 | `format` / `format:check` 脚本 | ✅ 必需 |
| `rimraf` | 清理 dist | `prepublishOnly` 脚本 | ✅ 必需 |
| `tsc-alias` | 路径别名解析 | `build` 脚本 | ✅ 必需 |
| `tsx` | 运行 TS 脚本 | `scripts/smokeLlm.ts`（`npx tsx scripts/smokeLlm.ts`） | ✅ 必需 |
| `typescript` | TS 编译器 | `build` / `typecheck` 脚本 + lefthook | ✅ 必需 |
| `vitest` | 测试框架 | `test` / `test:watch` / `test:cov` 脚本 | ✅ 必需 |

**结论**：16 个 devDeps 全部有实际用途，无冗余、无未使用。

### 2.4 过期依赖清单（memora 内核）

#### 🟢 非 Major 过期（可批量升级，仅 devDeps）

| 依赖 | current | wanted | latest | 类型 | 升级风险 |
|------|---------|--------|--------|------|----------|
| `@commitlint/cli` | 21.0.2 | 21.2.1 | 21.2.1 | minor | 低 |
| `@commitlint/config-conventional` | 21.0.2 | 21.2.0 | 21.2.0 | minor | 低 |
| `@types/node` | 22.19.19 | 22.20.1 | 22.20.1 | minor（22.x 内） | 低 |
| `@typescript-eslint/eslint-plugin` | 8.60.1 | 8.64.0 | 8.64.0 | minor | 低 |
| `@typescript-eslint/parser` | 8.60.1 | 8.64.0 | 8.64.0 | minor | 低 |
| `@vitest/coverage-v8` | 4.1.8 | 4.1.10 | 4.1.10 | patch | 极低 |
| `eslint` | 9.39.4 | 9.39.5 | 9.39.5 | patch（9.x 内） | 极低 |
| `msw` | 2.14.6 | 2.15.0 | 2.15.0 | minor | 低 |
| `prettier` | 3.8.3 | 3.9.5 | 3.9.5 | minor | 低 |
| `tsc-alias` | 1.8.17 | 1.9.1 | 1.9.1 | minor | 低 |
| `tsx` | 4.22.4 | 4.23.1 | 4.23.1 | minor | 低 |
| `vitest` | 4.1.8 | 4.1.10 | 4.1.10 | patch | 极低 |

> 建议升级命令（**待用户确认后执行**）：`npm update` 或 `npm install <pkg>@latest --save-dev` 逐包升级。

#### 🟡 Major 过期（需评估 breaking，按用户规则禁止自动升级）

| 依赖 | current | latest | 跨度 | 评估 |
|------|---------|--------|------|------|
| `@types/node` | 22.19.19 | 26.1.1 | 22→26（4 major） | 🚫 不升。`engines.node ≥22`，类型应锁在 22.x，避免使用新 API |
| `eslint` | 9.39.4 | 10.7.0 | 9→10 | 🚫 不升。ESLint 10 有配置格式变更，需独立评估 |
| `lefthook` | 1.13.6 | 2.1.10 | 1→2 | 🚫 不升。Lefthook 2 有配置兼容性变更 |
| `pino`（peer） | 9.14.0 | 10.3.1 | 9→10 | 🚫 不升。peerDep 范围 `>=9.0.0`，宿主未要求 10 |
| `pino-pretty` | 11.3.0 | 13.1.3 | 11→13 | 🚫 不升。需与 pino 主版本对齐，且仅开发用 |
| `typescript` | 5.9.3 | 7.0.2 | 5→7（跨 6） | 🚫 不升。TS 7 为重大版本，需独立 ADR 评估 |

---

## 三、sprite 宿主依赖审计

### 3.1 漏洞扫描结果

```
npm audit --json
→ metadata.vulnerabilities: { info:0, low:0, moderate:7, high:0, critical:0, total:7 }
→ dependencies: { prod:154, dev:515, optional:107, peer:13, total:670 }
```

#### 🟡 Moderate 漏洞链（7 个，全部源自同一传递依赖）

**根因漏洞**：

| 字段 | 值 |
|------|----|
| CVE | GHSA-5v7r-6r5c-r473 |
| 标题 | file-type affected by infinite loop in ASF parser on malformed input with zero-size sub-header |
| 严重性 | moderate（CVSS 5.3，DoS 类） |
| CWE | CWE-835（无限循环） |
| 受影响范围 | `file-type >=13.0.0 <21.3.1` |
| 修复版本 | file-type ≥21.3.1 |

**传递影响链**（直接依赖 → 上游）：

```
@nut-tree-fork/nut-js (direct, ^4.2.6)
  └─ @nut-tree-fork/shared
  └─ @nut-tree-fork/provider-interfaces
       └─ jimp (0.16.3-canary...0.22.12)
            └─ @jimp/custom
                 └─ @jimp/core
                      └─ file-type (13.0.0 - 21.3.0)  ← 漏洞所在
```

**npm audit 关键字段**：

| 包 | isDirect | fixAvailable | 说明 |
|----|----------|--------------|------|
| `@nut-tree-fork/nut-js` | **true** | **false** | 直接依赖，但上游 jimp 未升级 file-type，无法自动修复 |
| `@nut-tree-fork/shared` | false | true | 可在重构后修复，但 nut-js 仍受影响 |
| `@nut-tree-fork/provider-interfaces` | false | true | 同上 |
| `jimp` | false | **false** | jimp 上游未发布含修复的版本 |
| `@jimp/custom` / `@jimp/core` | false | false | 同 jimp |
| `file-type` | false | false | 上游已修（21.3.1+），但 jimp 锁定旧版 |

#### 漏洞实际风险评估

| 维度 | 评估 |
|------|------|
| 触发条件 | 应用需主动解析外部 ASF（Advanced Systems Format）畸形文件 |
| 实际暴露面 | nut-js 用于屏幕截图（屏幕抓取 + 图像比对），**不接受外部用户上传文件** |
| 影响 | 进程无限循环（DoS），无 RCE/信息泄露 |
| 攻击向量 | 仅当 nut-js 处理的截图数据被攻击者控制时才可触发（本地桌面场景几乎不可达） |
| **综合风险** | **低**。漏洞真实但暴露面极小，本地桌面应用场景下攻击者无法注入畸形 ASF |

#### 修复路径（按优先级）

1. **短期（接受风险）**：在 `npm audit` 输出归档说明，标注"漏洞真实但暴露面极小，本地桌面场景不可达"，**继续打包**
2. **中期（监控上游）**：关注 `@nut-tree-fork/nut-js` 是否发布切换至 `sharp` 或升级 jimp 的新版本
3. **长期（如需根治）**：评估替换 `@nut-tree-fork/nut-js` 为其他屏幕控制库（如 `robotjs`），或 fork 后自行 patch jimp 依赖

### 3.2 核心依赖版本核查

| 依赖 | 类型 | current | wanted | latest | 状态 |
|------|------|---------|--------|--------|------|
| `electron` | devDep | 40.10.5 | 40.10.6 | 43.1.1 | ✅ 40.x 内 patch 可升；🚫 major 40→43 需独立 ADR |
| `better-sqlite3` | dep | 12.11.1（allowScripts） | — | — | ✅ 已是 latest，无 outdated 条目 |
| `@nut-tree-fork/nut-js` | dep | 4.2.6+ | — | — | ✅ 已是 latest，但有传递漏洞（见 §3.1） |
| `electron-builder` | devDep | 26.x | — | — | ✅ 已是 latest |
| `jsdom` | devDep | 29.1.1 | — | — | ✅ 已是 latest |
| `sharp` | devDep | 0.35.3 | — | — | ✅ 已是 latest |

**ABI 绑定说明**：
- `electron` 40.x 升至 40.10.6（patch）安全，不触及 ABI
- `electron` 40 → 43（major）会引入新 Chromium + 新 Node ABI，需重建 `better-sqlite3` / `nut-js` / `sharp` native 模块，**禁止自动升级**
- `better-sqlite3` 12.11.1 已与 electron 40 ABI 对齐（通过 `electron-builder install-app-deps` 重建）

### 3.3 过期依赖清单（sprite 宿主）

#### 🟢 非 Major 过期（可批量升级）

| 依赖 | current | wanted | latest | 类型 | 升级风险 |
|------|---------|--------|--------|------|----------|
| `@types/node` | 24.13.2 | 24.13.3 | 24.13.3 | patch | 极低 |
| `@typescript-eslint/eslint-plugin` | 8.62.0 | 8.64.0 | 8.64.0 | minor | 低 |
| `@typescript-eslint/parser` | 8.62.0 | 8.64.0 | 8.64.0 | minor | 低 |
| `electron` | 40.10.5 | 40.10.6 | 40.10.6 | patch（40.x 内） | 极低（无 ABI 变更） |
| `eslint` | 9.39.4 | 9.39.5 | 9.39.5 | patch | 极低 |
| `prettier` | 3.9.1 | 3.9.5 | 3.9.5 | minor | 低 |
| `tsx` | 4.22.4 | 4.23.1 | 4.23.1 | minor | 低 |
| `vitest` | 4.1.9 | 4.1.10 | 4.1.10 | patch | 极低 |

#### 🟡 Major 过期（需评估 breaking）

| 依赖 | current | latest | 跨度 | 评估 |
|------|---------|--------|------|------|
| `@types/node` | 24.13.2 | 26.1.1 | 24→26 | 🚫 不升。`engines.node ≥24`，类型应锁在 24.x |
| `electron` | 40.10.5 | 43.1.1 | 40→43 | 🚫 不升。涉及 Chromium/Node ABI 大变更，需独立 ADR + 全量 native 模块重建测试 |
| `eslint` | 9.39.4 | 10.7.0 | 9→10 | 🚫 不升。配置格式可能变更 |
| `typescript` | 5.9.3 | 7.0.2 | 5→7 | 🚫 不升。TS 7 重大版本，需独立 ADR |

---

## 四、升级建议（按优先级）

### P1（安全性）— 无

无 high/critical 漏洞，无需立即修复。

### P2（架构一致性）— 无

零依赖内核硬约束已满足，无违规。

### P3（自然生长 / 维护）— 可选升级

#### 建议 A：批量升级非 Major devDeps（低风险）

**memora 内核**（12 包）：
```bash
# 在 f:\zooique\memora\
npm install --save-dev \
  @commitlint/cli@^21.2.1 \
  @commitlint/config-conventional@^21.2.0 \
  @types/node@^22.20.1 \
  @typescript-eslint/eslint-plugin@^8.64.0 \
  @typescript-eslint/parser@^8.64.0 \
  @vitest/coverage-v8@^4.1.10 \
  eslint@^9.39.5 \
  msw@^2.15.0 \
  prettier@^3.9.5 \
  tsc-alias@^1.9.1 \
  tsx@^4.23.1 \
  vitest@^4.1.10
```

**sprite 宿主**（8 包）：
```bash
# 在 f:\zooique\memora\hosts\memora-sprite\
npm install --save-dev \
  @types/node@^24.13.3 \
  @typescript-eslint/eslint-plugin@^8.64.0 \
  @typescript-eslint/parser@^8.64.0 \
  electron@^40.10.6 \
  eslint@^9.39.5 \
  prettier@^3.9.5 \
  tsx@^4.23.1 \
  vitest@^4.1.10
```

> 升级后需运行 `npm test` + `npm run typecheck` + `npm run lint` 验证。

#### 建议 B：sprite moderate 漏洞风险接受

`@nut-tree-fork/nut-js` → `jimp` → `file-type` 漏洞链 fixAvailable: false，且实际暴露面极小（本地桌面场景不可达），**建议风险接受并归档说明**，不阻塞打包。

### P4（测试与代码质量）— 无新增

### P5（风格偏好 / Major 升级）— 不执行

按用户规则 `禁止依赖审计升级 major 版有 breaking changes`，以下 major 升级**全部不执行**，仅在文档中归档：
- memora: `@types/node` 22→26、`eslint` 9→10、`lefthook` 1→2、`pino` 9→10、`pino-pretty` 11→13、`typescript` 5→7
- sprite: `@types/node` 24→26、`electron` 40→43、`eslint` 9→10、`typescript` 5→7

如未来需要升级任一 major，须先走"年轮审判"产出 ADR，再走"依赖审计"逐包评估。

---

## 五、风险评估

### 5.1 打包阻塞风险

| 风险项 | 阻塞打包？ | 说明 |
|--------|------------|------|
| memora 零依赖约束违规 | ❌ 不阻塞 | `dependencies: {}` 已满足 |
| memora 0 漏洞 | ❌ 不阻塞 | — |
| sprite 7 个 moderate 漏洞 | ❌ 不阻塞 | 暴露面极小，风险接受 |
| sprite electron 40.10.5 | ❌ 不阻塞 | patch 升级可选，不强制 |
| sprite native 模块 ABI | ❌ 不阻塞 | better-sqlite3/nut-js/sharp 与 electron 40 已对齐 |

**结论**：✅ **无打包阻塞项**，可继续后续打包流程。

### 5.2 后续监控项

1. **file-type 漏洞上游修复**：定期检查 `@nut-tree-fork/nut-js` 是否发布新版本切换 jimp
2. **electron 40 EOL**：关注 Electron 40.x 的支持周期，提前规划 major 升级 ADR
3. **typescript 7 评估**：TS 7 为重大版本，建议在下一个迭代周期独立评估

### 5.3 关键约束遵守情况

| 约束 | 来源 | 遵守情况 |
|------|------|----------|
| memora `dependencies` 必须为空 | project-rules.md §1.6 | ✅ |
| 禁止升级 major 版有 breaking changes | big-tree-grower DON'T | ✅ 全部不升 |
| Electron major 升级需额外评估 | 任务描述关键约束 §4 | ✅ 未升 |
| 仅审查不修改 package.json | 任务描述 | ✅ 未修改 |
| 不运行 npm install | 任务描述 | ✅ 未运行 |

---

## 六、归档清单

- **本报告**：`f:\zooique\memora\tasks\打包前审查\step-9-data-05-deps.md`
- **关联前置**：`step-1` 至 `step-8` 同目录下其他审查记录
- **后续动作**：
  - 建议 A（批量升级 devDeps）→ 归档到 `tasks/待完成任务.md`，由用户决定执行时机
  - 建议 B（漏洞风险接受）→ 本报告已说明，无需额外归档
  - Major 升级归档 → 不执行，本报告已记录备查

---

> **审计完成声明**：本次审计仅执行 `npm audit` / `npm outdated` / 文件读取，未修改任何 `package.json`，未运行 `npm install`。所有 major 升级建议均按用户规则不执行，归档备查。
