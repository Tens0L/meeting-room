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

export interface Scene {
  me: string;
  player: { x: number; y: number; walking: boolean };
  nodes: NodeData[];
  parents: Map<string, string | null>;
  profiles: Map<string, Profile>;
  footprints: FootprintData[];
  ghosts: Ghost[];
  focusId: string | null;
  carryingId: string | null;
  dropTargetId: string | null;
  /** 前回の訪問時刻。これより後に他の人が更新したノードに NEW を付ける */
  lastVisit: number;
}

const FONT = '14px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
const SMALL = '11px system-ui, -apple-system, "Hiragino Sans", "Noto Sans JP", sans-serif';
const MAX_W = 220;
const PAD = 10;
const LINE_H = 19;

interface Theme {
  bg: string;
  grid: string;
  card: string;
  cardText: string;
  muted: string;
  edge: string;
}

function theme(): Theme {
  return isDark()
    ? { bg: "#1b1f27", grid: "rgba(255,255,255,0.05)", card: "#262c38", cardText: "#e8ecf3", muted: "#9aa4b5", edge: "rgba(200,210,230,0.35)" }
    : { bg: "#f3efe6", grid: "rgba(60,50,30,0.07)", card: "#fffdf8", cardText: "#2a2620", muted: "#7b7366", edge: "rgba(80,70,50,0.35)" };
}

export class Renderer {
  readonly rects = new Map<string, Rect>();
  private layoutCache = new Map<string, { lines: string[]; w: number; h: number }>();
  camera = { x: 0, y: 0 };

  constructor(private canvas: HTMLCanvasElement) {}

  private get ctx() {
    return this.canvas.getContext("2d")!;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.floor(this.canvas.clientHeight * dpr);
  }

  screenToWorld(sx: number, sy: number) {
    return { x: sx - this.canvas.clientWidth / 2 + this.camera.x, y: sy - this.canvas.clientHeight / 2 + this.camera.y };
  }

  hitNode(wx: number, wy: number): string | null {
    for (const [id, r] of this.rects) {
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return id;
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
    const W = this.canvas.clientWidth;
    const H = this.canvas.clientHeight;
    // カメラはプレイヤーをなめらかに追う
    this.camera.x += (s.player.x - this.camera.x) * 0.12;
    this.camera.y += (s.player.y - this.camera.y) * 0.12;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = th.bg;
    ctx.fillRect(0, 0, W, H);
    ctx.translate(Math.round(W / 2 - this.camera.x), Math.round(H / 2 - this.camera.y));

    const view = { x0: this.camera.x - W / 2 - TILE, y0: this.camera.y - H / 2 - TILE, x1: this.camera.x + W / 2 + TILE, y1: this.camera.y + H / 2 + TILE };

    // グリッド
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = Math.floor(view.x0 / TILE) * TILE; x < view.x1; x += TILE) {
      ctx.moveTo(x + 0.5, view.y0);
      ctx.lineTo(x + 0.5, view.y1);
    }
    for (let y = Math.floor(view.y0 / TILE) * TILE; y < view.y1; y += TILE) {
      ctx.moveTo(view.x0, y + 0.5);
      ctx.lineTo(view.x1, y + 0.5);
    }
    ctx.stroke();

    this.drawFootprints(s, view);

    // ノードの位置を決めてから辺を描く
    this.rects.clear();
    const byId = new Map(s.nodes.map((n) => [n.id, n]));
    for (const n of s.nodes) {
      const l = this.layout(n);
      let cx = n.x;
      let cy = n.y;
      if (n.id === s.carryingId) {
        cx = s.player.x;
        cy = s.player.y - 40 - l.h / 2;
      }
      this.rects.set(n.id, { x: cx - l.w / 2, y: cy - l.h / 2, w: l.w, h: l.h });
    }

    ctx.strokeStyle = th.edge;
    ctx.lineWidth = 2;
    for (const n of s.nodes) {
      const p = s.parents.get(n.id);
      const a = p ? this.rects.get(p) : null;
      const b = this.rects.get(n.id);
      if (!a || !b) continue;
      const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.bezierCurveTo((ax + bx) / 2, ay, (ax + bx) / 2, by, bx, by);
      ctx.stroke();
    }
    // 運んでいるノードの付け替え先プレビュー
    if (s.carryingId && s.dropTargetId) {
      const a = this.rects.get(s.dropTargetId)!;
      const b = this.rects.get(s.carryingId)!;
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = colorOf(s.profiles.get(s.me)?.color);
      ctx.beginPath();
      ctx.moveTo(a.x + a.w / 2, a.y + a.h / 2);
      ctx.lineTo(b.x + b.w / 2, b.y + b.h / 2);
      ctx.stroke();
      ctx.restore();
    }

    // 運んでいるノードは最後に描く
    const order = s.nodes.filter((n) => n.id !== s.carryingId);
    if (s.carryingId && byId.has(s.carryingId)) order.push(byId.get(s.carryingId)!);
    for (const n of order) this.drawNode(n, s, th, t);

    // 他の人の最後の居場所（留守中の「ゴースト」）
    for (const g of s.ghosts) {
      const p = s.profiles.get(g.userId);
      ctx.globalAlpha = 0.5;
      drawAvatar(ctx, p?.avatar ?? "slime", g.x, g.y, colorOf(p?.color), t);
      ctx.globalAlpha = 1;
      this.nameTag(p?.displayName ?? "?", `${timeAgo(g.lastSeen)}にここにいた`, g.x, g.y, colorOf(p?.color), th, 0.75);
    }

    const me = s.profiles.get(s.me);
    drawAvatar(ctx, me?.avatar ?? "slime", s.player.x, s.player.y, colorOf(me?.color), t, s.player.walking);
    this.nameTag(me?.displayName ?? "わたし", me?.statusText ?? "", s.player.x, s.player.y, colorOf(me?.color), th, 1);
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
    const focused = n.id === s.focusId || n.id === s.dropTargetId;

    ctx.save();
    if (focused) {
      ctx.shadowColor = authorColor;
      ctx.shadowBlur = 16 + Math.sin(t / 200) * 4;
    } else {
      ctx.shadowColor = "rgba(0,0,0,0.12)";
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;
    }
    ctx.fillStyle = th.card;
    ctx.strokeStyle = authorColor;
    ctx.lineWidth = n.lock ? 3 : 2;
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 8);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = authorColor;
    ctx.lineWidth = n.lock ? 3 : 2;
    if (n.lock) ctx.setLineDash([]);
    ctx.beginPath();
    ctx.roundRect(r.x, r.y, r.w, r.h, 8);
    ctx.stroke();

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
