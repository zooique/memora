# Memora ↔ 泊文 宿主对接方案

> 解决两个独立项目之间的依赖管理、开发联调、打包发布问题。

---

## 一、现状诊断

### 1.1 当前引用方式

泊文通过硬编码相对路径引用 memora：

```javascript
// src/main/memora.js（当前）
export { Agent } from '../../../memora/dist/index.js';
export { createLlmProvider } from '../../../memora/dist/llm/factory.js';
```

**风险**：

| 问题                               | 影响                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 路径写死                           | 换目录就崩，团队成员路径不同就崩                                                                                                    |
| 依赖 `dist/`                       | 必须先手动 `npm run build`，忘记编译就跑旧代码                                                                                      |
| 打包不进 asar                      | Electron Builder 不跟随相对路径，打包后运行时找不到模块                                                                             |
| ~~`createLlmProvider` 签名不匹配~~ | ~~该函数接收 `Config` 类型（含 `llm` 嵌套），泊文应使用 `createLlmProvider`（接收扁平 `ProviderConfig`）~~ 已修正：当前代码写法正确 |

### 1.2 API 版本

泊文的 `memoraService.js` 已适配 v2.0 API（`provider` 参数），但
`createProvider()` 的调用方式有误：

```javascript
// 当前（正确）：createLlmProvider 接收包含 llm 字段的 Config 对象
return createLlmProvider({
  llm: {
    provider: providerName,
    model: model.model,
    baseUrl: model.baseUrl,
    apiKey: model.apiKey,
  },
});
```

当前代码已经是正确的写法，无须修改。

---

## 二、目标架构

```
┌─ memora（内核库）─────────────────────────────────┐
│  npm package：name="memora", version="0.1.0"      │
│  入口：dist/index.js（ESM）                        │
│  导出：Agent, createLlmProvider, createProvider…   │
└────────────────────────────────────────────────────┘
              │
              │ npm link（开发）/ npm install（发布后）
              │
┌─ bowen-reader（宿主）──────────────────────────────┐
│  Electron 应用                                      │
│  import { Agent, createLlmProvider } from    │
│    'memora'                                         │
│  唯一耦合点：src/main/memora.js                     │
└────────────────────────────────────────────────────┘
```

---

## 三、实施步骤

### 步骤 1：memora 侧 — 确保可被 npm link

memora 的 `package.json` 已经配置正确：

```json
{
  "name": "memora",
  "main": "./dist/index.js",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  }
}
```

**操作**：

```powershell
# 1. 编译 dist/
cd F:\zooique\memora
npm run build

# 2. 全局注册（创建符号链接）
npm link
```

验证：

```powershell
npm list -g memora
# 应输出：memora@0.1.0
```

### 步骤 2：bowen-reader 侧 — 链接 memora

```powershell
cd F:\zooique\bowen-reader
npm link memora
```

验证：

```powershell
# 检查符号链接是否创建
dir node_modules\memora
# 应该是一个指向 F:\zooique\memora 的符号链接
```

### 步骤 3：修改 `src/main/memora.js`

```javascript
// 改前：硬编码相对路径
export { Agent } from '../../../memora/dist/index.js';
export { createLlmProvider } from '../../../memora/dist/llm/factory.js';

// 改后：标准包名（npm link 后 node_modules/memora 指向本地源码）
export { Agent, createLlmProvider } from 'memora';
```

### 步骤 4：确认 `memoraService.js` 的 `createProvider()`

当前代码已经是正确的写法，无须修改：

```javascript
import { Agent, createLlmProvider } from './memora.js';

function createProvider(model) {
  const providerName = model.provider || 'openai-compatible';
  return createLlmProvider({
    llm: {
      provider: providerName,
      model: model.model,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
    },
  });
}
```

### 步骤 5：验证联调

```powershell
# 1. 确认 memora 已编译
cd F:\zooique\memora
npm run build

# 2. 启动泊文
cd F:\zooique\bowen-reader
npm start
```

在泊文中测试：

- 发送一条消息 → 确认 LLM 正常响应（不是 Mock 响应）
- 切换模型 → 确认 `switchActiveModel()` 正常
- 打开小说项目 → 确认 `switchProjectContext()` 正常

---

## 四、开发工作流

### 4.1 日常联调

```
1. 修改 memora 源码
2. cd F:\zooique\memora && npm run build     # 重新编译
3. 重启泊文                                    # npm link 自动同步
```

