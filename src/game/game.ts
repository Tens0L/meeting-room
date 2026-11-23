import type { Footprints } from "../model/footprints";
import type { NodeData, Profile, World } from "../model/world";
import { MAX_ZOOM, MIN_ZOOM, Renderer, presenceSpot, type Camera, type Ghost, type Hit, type Rect } from "./renderer";

export interface GameUI {
  /**
   * 編集画面を開く。閉じたら onClose を呼ぶこと。
   * isNew: いま作ったばかりの箱（空のまま閉じたら消す）
   */
  openEditor(nodeId: string, isNew: boolean, onClose: () => void): void;
  toast(msg: string): void;
  /** ダイアログ表示中などは操作を止める */
  isBlocked(): boolean;
}

/** これ以上動いたら「タップ」ではなく「スワイプ／ドラッグ」とみなす（画面上の px） */
const TAP_SLOP = 8;
/** 長押しとみなす時間 */
const LONG_PRESS_MS = 450;
/** キーボードでの画面移動の速さ（画面上の px/秒） */
const KEY_PAN_SPEED = 600;

interface PointerInfo {
  x: number;
  y: number;
  type: string;
}

type Gesture =
  | { kind: "idle" }
  /** 押した直後。まだタップかスワイプか長押しか決まっていない */
  | { kind: "press"; pointerId: number; hit: Hit | null; sx: number; sy: number; timer: number | null; type: string }
  | { kind: "pan"; pointerId: number; lastX: number; lastY: number }
  | { kind: "move"; pointerId: number; id: string; offX: number; offY: number }
  | { kind: "pinch"; lastDist: number; lastMidX: number; lastMidY: number }
  /** 長押ししたがロック中で動かせなかった。指を離すまで何もしない */
  | { kind: "ignore"; pointerId: number };

/**
 * 画面の操作。描画は Renderer、データは World に任せる。
 *
 *   スワイプ／ドラッグ      … 画面を動かす
 *   ピンチ／ホイール        … 拡大・縮小
 *   何もない所をタップ      … そこにテキスト箱を置く
 *   箱をタップ              … 編集（ロック・削除も編集画面から）
 *   箱を長押し（マウスはそのままドラッグ）… 移動
 *   箱の右の＋              … 右側に、線でつながった箱を追加
 *   箱の左のアンカー        … タップしてから別の箱をタップすると、その箱につなぐ
 */
