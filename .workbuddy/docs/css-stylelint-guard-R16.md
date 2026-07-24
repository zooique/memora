# R16 · 样式守卫（stylelint）执行方案

> 评估日期：2026-07-24
> 作者：CSS 审计 / R9–R14 收口工作的延续
> 状态：**已实现（2026-07-24）**。实现中修正了设计阶段的 3 处偏差，见文末「实现修正」与 styles/README.md §10 CSS-R16。

---

## 1. 为什么需要（第一性原理）

CSS 抽象只为三件事：去重、单点决策、强制一致。R9–R14 已把「去重 / 单点」基本做对，但**没有任何机制阻止回归**——本次审计亲手证明了这点：

- R13 修的 `--success-10` 是「引用了不存在的 token，被 fallback 遮罩」的典型 bug。
- R13-bis：`completion-stats.css` 里 `--orange` / `--text-tertiary` / `--orange-20` 同样不存在，静默回退。
- R14 修的 `.lineage-source-tag` 是 R9 标签收口时漏删的重复基类。

人工审计能抓到，但不可持续。需要一个**构建期 / 提交期守卫**，把「幻影 token、重复属性、`!important`、非法 hex」这类**确定性 bug**挡在门外。**注意：目标是「守卫（guard）」，不是「格式化器（formatter）」**——不引入 `stylelint-config-standard` 那套几百条风格规则，避免噪音淹没信号。

---

## 2. 工具选型（对抗式对比）

| 候选 | verdict | 理由 |
|---|---|---|
| **stylelint v16** + `stylelint-value-no-unknown-custom-properties` | ✅ 选 | 精准抓「幻影 token」的成熟方案；与现有 lefthook / eslint 体系同生态；纯 CSS 无需额外语法器。（⚠️ 设计阶段曾误写为 `@csstools/stylelint-value-no-unknown-custom-properties`——该作用域包在 npm **不存在**；正确包名是未限定作用域的 `stylelint-value-no-unknown-custom-properties`，其注册规则名为 `csstools/value-no-unknown-custom-properties`。） |
| csstree / postcss 自定义脚本 | ❌ | 要自己写聚合与规则，维护成本高，重复造轮子 |
| prettier (CSS) | ❌ | 只管格式，不报语义错误 |
| 直接扩展 `stylelint-config-standard` | ❌ | 78 个遗留 CSS 文件会炸出数百条风格告警，信噪比崩塌 |

结论：最小可用集 = `stylelint` + `stylelint-value-no-unknown-custom-properties`，**不 extend 任何 preset**。

---

## 3. 创建 / 修改的文件（最终实现形态）

### 3.1 新增 `.stylelintrc.mjs`（host 根 `hosts/memora-sprite/`）

> 用 `.mjs`（JS 配置）而非 `.json`，以便用 `fileURLToPath(import.meta.url)` 算出**绝对路径**传入 `importFrom`（monorepo 下 relative 从 CWD 解析可能失效，插件 README 明确建议用绝对路径）。

```js
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_SOURCES = [
  resolve(__dirname, 'src/electron/renderer/styles/foundation/tokens.css'),
  resolve(__dirname, 'src/electron/renderer/styles/foundation/base.css'),
  resolve(__dirname, 'src/electron/renderer/styles/foundation/controls.css'),
  resolve(__dirname, 'src/electron/renderer/styles/foundation/utilities.css'),
];

export default {
  plugins: ['stylelint-value-no-unknown-custom-properties'],
  rules: {
    // 主规则：抓「引用不存在的 --x token」（R13 / R13-bis 类 bug）。importFrom 提供已知 token 集。
    'csstools/value-no-unknown-custom-properties': [true, { importFrom: TOKEN_SOURCES }],
    'declaration-block-no-duplicate-properties': [true, { ignore: ['consecutive-duplicates-with-different-values'] }],
    'color-no-invalid-hex': true,
    'no-empty-source': true,
    // 以下两条经核实为「明知故犯」，关闭以免阻塞（详见实现修正 §4）：
    'no-duplicate-selectors': null,        // markdown.css 基础+增强规则有意同选择器拆分
    'declaration-no-important': null,      // .hidden / .sr-only 工具类有意 !important
  },
  ignoreFiles: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.min.css'],
};
```

