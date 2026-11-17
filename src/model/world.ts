import * as Y from "yjs";

export type NodeType = "note" | "progress" | "request" | "research";
export type NodeStatus = "todo" | "doing" | "done";

export interface NodeLock {
  by: string;
  at: number;
}

export interface NodeData {
  id: string;
  /** 親ノード。null ならルート */
  parentId: string | null;
  text: string;
  type: NodeType;
  status: NodeStatus | null;
  /** 作業依頼の担当者 */
  assigneeId: string | null;
  x: number;
  y: number;
  /** 作成者（作成後は変更しない） */
  authorId: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  lock: NodeLock | null;
}

export interface Profile {
  displayName: string;
  /** テーマカラー（パレットのキー） */
  color: string;
  /** プリセットアバターの ID */
  avatar: string;
  statusText: string;
  updatedAt: number;
}

/** 内容の編集にあたるフィールド（ロック中は作成者以外変更できない） */
export type EditablePatch = Partial<Pick<NodeData, "text" | "type" | "status" | "assigneeId">>;

/** Syncer がリモートの更新を適用するときに使う origin */
export const REMOTE_ORIGIN = Symbol("remote");

/**
 * マインドマップの世界の状態（Y.Doc）を扱うクラス。
 *
 * - nodes: Y.Map<nodeId, Y.Map<field, value>>
 *   フィールド単位で別々の人が同時に編集してもマージされる。
 *   ツリーは入れ子にせず parentId で表す（付け替えが1フィールドの更新で済む）。
 * - profiles: Y.Map<userId, Profile>
 *   各ユーザーは自分のキーにだけ書く。
 */
export class World {
  readonly doc: Y.Doc;
  readonly nodes: Y.Map<Y.Map<unknown>>;
  readonly profiles: Y.Map<Profile>;

  constructor(doc = new Y.Doc()) {
    this.doc = doc;
    this.nodes = doc.getMap("nodes");
    this.profiles = doc.getMap("profiles");
  }

  // ---------- 読み取り ----------

  getNode(id: string): NodeData | null {
    const m = this.nodes.get(id);
    return m ? readNode(id, m) : null;
  }

  allNodes(): NodeData[] {
    const out: NodeData[] = [];
    this.nodes.forEach((m, id) => out.push(readNode(id, m)));
    return out;
  }

  getProfile(userId: string): Profile | null {
    return this.profiles.get(userId) ?? null;
  }

  /**
   * 実際に描画に使う親子関係を求める。
   * - 親が存在しない（削除された）ノードはルート扱い
   * - 同時に付け替えて循環ができた場合、循環中で ID が最小のノードをルート扱いにする
   *   （どのクライアントでも同じ結果になるように決定的に選ぶ）
   */
  resolveParents(): Map<string, string | null> {
    const raw = new Map<string, string | null>();
    this.nodes.forEach((m, id) => {
      const p = (m.get("parentId") as string | null) ?? null;
      raw.set(id, p && this.nodes.has(p) && p !== id ? p : null);
    });
    const resolved = new Map(raw);
    for (const start of raw.keys()) {
      const path: string[] = [];
      const onPath = new Set<string>();
      let cur: string | null = start;
      while (cur != null && !onPath.has(cur)) {
        path.push(cur);
        onPath.add(cur);
        cur = resolved.get(cur) ?? null;
      }
      if (cur != null) {
        // cur から始まる循環を検出した
        const cycle = path.slice(path.indexOf(cur));
        const breaker = [...cycle].sort()[0];
        resolved.set(breaker, null);
      }
    }
    return resolved;
  }

  /** id が ancestorId の子孫（または同一）か */
  isDescendant(id: string, ancestorId: string, parents = this.resolveParents()): boolean {
    let cur: string | null = id;
    const seen = new Set<string>();
    while (cur != null && !seen.has(cur)) {
      if (cur === ancestorId) return true;
      seen.add(cur);
      cur = parents.get(cur) ?? null;
    }
    return false;
  }

  // ---------- 権限 ----------

  /** 内容の編集・移動・削除ができるか（ロックしていない、または自分のロック） */
  canEdit(id: string, userId: string): boolean {
    const n = this.getNode(id);
    if (!n) return false;
    return n.lock == null || n.lock.by === userId;
  }

  /** ロック解除はロックした本人だけ */
  canUnlock(id: string, userId: string): boolean {
    const n = this.getNode(id);
    return !!n?.lock && n.lock.by === userId;
  }

