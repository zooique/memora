/**
 * 上下文压缩策略接口与实现
 *
 * 对应大厂"微压缩层"设计（如 Claude Code MicroCompact、LangChain Deep Agents Offloading）：
 * 在每轮对话前静默执行，将旧的 tool_result 替换为占位符或卸载到文件系统，
 * 从而在不丢失语义的前提下回收上下文空间。
 */

import type { Message } from '@/llm/provider.js';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * 压缩策略接口（可插拔）
 */
export interface ICompactionStrategy {
  /** 判断是否需要压缩 */
  shouldCompact(messages: readonly Message[]): boolean;

  /** 执行压缩，返回新的消息数组（或原地修改），支持异步（如文件 IO） */
  compact(messages: Message[]): Promise<void> | void;
}

/**
 * 结果替换策略
 *
 * 将旧 tool_result 替换为 "[Previous: used {tool_name}]" 占位符，
 * 仅保留最近 N 次完整结果，兼顾语义与压缩率。
 */
export class ResultReplacementStrategy implements ICompactionStrategy {
  private readonly keepRecent: number;

  /**
   * @param keepRecent 保留最近多少次工具调用的完整结果（默认 3）
   */
  constructor(keepRecent: number = 3) {
    this.keepRecent = keepRecent;
  }

  /** @inheritdoc */
  shouldCompact(messages: readonly Message[]): boolean {
    const toolResultCount = messages.filter((m) => m.role === 'tool').length;
    return toolResultCount > this.keepRecent;
  }

  /**
   * 执行压缩：将旧的 tool_result 替换为占位符
   *
   * 算法：
   * 1. 收集所有 tool 角色的消息（即 tool_result）
   * 2. 构建 tool_use_id -> tool_name 映射（从 assistant 消息中的 toolCalls）
   * 3. 将除最近 N 个外的所有 tool_result 替换为 "[Previous: used {tool_name}]"
   */
  compact(messages: Message[]): void {
    // 1. 收集所有工具结果消息（role === 'tool'）
    const toolResults: Message[] = [];
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolCallId) {
        toolResults.push(msg);
      }
    }

    // 如果工具结果数量 <= 保留阈值，无需压缩
    if (toolResults.length <= this.keepRecent) {
      return;
    }

    // 2. 构建工具调用 ID -> 工具名称的映射
    //    从 assistant 消息中的 toolCalls 提取
    const toolNameMap = new Map<string, string>();
    for (const msg of messages) {
      if (msg.role === 'assistant' && msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          toolNameMap.set(tc.id, tc.function.name);
        }
      }
    }

    // 3. 确定需要替换的工具结果（除了最近 N 个）
    const toReplace = toolResults.slice(0, -this.keepRecent);

    // 4. 执行替换
    for (const resultMsg of toReplace) {
      const toolName =
        toolNameMap.get(resultMsg.toolCallId!) ?? 'unknown';
      // 关键：保留工具名以维持语义连贯性，替换完整内容
      resultMsg.content = `[Previous: used ${toolName}]`;
    }
  }
}

/**
 * 卸载式压缩策略（Offloading Strategy）
 *
 * 对应大厂"卸载压缩"设计（如 LangChain Deep Agents）：
 * 将超大的 tool_result（如 > 20K tokens）写入文件系统，
 * 用"文件路径 + 预览"替换原始内容，实现上下文卸载。
 *
 * 优势：
 * - 彻底回收超大输出的上下文空间（如读大文件、执行长日志命令）
 * - 保留工具名和文件路径，LLM 可通过 read_file 等工具重新获取内容
 * - 不破坏语义连贯性，占位符包含足够的上下文信息
 */
export class OffloadCompactionStrategy implements ICompactionStrategy {
  private readonly offloadDir: string;
  private readonly thresholdTokens: number;
  private readonly previewChars: number;
  
  /**
   * 文件系统操作接口（便于测试和扩展）
   */
  private readonly fsOps: {
    mkdir: typeof mkdir;
    writeFile: typeof writeFile;
  };

  /**
   * @param offloadDir 卸载文件存储目录（默认 ~/.memora/outputs/）
   * @param thresholdTokens 卸载阈值（tokens，默认 20000，约 80000 字符）
   * @param previewChars 预览字符数（默认 1000）
   * @param fsOps 自定义文件系统操作（可选，用于测试或自定义存储）
   */
  constructor(
    offloadDir: string = path.join(process.env.HOME ?? process.cwd(), '.memora', 'outputs'),
    thresholdTokens: number = 20_000,
    previewChars: number = 1_000,
    fsOps?: { mkdir?: typeof mkdir; writeFile?: typeof writeFile },
  ) {
    this.offloadDir = offloadDir;
    this.thresholdTokens = thresholdTokens;
    this.previewChars = previewChars;
    // 允许注入自定义 fs 操作，默认使用 node:fs/promises
    this.fsOps = {
      mkdir: fsOps?.mkdir ?? mkdir,
      writeFile: fsOps?.writeFile ?? writeFile,
    };
  }

