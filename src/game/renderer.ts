import { FOOTPRINT_TTL_MS, TILE, type FootprintData } from "../model/footprints";
import type { NodeData, Profile } from "../model/world";
import { colorOf, isDark } from "../ui/palette";
import { drawAvatar } from "./avatars";
import { STATUS_LABEL, TYPE_META, timeAgo } from "./labels";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Ghost {
  userId: string;
  x: number;
  y: number;
  lastSeen: number;
}

export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

export type HitKind = "box" | "anchor" | "plus";
export interface Hit {
  kind: HitKind;
  id: string;
}

export interface Scene {
  me: string;
  camera: Camera;
  nodes: NodeData[];
  parents: Map<string, string | null>;
  profiles: Map<string, Profile>;
  footprints: FootprintData[];
  ghosts: Ghost[];
  /** 編集画面を開いている箱（縁の色を変え、横に自分のアバターを出す） */
  editingId: string | null;
  /** 移動中の箱と、その中心座標 */
  moving: { id: string; x: number; y: number } | null;
  /** アンカーをタップして「つなぐ先」を選んでいる箱 */
  connectFromId: string | null;
  /** つなぐ先を選んでいる間の指・マウスの位置（ワールド座標） */
  pointer: { x: number; y: number } | null;
  /** 前回の訪問時刻。これより後に他の人が更新したノードに NEW を付ける */
  lastVisit: number;
}

const FONT = '14px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
const SMALL = '11px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
const MAX_W = 220;
const PAD = 10;
const LINE_H = 19;
/** 箱の左のアンカー・右の＋ボタンの、箱の縁からの距離と半径 */
const ANCHOR_OFF = 14;
const ANCHOR_R = 7;
const PLUS_OFF = 18;
const PLUS_R = 11;
/** アンカー・＋ボタンの当たり判定（画面上の px）。指で押しやすいよう見た目より大きい */
const HANDLE_HIT_PX = 22;

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 2.5;

interface Theme {
  bg: string;
  grid: string;
  card: string;
  cardText: string;
  muted: string;
  edge: string;
  editing: string;
  moving: string;
  connecting: string;
}

function theme(): Theme {
  return isDark()
    ? {
        bg: "#1b1f27", grid: "rgba(255,255,255,0.05)", card: "#262c38", cardText: "#e8ecf3", muted: "#9aa4b5",
        edge: "rgba(200,210,230,0.35)", editing: "#74c0fc", moving: "#ffc078", connecting: "#8ce99a",
      }
    : {
        bg: "#f3efe6", grid: "rgba(60,50,30,0.07)", card: "#fffdf8", cardText: "#2a2620", muted: "#7b7366",
        edge: "rgba(80,70,50,0.35)", editing: "#1c7ed6", moving: "#e8590c", connecting: "#2b8a3e",
      };
}

/** 箱の左のアンカーと右の＋ボタンの位置 */
export function handles(r: Rect) {
  const cy = r.y + r.h / 2;
  return { anchor: { x: r.x - ANCHOR_OFF, y: cy }, plus: { x: r.x + r.w + PLUS_OFF, y: cy } };
}

/** 編集中の箱の横に立つアバターの足元の位置（他の人にはここにゴーストが出る） */
export function presenceSpot(r: Rect) {
  return { x: r.x - ANCHOR_OFF - 30, y: r.y + r.h };
}

export class Renderer {
  readonly rects = new Map<string, Rect>();
  /** 描いた順（上に描いたものほど後ろ）。当たり判定は逆順に見る */
  private order: string[] = [];
  private layoutCache = new Map<string, { lines: string[]; w: number; h: number }>();
  camera: Camera = { x: 0, y: 0, zoom: 1 };

  constructor(private canvas: HTMLCanvasElement) {}

  private get ctx() {
    return this.canvas.getContext("2d")!;
  }

  get width() {
    return this.canvas.clientWidth;
  }

  get height() {
    return this.canvas.clientHeight;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.floor(this.canvas.clientHeight * dpr);
  }

  screenToWorld(sx: number, sy: number) {
    const c = this.camera;
    return { x: (sx - this.width / 2) / c.zoom + c.x, y: (sy - this.height / 2) / c.zoom + c.y };
  }