**为何只开这 4 条（高信号、低误报）**：
- `csstools/value-no-unknown-custom-properties` → **主规则**，抓 R13 / R13-bis 全部幻影 token。
- `declaration-block-no-duplicate-properties` → 抓同一块内重复声明。
- `color-no-invalid-hex` / `no-empty-source` → 廉价卫生项。
- `no-duplicate-selectors` / `declaration-no-important` → 首跑发现其告警均为**有意的明知故犯**，置 `null` 关闭（见实现修正）。

**刻意不开**：`color-hex-length`、`color-function-notation`、`alpha-value-notation`、`shorthand-property-no-redundant-values`、`selector-class-pattern` 等——它们会针对 `base.css` 里**有意的防御性 fallback**（`var(--red, #dc2626)`）和众多结构性裸 `px` 狂报错，信噪比差。

### 3.2 修改 `hosts/memora-sprite/package.json`

```diff
  "scripts": {
+   "lint:css": "stylelint \"src/electron/renderer/styles/**/*.css\"",
+   "lint:css:fix": "stylelint \"src/electron/renderer/styles/**/*.css\" --fix",
    "lint": "npm run check-configs && eslint . --ext .ts && npm run lint:css",
  },
  "devDependencies": {
+   "stylelint": "^16.26.1",
+   "stylelint-value-no-unknown-custom-properties": "^6.1.1",
  }
```

> 安装用 node 24（host `engines.node>=24`）并加 `--ignore-scripts`，跳过 `electron-builder install-app-deps` 重型 postinstall（stylelint 为纯 JS 包，无需重建原生模块）。