  /** @inheritdoc */
  shouldCompact(messages: readonly Message[]): boolean {
    // 检查是否有超大的工具结果
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolCallId) {
        const tokens = estimateTokens(msg.content);
        if (tokens > this.thresholdTokens) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * 执行卸载：将超大 tool_result 写入文件系统，用路径+预览替换
   *
   * 算法：
   * 1. 遍历所有 tool 消息，找到超过阈值的
   * 2. 确保卸载目录存在
   * 3. 为每个超大结果生成唯一文件名，异步写入文件
   * 4. 替换消息内容为"文件路径 + 前 N 字符预览"
   */
  async compact(messages: Message[]): Promise<void> {
    // 1. 收集需要卸载的工具结果
    const toOffload: Array<{ msg: Message; originalTokens: number }> = [];
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolCallId) {
        const tokens = estimateTokens(msg.content);
        if (tokens > this.thresholdTokens) {
          toOffload.push({ msg, originalTokens: tokens });
        }
      }
    }

    if (toOffload.length === 0) {
      return;
    }

    // 2. 确保卸载目录存在
    try {
      await this.fsOps.mkdir(this.offloadDir, { recursive: true });
    } catch {
      // 如果目录创建失败（如权限问题），降级为预览截断，不阻塞主流程
      this.fallbackTruncation(toOffload);
      return;
    }

    // 3. 为每个超大结果生成唯一路径并异步写入
    //    使用 Promise.allSettled 确保即使部分文件写入失败，其他的也能正常处理
    const writeResults = await Promise.allSettled(
      toOffload.map(({ msg, originalTokens }) => {
        const uniqueId = randomBytes(4).toString('hex');
        const fileName = `${Date.now()}_${msg.toolCallId}_${uniqueId}.txt`;
        const filePath = path.join(this.offloadDir, fileName);

        return this.fsOps.writeFile(filePath, msg.content, 'utf-8').then(() => ({
          msg,
          originalTokens,
          filePath,
          success: true,
        }));
      }),
    );

    // 4. 根据写入结果替换内容
    for (const result of writeResults) {
      if (result.status === 'fulfilled' && result.value) {
        const { msg, originalTokens, filePath } = result.value;
        // 成功写入：替换为路径 + 预览
        const preview = msg.content.slice(0, this.previewChars);
        const truncatedChars = msg.content.length - this.previewChars;
        msg.content =
          `[输出已卸载至: ${filePath}]\n` +
          `[预估 Token: ${originalTokens}]\n` +
          `[预览 (前 ${this.previewChars} 字符):]\n` +
          `${preview}...\n` +
          `[省略 ${truncatedChars} 字符，如需完整内容请使用 read_file 工具读取上述路径]`;
      } else {
        // 写入失败：降级为截断
        const { msg, originalTokens } = toOffload[writeResults.indexOf(result)]!;
        const preview = msg.content.slice(0, this.previewChars);
        const truncatedChars = msg.content.length - this.previewChars;
        msg.content =
          `[输出过大，已截断 (预估 ${originalTokens} tokens)]\n` +
          `[预览 (前 ${this.previewChars} 字符):]\n` +
          `${preview}...\n` +
          `[省略 ${truncatedChars} 字符，部分信息可能丢失]`;
      }
    }
  }

  /**
   * 降级方案：当文件系统不可用时（如权限问题），采用简单截断
   *
   * 作为最后的安全兜底，确保即使 IO 失败也能回收空间。
   */
  private fallbackTruncation(
    toOffload: Array<{ msg: Message; originalTokens: number }>,
  ): void {
    for (const { msg, originalTokens } of toOffload) {
      const preview = msg.content.slice(0, this.previewChars);
      const truncatedChars = msg.content.length - this.previewChars;
      msg.content =
        `[输出过大，已截断 (预估 ${originalTokens} tokens)]\n` +
        `[预览 (前 ${this.previewChars} 字符):]\n` +
        `${preview}...\n` +
        `[省略 ${truncatedChars} 字符，部分信息可能丢失]`;
    }
  }
}

/**
 * 简单 Token 估算工具（chars/4 启发式，无需第三方 tokenizer）
 *
 * 与 Claude Code 的 approach 一致：4 字符 ≈ 1 token（中文约 1.5-2 token/字，
 * 英文约 0.75 token/word，取折中值 4 字符/token 足够保守）。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