  /** 画面上の点 (sx, sy) にあるもの。アンカーと＋ボタンを箱より優先する */
  hitTest(sx: number, sy: number): Hit | null {
    const w = this.screenToWorld(sx, sy);
    const reach = HANDLE_HIT_PX / this.camera.zoom;
    let best: Hit | null = null;
    let bestD = Infinity;
    for (const id of this.order) {
      const hd = handles(this.rects.get(id)!);
      for (const kind of ["anchor", "plus"] as const) {
        const p = hd[kind];
        const d = Math.hypot(p.x - w.x, p.y - w.y);
        if (d <= Math.max(reach, kind === "plus" ? PLUS_R : ANCHOR_R) && d < bestD) {
          bestD = d;
          best = { kind, id };
        }
      }
    }
    if (best) return best;
    for (let i = this.order.length - 1; i >= 0; i--) {
      const id = this.order[i];
      const r = this.rects.get(id)!;
      if (w.x >= r.x && w.x <= r.x + r.w && w.y >= r.y && w.y <= r.y + r.h) return { kind: "box", id };
    }
    return null;
  }

  /** ノードの大きさ（テキストを折り返して決める） */
  layout(n: NodeData) {
    const key = `${n.type}|${n.status}|${n.text}`;
    const cached = this.layoutCache.get(key);
    if (cached) return cached;
    const ctx = this.ctx;
    ctx.font = FONT;
    const lines: string[] = [];
    const src = n.text.trim() || "（未入力）";
    for (const para of src.split("\n")) {
      let line = "";
      for (const ch of para) {
        if (ctx.measureText(line + ch).width > MAX_W - PAD * 2 && line) {
          lines.push(line);
          line = ch;
        } else line += ch;
      }
      lines.push(line);
      if (lines.length >= 5) break;
    }
    if (lines.length > 4) {
      lines.length = 4;
      lines[3] = lines[3].slice(0, -1) + "…";
    }
    const textW = Math.max(...lines.map((l) => ctx.measureText(l).width), 90);
    const w = Math.min(MAX_W, Math.ceil(textW) + PAD * 2);
    const h = PAD * 2 + 18 + lines.length * LINE_H;
    const out = { lines, w, h };
    if (this.layoutCache.size > 2000) this.layoutCache.clear();
    this.layoutCache.set(key, out);
    return out;
  }

  draw(s: Scene, t: number) {
    const ctx = this.ctx;
    const th = theme();
    const dpr = window.devicePixelRatio || 1;
    const W = this.width;
    const H = this.height;
    const c = (this.camera = s.camera);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W / 2, H / 2);
    ctx.scale(c.zoom, c.zoom);
    ctx.translate(-c.x, -c.y);

    const hw = W / 2 / c.zoom + TILE;
    const hh = H / 2 / c.zoom + TILE;
    const view = { x0: c.x - hw, y0: c.y - hh, x1: c.x + hw, y1: c.y + hh };

    // グリッド
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1 / c.zoom;
    ctx.beginPath();
    for (let x = Math.floor(view.x0 / TILE) * TILE; x < view.x1; x += TILE) {
      ctx.moveTo(x, view.y0);
      ctx.lineTo(x, view.y1);
    }
    for (let y = Math.floor(view.y0 / TILE) * TILE; y < view.y1; y += TILE) {
      ctx.moveTo(view.x0, y);
      ctx.lineTo(view.x1, y);
    }
    ctx.stroke();

    this.drawFootprints(s, view);

    // 箱の位置を決めてから線を描く
    this.rects.clear();
    for (const n of s.nodes) {
      const l = this.layout(n);
      const cx = s.moving?.id === n.id ? s.moving.x : n.x;
      const cy = s.moving?.id === n.id ? s.moving.y : n.y;
      this.rects.set(n.id, { x: cx - l.w / 2, y: cy - l.h / 2, w: l.w, h: l.h });
    }

    // 線は親の＋ボタンから子のアンカーへ
    ctx.strokeStyle = th.edge;
    ctx.lineWidth = 2;
    for (const n of s.nodes) {
      const p = s.parents.get(n.id);
      const a = p ? this.rects.get(p) : null;
      const b = this.rects.get(n.id);
      if (!a || !b) continue;
      const from = handles(a).plus;
      const to = handles(b).anchor;
      const mx = (from.x + to.x) / 2;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.bezierCurveTo(Math.max(mx, from.x + 30), from.y, Math.min(mx, to.x - 30), to.y, to.x, to.y);
      ctx.stroke();
    }

    // 移動中・編集中の箱は最後に（上に）描く
    const front = new Set([s.moving?.id, s.editingId, s.connectFromId].filter(Boolean) as string[]);
    const ordered = [...s.nodes.filter((n) => !front.has(n.id)), ...s.nodes.filter((n) => front.has(n.id))];
    this.order = ordered.map((n) => n.id);
    for (const n of ordered) this.drawNode(n, s, th, t);

