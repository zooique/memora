# R16 · 样式守卫（stylelint）执行方案

> 评估日期：2026-07-24
> 作者：CSS 审计 / R9–R14 收口工作的延续
> 状态：**设计阶段（待确认后执行）**

---

## 1. 为什么需要（第一性原理）

CSS 抽象只为三件事：去重、单点决策、强制一致。R9–R14 已把「去重 / 单点」基本做对，但**没有任何机制阻止回归**——本次审计亲手证明了这点：

- R13 修的 `--success-10` 是「引用了不存在的 token，被 fallback 遮罩」的典型 bug。
- R13-bis（本次新发现）：`completion-stats.css` 里 `--orange`(6处) / `--text-tertiary`(5处) / `--orange-20`(1处) **同样不存在**，静默回退到 `--accent` / `--text-secondary`。
- R14 修的 `.lineage-source-tag` 是 R9 标签收口时漏删的重复基类。

人工审计能抓到，但不可持续。需要一个**构建期 / 提交期守卫**，把「幻影 token、重复选择器、重复属性、`!important`、非法 hex」这类**确定性 bug**挡在门外。**注意：目标是「守卫（guard）」，不是「格式化器（formatter）」**——不引入 `stylelint-config-standard` 那套几百条风格规则，避免噪音淹没信号。

---

## 2. 工具选型（对抗式对比）

| 候选 |  verdict | 理由 |
|---|---|---|
| **stylelint v16** + `@csstools/stylelint-value-no-unknown-custom-properties` | ✅ 选 | 唯一能跨文件聚合 `:root` 自定义属性、精准抓「幻影 token」的成熟方案；与现有 lefthook / eslint 体系同生态；纯 CSS 无需额外语法器 |
| csstree / postcss 自定义脚本 | ❌ | 要自己写聚合与规则，维护成本高，重复造轮子 |
| prettier (CSS) | ❌ | 只管格式，不报语义错误 |
| 直接扩展 `stylelint-config-standard` | ❌ | 78 个遗留 CSS 文件会炸出数百条风格告警（现代颜色记法、0px→0、简写冗余等），信噪比崩塌 |

结论：最小可用集 = `stylelint` + `@csstools/stylelint-value-no-unknown-custom-properties`，**不 extend 任何 preset**。

---

## 3. 要创建 / 修改的文件

### 3.1 新增 `.stylelintrc.json`（host 根 `hosts/memora-sprite/`）

```json
{
  "plugins": ["@csstools/stylelint-value-no-unknown-custom-properties"],
  "rules": {
    "@csstools/value-no-unknown-custom-properties": [true, { "imports": true }],
    "no-duplicate-selectors": true,
    "declaration-block-no-duplicate-properties": [true, { "ignore": ["consecutive-duplicates-with-different-values"] }],
    "declaration-no-important": true,
    "color-no-invalid-hex": true,
    "no-empty-source": true
  },
  "ignoreFiles": ["dist/**", "node_modules/**", "coverage/**", "**/*.min.css"]
}
```

**为何只开这 6 条**（高信号、低误报）：
- `@csstools/value-no-unknown-custom-properties` → **主规则**，抓 R13 / R13-bis 全部幻影 token。
- `no-duplicate-selectors` → 抓 R14 类「重复基类漏删」。
- `declaration-block-no-duplicate-properties` → 抓同一块内重复声明。
- `declaration-no-important` → 抓 `!important` 越权（当前代码应已无，作为回归闸）。
- `color-no-invalid-hex` / `no-empty-source` → 廉价卫生项。

**刻意不开**：`color-hex-length`、`color-function-notation`、`alpha-value-notation`、`shorthand-property-no-redundant-values`、`selector-class-pattern` 等——它们会针对 `base.css` 里**有意的防御性 fallback**（`var(--red, #dc2626)`）和众多结构性裸 `px` 狂报错，信噪比差。

### 3.2 修改 `hosts/memora-sprite/package.json`

```diff
  "scripts": {
+   "lint:css": "stylelint \"src/electron/renderer/styles/**/*.css\"",
+   "lint:css:fix": "stylelint \"src/electron/renderer/styles/**/*.css\" --fix",
    "lint": "npm run check-configs && eslint . --ext .ts",
  },
  "devDependencies": {
+   "@csstools/stylelint-value-no-unknown-custom-properties": "^3.0.0",
+   "stylelint": "^16.0.0",
  }
```

