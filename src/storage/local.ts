import { NotFoundError, type FileStore, type StoredFile } from "./types";

/**
 * 開発用のストア。localStorage に保存するので、同じブラウザの別タブ同士で
 * 「共有フォルダ」を再現できる（?mode=local&user=alice / ?mode=local&user=bob）。
 */
const INDEX_KEY = "mr-local-store:index";
const DATA_PREFIX = "mr-local-store:data:";

function loadIndex(): Record<string, StoredFile> {
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveIndex(index: Record<string, StoredFile>) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

export function toBase64(data: Uint8Array): string {
  let s = "";
  for (let i = 0; i < data.length; i += 0x8000) {
    s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class LocalStore implements FileStore {
  async list(prefix: string): Promise<StoredFile[]> {
    return Object.values(loadIndex()).filter((f) => f.name.startsWith(prefix));
  }

  async read(id: string): Promise<Uint8Array> {
    const raw = localStorage.getItem(DATA_PREFIX + id);
    if (raw == null) throw new NotFoundError(id);
    return fromBase64(raw);
  }

  async create(name: string, data: Uint8Array): Promise<string> {
    const id = crypto.randomUUID();
    localStorage.setItem(DATA_PREFIX + id, toBase64(data));
    const index = loadIndex();
    index[id] = { id, name, modifiedTime: new Date().toISOString() };
    saveIndex(index);
    return id;
  }

  async overwrite(id: string, data: Uint8Array): Promise<void> {
    const index = loadIndex();
    if (!index[id]) throw new NotFoundError(id);
    localStorage.setItem(DATA_PREFIX + id, toBase64(data));
    index[id].modifiedTime = new Date().toISOString();
    saveIndex(index);
  }

  async remove(id: string): Promise<void> {
    const index = loadIndex();
    if (!index[id]) throw new NotFoundError(id);
    localStorage.removeItem(DATA_PREFIX + id);
    delete index[id];
    saveIndex(index);
  }
}
