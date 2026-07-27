#!/usr/bin/env node
/**
 * Memora Sprite CLI 入口
 *
 * 职责：
 * - 交互式 LLM 配置引导（setupWizard）
 * - CLI 命令路由（/memories、/config、/dashboard 等）
 * - REPL 主循环
 *
 * 从 src/index.ts 拆分，CLI 逻辑与库导出完全分离。
 * 非 CLI 场景（如 Electron 宿主）直接 import src/index.ts 的导出函数，
 * 不会加载 CLI 代码。
 */
import { resolve } from 'node:path';
// safeWriteJson 统一 JSON 写入 + 0o600 权限保护（ADR-017 枝叶层 2 次提取）
import { safeWriteJson } from './shared/safeWriteJson.js';
import { createInterface } from 'node:readline';
import type { Interface } from 'node:readline';
import type { Agent, Config } from 'memora';
import { toError } from 'memora';
import { startSprite } from './index.js';
import { DEFAULT_CONFIG_PATH } from './storage/spriteConfigStore.js';
import type { Sprite, SpriteConfigKey } from './index.js';
import { CliInteraction } from './sprite/cli/interaction.js';
import type { IInteraction } from './sprite/interaction.js';

// ─── 首次启动引导 ──────────────────────────────────────

/** 交互式提问 */
function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * 首次启动引导
 *
 * 交互式收集 LLM 配置并保存到 ~/.memora-sprite/config.json
 */
async function setupWizard(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n=== Memora Sprite 首次启动 ===\n');
  console.log('请配置 LLM 提供商（任何 OpenAI 兼容端点）：');

  // 单一自定义入口：不内置预设，避免模型/厂商迭代后预设迅速过时
  // 用户决策已确认：LLM Provider configuration must use a single custom entry
  const provider = await ask(rl, '\n提供商名称（如 openai、deepseek、自定义）：');
  const model = await ask(rl, '模型名称（如 deepseek-chat、gpt-4o、claude-3-opus）：');
  const baseUrl = await ask(rl, 'API 地址（如 https://api.deepseek.com）：');

  const providerConfig = { provider, model, baseUrl };
  console.log(`\n已选择：${providerConfig.provider} / ${providerConfig.model}`);

  const apiKey = await ask(rl, '\n请输入 API Key：');

  if (!apiKey) {
    console.error('\n错误：API Key 不能为空');
    rl.close();
    process.exit(1);
  }

  // ── 可选：Embedding 配置（启用语义召回） ──
  console.log('\n── Embedding 配置（可选） ──');
  console.log('配置后启用语义搜索（向量召回），让记忆搜索更智能。');
  console.log('Embedding API 与 Chat API 独立，可使用不同提供商。');
  console.log('常见选项：');
  console.log('  - OpenAI text-embedding-3-small（$0.02/1M tokens）');
  console.log('  - 硅基流动 BAAI/bge-large-zh-v1.5（免费）');
  console.log('  - Ollama 本地 bge-m3（完全免费，需安装 Ollama）');
  console.log('  - 与 Chat 相同的提供商（如果支持 /embeddings 端点）');

  let embedding: Config['embedding'];
  const wantEmbedding = await ask(rl, '\n是否配置 Embedding？[y/N]：');
  if (wantEmbedding.toLowerCase() === 'y' || wantEmbedding.toLowerCase() === 'yes') {
    const useSameAsChat = await ask(rl, '复用 Chat 的 baseUrl 和 apiKey？[Y/n]：');
    let embBaseUrl: string;
    let embApiKey: string;
    if (useSameAsChat.toLowerCase() === 'n' || useSameAsChat.toLowerCase() === 'no') {
      embBaseUrl = await ask(rl, 'Embedding API 地址（如 https://api.siliconflow.cn/v1）：');
      embApiKey = await ask(rl, 'Embedding API Key：');
      if (!embApiKey) {
        console.error('错误：Embedding API Key 不能为空');
        rl.close();
        process.exit(1);
      }
    } else {
      embBaseUrl = providerConfig.baseUrl;
      embApiKey = apiKey;
    }
    const embModel = await ask(rl, 'Embedding 模型名称（如 text-embedding-3-small、BAAI/bge-large-zh-v1.5）：');
    if (!embModel) {
      console.error('错误：Embedding 模型名称不能为空');
      rl.close();
      process.exit(1);
    }
    embedding = { baseUrl: embBaseUrl, apiKey: embApiKey, model: embModel };
  }

  rl.close();

  // 保存配置到 ~/.memora-sprite/config.json（根级，与 data/ 分层）
  const configPath = DEFAULT_CONFIG_PATH;

  const config: Config = {
    llm: {
      provider: providerConfig.provider,
      model: providerConfig.model,
      baseUrl: providerConfig.baseUrl,
      apiKey,
      temperature: 0.7,
    },
    memory: { dataDir: '~/.memora-sprite/data', maxContextTokens: 120000 },
    security: { permission: 'owner', confirmWrites: false },
    allowedPaths: [],
    ...(embedding ? { embedding } : {}),
  };

  // safeWriteJson 统一处理 JSON 写入 + 0o600 权限（防止 apiKey 泄露给同机其他用户）
  await safeWriteJson(configPath, config);
  console.log(`\n配置已保存到：${configPath}`);
  if (embedding) {
    console.log('✅ 已启用语义搜索（向量召回）');
  } else {
    console.log('ℹ️  未配置 Embedding，使用纯关键词召回（后续可手动配置）');
  }
}

