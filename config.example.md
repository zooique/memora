# Memora · 配置文件示例

> 复制本文件到 `~/.memora/config.json`（用户级）或
> `<项目>/.memora/config.json`（项目级）即可。

## 完整配置（DeepSeek 示例）

```json
{
  "llm": {
    "provider": "deepseek",
    "model": "deepseek-chat",
    "apiKey": "${MEMORA_LLM_API_KEY}",
    "baseUrl": "https://api.deepseek.com/v1",
    "temperature": 0.7
  },
  "memory": {
    "dataDir": "~/.memora",
    "maxContextTokens": 120000
  },
  "security": {
    "permission": "owner",
    "confirmWrites": false
  },
  "allowedPaths": ["${HOME}/projects"]
}
```

## 字段说明

| 字段                      | 类型       | 必填          | 默认          | 说明                                                       |
| ------------------------- | ---------- | ------------- | ------------- | ---------------------------------------------------------- |
| `llm.provider`            | enum       | 否            | `mock`        | `deepseek` / `doubao` / `openai` / `mock`（mock 用于测试） |
| `llm.model`               | string     | 否            | provider 默认 | 模型名，如 `deepseek-chat` / `gpt-4o-mini`                 |
| `llm.apiKey`              | string     | 真实 LLM 必填 | —             | 推荐 `${MEMORA_LLM_API_KEY}` 占位符                        |
| `llm.baseUrl`             | string     | 否            | provider 默认 | OpenAI 兼容端点                                            |
| `llm.temperature`         | number 0-2 | 否            | `0.7`         | 温度                                                       |
| `memory.dataDir`          | string     | 否            | `~/.memora`   | 记忆文件 + SQLite 数据库目录                               |
| `memory.maxContextTokens` | number     | 否            | `120000`      | 单次上下文最大 token 数                                    |
| `security.permission`     | enum       | 否            | `owner`       | `owner` / `guest`                                          |
| `security.confirmWrites`  | boolean    | 否            | `false`       | owner 模式下写入前是否需要确认                             |
| `allowedPaths`            | string[]   | 否            | `[]`          | 工具可访问的额外白名单路径                                 |

## Provider 默认 baseUrl

| provider   | baseUrl                                    | 默认模型         |
| ---------- | ------------------------------------------ | ---------------- |
| `deepseek` | `https://api.deepseek.com/v1`              | `deepseek-chat`  |
| `doubao`   | `https://ark.cn-beijing.volces.com/api/v3` | `doubao-pro-32k` |
| `openai`   | `https://api.openai.com/v1`                | `gpt-4o-mini`    |
| `mock`     | —                                          | `mock-model`     |

## 环境变量占位符

`apiKey` / `baseUrl` / `allowedPaths` 字段支持 `${ENV_VAR}`
占位符，加载配置时自动展开为环境变量值。

**为什么用占位符？**
避免把密钥提交到 Git。配置可以公开分享，密钥通过环境变量注入。

```json
{
  "llm": {
    "provider": "deepseek",
    "apiKey": "${MEMORA_LLM_API_KEY}"
  }
}
```

```bash
# Linux / macOS
export MEMORA_LLM_API_KEY="sk-xxxxxxxx"

# Windows PowerShell
$env:MEMORA_LLM_API_KEY = "sk-xxxxxxxx"
```

## 配置加载优先级

1. `--config <path>` 命令行参数
2. `<cwd>/.memora/config.json`（项目级）
3. `~/.memora/config.json`（用户级）
4. 内置默认值

详见 [src/config/loader.ts](../src/config/loader.ts)。
