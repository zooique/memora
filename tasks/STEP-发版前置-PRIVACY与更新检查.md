# STEP 卡片：发版前置（P0-3 更新检查 + P0-5 隐私白皮书）

> 目标：补齐发布 P0 清单里仅剩的两块硬缺口，使「可以发版测试」成立。
> 关联文档：`发布流程-gitee-20260722.md` §0（P0 清单）、§5（检查更新）、§7（PRIVACY 要点）
> 约束红线：**零新增 IPC 通道**（治理阈值 129/130 不变）。更新检查一律走「渲染层锚点 + 主进程 `will-navigate` 拦截」或 `window.electronAPI` 现有桥，**不新增 channels.ts 条目**。
> 日期：2026-07-23
> 核验：2026-07-28 联网核实 §5 所述 Gitee API / electron-builder 配置仍有效（详见主文档 §5「时效性核验」）；本卡约束与实现方式不变。

---

## 决策前提（先填占位符）

| 占位符 | 含义 | 路线 A（Gitee 发布仓库） | 路线 B（对象存储） |
|---|---|---|---|
| `{下载地址}` | 用户获取新版的页 | Gitee 仅作反馈（见 §6），不托管 exe | 对象存储落地页 / 你的下载页 |
| `{隐私地址}` | 在线隐私白皮书 | 对象存储落地页 / 你的站点（与 exe 同桶或同站） | 落地页 URL |

> 当前 130MB 体积下默认 **路线 B（对象存储）**（Gitee 100MB 上限无法托管 exe，仅留作反馈 Issues）。下面 STEP 以路线 B 书写；`{下载地址}`=对象存储落地页。

---

## P0-3：应用内「检查更新」按钮（梯度 A，满足字面要求）

**原则**：P0-3 的字面是「应用内按钮 → 打开下载页」。不接 `electron-updater`、不做版本比对，最省事且零风险。版本比对（梯度 B）列为可延后项。

### STEP-3.1 主进程加外部链接拦截（一次性，~5 行）
在创建主窗口处（如 `src/electron/main.ts` 中 `new BrowserWindow` 之后），加：

```ts
import { shell } from 'electron';
// 渲染层点击外部 <a href="https://..."> 时，改为用系统浏览器打开，而非在应用内导航
mainWindow.webContents.on('will-navigate', (e, url) => {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    e.preventDefault();
    shell.openExternal(url);
  }
});
mainWindow.webContents.on('new-window', (e, url) => {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    e.preventDefault();
    shell.openExternal(url);
  }
});
```

> 作用：让设置面板里的 `<a href="{下载地址}">` 直接唤起系统浏览器，无需新增 IPC。

### STEP-3.2 设置/关于面板加按钮
在 `src/electron/renderer/panels/settingsPanelManager.ts` 渲染处，新增「关于」分区（或追加到现有设置 HTML）：

```html
<div class="about-section">
  <div>Memora Sprite <span id="app-version">v1.3.0</span></div>
  <a class="btn-link" href="{下载地址}" target="_blank" rel="noopener">检查更新</a>
  <a class="btn-link" href="{隐私地址}" target="_blank" rel="noopener">隐私白皮书</a>
</div>
```

> 版本号从 `package.json` 注入（宿主 `version` 当前 `1.3.0`）；若已有关于页，直接补两个 `<a>` 即可。

### STEP-3.3 手动验证
- [ ] 设置面板出现「检查更新」「隐私白皮书」两个链接
- [ ] 点击「检查更新」→ 系统浏览器打开对象存储落地页（应用内不导航）
- [ ] 点击「隐私白皮书」→ 打开 PRIVACY.md

### STEP-3.4（可延后，非 P0）梯度 B 版本比对
仅当想「有新版才提示」时做。**参考实现见 `发布流程-gitee-20260722.md` §5 梯度 B**（要点：下载与检测走对象存储 `version.json`，无 Gitee 100MB 限制、无 token、无 CORS；版本用数值比较器而非字符串/`!==`；有新版才 `shell.openExternal(page)`；本机客户端版本用 `app.getVersion()`）。
> 约束：① 检查在**主进程**用 Node `fetch` 拉 `version.json`（对象存储公开读、无 CORS）；② IPC 红线 —— 复用**已有** `ipcRenderer.invoke` 通道触发，**不新增** `channels.ts` 条目。首版不做，避免碰 IPC 阈值。

---

## P0-5：隐私白皮书落位

### STEP-5.1 文件已就绪
`PRIVACY.md` 已创建于仓库根（`F:\zooique\memora\PRIVACY.md`），内容基于已核实事实：
- 全仓无遥测/崩溃上报/行为追踪（grep 印证）
- 唯一出网 = 用户配置的 LLM 接口
- 记忆本机 SQLite、API Key 本机配置、度量仅哈希不出网

### STEP-5.2 随包发布
- 路线 A（Gitee 仅反馈，不托管文件）：`PRIVACY.md` 放在对象存储落地页（路线 B）或你自己的站点，与直链并列。
- 路线 B：放到落地页，与直链并列。

### STEP-5.3 应用内可达（同 STEP-3.2 的「隐私白皮书」链接）
已通过 `{隐私地址}` 锚点实现；若想要离线版，可加一个按钮用 `shell.openExternal('file://' + path.join(app.getPath('userData'), '..', 'PRIVACY.md'))` 打开本地副本（需主进程桥，复用现有 `electronAPI`，不加新通道）。

### STEP-5.4 自证素材（增强信任）
建议附一张「进程除 LLM 域名外零外联」的防火墙/任务管理器截图，放进下载页或 PRIVACY.md §5。闭源下这是信任命门。

---

## Done 标准（勾满即解锁发版）

- [ ] P0-3：设置面板有「检查更新」按钮，点击系统浏览器打开下载页（零新增 IPC）
- [ ] P0-5：`PRIVACY.md` 已随发布仓库/落地页可见，且应用内有可达链接
- [ ] 主进程 `will-navigate` 拦截已加，外部链接不再在应用内导航
- [ ] 手动验证三步通过，tsc 编译通过，sprite 全量测试无回归

> 这两块做完，P0 清单仅剩 P0-1（构建产物已存在）、P0-2（错误日志+自检）、P0-4（冒烟测试）、⚠️A1（冷启动召回，数据驱动延后）——其中 P0-2/P0-4 为验证类动作，A1 按决策红线延后。即可进入「发版测试」。
