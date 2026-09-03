/**
 * [ASK] 提问契约解析器 — 单一真理源（2026-09-03 T1 下沉）
 *
 * 内核 loop（运行时提问提取）与宿 main 端 webview（重放/复制清洗）共用同一份实现的
 * 浏览器安全纯函数：零 Node 依赖、零状态，可按需被 esbuild 内联进浏览器 bundle。
 * 行级格式契约（与角色包注入指令一致，见 strategyResolver）：
 *   - 行首 `[ASK]`（可多条）即问题行，可多条；问题至行尾
 *   - 行尾花括号 `{A|B|C}`（全半角括号、`|`/`｜` 分隔均可）声明候选选项；
 *     仅括号内含分隔符才解析为选项，避免将正文普通花括号字面量（如示例代码）误判吞掉
 */

/** 解析出的提问条目（轻量结构；内核侧消费时补溯源字段 slot，见 loop.extractAskQuestions） */
export interface ParsedAskQuestion {
  /** 问题文本（已剥离行内选项声明） */
  question: string;
  /** 候选选项（`{A|B|C}` 拆分；无则缺省） */
  options?: string[];
}

/**
 * 从正文提取结构化提问列表（无 [ASK] 行返回空数组）
 *
 * @param text 待解析全文（assistant 段原始文本）
 * @returns 解析出的提问列表
 */
export function parseAskQuestions(text: string): ParsedAskQuestion[] {
  const questions: ParsedAskQuestion[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = /^\[ASK\][\s:：]*(.+)$/i.exec(trimmed);
    if (match && match[1]?.trim()) {
      let questionText = match[1].trim();
      let options: string[] | undefined;
      // 行内选项解析：捕获行尾花括号内容，仅当内含分隔符时按选项拆分
      const optMatch = /^(.*?)\s*[｛{](.+)[｝}]\s*$/.exec(questionText);
      if (optMatch && /[|｜]/.test(optMatch[2]!)) {
        const resolved = optMatch[1]!.trim();
        if (resolved.length > 0) {
          // 仅当括号前还有问题文本才拆分为选项，否则整行按普通问题处理
          questionText = resolved;
          options = optMatch[2]!
            .split(/[|｜]/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        }
      }
      questions.push({
        question: questionText,
        ...(options && options.length > 0 ? { options } : {}),
      });
    }
  }
  return questions;
}

/**
 * 剔除正文中的 [ASK] 契约行（展示/复制用：防提问与选择题双重展示、防契约噪声混入复制）
 *
 * 判定口径与 parseAskQuestions 对齐但更宽：凡是行首 `[ASK]` 的行（含无正文的裸契约行）
 * 一律剔除，其余行原样保留；不做 trim（是否收尾空白由调用方决定，保证 markdown 原样恢复）。
 *
 * @param text 原文全文
 * @returns 剔除 [ASK] 行后的正文
 */
export function stripAskLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !/^\s*\[ASK\][\s:：]*/i.test(l.trim()))
    .join('\n');
}