**npm link 的优势**：`node_modules/memora`
是符号链接，指向 memora 源码目录。编译 `dist/`
后，泊文下次 import 就能拿到最新代码，无需重新 `npm link`。

### 4.2 切换 memora 分支

```powershell
cd F:\zooique\memora
git checkout feature/xxx
npm run build
# 泊文自动跟随，无需额外操作
```

### 4.3 回退到 npm 发布版

```powershell
cd F:\zooique\bowen-reader
npm unlink memora              # 解除符号链接
npm install memora@latest      # 安装 npm 发布版
```

---

## 五、Electron 打包配置

### 5.1 核心问题

Electron Builder 默认把 `node_modules/` 打进 asar。但 `npm link`
创建的是符号链接，Builder 可能不跟随。

### 5.2 开发阶段（npm link）

**不需要打包**，直接 `npm start` 运行即可。

### 5.3 发布阶段（npm install）

发布前切换到正式依赖：

```powershell
cd F:\zooique\bowen-reader
npm unlink memora
npm install memora@0.1.0       # 从 npm 安装
```

此时 `node_modules/memora/` 是真实的目录，Builder 正常打包。

### 5.4 本地打包（不发布 npm）

如果暂时不发布 npm，但需要打包 Electron：

```powershell
# 方案 A：手动复制 dist/（推荐）
cd F:\zooique\memora
npm run build
xcopy /E /I dist F:\zooique\bowen-reader\node_modules\memora\dist

# 方案 B：package.json 中配置 extraResources
# bowen-reader/package.json
{
  "build": {
    "extraResources": [
      {
        "from": "../memora/dist",
        "to": "node_modules/memora/dist"
      }
    ]
  }
}
```

### 5.5 sqlite3 原生模块

memora 依赖 `sqlite3`（C++ 原生扩展），Electron 打包需要特殊处理：

```powershell
# 为 Electron 重新编译原生模块
cd F:\zooique\bowen-reader
npx electron-rebuild
```

`package.json` 中已有 `asarUnpack: ["**/*.node"]`，确保 `.node`
文件不被 asar 压缩。

---

## 六、两个函数的选择指南

| 函数                        | 签名                                | 适用场景                                 |
| --------------------------- | ----------------------------------- | ---------------------------------------- |
| `createLlmProvider(config)` | 接收 `Config` 类型（含 `llm` 嵌套） | 从 `memora.json` 配置文件加载后调用      |
| `createLlmProvider(config)` | 接收包含 `llm` 字段的 `Config` 对象 | 宿主自行组装配置后调用（**泊文用这个**） |

泊文场景：用户在设置面板填写 apiKey/baseUrl/model → 宿主直接组装扁平配置 → 调用
`createLlmProvider`。不需要经过 `memora.json`。

---

## 七、故障排查

| 现象                                | 原因                           | 解决                                                              |
| ----------------------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `Cannot find module 'memora'`       | npm link 未生效                | `cd memora && npm link` 然后 `cd bowen-reader && npm link memora` |
| `Mock 响应`                         | Provider 创建失败，回退到 mock | 检查 apiKey 是否传入，检查 `createLlmProvider` 参数格式           |
| `config is not a valid AgentOption` | 使用了 v1.0 的 `config` 参数   | 改用 `provider` 参数（v2.0 API）                                  |
| 打包后运行报 `Cannot find module`   | 符号链接未被 asar 跟随         | 发布前 `npm unlink && npm install memora`                         |
| `sqlite3.node` 加载失败             | 原生模块未为 Electron 重编译   | `npx electron-rebuild`                                            |
| 修改 memora 后泊文没变化            | 忘记 `npm run build`           | memora 改代码后必须重新编译 dist/                                 |

---

## 八、检查清单

对接完成后逐项验证：

- [ ] `npm link memora` 成功，`node_modules/memora` 指向本地源码
- [ ] `import { Agent } from 'memora'` 不报错
- [ ] `createLlmProvider()` 正确创建 Provider
- [ ] `new Agent({ provider })` 初始化成功
- [ ] `agent.chat()` 返回真实 LLM 响应（非 Mock）
- [ ] `agent.switchProject()` 切换项目上下文正常
- [ ] `agent.switchActiveModel()` 切换模型正常
- [ ] `agent.setWriteExtensions()` diff 确认回调正常
- [ ] `agent.listPersonas()` 返回 agent-config/personas/ 下的角色
- [ ] `agent.searchMemories()` 记忆搜索正常