  // ---------- 書き込み ----------

  createNode(
    userId: string,
    init: { parentId: string | null; x: number; y: number; text?: string; type?: NodeType },
  ): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.doc.transact(() => {
      const m = new Y.Map<unknown>();
      const type = init.type ?? "note";
      m.set("parentId", init.parentId);
      m.set("text", init.text ?? "");
      m.set("type", type);
      m.set("status", defaultStatus(type));
      m.set("assigneeId", null);
      m.set("x", Math.round(init.x));
      m.set("y", Math.round(init.y));
      m.set("authorId", userId);
      m.set("updatedBy", userId);
      m.set("createdAt", now);
      m.set("updatedAt", now);
      m.set("lock", null);
      this.nodes.set(id, m);
    });
    return id;
  }

  updateNode(userId: string, id: string, patch: EditablePatch): boolean {
    const m = this.nodes.get(id);
    if (!m || !this.canEdit(id, userId)) return false;
    this.doc.transact(() => {
      for (const [k, v] of Object.entries(patch)) {
        if (v !== undefined && m.get(k) !== v) m.set(k, v);
      }
      if (patch.type && patch.status === undefined && m.get("status") == null) {
        m.set("status", defaultStatus(patch.type));
      }
      touch(m, userId);
    });
    return true;
  }

  moveNode(userId: string, id: string, x: number, y: number): boolean {
    const m = this.nodes.get(id);
    if (!m || !this.canEdit(id, userId)) return false;
    this.doc.transact(() => {
      m.set("x", Math.round(x));
      m.set("y", Math.round(y));
      touch(m, userId);
    });
    return true;
  }

  /** 親を付け替える。自分の子孫の下には付けられない */
  reparent(userId: string, id: string, newParentId: string | null): boolean {
    const m = this.nodes.get(id);
    if (!m || !this.canEdit(id, userId)) return false;
    if (newParentId != null) {
      if (!this.nodes.has(newParentId)) return false;
      if (this.isDescendant(newParentId, id)) return false;
    }
    this.doc.transact(() => {
      m.set("parentId", newParentId);
      touch(m, userId);
    });
    return true;
  }

  /** ノードを削除する。子ノードは削除したノードの親に付け替える */
  deleteNode(userId: string, id: string): boolean {
    if (!this.canEdit(id, userId)) return false;
    const parents = this.resolveParents();
    const newParent = parents.get(id) ?? null;
    this.doc.transact(() => {
      for (const [childId, p] of parents) {
        if (p === id) this.nodes.get(childId)?.set("parentId", newParent);
      }
      this.nodes.delete(id);
    });
    return true;
  }

  lock(userId: string, id: string): boolean {
    const m = this.nodes.get(id);
    if (!m) return false;
    const cur = m.get("lock") as NodeLock | null;
    if (cur) return cur.by === userId;
    m.set("lock", { by: userId, at: Date.now() });
    return true;
  }

  unlock(userId: string, id: string): boolean {
    const m = this.nodes.get(id);
    if (!m || !this.canUnlock(id, userId)) return false;
    m.set("lock", null);
    return true;
  }

  setProfile(userId: string, profile: Omit<Profile, "updatedAt">): void {
    this.profiles.set(userId, { ...profile, updatedAt: Date.now() });
  }
}

function defaultStatus(type: NodeType): NodeStatus | null {
  return type === "progress" || type === "request" ? "todo" : null;
}

function touch(m: Y.Map<unknown>, userId: string) {
  m.set("updatedBy", userId);
  m.set("updatedAt", Date.now());
}

function readNode(id: string, m: Y.Map<unknown>): NodeData {
  return {
    id,
    parentId: (m.get("parentId") as string | null) ?? null,
    text: (m.get("text") as string) ?? "",
    type: (m.get("type") as NodeType) ?? "note",
    status: (m.get("status") as NodeStatus | null) ?? null,
    assigneeId: (m.get("assigneeId") as string | null) ?? null,
    x: (m.get("x") as number) ?? 0,
    y: (m.get("y") as number) ?? 0,
    authorId: (m.get("authorId") as string) ?? "",
    updatedBy: (m.get("updatedBy") as string) ?? "",
    createdAt: (m.get("createdAt") as number) ?? 0,
    updatedAt: (m.get("updatedAt") as number) ?? 0,
    lock: (m.get("lock") as NodeLock | null) ?? null,
  };
}
