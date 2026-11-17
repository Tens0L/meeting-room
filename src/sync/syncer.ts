import * as Y from "yjs";
import { REMOTE_ORIGIN } from "../model/world";
import { AuthExpiredError, NotFoundError, type FileStore } from "../storage/types";

export type SyncStatus = "synced" | "dirty" | "syncing" | "error" | "auth";

export interface PendingStorage {
  load(): Uint8Array | null;
  save(update: Uint8Array | null): void;
}

export interface SyncerOptions {
  /** ファイル名に埋め込むユーザー ID（英数字とハイフンのみ） */
  userId: string;
  /** 自分の差分ファイルがこの数を超えたら1つにまとめる */
  compactThreshold?: number;
  /** 未保存の変更をブラウザに退避しておく（タブを閉じても失われないように） */
  pendingStorage?: PendingStorage;
  onStatus?: (status: SyncStatus, detail?: string) => void;
  /** リモートの更新を取り込んだときに呼ばれる */
  onRemoteApplied?: (fileCount: number) => void;
}

export const UPDATE_PREFIX = "u_";

/**
 * Y.Doc を共有フォルダ経由で「時間差同期」する。
 *
 * - 自分の変更は自分専用の差分ファイル `u_{userId}_{time}_{rand}.bin` として新規作成するだけ。
 *   既存ファイルを上書きしないので、複数人が書いても衝突しない。
 * - 読むときはフォルダ内の未適用の差分を全部 Y.applyUpdate する。
 *   CRDT なので順番は関係なく、同じものを2回適用しても結果は変わらない。
 * - 自分のファイルが増えたら、自分の分だけ1つにまとめる（他人のファイルは消さない）。
 */
export class Syncer {
  private pending: Uint8Array[] = [];
  private applied = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private status: SyncStatus = "synced";
  private timers: ReturnType<typeof setInterval>[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly compactThreshold: number;

  constructor(
    private doc: Y.Doc,
    private store: FileStore,
    private opts: SyncerOptions,
  ) {
    if (!/^[A-Za-z0-9-]+$/.test(opts.userId)) throw new Error(`invalid userId: ${opts.userId}`);
    this.compactThreshold = opts.compactThreshold ?? 20;

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE_ORIGIN) return;
      this.pending.push(update);
      this.persistPending();
      this.setStatus("dirty");
    });

    const saved = opts.pendingStorage?.load();
    if (saved) Y.applyUpdate(doc, saved, "restored-pending"); // ローカル扱いで再度キューに積まれる
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** 定期的な取得と、変更後の自動保存を開始する */
  start({ pollMs, flushDelayMs }: { pollMs: number; flushDelayMs: number }) {
    this.stop();
    this.timers.push(setInterval(() => void this.pull(), pollMs));
    this.doc.on("update", this.scheduleFlush);
    this.flushDelayMs = flushDelayMs;
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.doc.off("update", this.scheduleFlush);
    if (this.flushTimer) clearTimeout(this.flushTimer);
  }

  private flushDelayMs = 5000;
  private scheduleFlush = (_u: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN) return;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), this.flushDelayMs);
  };

  /** 取得 → 保存 → 必要なら圧縮、をまとめて行う */
  syncNow(): Promise<void> {
    return this.run(async () => {
      await this.pullInner();
      await this.flushInner();
      await this.compactInner();
    });
  }

  pull(): Promise<void> {
    return this.run(() => this.pullInner());
  }

  flush(): Promise<void> {
    return this.run(async () => {
      await this.flushInner();
      await this.compactInner();
    });
  }

  // ---------- 内部処理（run で直列化して実行する） ----------

  private run(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      this.setStatus("syncing");
      try {
        await fn();
        this.setStatus(this.pending.length ? "dirty" : "synced");
      } catch (e) {
        if (e instanceof AuthExpiredError) this.setStatus("auth", e.message);
        else this.setStatus("error", e instanceof Error ? e.message : String(e));
        throw e;
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async pullInner() {
    const files = await this.store.list(UPDATE_PREFIX);
    const fresh = files.filter((f) => !this.applied.has(f.id));
    if (!fresh.length) return;
    const datas = await Promise.all(
      fresh.map(async (f) => {
        try {
          return { f, data: await this.store.read(f.id) };
        } catch {
          return null; // 読む直前に圧縮で消された場合など。次回の一覧で拾い直す
        }
      }),
    );
    const ok = datas.filter((d): d is NonNullable<typeof d> => d != null);
    if (!ok.length) return;
    const merged = Y.mergeUpdates(ok.map((d) => d.data));
    Y.applyUpdate(this.doc, merged, REMOTE_ORIGIN);
    ok.forEach((d) => this.applied.add(d.f.id));
    this.opts.onRemoteApplied?.(ok.length);
  }

  private async flushInner() {
    if (!this.pending.length) return;
    const batch = this.pending;
    const merged = Y.mergeUpdates(batch);
    const id = await this.store.create(this.newFileName(), merged);
    this.applied.add(id);
    // 保存中に増えた分は残す
    this.pending = this.pending.slice(batch.length);
    this.persistPending();
  }

  private async compactInner() {
    const own = (await this.store.list(`${UPDATE_PREFIX}${this.opts.userId}_`)).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (own.length <= this.compactThreshold) return;
    // 同じ人の別のタブや端末が同時に圧縮していると、読む前に消されていることがある。
    // 消えていたファイルは向こうがまとめ済みなので、こちらでは扱わない
    const read = await Promise.all(
      own.map(async (f) => {
        try {
          return { f, data: await this.store.read(f.id) };
        } catch (e) {
          if (e instanceof NotFoundError) return null;
          throw e;
        }
      }),
    );
    const ok = read.filter((r): r is NonNullable<typeof r> => r != null);
    if (ok.length < 2) return;
    const id = await this.store.create(this.newFileName(), Y.mergeUpdates(ok.map((r) => r.data)));
    this.applied.add(id);
    // 新しいファイルを作ってから古いものを消す（途中で失敗してもデータは失われない）
    for (const { f } of ok) {
      try {
        await this.store.remove(f.id);
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e; // すでに別のタブが消していた
      }
    }
  }

  private newFileName(): string {
    const ts = new Date().toISOString().replace(/[-:.]/g, "");
    const rand = Math.random().toString(36).slice(2, 8);
    return `${UPDATE_PREFIX}${this.opts.userId}_${ts}_${rand}.bin`;
  }

  private persistPending() {
    const ps = this.opts.pendingStorage;
    if (!ps) return;
    ps.save(this.pending.length ? Y.mergeUpdates(this.pending) : null);
  }

  private setStatus(s: SyncStatus, detail?: string) {
    if (s === this.status && !detail) return;
    this.status = s;
    this.opts.onStatus?.(s, detail);
  }
}