export class Game {
  readonly renderer: Renderer;
  readonly camera: Camera = { x: 0, y: 0, zoom: 1 };
  editingId: string | null = null;
  connectFromId: string | null = null;
  private moving: { id: string; x: number; y: number } | null = null;
  private pointerWorld: { x: number; y: number } | null = null;
  private pointers = new Map<number, PointerInfo>();
  private gesture: Gesture = { kind: "idle" };
  private keys = new Set<string>();
  private last = performance.now();
  private nodesCache: NodeData[] | null = null;
  private parentsCache: Map<string, string | null> | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
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
    canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.onPointerUp(e, false));
    canvas.addEventListener("pointercancel", (e) => this.onPointerUp(e, true));
    canvas.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse" && this.gesture.kind === "idle") this.pointerWorld = null;
    });
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    // iPhone の Safari は長押しで拡大鏡や文字選択を出そうとするので、地図の上では止める。
    // 操作はポインターイベントで受けているので、タッチイベントを止めても影響しない
    const stop = (e: TouchEvent) => e.preventDefault();
    canvas.addEventListener("touchstart", stop, { passive: false });
    canvas.addEventListener("touchmove", stop, { passive: false });
  }

  start(center: { x: number; y: number }) {
    this.camera.x = center.x;
    this.camera.y = center.y;
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

  // ---------- 毎フレーム ----------

  private tick(t: number) {
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;

    if (!this.ui.isBlocked()) {
      let dx = 0;
      let dy = 0;
      if (this.keys.has("arrowleft") || this.keys.has("a")) dx -= 1;
      if (this.keys.has("arrowright") || this.keys.has("d")) dx += 1;
      if (this.keys.has("arrowup") || this.keys.has("w")) dy -= 1;
      if (this.keys.has("arrowdown") || this.keys.has("s")) dy += 1;
      const len = Math.hypot(dx, dy);
      if (len > 0) {
        this.camera.x += ((dx / len) * KEY_PAN_SPEED * dt) / this.camera.zoom;
        this.camera.y += ((dy / len) * KEY_PAN_SPEED * dt) / this.camera.zoom;
      }
    }
    // 足跡は画面中央（見ている場所）に残る
    this.footprints.record(this.camera.x, this.camera.y);

    const profiles = new Map<string, Profile>();
    this.world.profiles.forEach((p, id) => profiles.set(id, p));
    const others = [...this.footprints.others.values()];
    const ghosts: Ghost[] = others
      .filter((f) => f.lastPos)
      .map((f) => ({ userId: f.userId, x: f.lastPos!.x, y: f.lastPos!.y, lastSeen: f.lastSeen }));

    this.renderer.draw(
      {
        me: this.me,
        camera: this.camera,
        nodes: this.nodes,
        parents: this.parents,
        profiles,
        footprints: [...others, this.footprints.mine],
        ghosts,
        editingId: this.editingId,
        moving: this.moving,
        connectFromId: this.connectFromId,
        pointer: this.pointerWorld,
        lastVisit: this.lastVisit,
      },
      t,
    );
  }

  // ---------- ポインター（指・マウス・ペン） ----------

  private local(e: PointerEvent | WheelEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onPointerDown(e: PointerEvent) {
    if (this.ui.isBlocked()) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, { ...p, type: e.pointerType });
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // 合成イベントなどでは失敗することがある
    }
    this.pointerWorld = this.renderer.screenToWorld(p.x, p.y);

    if (this.pointers.size >= 2) {
      // 2本目の指：ピンチに切り替える（移動中なら、その場に置く）
      this.cancelPressTimer();
      if (this.gesture.kind === "move") this.dropMoving();
      const [a, b] = [...this.pointers.values()];
      this.gesture = { kind: "pinch", lastDist: Math.hypot(a.x - b.x, a.y - b.y), lastMidX: (a.x + b.x) / 2, lastMidY: (a.y + b.y) / 2 };
      return;
    }

    const hit = this.renderer.hitTest(p.x, p.y);
    let timer: number | null = null;
    // 指・ペンでは、箱の長押しで移動モードに入る
    if (hit?.kind === "box" && e.pointerType !== "mouse") {
      timer = window.setTimeout(() => {
        if (this.gesture.kind === "press" && this.gesture.pointerId === e.pointerId) this.beginMove(e.pointerId, hit.id);
      }, LONG_PRESS_MS);
    }
    this.gesture = { kind: "press", pointerId: e.pointerId, hit, sx: p.x, sy: p.y, timer, type: e.pointerType };
  }

  private onPointerMove(e: PointerEvent) {
    const p = this.local(e);
    if (e.pointerType === "mouse" || this.pointers.has(e.pointerId)) {
      this.pointerWorld = this.renderer.screenToWorld(p.x, p.y);
    }
    const info = this.pointers.get(e.pointerId);
    if (!info) return;
    info.x = p.x;
    info.y = p.y;
    const g = this.gesture;

    switch (g.kind) {
      case "press": {
        if (g.pointerId !== e.pointerId) return;
        if (Math.hypot(p.x - g.sx, p.y - g.sy) <= TAP_SLOP) return;
        this.cancelPressTimer();
        if (g.hit?.kind === "box" && g.type === "mouse") {
          // マウスは箱をそのままドラッグして動かせる
          this.beginMove(e.pointerId, g.hit.id);
          this.onPointerMove(e);
        } else {
          this.gesture = { kind: "pan", pointerId: e.pointerId, lastX: g.sx, lastY: g.sy };
          this.onPointerMove(e);
        }
        return;
      }
      case "pan": {
        if (g.pointerId !== e.pointerId) return;
        this.camera.x -= (p.x - g.lastX) / this.camera.zoom;
        this.camera.y -= (p.y - g.lastY) / this.camera.zoom;
        g.lastX = p.x;
        g.lastY = p.y;
        return;
      }
      case "move": {
        if (g.pointerId !== e.pointerId || !this.moving) return;
        const w = this.renderer.screenToWorld(p.x, p.y);
        this.moving.x = w.x - g.offX;
        this.moving.y = w.y - g.offY;
        return;
      }
      case "pinch": {
        if (this.pointers.size < 2) return;
        const [a, b] = [...this.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        // 前回の指の中点の下にあった場所が、今の中点の下に来るように拡大・移動する
        const anchor = this.renderer.screenToWorld(g.lastMidX, g.lastMidY);
        const zoom = clampZoom(this.camera.zoom * (g.lastDist > 0 ? dist / g.lastDist : 1));
        this.setZoomAt(zoom, midX, midY, anchor);
        g.lastDist = dist;
        g.lastMidX = midX;
        g.lastMidY = midY;
        return;
      }
    }
  }

  private onPointerUp(e: PointerEvent, cancelled: boolean) {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.local(e);
    this.pointers.delete(e.pointerId);
    if (e.pointerType !== "mouse") this.pointerWorld = this.connectFromId ? this.renderer.screenToWorld(p.x, p.y) : null;
    const g = this.gesture;

    switch (g.kind) {
      case "press":
        this.cancelPressTimer();
        this.gesture = { kind: "idle" };
        if (!cancelled && g.pointerId === e.pointerId) this.onTap(g.hit, p.x, p.y);
        return;
      case "move":
        if (g.pointerId === e.pointerId) {
          this.dropMoving();
          this.gesture = { kind: "idle" };
        }
        return;
      case "pinch": {
        // 1本指に戻ったら、そのまま画面移動を続ける
        const rest = [...this.pointers.entries()][0];
        this.gesture = rest ? { kind: "pan", pointerId: rest[0], lastX: rest[1].x, lastY: rest[1].y } : { kind: "idle" };
        return;
      }
      default:
        if (this.pointers.size === 0) this.gesture = { kind: "idle" };
    }
  }

  private onWheel(e: WheelEvent) {
    if (this.ui.isBlocked()) return;
    e.preventDefault();
    const p = this.local(e);
    // トラックパッドのピンチは ctrlKey 付きのホイールとして届く
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    const anchor = this.renderer.screenToWorld(p.x, p.y);
    this.setZoomAt(clampZoom(this.camera.zoom * factor), p.x, p.y, anchor);
  }

  /** 世界の点 anchor が画面の (sx, sy) に来るように、倍率を zoom にする */
  private setZoomAt(zoom: number, sx: number, sy: number, anchor: { x: number; y: number }) {
    this.camera.zoom = zoom;
    this.camera.x = anchor.x - (sx - this.renderer.width / 2) / zoom;
    this.camera.y = anchor.y - (sy - this.renderer.height / 2) / zoom;
  }

  private cancelPressTimer() {
    if (this.gesture.kind === "press" && this.gesture.timer != null) {
      clearTimeout(this.gesture.timer);
      this.gesture.timer = null;
    }
  }

  // ---------- 操作 ----------

  private onTap(hit: Hit | null, sx: number, sy: number) {
    const w = this.renderer.screenToWorld(sx, sy);

    // つなぐ先を選んでいるとき
    if (this.connectFromId) {
      const from = this.connectFromId;
      this.connectFromId = null;
      this.pointerWorld = null;
      if (!hit || hit.id === from) {
        this.ui.toast("つなぐのをやめました");
        return;
      }
      this.connect(from, hit.id);
      return;
    }

    if (!hit) return this.createAt(w.x, w.y);
    switch (hit.kind) {
      case "plus":
        return this.addChild(hit.id);
      case "anchor":
        return this.startConnect(hit.id);
      case "box":
        return this.edit(hit.id, false);
    }
  }

  /** 何もない所をタップ：そこに箱を置いて編集する */
  private createAt(x: number, y: number) {
    const free = this.freeSpot("", { x: x - 55, y: y - 28, w: 110, h: 57 });
    const id = this.world.createNode(this.me, { parentId: null, x: free.x, y: free.y });
    this.edit(id, true);
  }

  /** ＋ボタン：右側に、線でつながった箱を追加して編集する */
  private addChild(parentId: string) {
    const r = this.renderer.rects.get(parentId);
    if (!r) return;
    const W = 110;
    const H = 57;
    const x = r.x + r.w + 90;
    const y = r.y + r.h / 2 - H / 2;
    const free = this.freeSpot("", { x, y, w: W, h: H });
    const id = this.world.createNode(this.me, { parentId, x: free.x, y: free.y });
    this.ensureVisible(free.x, free.y, W, H);
    this.edit(id, true);
  }

  /** 中心 (x, y)・大きさ w×h の箱が画面に収まるよう、必要なら画面を動かす */
  private ensureVisible(x: number, y: number, w: number, h: number) {
    const z = this.camera.zoom;
    // 箱の左右のアンカー・＋ボタンも含めて、画面の端から少し内側に収める
    const margin = 24 / z;
    const halfW = this.renderer.width / 2 / z - margin;
    const halfH = this.renderer.height / 2 / z - margin;
    const needX = w / 2 + 30;
    const needY = h / 2;
    if (x + needX > this.camera.x + halfW) this.camera.x = x + needX - halfW;
    if (x - needX < this.camera.x - halfW) this.camera.x = x - needX + halfW;
    if (y + needY > this.camera.y + halfH) this.camera.y = y + needY - halfH;
    if (y - needY < this.camera.y - halfH) this.camera.y = y - needY + halfH;
  }

  private edit(id: string, isNew: boolean) {
    this.editingId = id;
    this.keys.clear();
    const r = this.renderer.rects.get(id);
    if (r) {
      const at = presenceSpot(r);
      this.footprints.markPresence(at.x, at.y);
    }
    this.ui.openEditor(id, isNew, () => {
      if (this.editingId === id) this.editingId = null;
    });
  }

  /** アンカー：つなぐ先を選ぶモードに入る */
  private startConnect(id: string) {
    if (!this.world.canEdit(id, this.me)) {
      this.ui.toast(this.lockedMessage(id));
      return;
    }
    this.connectFromId = id;
    this.ui.toast("つなぐ先の箱をタップしてください（何もない所をタップで取り消し）");
  }

  /** from を to の下（右側）につなぐ */
  private connect(from: string, to: string) {
    if (this.world.isDescendant(to, from, this.parents)) {
      this.ui.toast("この箱の先につながっている箱には、つなげません");
      return;
    }
    if (this.parents.get(from) === to) {
      this.ui.toast("すでにつながっています");
      return;
    }
    if (this.world.reparent(this.me, from, to)) this.ui.toast("つなぎました");
    else this.ui.toast(this.lockedMessage(from));
  }

  private beginMove(pointerId: number, id: string) {
    if (!this.world.canEdit(id, this.me)) {
      this.ui.toast(this.lockedMessage(id));
      this.gesture = { kind: "ignore", pointerId };
      return;
    }
    const n = this.world.getNode(id);
    const info = this.pointers.get(pointerId);
    if (!n || !info) return;
    const w = this.renderer.screenToWorld(info.x, info.y);
    this.moving = { id, x: n.x, y: n.y };
    this.gesture = { kind: "move", pointerId, id, offX: w.x - n.x, offY: w.y - n.y };
    navigator.vibrate?.(15);
  }

  private dropMoving() {
    const m = this.moving;
    this.moving = null;
    if (!m) return;
    const r = this.renderer.rects.get(m.id);
    if (!r) return;
    const placed = { ...r, x: m.x - r.w / 2, y: m.y - r.h / 2 };
    const free = this.freeSpot(m.id, placed);
    this.world.moveNode(this.me, m.id, free.x, free.y);
  }

  private onKeyDown(e: KeyboardEvent) {
    const el = e.target as HTMLElement | null;
    if (el?.closest?.("input, textarea, select")) return;
    if (this.ui.isBlocked()) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
    this.keys.add(k);
    if (e.repeat) return;
    const cx = this.renderer.width / 2;
    const cy = this.renderer.height / 2;
    const center = { x: this.camera.x, y: this.camera.y };
    switch (k) {
      case "+":
      case "=":
        this.setZoomAt(clampZoom(this.camera.zoom * 1.2), cx, cy, center);
        break;
      case "-":
        this.setZoomAt(clampZoom(this.camera.zoom / 1.2), cx, cy, center);
        break;
      case "escape":
        if (this.connectFromId) {
          this.connectFromId = null;
          this.ui.toast("つなぐのをやめました");
        }
        break;
    }
  }

  /**
   * r の位置から、他の箱と重ならない所まで下にずらした中心座標。
   * 箱の左右にはアンカーと＋ボタンがあるので、横方向は広めに空ける
   */
  private freeSpot(id: string, r: Rect) {
    const GAP_X = 40;
    const GAP_Y = 12;
    let y = r.y;
    for (let i = 0; i < 50; i++) {
      const hit = [...this.renderer.rects].find(
        ([oid, o]) =>
          oid !== id && r.x < o.x + o.w + GAP_X && o.x < r.x + r.w + GAP_X && y < o.y + o.h + GAP_Y && o.y < y + r.h + GAP_Y,
      );
      if (!hit) break;
      y = hit[1].y + hit[1].h + GAP_Y;
    }
    return { x: r.x + r.w / 2, y: y + r.h / 2 };
  }

  lockedMessage(id: string): string {
    const n = this.world.getNode(id);
    const name = n?.lock ? (this.world.getProfile(n.lock.by)?.displayName ?? "誰か") : "誰か";
    return `🔒 ${name}さんがロックしています`;
  }
}

function clampZoom(z: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}
