# Memora Sprite

> 本地 AI 桌面伴侣——能自我进化的记忆精灵

Memora Sprite 是 [Memora](https://gitee.com/zooique/memora) 智能内核的桌面宿主。
它是一个运行在本机的 Electron 应用，连接你自己的 LLM 服务，成为陪伴你工作与思考的 AI 伙伴。

## 能力速览

| 模块 | 说明 |
|---|---|
| 💬 对话 | 接入 DeepSeek / OpenAI / 本地 LLM，对话与记忆持久保存 |
| 🧠 长期记忆 | 跨会话记忆沉淀与智能召回，图谱可视化 |
| 🚀 输入补全 | 基于历史记忆与上下文的对话补全 |
| 👁️ 感知面板 | 实时情感氛围、信任等级、活跃模式分析 |
| 🎭 角色系统 | 切换人格不丢记忆 |
| 📋 快捷记录 | 剪贴板内容一键记录为记忆 / 触发召回 |
| ⚙️ 完全本机 | 零遥测 · 零云备份 · 数据 100% 在本地 |

## 安装

### 下载安装包

从 [Releases](https://gitee.com/zooique/memora/releases) 页面下载 `Memora Sprite Setup x.x.x.exe`，双击安装。

> 当前仅发布 Windows 版本。安装包未做代码签名，系统可能提示「未知发布者」，点击「仍要运行」即可。

### 从源码构建

```bash
# 要求 Node.js >= 24
git clone https://gitee.com/zooique/memora.git
cd memora/hosts/memora-sprite
npm install
npm run build:electron
npm run start:electron
```

## 配置

首次启动后在设置面板填写你的 LLM 配置（服务商、API Key、模型）。支持 OpenAI 兼容接口。

## 隐私

**Memora Sprite 完全运行在本机。** 详细隐私声明见 [PRIVACY.md](../../PRIVACY.md)。

速览：

- 记忆 · 配置 · 对话历史 → 本机 SQLite + JSON
- 唯一联网行为 → 调用你自配的 LLM API
- 零遥测 · 零埋点 · 零第三方分析
- 卸载即数据清除

## 开发

```bash
npm install
npm run dev:electron         # 开发热重载
npm run test                 # 运行测试（4631 项，含覆盖率阈值）
npm run lint                 # 代码检查（ESLint + Stylelint + IPC 校验）
npm run typecheck:electron   # 类型检查
npm run package:win          # 打包 Windows 安装包
```

更多设计文档见 `docs/` 目录。版本历史见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

[MIT](https://gitee.com/zooique/memora/blob/main/LICENSE) · 内核 [@zooique/memora](https://www.npmjs.com/package/@zooique/memora)
