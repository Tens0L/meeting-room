import { NotFoundError, type FileStore, type StoredFile } from "./types";

interface Entry extends StoredFile {
  data: Uint8Array;
}

/** テスト用のメモリ上のストア。複数クライアントで同じインスタンスを共有して使う */
export class MemoryStore implements FileStore {
  private files = new Map<string, Entry>();
  private seq = 0;
  private clock = 0;

  private now(): string {
    // 同一ミリ秒でも順序がつくように単調増加させる
    this.clock = Math.max(this.clock + 1, Date.now());
    return new Date(this.clock).toISOString();
  }

  async list(prefix: string): Promise<StoredFile[]> {
    return [...this.files.values()]
      .filter((f) => f.name.startsWith(prefix))
      .map(({ id, name, modifiedTime }) => ({ id, name, modifiedTime }));
  }

  async read(id: string): Promise<Uint8Array> {
    const f = this.files.get(id);
    if (!f) throw new NotFoundError(id);
    return f.data.slice();
  }

  async create(name: string, data: Uint8Array): Promise<string> {
    const id = `mem-${++this.seq}`;
    this.files.set(id, { id, name, data: data.slice(), modifiedTime: this.now() });
    return id;
  }

  async overwrite(id: string, data: Uint8Array): Promise<void> {
    const f = this.files.get(id);
    if (!f) throw new NotFoundError(id);
    f.data = data.slice();
    f.modifiedTime = this.now();
  }

  async remove(id: string): Promise<void> {
    // ドライブと同じく、存在しないファイルの削除はエラーにする
    if (!this.files.delete(id)) throw new NotFoundError(id);
  }
}