    // つなぐ先を選んでいる間は、アンカーから指・マウスまで点線を引く
    if (s.connectFromId && this.rects.has(s.connectFromId)) {
      const from = handles(this.rects.get(s.connectFromId)!).anchor;
      const to = s.pointer ?? { x: from.x - 80, y: from.y };
      ctx.save();
      ctx.setLineDash([6 / c.zoom, 6 / c.zoom]);
      ctx.strokeStyle = th.connecting;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.restore();
    }

    // 他の人が最後に編集した場所（半透明のアバター）
    for (const g of s.ghosts) {
      const p = s.profiles.get(g.userId);
      ctx.globalAlpha = 0.5;
      drawAvatar(ctx, p?.avatar ?? "slime", g.x, g.y, colorOf(p?.color), t);
      ctx.globalAlpha = 1;
      this.nameTag(p?.displayName ?? "?", `最終 ${timeAgo(g.lastSeen)}`, g.x, g.y, colorOf(p?.color), th, 0.75);
    }

    // 編集中は、その箱の横に自分のアバターを出す
    const editing = s.editingId ? this.rects.get(s.editingId) : null;
    if (editing) {
      const me = s.profiles.get(s.me);
      const at = presenceSpot(editing);
      drawAvatar(ctx, me?.avatar ?? "slime", at.x, at.y, colorOf(me?.color), t, true);
      this.nameTag(me?.displayName ?? "わたし", "", at.x, at.y, colorOf(me?.color), th, 1);
    }

