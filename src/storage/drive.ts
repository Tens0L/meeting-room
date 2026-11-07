import { AuthExpiredError, NotFoundError, type FileStore, type StoredFile } from "./types";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";

/**
 * Google ドライブの共有フォルダを FileStore として扱う。
 * フォルダ直下にフラットにファイルを置き、名前の接頭辞で種類を分ける。
 */
export class DriveStore implements FileStore {
  constructor(
    private folderId: string,
    private getToken: () => string | null,
  ) {}

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const token = this.getToken();
    if (!token) throw new AuthExpiredError();
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) throw new AuthExpiredError();
    if (res.status === 404) throw new NotFoundError(url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Drive API ${res.status}: ${body.slice(0, 300)}`);
    }
    return res;
  }

  async list(prefix: string): Promise<StoredFile[]> {
    const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const q = `'${esc(this.folderId)}' in parents and name contains '${esc(prefix)}' and trashed = false`;
    const out: StoredFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q,
        fields: "nextPageToken, files(id, name, modifiedTime)",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.request(`${API}/files?${params}`);
      const json = (await res.json()) as { files: StoredFile[]; nextPageToken?: string };
      out.push(...json.files);
      pageToken = json.nextPageToken;
    } while (pageToken);
    // "contains" は部分一致なので、接頭辞一致に絞る
    return out.filter((f) => f.name.startsWith(prefix));
  }

  async read(id: string): Promise<Uint8Array> {
    const res = await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async create(name: string, data: Uint8Array, mimeType = "application/octet-stream"): Promise<string> {
    const boundary = "mr" + crypto.randomUUID().replace(/-/g, "");
    const meta = JSON.stringify({ name, parents: [this.folderId], mimeType });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      data as BlobPart,
      `\r\n--${boundary}--`,
    ]);
    const res = await this.request(`${UPLOAD}/files?uploadType=multipart&supportsAllDrives=true&fields=id`, {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body,
    });
    return ((await res.json()) as { id: string }).id;
  }

  async overwrite(id: string, data: Uint8Array, mimeType = "application/octet-stream"): Promise<void> {
    await this.request(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&supportsAllDrives=true`, {
      method: "PATCH",
      headers: { "Content-Type": mimeType },
      body: data as BodyInit,
    });
  }

  async remove(id: string): Promise<void> {
    await this.request(`${API}/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: "DELETE" });
  }
}
