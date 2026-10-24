/**
 * 命令：登记作品投影（右键文件即登记，LLM 自动生成一句话描述）
 *
 * 极简触发器：不在宿主侧维护「作品清单编辑 UI」，登记动作只做三件事——
 * 读文件（按上限裁切）→ 让模型生成描述 → 交给内核 `agent.works.registerWork` 落库。
 *
 * 从 extension.ts 外置而来（零行为变更）：提示语、降级兜底与执行顺序逐字保留——
 * 这些文案是用户已见过的回执，改一个字都算行为变化。
 */
import * as vscode from 'vscode';
import type { Agent } from '@zooique/memora';
import { accumulateStream } from '@zooique/memora';
import { toNoticeText } from '../host/noticeText.js';

/**
 * 文件内容裁切上限：超长文件只取头部
 *
 * 内容只用于「生成一句话描述」，不是注入上下文，故按字符数而非 token 预算裁切。
 */
const DESCRIPTION_MAX_INPUT_CHARS = 8000;

/**
 * 输出 token 上限：推理模型（R1/QwQ）需预留 reasoning_content 预算，过小会导致 content 空
 */
const DESCRIPTION_MAX_TOKENS = 4096;

/**
 * 登记作品投影
 *
 * @param uri 右键菜单传入的目标（文件 / 多选数组 / 命令面板调用时为 undefined）
 * @param tryGetAgent 取当前工作区 Agent（**失败返 null 不抛错**：装配失败时本命令只提示
 *   「未就绪」，与其余命令同一口径；工作区根的回退规则由该闭包统一持有，本命令不重算）
 * @param output 输出通道（LLM 原始返回与降级原因留痕，用户报障时唯一可查的面）
 */
export async function registerWorkCommand(
  uri: vscode.Uri | vscode.Uri[] | undefined,
  tryGetAgent: () => Promise<Agent | null>,
  output: vscode.OutputChannel,
): Promise<void> {
  // 仅支持从右键菜单触发（必须带 uri 参数）
  const uris = Array.isArray(uri) ? uri : uri ? [uri] : [];
  if (uris.length === 0) {
    vscode.window.showWarningMessage('请在文件上右键，选择「Memora: 登记作品投影」');
    return;
  }

  // 提取第一个文件路径
  const targetUri = uris[0];
  const relativePath = vscode.workspace.asRelativePath(targetUri);

  // 显示进度
  vscode.window.showInformationMessage('正在登记：' + relativePath + ' ...');

  // 装配路径与其余命令同源：tryGetAgent 内部持有 workspacePath（首根 / 未开工作区的回退）
  const agent = await tryGetAgent();
  if (!agent?.works) {
    vscode.window.showWarningMessage('Memora Agent 未就绪，无法登记作品');
    return;
  }

  try {
    // 读取文件内容（按上限裁切，超长文件仅取头部并标注，保持上下文足够且成本可控）
    const fileContent = await vscode.workspace.fs.readFile(targetUri);
    const fullText = Buffer.from(fileContent).toString('utf-8');
    const truncated = fullText.length > DESCRIPTION_MAX_INPUT_CHARS;
    const text =
      (truncated ? fullText.substring(0, DESCRIPTION_MAX_INPUT_CHARS) : fullText) +
      (truncated
        ? `\n\n（以下仅文件开头前 ${DESCRIPTION_MAX_INPUT_CHARS} 字符，内容可能不完整）`
        : '');

    // 调用 LLM 生成一句话描述
    // prompt 显式传入文件名 + 禁止复述标题，迫使模型提炼要点而非回声文件名
    const baseNameHint = relativePath.split(/[\\/]/).pop() ?? '';
    const prompt =
      `文件名：${baseNameHint}\n` +
      `请用一句话（不超过 25 字）概括该文件的核心内容或用途，` +
      `不要简单重复文件名，要提炼它具体讲了什么、解决什么问题或包含哪些要点：\n\n` +
      text;
    let description = '';
    try {
      const raw = await accumulateStream(
        agent.provider,
        [
          { role: 'system', content: '你是文件描述生成器，只输出一句中文描述，不要解释。' },
          { role: 'user', content: prompt },
        ],
        { maxTokens: DESCRIPTION_MAX_TOKENS },
      );
      // 诊断日志：区分"模型返回空"与"返回纯空白被 trim 掉"
      output.appendLine(`[作品投影] LLM 原始返回 len=${raw.length} content=${JSON.stringify(raw)}`);
      description = raw.trim();
    } catch (llmErr) {
      // LLM 调用异常（鉴权/网络/超时）→ 不静默吞：打到输出通道 + 告警，留文件名兜底
      const msg = llmErr instanceof Error ? llmErr.message : String(llmErr);
      output.appendLine(`[作品投影] LLM 生成描述失败：${msg}`);
      vscode.window.showWarningMessage(
        'LLM 生成描述失败（详见 Memora 输出通道），已用文件名兜底：' + msg,
      );
    }

    // 优雅降级：LLM 未返回有效描述时，用文件名（去扩展名）兜底，避免写空 description
    if (!description) {
      description =
        relativePath
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.[^.]+$/, '') ?? 'unknown';
      output.appendLine(`[作品投影] LLM 未返回描述，已用文件名兜底：${description}`);
      vscode.window.showWarningMessage('LLM 未返回描述，已用文件名「' + description + '」兜底');
    } else {
      output.appendLine(`[作品投影] LLM 生成描述：${description}`);
    }

    // 登记投影
    const result = await agent.works.registerWork(relativePath, description);
    if (result) {
      vscode.window.showInformationMessage('作品登记成功：' + result.name + ' | ' + description);
    } else {
      vscode.window.showErrorMessage('作品登记失败，路径可能越界或发生其他错误');
    }
  } catch (err) {
    vscode.window.showErrorMessage('登记失败：' + toNoticeText(err));
  }
}
