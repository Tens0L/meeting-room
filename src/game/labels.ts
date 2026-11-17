import type { NodeStatus, NodeType } from "../model/world";

export const TYPE_META: Record<NodeType, { icon: string; label: string }> = {
  note: { icon: "📝", label: "メモ" },
  progress: { icon: "📈", label: "進捗" },
  request: { icon: "📮", label: "依頼" },
  research: { icon: "🔬", label: "調査" },
};

export const STATUS_LABEL: Record<NodeStatus, string> = {
  todo: "未着手",
  doing: "対応中",
  done: "完了",
};

export function timeAgo(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "たった今";
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}
