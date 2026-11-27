/**
 * 从按轮分桶的流式正文里扣除 `narrate.withdrawn`（§6.4.1 第二真源漂移修复）
 *
 * 契约真源 = 内核 `observeExecutionChunk`：`withdrawn` 是最近追加正文的后缀，
 * 仅后缀匹配时扣除；不匹配时忽略（宁可多留一段叙述，也不误删真实答案）。
 * 宿主不重判文本分类——分类与撤回裁定都在内核，这里只搬运已裁定的事实，
 * 让 live 投影与远程富增量共用同一份正文口径。
 *
 * 纯函数、零 DOM 副作用，落在 `webview/helpers/` 以便宿主侧与桥侧共用判据。
 */
export function withdrawLiveText(
  textByRound: Map<string, string>,
  roundId: string | undefined,
  withdrawn: string,
): void {
  if (!roundId || withdrawn.length === 0) return;
  const current = textByRound.get(roundId);
  if (!current?.endsWith(withdrawn)) return;
  textByRound.set(roundId, current.slice(0, current.length - withdrawn.length));
}
