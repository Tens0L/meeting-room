import * as Y from "yjs";
import { fromBase64, toBase64 } from "../storage/local";
import type { PendingStorage } from "./syncer";

/** localStorage の必要な部分だけ（テストで差し替えられるように） */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

export function localStorageKV(): KV {
  return {
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, v) => localStorage.setItem(k, v),
    removeItem: (k) => localStorage.removeItem(k),
    keys: () => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!),
  };
}

/** 心拍がこれより古いタブは閉じたものとみなす */
export const TAB_STALE_MS = 60_000;

/**
 * 未保存の変更の退避先。タブごとに別のキーに書く。
 *
 *   {prefix}:data:{tabId}   … そのタブの未保存の変更
 *   {prefix}:alive:{tabId}  … そのタブの心拍（最後に生きていた時刻）
 *
 * 1つのキーを共有すると、あるタブが保存を終えて退避を消したときに、
 * まだ保存していない別のタブの退避まで消えてしまう。
 * 起動時は、心拍が途絶えたタブ（閉じた・クラッシュした）の退避だけを引き継ぐ。
 */
export class TabPendingStorage implements PendingStorage {
  constructor(
    private kv: KV,
    private prefix: string,
    private tabId: string,
    private now: () => number = Date.now,
    /** 以前の版が使っていた、タブで共有するキー（あれば引き継ぐ） */
    private legacyKey?: string,
  ) {}

  private dataKey(tab: string) {
    return `${this.prefix}:data:${tab}`;
  }

  private aliveKey(tab: string) {
    return `${this.prefix}:alive:${tab}`;
  }

  /** 定期的に呼んで、このタブが開いていることを知らせる */
  heartbeat() {
    this.kv.setItem(this.aliveKey(this.tabId), String(this.now()));
  }

  /** タブを閉じるときに呼ぶ。未保存の分は次に開いたタブがすぐ引き継げる */
  retire() {
    this.kv.removeItem(this.aliveKey(this.tabId));
  }

  load(): Uint8Array | null {
    this.heartbeat();
    const dataPrefix = `${this.prefix}:data:`;
    const orphans: string[] = [];
    for (const key of this.kv.keys()) {
      if (!key.startsWith(dataPrefix)) continue;
      const tab = key.slice(dataPrefix.length);
      if (tab === this.tabId) continue;
      const alive = Number(this.kv.getItem(this.aliveKey(tab)) ?? 0);
      if (this.now() - alive > TAB_STALE_MS) orphans.push(tab);
    }
    const updates: Uint8Array[] = [];
    for (const tab of orphans) {
      const raw = this.kv.getItem(this.dataKey(tab));
      if (raw) updates.push(fromBase64(raw));
    }
    // 未保存の分がないまま閉じたタブの心拍も片付ける
    const alivePrefix = `${this.prefix}:alive:`;
    for (const key of this.kv.keys()) {
      if (key.startsWith(alivePrefix) && this.now() - Number(this.kv.getItem(key) ?? 0) > TAB_STALE_MS) {
        if (!this.kv.getItem(this.dataKey(key.slice(alivePrefix.length)))) this.kv.removeItem(key);
      }
    }
    const legacy = this.legacyKey ? this.kv.getItem(this.legacyKey) : null;
    if (legacy) updates.push(fromBase64(legacy));
    if (!updates.length) return null;

    // 先に自分のキーへ書いてから元を消す（途中で止まっても失われない）
    const merged = Y.mergeUpdates(updates);
    this.save(merged);
    for (const tab of orphans) {
      this.kv.removeItem(this.dataKey(tab));
      this.kv.removeItem(this.aliveKey(tab));
    }
    if (legacy && this.legacyKey) this.kv.removeItem(this.legacyKey);
    return merged;
  }

  save(update: Uint8Array | null) {
    if (update) this.kv.setItem(this.dataKey(this.tabId), toBase64(update));
    else this.kv.removeItem(this.dataKey(this.tabId));
  }
}