### 3.3 修改 `lefthook.yml`（pre-commit，Phase 3 才启用阻塞）

```diff
 pre-commit:
   parallel: false
   commands:
     lint-staged:
       glob: "*.ts"
       run: npx eslint {staged_files} --max-warnings 0 --no-warn-ignored
       stage_fixed: true
     typecheck:
       glob: "*.ts"
       run: npx tsc --noEmit
+    # 步骤 3：CSS 守卫（Phase 3 起阻塞；Phase 1/2 仅报告）
+    # ⚠️ 必须 lint 整个 styles 目录，不能只传 {staged_files}：
+    #    csstools 插件需跨文件聚合所有 :root 自定义属性，否则会误报 --accent 等合法 token 为未知。
+    lint:css:
+      glob: "*.css"
+      run: npx stylelint "src/electron/renderer/styles/**/*.css"
+      stage_fixed: true
```

---

## 4. 关键设计陷阱（已实测论证）

**陷阱：跨文件 token 聚合。** `@csstools/value-no-unknown-custom-properties` 只把「本次 lint 运行中出现的 `:root` 声明」视为已知。若 lefthook 只把 staged 的 `*.css` 传给 stylelint，`tokens.css`（定义 `--accent`/`--red` 等）可能不在集合内 → **合法 token 被误报为未知**，守卫直接废掉。

**对策（已论证可行）**：始终以整目录 glob `src/electron/renderer/styles/**/*.css` 调用 stylelint，让插件聚合全量 `:root`。在此前提下：
- `--accent` / `--red` / `--green` 等 → 已知，不报。
- `base.css` 的防御性 fallback（`var(--red, #dc2626)`）→ 引用的 `--red` 已知，**不误报**（fallback 内的硬编码 hex 不被 unknown-custom-property 规则触碰）。
- `--orange` / `--text-tertiary` / `--orange-20` → 全局无定义 → **精确报出**（R13-bis）。

---

## 5. 执行阶段（建议）

| 阶段 | 动作 | 阻塞？ | 产出 |
|---|---|---|---|
| **P1 基建** | 安装 2 个 devDep；落 `.stylelintrc.json`；加 `lint:css` 脚本 | 否 | 可运行守卫 |
| **P1 基线** | 跑 `npm run lint:css` 记录基线告警数 | 否 | 预期 ≈11 条 unknown-custom-property（来自 R13-bis）+ 少量（若重复选择器/属性残留） |
| **P2 清理** | 修 R13-bis：把 `--orange`→`--accent`、`--text-tertiary`→`--text-secondary`、`--orange-20`→`--accent-20`（completion-stats.css，约 12 处） | 否 | 守卫转绿（0 告警） |
| **P3 卡点** | 把 `lint:css` 并入 `lint` 脚本 + lefthook pre-commit 阻塞 | **是** | 提交门禁生效，幻影 token / 重复选择器回归被挡 |

> P2 的 R13-bis 修复与 R13 同源，建议与 R13 一并处理（零风险、2 行 token 级改动），但当前回合范围限定为 R13+R14 + 本方案设计，故 R13-bis 留作首轮清理。

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 跨文件误报合法 token | 整目录 glob（见 §4），首次运行人工核对基线 |
| `no-duplicate-selectors` 对「后代覆写 / 状态扩展 / 动画钩子」误报 | 审计已确认真实完全相同选择器极少；P1 基线先 review，必要时将该规则降级为 warn |
| stylelint 版本 vs Node 22/24 | v16 要求 Node ^18.12/^20/>=21.1，当前 22.22.2 / engines>=24 均满足 |
| CSP `style-src 'self'` | 无关——stylelint 是构建/提交期工具，不进运行时 |
| 安装 devDep 需网络 | P1 在用户确认后执行 `npm install`（仅 2 个包） |

---

## 7. 成功标准

1. `npm run lint:css` 退出码 0（R13-bis 修复后）。
2. 任何新引入「引用不存在的 `--x` token」或「重复基类」的提交，在 pre-commit 被拦下。
3. 不引入风格类噪音（不 extend preset），守卫保持高信噪比。

---

## 8. 预估工作量

- P1 基建 + 配置：~30 min
- P1 基线 + P2 清理：~30 min（R13-bis 12 处机械替换）
- P3 卡点：~15 min
- 合计：**~1.25 h**，且 P1/P2 可独立完成、不阻塞开发。
