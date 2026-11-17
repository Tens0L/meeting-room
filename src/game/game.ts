import type { Footprints } from "../model/footprints";
import type { NodeData, Profile, World } from "../model/world";
import { Renderer, type Ghost } from "./renderer";

export interface GameUI {
  /** isNew: いま作ったばかりのノード（空のまま閉じたら消す） */
  openEditor(nodeId: string, isNew?: boolean): void;
  toast(msg: string): void;
  confirm(msg: string): boolean;
  /** ダイアログ表示中などはキー操作を止める */
  isBlocked(): boolean;
}

const SPEED = 240; // px/秒
const FOCUS_RANGE = 56;
const DROP_RANGE = 36;

/**
 * プレイヤーの移動とキー操作。描画は Renderer、データは World に任せる。
 *
 * 操作:
 *   WASD / 矢印 … 移動（クリックした場所へ歩くこともできる）
 *   E / Enter   … 近くのノードを編集
 *   N           … 近くのノードに子ノードを追加（近くになければ新しいルート）
 *   G           … ノードを持ち上げる / 置く（他のノードの近くに置くと、その子になる）
 *   L           … ロック / ロック解除
 *   Delete / X  … 削除
 */
export class Game {
  readonly renderer: Renderer;
  readonly player = { x: 0, y: 0, walking: false };
  focusId: string | null = null;
  carryingId: string | null = null;
  private dropTargetId: string | null = null;
  private keys = new Set<string>();
  private target: { x: number; y: number } | null = null;
  private last = performance.now();
  private nodesCache: NodeData[] | null = null;
  private parentsCache: Map<string, string | null> | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    private world: World,
    private footprints: Footprints,
    private me: string,
    private ui: GameUI,
    private lastVisit: number,
  ) {
    this.renderer = new Renderer(canvas);
    world.doc.on("update", () => {
      this.nodesCache = null;
      this.parentsCache = null;
    });

    window.addEventListener("resize", () => this.renderer.resize());
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
    window.addEventListener("keyup", (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener("blur", () => this.keys.clear());
    canvas.addEventListener("click", (e) => this.onClick(e));
    canvas.addEventListener("dblclick", (e) => {
      const w = this.renderer.screenToWorld(e.offsetX, e.offsetY);
      const id = this.renderer.hitNode(w.x, w.y);
      if (id) this.ui.openEditor(id);
    });
  }

  start(spawn: { x: number; y: number }) {
    this.player.x = spawn.x;
    this.player.y = spawn.y;
    this.renderer.camera = { ...spawn };
    this.renderer.resize();
    const loop = (t: number) => {
      this.tick(t);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private get nodes() {
    return (this.nodesCache ??= this.world.allNodes());
  }

  private get parents() {
    return (this.parentsCache ??= this.world.resolveParents());
  }

  private tick(t: number) {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;

    let dx = 0;
    let dy = 0;
    if (!this.ui.isBlocked()) {
      if (this.keys.has("arrowleft") || this.keys.has("a")) dx -= 1;
      if (this.keys.has("arrowright") || this.keys.has("d")) dx += 1;
      if (this.keys.has("arrowup") || this.keys.has("w")) dy -= 1;
      if (this.keys.has("arrowdown") || this.keys.has("s")) dy += 1;
    }
    if (dx || dy) this.target = null;
    else if (this.target) {
      const tx = this.target.x - this.player.x;
      const ty = this.target.y - this.player.y;
      const d = Math.hypot(tx, ty);
      if (d < 4) this.target = null;
      else {
        dx = tx / d;
        dy = ty / d;
      }
    }
    const len = Math.hypot(dx, dy);
    this.player.walking = len > 0;
    if (len > 0) {
      this.player.x += (dx / len) * SPEED * dt;
      this.player.y += (dy / len) * SPEED * dt;
    }
    this.footprints.record(this.player.x, this.player.y);

    this.focusId = this.carryingId ? null : this.nearestNode(FOCUS_RANGE);
    this.dropTargetId = this.carryingId ? this.nearestDropTarget() : null;

    const profiles = new Map<string, Profile>();
    this.world.profiles.forEach((p, id) => profiles.set(id, p));
    const others = [...this.footprints.others.values()];
    const ghosts: Ghost[] = others
      .filter((f) => f.lastPos)
      .map((f) => ({ userId: f.userId, x: f.lastPos!.x, y: f.lastPos!.y, lastSeen: f.lastSeen }));

    this.renderer.draw(
      {
        me: this.me,
        player: this.player,
        nodes: this.nodes,
        parents: this.parents,
        profiles,
        footprints: [...others, this.footprints.mine],
        ghosts,
        focusId: this.focusId,
        carryingId: this.carryingId,
        dropTargetId: this.dropTargetId,
        lastVisit: this.lastVisit,
      },
      t,
    );
  }

  /** プレイヤーから一番近いノード（矩形までの距離で測る） */
  private nearestNode(range: number, exclude?: (id: string) => boolean): string | null {
    let best: string | null = null;
    let bestD = range;
    for (const [id, r] of this.renderer.rects) {
      if (exclude?.(id)) continue;
      const cx = Math.max(r.x, Math.min(this.player.x, r.x + r.w));
      const cy = Math.max(r.y, Math.min(this.player.y - 16, r.y + r.h));
      const d = Math.hypot(cx - this.player.x, cy - (this.player.y - 16));
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  /** 持ち上げているカードと重なっている／近いノード（自分の子孫は除く） */
  private nearestDropTarget(): string | null {
    const c = this.carryingId!;
    const held = this.renderer.rects.get(c);
    if (!held) return null;
    const parents = this.parents;
    let best: string | null = null;
    let bestD = DROP_RANGE;
    for (const [id, r] of this.renderer.rects) {
      if (id === c || this.world.isDescendant(id, c, parents)) continue;
      // 矩形どうしのすき間（重なっていれば 0）
      const gx = Math.max(0, r.x - (held.x + held.w), held.x - (r.x + r.w));
      const gy = Math.max(0, r.y - (held.y + held.h), held.y - (r.y + r.h));
      const d = Math.hypot(gx, gy);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  private onClick(e: MouseEvent) {
    if (this.ui.isBlocked()) return;
    const w = this.renderer.screenToWorld(e.offsetX, e.offsetY);
    const id = this.renderer.hitNode(w.x, w.y);
    if (id) {
      const r = this.renderer.rects.get(id)!;
      this.target = { x: r.x + r.w / 2, y: r.y + r.h + 64 }; // 名前札がカードに重ならない位置
    } else this.target = w;
  }

  private onKeyDown(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    if (el?.closest?.("input, textarea, select")) return;
    if (this.ui.isBlocked()) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
    this.keys.add(k);
    if (e.repeat) return;

    switch (k) {
      case "e":
      case "enter":
        if (this.focusId) {
          e.preventDefault(); // 開いた編集欄に "e" が入力されないように
          this.ui.openEditor(this.focusId);
        }
        break;
      case "n":
        e.preventDefault();
        this.addNode();
        break;
      case "g":
        this.toggleCarry();
        break;
      case "l":
        this.toggleLock();
        break;
      case "delete":
      case "backspace":
      case "x":
        this.deleteFocused();
        break;
    }
  }

  /** 画面のボタン（タッチ操作）から呼ぶ。キー操作と同じ動作をする */
  act(action: "add" | "edit" | "carry" | "lock" | "delete") {
    if (this.ui.isBlocked()) return;
    this.target = null;
    switch (action) {
      case "add":
        return this.addNode();
      case "edit":
        if (this.focusId) this.ui.openEditor(this.focusId);
        return;
      case "carry":
        return this.toggleCarry();
      case "lock":
        return this.toggleLock();
      case "delete":
        return this.deleteFocused();
    }
  }

  private addNode() {
    const parentId = this.focusId;
    let x = this.player.x;
    let y = this.player.y - 70;
    if (parentId) {
      const r = this.renderer.rects.get(parentId)!;
      // 親の右側、既存の子の下に並べる
      const siblings = [...this.parents].filter(([, p]) => p === parentId).length;
      x = r.x + r.w + 140;
      y = r.y + r.h / 2 + siblings * 95 - 45;
    }
    // 空ノードのおおよその大きさで、他のカードと重ならない位置を探す
    const W = 110, H = 57;
    const free = this.freeSpot("", { x: x - W / 2, y: y - H / 2, w: W, h: H });
    const id = this.world.createNode(this.me, { parentId, x: free.x, y: free.y });
    this.keys.clear();
    this.ui.openEditor(id, true);
  }

  private toggleCarry() {
    if (this.carryingId) {
      const id = this.carryingId;
      const r = this.renderer.rects.get(id);
      if (r) {
        const free = this.freeSpot(id, r);
        this.world.moveNode(this.me, id, free.x, free.y);
      }
      if (this.dropTargetId && this.dropTargetId !== this.parents.get(id)) {
        if (this.world.reparent(this.me, id, this.dropTargetId)) this.ui.toast("つなぎ先を変更しました");
      }
      this.carryingId = null;
      return;
    }
    if (!this.focusId) return;
    if (!this.world.canEdit(this.focusId, this.me)) {
      this.ui.toast(this.lockedMessage(this.focusId));
      return;
    }
    this.carryingId = this.focusId;
  }

  /** r の位置から、他のカードと重ならない所まで下にずらした中心座標 */
  private freeSpot(id: string, r: { x: number; y: number; w: number; h: number }) {
    const GAP = 12;
    let y = r.y;
    for (let i = 0; i < 50; i++) {
      const hit = [...this.renderer.rects].find(
        ([oid, o]) => oid !== id && r.x < o.x + o.w + GAP && o.x < r.x + r.w + GAP && y < o.y + o.h + GAP && o.y < y + r.h + GAP,
      );
      if (!hit) break;
      y = hit[1].y + hit[1].h + GAP;
    }
    return { x: r.x + r.w / 2, y: y + r.h / 2 };
  }

  private toggleLock() {
    const id = this.focusId;
    if (!id) return;
    const n = this.world.getNode(id)!;
    if (!n.lock) {
      this.world.lock(this.me, id);
      this.ui.toast("🔒 ロックしました（他の人は編集・移動・削除できません。子ノードの追加はできます）");
    } else if (this.world.unlock(this.me, id)) {
      this.ui.toast("🔓 ロックを解除しました");
    } else {
      this.ui.toast(this.lockedMessage(id) + "。解除できるのはロックした本人だけです");
    }
  }

  private deleteFocused() {
    const id = this.focusId;
    if (!id) return;
    if (!this.world.canEdit(id, this.me)) {
      this.ui.toast(this.lockedMessage(id));
      return;
    }
    const n = this.world.getNode(id)!;
    const label = n.text.trim().split("\n")[0].slice(0, 20) || "（未入力）";
    if (this.ui.confirm(`「${label}」を削除しますか？（子ノードは親につなぎ直されます）`)) {
      this.world.deleteNode(this.me, id);
    }
    this.keys.clear();
  }

  lockedMessage(id: string): string {
    const n = this.world.getNode(id);
    const name = n?.lock ? (this.world.getProfile(n.lock.by)?.displayName ?? "誰か") : "誰か";
    return `🔒 ${name}さんがロックしています`;
  }
}