    // 画面中央の小さなプラス（足跡はここに残る）
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = th.muted;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(W / 2 - 7, H / 2);
    ctx.lineTo(W / 2 + 7, H / 2);
    ctx.moveTo(W / 2, H / 2 - 7);
    ctx.lineTo(W / 2, H / 2 + 7);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawFootprints(s: Scene, view: { x0: number; y0: number; x1: number; y1: number }) {
    const ctx = this.ctx;
    const now = Date.now();
    const boost = isDark() ? 1.7 : 1;
    for (const fp of s.footprints) {
      const color = colorOf(s.profiles.get(fp.userId)?.color);
      ctx.fillStyle = color;
      for (const [key, [time, count]] of Object.entries(fp.cells)) {
        const [tx, ty] = key.split(",").map(Number);
        const x = tx * TILE + TILE / 2;
        const y = ty * TILE + TILE / 2;
        if (x < view.x0 || x > view.x1 || y < view.y0 || y > view.y1) continue;
        // 古いほど薄く、何度も通ったほど濃く大きく
        const age = Math.min(1, (now - time) / FOOTPRINT_TTL_MS);
        const alpha = Math.min(0.9, (0.1 + 0.3 * (1 - age)) * Math.min(1, 0.6 + Math.log2(count) * 0.2) * boost);
        const r = Math.min(4 + Math.log2(count) * 1.5, 8);
        // ユーザーごとに少しずらして重なりを避ける
        const off = (hash(fp.userId) % 5) - 2;
        ctx.globalAlpha = alpha;
        paw(ctx, x + off * 3, y + off * 2, r);
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawNode(n: NodeData, s: Scene, th: Theme, t: number) {
    const ctx = this.ctx;
    const r = this.rects.get(n.id)!;
    const l = this.layout(n);
    const authorColor = colorOf(s.profiles.get(n.authorId)?.color);
    // 編集中・移動中・つなぐ元の箱は、縁を別の色にする
    const mode =
      s.moving?.id === n.id ? th.moving : s.editingId === n.id ? th.editing : s.connectFromId === n.id ? th.connecting : null;
    const border = mode ?? authorColor;
    const width = mode ? 4 : n.lock ? 3 : 2;

    ctx.save();
    if (mode) {
      ctx.shadowColor = mode;
      ctx.shadowBlur = 14 + Math.sin(t / 200) * 4;
    } else {
      ctx.shadowColor = "rgba(0,0,0,0.12)";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;
    }
    if (s.moving?.id === n.id) {
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 8;
    }
    ctx.fillStyle = th.card;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 8);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = border;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 8);
    ctx.stroke();

    this.drawHandles(n, r, s, th, authorColor);

    // 作成者マーク（左上の色付きの丸）
    ctx.fillStyle = authorColor;
    ctx.beginPath();
    ctx.arc(r.x + 2, r.y + 2, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = th.card;
    ctx.lineWidth = 2;
    ctx.stroke();

    // 種類・状態
    const meta = TYPE_META[n.type];
    ctx.font = SMALL;
    ctx.fillStyle = th.muted;
    ctx.textBaseline = "top";
    let header = `${meta.icon} ${meta.label}`;
    if (n.status) header += ` · ${STATUS_LABEL[n.status]}`;
    if (n.type === "request" && n.assigneeId) header += ` → ${s.profiles.get(n.assigneeId)?.displayName ?? "?"}`;
    ctx.fillText(header, r.x + PAD + 4, r.y + PAD - 2, r.w - PAD * 2 - 20);

    // 本文
    ctx.font = FONT;
    ctx.fillStyle = n.text.trim() ? th.cardText : th.muted;
    l.lines.forEach((line, i) => ctx.fillText(line, r.x + PAD, r.y + PAD + 18 + i * LINE_H));

    // ロック（ロックした人の色の錠前）
    if (n.lock) {
      const lc = colorOf(s.profiles.get(n.lock.by)?.color);
      lock(ctx, r.x + r.w - 14, r.y + 13, lc);
    }

    // 前回の訪問以降に他の人が更新した
    if (n.updatedAt > s.lastVisit && n.updatedBy !== s.me) {
      ctx.font = 'bold 10px system-ui, sans-serif';
      const tx = r.x + r.w - (n.lock ? 54 : 34);
      ctx.fillStyle = "#f59f00";
      ctx.beginPath();
      ctx.roundRect(tx, r.y - 7, 30, 14, 7);
      ctx.fill();
      ctx.fillStyle = "#1b1b1b";
      ctx.textBaseline = "middle";
      ctx.fillText("NEW", tx + 5, r.y);
    }
  }

  /** 箱の左のアンカー（つなぐ）と右の＋ボタン（子を追加） */
  private drawHandles(n: NodeData, r: Rect, s: Scene, th: Theme, authorColor: string) {
    const ctx = this.ctx;
    const { anchor, plus } = handles(r);
    const lockedByOther = !!n.lock && n.lock.by !== s.me;
    const connecting = s.connectFromId === n.id;
    const hasParent = s.parents.get(n.id) != null;

    // アンカー：つながっていれば塗りつぶし、つなぐ元なら緑
    ctx.save();
    ctx.globalAlpha = lockedByOther ? 0.35 : 1;
    ctx.beginPath();
    ctx.arc(anchor.x, anchor.y, connecting ? ANCHOR_R + 2 : ANCHOR_R, 0, Math.PI * 2);
    ctx.fillStyle = connecting ? th.connecting : hasParent ? authorColor : th.card;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = connecting ? th.connecting : authorColor;
    ctx.stroke();
    ctx.restore();

    // ＋ボタン
    ctx.beginPath();
    ctx.arc(plus.x, plus.y, PLUS_R, 0, Math.PI * 2);
    ctx.fillStyle = th.card;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = th.muted;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(plus.x - 5, plus.y);
    ctx.lineTo(plus.x + 5, plus.y);
    ctx.moveTo(plus.x, plus.y - 5);
    ctx.lineTo(plus.x, plus.y + 5);
    ctx.lineWidth = 2;
    ctx.strokeStyle = th.cardText;
    ctx.stroke();
  }

  private nameTag(name: string, sub: string, x: number, y: number, color: string, th: Theme, alpha: number) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 12px system-ui, -apple-system, "Hiragino Sans", sans-serif';
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    const w = ctx.measureText(name).width + 14;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - 58, w, 18, 9);
    ctx.fill();
    ctx.fillStyle = isDark() ? "#14161c" : "#fff";
    ctx.fillText(name, x, y - 49);
    if (sub) {
      ctx.font = SMALL;
      ctx.fillStyle = th.muted;
      ctx.fillText(sub, x, y + 14);
    }
    ctx.restore();
  }
}

function paw(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.ellipse(x, y + r * 0.3, r * 0.75, r * 0.6, 0, 0, Math.PI * 2);
  ctx.fill();
  for (const [dx, dy] of [[-0.7, -0.55], [0, -0.85], [0.7, -0.55]]) {
    ctx.beginPath();
    ctx.arc(x + dx * r, y + dy * r, r * 0.28, 0, Math.PI * 2);
    ctx.fill();
  }
}

function lock(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y - 3, 4, Math.PI, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(x - 6, y - 3, 12, 9, 2);
  ctx.fill();
  ctx.restore();
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}