// ─── 配置命令辅助 ──────────────────────────────────────

/** CLI /config 命令可配置的键名集合（与帮助文本保持一致） */
const CLI_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'triggerIntervalMs',
  'defaultPersona',
  'silentMode',
  'proactiveThreshold',
  'proactiveCooldownMs',
  'fileWatcherEnabled',
  'fileWatcherPaths',
  'fileWatcherIgnore',
  'fileWatcherDebounceMs',
]);

/**
 * 类型守卫：校验字符串是否为 CLI 可配置的 SpriteConfigKey
 *
 * 替代 `key as never` 类型断言，通过运行时校验 + 类型窄化确保类型安全。
 * 仅允许 CLI 帮助文本中列出的 8 个键名通过，其他键名（如 floatIconPosition、windowState 等）
 * 不通过 CLI /config 命令配置，由各自专属的 UI 操作管理。
 */
function isCliConfigKey(key: string): key is SpriteConfigKey {
  return CLI_CONFIG_KEYS.has(key);
}

// ─── 记忆管理命令 ──────────────────────────────────────

/** 处理 /memories 命令 */
async function handleMemories(args: string, sprite: Sprite): Promise<void> {
  const parts = args.split(/\s+/);
  const sub = parts[0] ?? '';

  if (!sub || sub === 'list') {
    // /memories [source]
    const source = parts[1] || undefined;
    const memories = sprite.listMemories(source);
    if (memories.length === 0) {
      console.log(source ? `没有来源为 "${source}" 的记忆` : '记忆库为空');
      return;
    }
    console.log(`\n记忆列表（${memories.length} 条）${source ? ` · source: ${source}` : ''}:`);
    console.log('─'.repeat(70));
    for (const m of memories) {
      console.log(`[${m.id}]`);
      console.log(`  ${m.name}  ·  ${m.source}  ·  score: ${m.score}`);
      console.log(`  ${m.contentPreview}`);
      console.log('');
    }
    console.log('用法：/memories add <source> <name> <内容> | /memories show <id> | /memories delete <id> | /memories search <关键词>');
    return;
  }

  if (sub === 'show') {
    const id = parts[1];
    if (!id) { console.log('用法：/memories show <id>'); return; }
    const m = sprite.showMemory(id);
    if (!m) { console.log(`记忆 ${id} 不存在`); return; }
    console.log(`\n记忆详情：${m.id}`);
    console.log('─'.repeat(60));
    console.log(`名称：${m.name}`);
    console.log(`来源：${m.source}`);
    console.log(`权重：${m.score}`);
    console.log(`创建时间：${m.createdAt}`);
    console.log(`最近访问：${m.accessedAt}`);
    console.log(`内容：`);
    console.log(m.content);
    console.log('─'.repeat(60));
    return;
  }

  if (sub === 'delete') {
    const id = parts[1];
    if (!id) { console.log('用法：/memories delete <id>'); return; }
    const ok = sprite.deleteMemory(id);
    console.log(ok ? `已删除记忆：${id}` : `记忆 ${id} 不存在`);
    return;
  }

  if (sub === 'search') {
    const query = parts.slice(1).join(' ');
    if (!query) { console.log('用法：/memories search <关键词>'); return; }
    const hits = await sprite.searchMemories(query);
    if (hits.length === 0) { console.log(`未找到与 "${query}" 相关的记忆`); return; }
    console.log(`\n搜索 "${query}" — ${hits.length} 条结果:`);
    console.log('─'.repeat(70));
    for (const h of hits) {
      const simTag = h.similarity !== undefined ? `  ·  相似度: ${(h.similarity * 100).toFixed(0)}%` : '';
      console.log(`[${h.name}]  ·  ${h.source}  ·  score: ${h.score}${simTag}`);
      console.log(`  ${h.contentPreview}`);
      console.log('');
    }
    return;
  }

  if (sub === 'add') {
    const source = parts[1];
    const name = parts[2];
    const content = parts.slice(3).join(' ');
    if (!source || !name || !content) {
      console.log('用法：/memories add <source> <name> <内容>');
      console.log('示例：/memories add insight "React 经验" 用户有 3 年 React 经验');
      return;
    }
    try {
      const id = sprite.upsertMemory(source, name, content);
      console.log(`已添加记忆：${id}`);
    } catch (error) {
      console.log(`添加失败：${toError(error).message}`);
    }
    return;
  }

  console.log(`未知子命令：${sub}`);
  console.log('用法：/memories [list [source]] | add <source> <name> <内容> | show <id> | delete <id> | search <关键词>');
}