### 3.3 修改 `lefthook.yml`（pre-commit 阻塞门禁，已实现）

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
+    # 步骤 3：CSS 守卫（stylelint；importFrom 提供 token 集，守卫全量 styles 目录）
+    lint:css:
+      glob: "*.css"
+      run: npm run lint:css
+      stage_fixed: false
```

---

## 4. 关键设计陷阱（实现中实测论证 + 修正）

### 4.1 原假设（错误）：「整目录 glob 让插件聚合全量 :root」

设计阶段认为：以整目录 glob `src/electron/renderer/styles/**/*.css` 调用 stylelint，插件会聚合所有文件的 `:root` 自定义属性。

**实测推翻**：`stylelint-value-no-unknown-custom-properties` 只在**单个文件内部**沿 `@import` 链聚合 token，**不会跨 glob 文件合并**。本项目的 token 由 `index.html` 单独 `<link>` 的 `foundation/tokens.css` 引入，各面板/浮层 CSS 自身并不 `@import` tokens.css。因此孤立扫描叶子文件时，插件看不到 token → **首次整目录 glob 跑出 3260 条误报**（全是 `--accent` / `--red` / `--font-xs` 等合法 token）。

### 4.2 修正方案：`importFrom` 提供已知 token 集

插件提供 `importFrom` 选项，可声明「这些文件里的 `:root` 自定义属性算已知」，对**每一个被 lint 的文件**（含孤立扫描的叶子文件）都生效，无需 `@import` 内联、不污染运行时。

```js
'csstools/value-no-unknown-custom-properties': [true, {
  importFrom: [ /* 绝对路径：tokens.css + base.css + controls.css + utilities.css */ ]
}]
```

- 用 `.mjs` + `fileURLToPath` 算绝对路径（README 明确 monorepo 下 relative 可能失效）。
- `importFrom` 列出全部 foundation 级 token 源（tokens.css 持有 167 个跨文件 token；base/controls/utilities 兜底少量 foundation 声明）。
- 验证：改回整目录 glob + importFrom 后，基线 0 误报；且注入幻影 token 到叶子文件能被精准抓到（见 4.4 验证）。

### 4.3 曾试过的「lint-only 入口文件」方案（放弃）

曾创建 `.stylelint-entry.css` 按 `index.html` 加载顺序 `@import` 全部入口，只 lint 该文件。但**验证发现是假绿**：stylelint 不内联 `@import`，插件只读导入文件来收集 token **定义**，并不校验导入文件内部的 `var()` 用法 → 注入叶子文件的幻影 token 未被抓到。故放弃该方案，改用 `importFrom`。

### 4.4 守卫有效性验证（对抗式）

- **假绿排查**：在 `health.css` 末尾注入 `.__x { color: var(--this-token-is-not-real-xyz); }`，重跑 → 守卫**报出**该幻影 → 证明守卫真实校验叶子文件（非只对入口空检）。
- **基线**：修复后 `npm run lint:css` 退出码 0，0 错误。

---

## 5. 执行阶段（实际结果）

| 阶段 | 动作 | 阻塞？ | 实际结果 |
|---|---|---|---|
| **P1 基建** | 安装 2 个 devDep；落 `.stylelintrc.mjs`；加 `lint:css` 脚本 | 否 | ✅ 完成 |
| **P1 基线** | 跑 `npm run lint:css` | 否 | 首次 3260 误报（glob 陷阱）→ 修正为 importFrom 后 18 条真实问题 |
| **P2 清理** | 修守卫抓出的真问题 | 否 | ✅ 6 处幻影 token 修复（见下）；2 条风格规则明知故犯置 null |
| **P3 卡点** | `lint:css` 并入 `lint` 脚本 + lefthook pre-commit 阻塞 | **是** | ✅ 完成，守卫现状 0 错误 |

---

## 6. 守卫首跑抓出的真问题（均已修复）

| token | 位置 | 根因 | 修复 |
|---|---|---|---|
| `--weight-normal` | health.css:78 / modal.css:531 | 拼写错误，tokens 里是 `--weight-regular` | → `--weight-regular` |
| `--overlay` | perception.css ×3（雷达参考线 stroke） | 未定义；原因无效 `var()` 导致参考线不可见 | → `--surface2`（主题感知边框色） |
| `--surface3` | sprite-settings.css:172（hover 边框） | 未定义（原作者意图中的 token 漏加） | tokens.css 双主题补 `--surface3` |

另两类告警经核实为**有意的明知故犯**，置 `null` 关闭：`no-duplicate-selectors`（markdown.css 基础+增强规则有意同选择器拆分）、`declaration-no-important`（`.hidden` / `.sr-only` 工具类必须 `!important` 覆盖其他 display）。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 跨文件误报合法 token | `importFrom` 绝对路径提供 token 集（§4.2），首次运行人工核对基线 |
| 新 token 未进 importFrom 导致误报 | 新增 foundation 级 token 源时同步 `TOKEN_SOURCES`；组件级局部 token 因同文件定义自动识别 |
| `no-duplicate-selectors` / `declaration-no-important` 关闭后漏检回归 | 这两类当前仅确认有意的明知故犯；若未来出现非有意用法，可改为 `["error"]` 重新启用（注意本版本不接受 `["warning"]` 作 severity，见 §8） |
| CSP `style-src 'self'` | 无关——stylelint 是构建/提交期工具，不进运行时 |
| 安装 devDep 需网络 / node 版本 | node 24 安装 + `--ignore-scripts` 跳过原生重建 |

---

## 8. 已知坑（实现中踩到）

- **包名**：npm 上**没有** `@csstools/stylelint-value-no-unknown-custom-properties`；正确是未限定作用域的 `stylelint-value-no-unknown-custom-properties`（v6 支持 stylelint 16）。
- **规则名**：该包注册的规则名是 `csstools/value-no-unknown-custom-properties`（不是 `@csstools/...`，也不是裸 `value-no-unknown-custom-properties`）——直接读包内 `lib/rule-name.mjs` 确认。
- **severity 写法**：本版本中 `no-duplicate-selectors` / `declaration-no-important` 不接受 `["warning"]` 作 severity（报 `Unexpected option value "warning"`）；需启用时用 `["error"]`，或置 `null` 关闭。其余规则 `true` 默认即 error 正常。
- **跨文件聚合**：见 §4.1，整目录 glob 不聚合 `:root`，必须用 `importFrom`。

---

## 9. 成功标准（已达成）

1. ✅ `npm run lint:css` 退出码 0（R13-bis / R16 首跑修复后）。
2. ✅ 任何新引入「引用不存在的 `--x` token」的提交，在 pre-commit 被拦下（lefthook `lint:css` 步骤）。
3. ✅ 不引入风格类噪音（不 extend preset），守卫保持高信噪比。

---

## 10. 预估工作量（实际）

- P1 基建 + 配置：~30 min（含包名/跨文件陷阱排查）
- P1 基线 + P2 清理：~45 min（3260 误报→18 真问题→0）
- P3 卡点：~15 min
- 合计：**~1.5 h**，守卫已转绿并接入提交门禁。
