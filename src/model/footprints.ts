import { NotFoundError, type FileStore, type StoredFile } from "../storage/types";

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
 * 書くのは本人だけなので CRDT は使わない。
 *
 * 同じ人が複数のタブや端末で同時に開いている場合に備えて:
 * - 保存のたびに保存済みの内容を読み、マスごとに新しい方を残してから上書きする
 *   （片方のタブが歩いた跡を、もう片方が消さない）
 * - 同時に新規作成してファイルが2つできたら、ID が小さい方に1つにまとめて残りを消す
 */
export class Footprints {
  readonly mine: FootprintData;
  readonly others = new Map<string, FootprintData>();
  private dirty = false;
  private lastCell: string | null = null;
  private seenModified = new Map<string, string>();

  constructor(
    private store: FileStore,
    private userId: string,
  ) {
    this.mine = { userId, lastPos: null, lastSeen: Date.now(), cells: {} };
  }

  private get myFileName() {
    return `${FOOTPRINT_PREFIX}${this.userId}.json`;
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
    const saved = await this.readOwner(await this.store.list(FOOTPRINT_PREFIX), this.userId);
    if (saved) {
      mergeInto(this.mine, saved.data);
      // 起動直後は、前回いた場所から始める
      this.mine.lastPos = saved.data.lastPos ?? this.mine.lastPos;
    }
    await this.pullOthers();
  }

  async pullOthers() {
    const files = await this.store.list(FOOTPRINT_PREFIX);
    const owners = new Set(files.map((f) => ownerOf(f.name)));
    owners.delete(this.userId);
    for (const owner of owners) {
      const mine = files.filter((f) => ownerOf(f.name) === owner);
      const sig = mine.map((f) => f.id + "@" + f.modifiedTime).sort().join(",");
      if (this.seenModified.get(owner) === sig) continue;
      const got = await this.readOwner(mine, owner);
      if (got) this.others.set(owner, got.data);
      this.seenModified.set(owner, sig);
    }
  }

  async save(force = false) {
    if (!this.dirty && !force) return;
    const files = (await this.store.list(FOOTPRINT_PREFIX)).filter((f) => f.name === this.myFileName);
    // 別のタブや端末が保存した分を取り込む
    const saved = await this.readOwner(files, this.userId);
    if (saved) mergeInto(this.mine, saved.data);
    prune(this.mine, Date.now());
    const bytes = new TextEncoder().encode(JSON.stringify(this.mine));
    // 書き込む前に dirty を下ろす（保存中に歩いた分は次回に保存される）
    this.dirty = false;
    try {
      if (saved) {
        await this.store.overwrite(saved.keepId, bytes, "application/json");
        for (const id of saved.extraIds) await removeQuietly(this.store, id);
      } else {
        await this.store.create(this.myFileName, bytes, "application/json");
      }
    } catch (e) {
      this.dirty = true;
      // 上書きしようとしたファイルを別のタブが消していた。次回の保存でやり直す
      if (!(e instanceof NotFoundError)) throw e;
    }
  }

  /**
   * owner の足跡ファイルを読んで1つにまとめる。
   * 重複していれば、残すファイル（ID が最小）と消してよいファイルを返す
   */
  private async readOwner(
    files: StoredFile[],
    owner: string,
  ): Promise<{ data: FootprintData; keepId: string; extraIds: string[] } | null> {
    const mine = files.filter((f) => ownerOf(f.name) === owner).sort((a, b) => a.id.localeCompare(b.id));
    let data: FootprintData | null = null;
    const readable: string[] = [];
    for (const f of mine) {
      const d = await this.readFile(f.id);
      if (!d) continue;
      readable.push(f.id);
      if (data) mergeInto(data, d);
      else data = d;
    }
    if (!data) return null;
    return { data, keepId: readable[0], extraIds: readable.slice(1) };
  }

  private async readFile(id: string): Promise<FootprintData | null> {
    try {
      const data = JSON.parse(new TextDecoder().decode(await this.store.read(id))) as FootprintData;
      prune(data, Date.now());
      return data;
    } catch {
      return null; // 読む直前に消された、または壊れている
    }
  }
}

function ownerOf(name: string): string {
  return name.slice(FOOTPRINT_PREFIX.length).replace(/\.json$/, "");
}

async function removeQuietly(store: FileStore, id: string) {
  try {
    await store.remove(id);
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
}

/**
 * src の足跡を dst に取り込む。マスごとに新しい時刻と大きい回数を残す
 * （同じ足跡を何度取り込んでも回数が増えないように、足し算ではなく最大値にする）。
 * 最後にいた場所は、より新しい方を残す。
 */
export function mergeInto(dst: FootprintData, src: FootprintData) {
  for (const [k, [t, c]] of Object.entries(src.cells)) {
    const cur = dst.cells[k];
    dst.cells[k] = cur ? [Math.max(cur[0], t), Math.max(cur[1], c)] : [t, c];
  }
  if (src.lastSeen > dst.lastSeen) {
    dst.lastSeen = src.lastSeen;
    dst.lastPos = src.lastPos;
  }
}

export function prune(data: FootprintData, now: number) {
  for (const [k, [t]] of Object.entries(data.cells)) {
    if (now - t > FOOTPRINT_TTL_MS) delete data.cells[k];
  }
}