// ─── CLI 主循环 ────────────────────────────────────────

/**
 * 启动 CLI 交互循环
 *
 * 使用 CliInteraction（readline）作为交互层，
 * 未来可替换为 Electron IPC 实现。
 */
/**
 * 启动 CLI 交互循环
 *
 * startSprite 不内部调用 setupWizard。
 * CLI 自行处理配置缺失的情况：先尝试启动，失败则引导用户配置后重试。
 */
async function main(): Promise<void> {
  let result: { agent: Agent; sprite: Sprite; close: () => Promise<void> };
  try {
    result = await startSprite();
  } catch {
    // 配置缺失，启动交互式引导
    await setupWizard();
    result = await startSprite();
  }

  const { agent, sprite, close } = result;

  console.log('\nMemora Sprite 已启动（/quit 退出 | /dashboard 仪表盘 | /persona 角色列表 | /switch <名称> 切换角色 | /mode auto|manual 匹配模式 | /web <关键词> 浏览器搜索 | /memories 记忆管理 | /config 配置）\n');

  const interaction: IInteraction = new CliInteraction();

  interaction.onClose(async () => {
    console.log('\n正在关闭…');
    await close();
    process.exit(0);
  });

  interaction.start(async ({ text }) => {
    // 命令路由
    if (text === '/quit') {
      close().then(() => {
        interaction.stop();
        process.exit(0);
      }).catch((err: unknown) => {
        console.error('退出清理失败:', err);
        process.exit(1);
      });
      return;
    }

    if (text === '/dashboard') {
      console.log(sprite.formatDashboard());
      return;
    }

    if (text === '/persona') {
      console.log(sprite.formatPersonas());
      return;
    }

    if (text.startsWith('/switch ')) {
      const name = text.slice(8).trim();
      if (!name) {
        console.log('用法：/switch <角色名称>');
        return;
      }
      const result = sprite.switchPersona(name);
      if (result) {
        console.log(`已切换到角色：${result}`);
      } else {
        console.log(`角色 "${name}" 不存在或角色管理不可用`);
      }
      return;
    }

    if (text.startsWith('/mode')) {
      const modeArg = text.slice(5).trim();
      if (modeArg === 'auto' || modeArg === 'manual') {
        sprite.setPersonaMode(modeArg);
        console.log(`角色匹配模式已切换为：${modeArg}`);
      } else {
        console.log(`当前模式：${sprite.personaMode}`);
        console.log('用法：/mode auto（自动匹配）| /mode manual（手动固定）');
      }
      return;
    }

    if (text.startsWith('/web ')) {
      const query = text.slice(5).trim();
      if (!query) {
        console.log('用法：/web <搜索关键词>');
        return;
      }
      const { webSearch } = await import('./sprite/tools.js');
      const msg = await webSearch(query);
      console.log(msg);
      return;
    }

    if (text.startsWith('/memories')) {
      const args = text.slice(9).trim();
      await handleMemories(args, sprite);
      return;
    }

    if (text === '/config') {
      console.log(sprite.formatConfig());
      return;
    }

    if (text.startsWith('/config ')) {
      const parts = text.slice(8).trim().split(/\s+/);
      if (parts.length < 2) {
        console.log('用法：/config <键名> <值>');
        console.log(`可用键名：${[...CLI_CONFIG_KEYS].join(', ')}`);
        return;
      }
      const [key = '', ...valueParts] = parts;
      const rawValue = valueParts.join(' ');

      if (!isCliConfigKey(key)) {
        console.log(`错误：未知配置键名 "${key}"`);
        console.log(`可用键名：${[...CLI_CONFIG_KEYS].join(', ')}`);
        return;
      }

      let value: unknown;
      if (key === 'silentMode' || key === 'fileWatcherEnabled') {
        value = rawValue === 'true' || rawValue === 'on' || rawValue === '1';
      } else if (key === 'triggerIntervalMs' || key === 'proactiveThreshold' || key === 'proactiveCooldownMs' || key === 'fileWatcherDebounceMs') {
        value = Number(rawValue);
        if (Number.isNaN(value)) {
          console.log(`错误：${key} 需要数字值`);
          return;
        }
      } else if (key === 'fileWatcherPaths' || key === 'fileWatcherIgnore') {
        value = rawValue.split(',').map(s => s.trim()).filter(Boolean);
      } else {
        value = rawValue;
      }

      sprite.updateConfig(key, value);
      console.log(`已更新：${key} = ${JSON.stringify(value)}`);
      return;
    }

    // 对话
    (async () => {
      try {
        for await (const chunk of agent.chat(text)) {
          if (chunk.type === 'text') {
            interaction.output(chunk.content);
          } else if (chunk.type === 'done') {
            interaction.output('\n');
          } else if (chunk.type === 'aborted') {
            console.log(`\n[${chunk.reason}]`);
          }
        }
      } catch (error) {
        console.error('\n对话出错:', error);
      }
    })();
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))
) {
  main().catch(console.error);
}