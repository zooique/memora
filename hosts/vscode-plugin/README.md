# Memora Doc Review

用 AI 把项目设计文档**打磨到自洽**，再动手写代码——在 IDE 侧边栏里做，消灭"反复拉扯代码导致一团乱"。

本插件是 [memora](https://gitee.com/zooique/memora) 内核的 VS Code 宿主，薄壳装配，复用内核全部能力。

---

## 功能

- **文档打磨**：打开侧边栏，和 AI 一起把设计文档聊到自洽
- **跨会话记忆**：记得你之前定过的决策，新会话自动召回
- **主动提问**：关键节点 AI 会停下来问你，不闷头写偏
- **文档自洽检查**：一键审阅当前文档的矛盾 / 缺口 / 悬空引用
- **代码骨架生成**：自洽通过后，根据设计文档一键生成代码骨架
- **网络搜索**：Agent 可联网查资料（Bing → DuckDuckGo 降级）
- **多模型配置**：可添加多个大模型 API，随时切换，支持连接测试

## 安装

### 方式一：从 VSIX 安装（推荐，发给别人用这个）

1. 拿到 `memora-doc-review.vsix` 文件
2. 打开 VS Code / Qoder 扩展面板（`Ctrl+Shift+X`）
3. 点右上角 `...` → **从 VSIX 安装...**（Install from VSIX...）
4. 选择 `memora-doc-review.vsix`，等待安装完成
5. 重启窗口（`Ctrl+Shift+P` → `Reload Window`）

### 方式二：从源码运行（开发调试）

```bash
cd hosts/vscode-plugin
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
4. 打开「文档打磨」面板，开始对话打磨文档

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
| `Memora: 打开设计文档打磨` | 打开侧边栏文档打磨面板 |
| `Memora: 审阅当前文档自洽性` | 审阅激活文档的矛盾/缺口/悬空引用 |
| `Memora: 根据设计文档生成代码骨架` | 生成代码骨架 |
| `Memora: 配置大模型` | 打开大模型配置面板 |

## 数据存储

- 记忆 / 会话 / 检查点存于工作区 `.memora/` 目录
- API Key 存 VS Code 安全存储（SecretStorage），**不会写入 settings.json 或进 git**

## 构建 VSIX

```bash
cd hosts/vscode-plugin
npm run package
```

产物：`memora-doc-review.vsix`

---

**License**: MIT