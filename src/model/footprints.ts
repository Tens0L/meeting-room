import type { FileStore } from "../storage/types";

export const TILE = 32;
export const FOOTPRINT_PREFIX = "fp_";
/** これより古い足跡は消す */
export const FOOTPRINT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface FootprintData {
  userId: string;
  lastPos: { x: number; y: number } | null;
  lastSeen: number;
  /** "tx,ty" → [最後に通った時刻, 通った回数] */
  cells: Record<string, [number, number]>;
}

/**
 * 足跡。マインドマップ本体とは別に、ユーザーごとの JSON ファイル `fp_{userId}.json` に保存する。
 * 書くのは本人だけなので CRDT は使わず、ファイルを丸ごと上書きする。
 */
export class Footprints {
  readonly mine: FootprintData;
  readonly others = new Map<string, FootprintData>();
  private myFileId: string | null = null;
  private dirty = false;
  private lastCell: string | null = null;
  private seenModified = new Map<string, string>();

  constructor(
    private store: FileStore,
    private userId: string,
  ) {
    this.mine = { userId, lastPos: null, lastSeen: Date.now(), cells: {} };
  }

  /** プレイヤーの位置を記録する。新しいマスに入ったときだけ足跡が増える */
  record(x: number, y: number, now = Date.now()) {
    const key = `${Math.floor(x / TILE)},${Math.floor(y / TILE)}`;
    this.mine.lastPos = { x: Math.round(x), y: Math.round(y) };
    this.mine.lastSeen = now;
    if (key !== this.lastCell) {
      this.lastCell = key;
      const prev = this.mine.cells[key];
      this.mine.cells[key] = [now, (prev?.[1] ?? 0) + 1];
      this.dirty = true;
    }
  }

  /** 起動時：自分の過去の足跡と、他の人の足跡を読み込む */
  async load() {
    const files = await this.store.list(FOOTPRINT_PREFIX);
    for (const f of files) {
      const owner = f.name.slice(FOOTPRINT_PREFIX.length).replace(/\.json$/, "");
      if (owner === this.userId) {
        this.myFileId = f.id;
        const data = await this.readFile(f.id);
        if (data) {
          Object.assign(this.mine.cells, data.cells);
          this.mine.lastPos = data.lastPos;
        }
      }
    }
    await this.pullOthers();
  }

  async pullOthers() {
    const files = await this.store.list(FOOTPRINT_PREFIX);
    for (const f of files) {
      const owner = f.name.slice(FOOTPRINT_PREFIX.length).replace(/\.json$/, "");
      if (owner === this.userId) continue;
      if (this.seenModified.get(f.id) === f.modifiedTime) continue;
      const data = await this.readFile(f.id);
      if (data) {
        this.others.set(owner, data);
        this.seenModified.set(f.id, f.modifiedTime);
      }
    }
  }

  async save(force = false) {
    if (!this.dirty && !force) return;
    prune(this.mine, Date.now());
    const bytes = new TextEncoder().encode(JSON.stringify(this.mine));
    if (this.myFileId) {
      await this.store.overwrite(this.myFileId, bytes, "application/json");
    } else {
      this.myFileId = await this.store.create(`${FOOTPRINT_PREFIX}${this.userId}.json`, bytes, "application/json");
    }
    this.dirty = false;
  }

  private async readFile(id: string): Promise<FootprintData | null> {
    try {
      const data = JSON.parse(new TextDecoder().decode(await this.store.read(id))) as FootprintData;
      prune(data, Date.now());
      return data;
    } catch {
      return null;
    }
  }
}

export function prune(data: FootprintData, now: number) {
  for (const [k, [t]] of Object.entries(data.cells)) {
    if (now - t > FOOTPRINT_TTL_MS) delete data.cells[k];
  }
}
