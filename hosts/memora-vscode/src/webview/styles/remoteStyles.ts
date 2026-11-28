/**
 * 远程控制子视图样式（`#remote-root` 前缀隔离）
 *
 * 设计纪律（与 worksStyles / generalStyles 同）：
 *   - 共享类（`.header` / `.hint` / `.btn` 等）的规则必须带本页 root 前缀；
 *     兄弟页有同类规则≠本页有（接线守卫按 root 前缀逐类对拍，缺即红）；
 *   - 只消费 `tokens.ts` 的刻度，不引入一次性裸值；
 *   - 设备行 / 审计行的动作按钮复用 `.btn-ghost` 基类，本页只补布局差异。
 */
export const remoteStyles = `
  /* ============ Remote：远程控制子视图 ============ */
  #remote-root { padding: var(--sp-3, 8px); }
  #remote-root .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2, 6px);
    margin-bottom: var(--sp-3, 8px);
  }
  #remote-root .header h2 { margin: 0; font-size: var(--font-lg, 14px); }
  #remote-root .header-actions { display: flex; gap: var(--sp-2, 6px); }
  #remote-root .hint {
    margin: 0 0 var(--sp-2, 6px);
    color: var(--text-secondary, #9aa0a6);
    font-size: var(--font-sm, 11px);
  }
  #remote-root .remote-section { margin-top: var(--sp-3, 8px); }
  #remote-root .remote-item {
    padding: var(--sp-3, 8px) var(--sp-4, 10px);
    border: var(--line-solid);
    border-radius: var(--radius, 6px);
    background: var(--surface-sidebar);
  }
  #remote-root .remote-item-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2, 6px);
    margin-bottom: var(--sp-2, 6px);
  }
  #remote-root .remote-label {
    font-size: var(--font-md, 12px);
    font-weight: 600;
    color: var(--text-primary, #cccccc);
  }
  /* 对外地址行：域名较长时允许折行，输入框吃掉剩余宽度，保存按钮不挤掉 */
  #remote-root .remote-address-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--sp-2, 6px);
    margin: var(--sp-2, 6px) 0;
  }
  #remote-root .remote-address-input {
    /* flex-basis 用 0（结构性常量，非刻度裸值）；描边让位于浅底卡片，与设备行同款 */
    flex: 1 1 0;
    min-width: 0;
    padding: var(--sp-1, 4px) var(--sp-2, 6px);
    border-radius: var(--radius-sm, 2px);
    font-size: var(--font-sm, 11px);
    color: var(--text-primary, #cccccc);
    background: var(--surface-sidebar, #252526);
  }
  /* 状态行：空串时脚本会 hidden，margin 只在有值时生效 */
  #remote-root .remote-value {
    margin: 0 0 var(--sp-1, 4px);
    font-size: var(--font-sm, 11px);
    color: var(--text-primary, #cccccc);
    word-break: break-all;
  }
  /* 连接串：长单行 + 可整段选中（用户点一下即全选，省掉拖选 1KB 字符串） */
  #remote-root #remotePairingLinkBox {
    margin: var(--sp-2, 6px) 0;
    padding: var(--sp-2, 6px);
    border-radius: var(--radius-sm, 2px);
    background: var(--surface-hover, rgba(128, 128, 128, 0.2));
  }
  #remote-root .remote-link-text {
    display: block;
    /* 长单行折叠阈值：复用 --dim-lg（同「长输入折叠」语义），不新造裸值 */
    max-height: var(--dim-lg, 160px);
    overflow: auto;
    word-break: break-all;
    user-select: all;
    font-size: var(--font-xs, 10px);
    color: var(--text-primary, #cccccc);
  }
  #remote-root .remote-list { list-style: none; margin: 0; padding: 0; }
  #remote-root .remote-device {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--sp-2, 6px);
    padding: var(--sp-2, 6px);
    margin-bottom: var(--sp-1, 4px);
    border-radius: var(--radius-sm, 2px);
    background: var(--surface-sidebar, #252526);
  }
  #remote-root .remote-device-info {
    display: flex;
    align-items: center;
    gap: var(--sp-2, 6px);
    min-width: 0;
  }
  #remote-root .remote-device-name {
    font-size: var(--font-sm, 11px);
    color: var(--text-primary, #cccccc);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #remote-root .remote-device-tier {
    flex-shrink: 0;
    padding: var(--sp-hair, 1px) var(--sp-2, 6px);
    border-radius: var(--radius-pill, 999px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    background: var(--surface-hover, rgba(128, 128, 128, 0.2));
  }
  #remote-root .remote-device-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1, 4px);
  }
  /* 在线状态：与档位徽标同款胶囊；在线用主色文字，离线保持次级（不靠颜色单独表意，
     同级还有文字「在线 / 离线」，色盲用户同样可读） */
  #remote-root .remote-device-status {
    flex-shrink: 0;
    padding: var(--sp-hair, 1px) var(--sp-2, 6px);
    border-radius: var(--radius-pill, 999px);
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
    background: var(--surface-hover, rgba(128, 128, 128, 0.2));
  }
  #remote-root .remote-device-online {
    color: var(--text-primary, #cccccc);
  }
  /* 撤销是破坏性动作：hover 才染红，静态保持中性（避免整行都在喊危险） */
  #remote-root .remote-revoke:hover { color: var(--text-error, #f14c4c); }
  #remote-root .remote-audit-row {
    display: flex;
    align-items: baseline;
    gap: var(--sp-2, 6px);
    padding: var(--sp-1, 4px) 0;
    font-size: var(--font-xs, 10px);
    color: var(--text-secondary, #9aa0a6);
  }
  #remote-root .remote-audit-time { flex-shrink: 0; }
  #remote-root .remote-audit-event {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #remote-root .remote-error { color: var(--text-error, #f14c4c); }
`;
