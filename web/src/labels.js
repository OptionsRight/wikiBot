export const ticketStateLabels = {
  submitted: "待受理",
  triaged: "已分诊",
  in_progress: "处理中",
  waiting_reporter: "待补充材料",
  resolved: "已解决待确认",
  closed: "已关闭",
  withdrawn: "已撤回",
  rejected: "已拒绝",
  duplicate: "重复",
};
export const ticketStateVariants = {
  submitted: "neutral",
  triaged: "info",
  in_progress: "info",
  waiting_reporter: "warn",
  resolved: "ok",
  closed: "neutral",
  withdrawn: "neutral",
  rejected: "danger",
  duplicate: "neutral",
};
export const ticketCategoryLabels = {
  question: "咨询问题",
  knowledge: "知识更正",
};
export const answerStateLabels = {
  queued: "排队中",
  running: "生成中",
  complete: "已完成",
  incomplete: "未完成",
  failed: "失败",
};
export const answerStateVariants = {
  queued: "neutral",
  running: "info",
  complete: "ok",
  incomplete: "warn",
  failed: "danger",
};
export const revisionStateLabels = {
  draft: "草稿",
  sync_pending: "来源写回中",
  snapshot_ready: "快照就绪",
};
export const releaseStateLabels = {
  submitted: "待评估复核",
  ready: "可激活",
  active: "当前版本",
  rejected: "已拒绝",
  retired: "已退役",
  stale: "已过期",
  revoked: "已吊销",
};
export const releaseStateVariants = {
  submitted: "info",
  ready: "ok",
  active: "solid",
  rejected: "danger",
  retired: "neutral",
  stale: "neutral",
  revoked: "danger",
};
export const roleLabels = { admin: "知识管理员", member: "普通成员" };
export const fmtTime = (ms) =>
  new Date(ms).toLocaleString("zh-CN", { hour12: false });
