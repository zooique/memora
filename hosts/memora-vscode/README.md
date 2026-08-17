# Memora

用 AI 打磨设计、沉淀记忆、生成骨架——在 IDE 侧边栏里做，消灭"反复拉扯代码导致一团乱"。

本插件是 [memora](https://gitee.com/zooique/memora) 内核的 **VS Code 通用落地宿主**：薄壳装配，复用内核全部能力；功能定位由**内置角色包**承载（出厂自带「文档打磨」角色），插件本身不硬编码任何定位。

---

## 功能

- **通用对话**：打开侧边栏与 AI 对话，定位由角色包决定
- **跨会话记忆**：记得你之前定过的决策，新会话自动召回
- **主动提问**：关键节点 AI 会停下来问你，不闷头写偏
- **角色包定位（出厂自带 doc-review）**：
  - **文档自洽检查**：在对话中让 AI 审阅文档的矛盾 / 缺口 / 悬空引用
  - **代码骨架生成**：自洽通过后，根据设计文档让 AI 生成代码骨架
- **网络搜索**：Agent 可联网查资料（Bing → DuckDuckGo 降级）
- **多模型配置**：可添加多个大模型 API，随时切换，支持连接测试

## 安装

### 方式一：从 VSIX 安装（推荐，发给别人用这个）

1. 拿到 `memora-vscode.vsix` 文件
2. 打开 VS Code / Qoder 扩展面板（`Ctrl+Shift+X`）
3. 点右上角 `...` → **从 VSIX 安装...**（Install from VSIX...）
4. 选择 `memora-vscode.vsix`，等待安装完成
5. 重启窗口（`Ctrl+Shift+P` → `Reload Window`）

### 方式二：从源码运行（开发调试）

```bash
cd hosts/memora-vscode
npm install
npm run compile
```

按 `F5` 启动 Extension Development Host 调试。

## 使用

1. 打开项目工作区（要有 `.md` 设计文档）
2. 点击左侧活动栏的 **Memora** 图标
3. 首次使用，先到「大模型配置」添加你的模型：
   - 点「添加 API」→ 填别名 / 模型 / Base URL / API Key
   - 点「测试连接」验证 → 保存 → 「设为当前」
   - 支持添加多个，随时切换
4. 打开「对话」面板，开始对话（标题旁徽章显示当前角色 `doc-review`）
   - 说"请对当前文档做自洽性审阅" → 触发自洽检查
   - 说"请基于设计文档生成代码骨架" → 触发骨架生成

### 不用配置面板（环境变量方式）

插件回退读取环境变量，设好后**重启 VS Code** 生效：

```bash
set MEMORA_BASE_URL=https://api.deepseek.com/v1
set MEMORA_MODEL=deepseek-chat
set MEMORA_API_KEY=你的key
```

已有环境变量配置的，无需走配置面板，优先级：**配置面板激活 Provider > 环境变量**。

## 命令

| 命令 | 说明 |
|------|------|
| `Memora: 打开对话面板` | 打开侧边栏对话面板（角色包承载定位） |
| `Memora: 配置大模型` | 打开大模型配置面板 |

## 数据存储

插件数据分**项目级 / 用户级**两级存储（插件定义行为，全部走 VS Code 原生机制，不额外创建用户目录文件夹）：

| 层级 | 位置 | 内容 |
|------|------|------|
| 项目级 | 工作区 `.memora/` 目录 | 会话记录 `sessions.json` / 记忆 `memories.json` / 会话检查点（一个项目一份，随项目走） |
| 用户级 | VS Code 用户设置 `settings.json` | 大模型 Provider 配置（别名 / 模型 / Base URL，**不含 API Key**） |
| 用户级 | VS Code 全局存储 `globalStorage` | 激活角色包（跨项目共享） |
| 用户级 | VS Code 安全存储 `SecretStorage` | API Key（加密存储） |

补充说明：

- **项目级 `.memora/`**：一个项目一份记忆，随项目工作区走（可提交或忽略由你决定）。
- **用户级配置**在 VS Code 用户数据目录（Windows：`AppData/Roaming/Code/User/`）。Provider 配置存用户级而非项目级——跨项目共享，切换项目无需重配，且不污染项目 `.vscode/settings.json`。
- **API Key 存 SecretStorage（VS Code 加密存储）**：不会写入 settings.json 或进 git。**找不到明文文件是正常的安全设计**，密钥本就不该以明文落盘。
- 若此前旧版本把 Provider 配置写进了项目 `.vscode/settings.json`，插件启动时会自动迁移到用户级并清理残留。

## 构建 VSIX

```bash
cd hosts/memora-vscode
npm run package
```

产物：`memora-vscode.vsix`（compile 前自动清理 dist，杜绝旧产物残留）

---

**License**: MIT
