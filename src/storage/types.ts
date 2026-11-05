/** 共有フォルダ内のファイル1件のメタ情報 */
export interface StoredFile {
  id: string;
  name: string;
  /** ISO 8601。変更検知に使う */
  modifiedTime: string;
}

/**
 * 共有フォルダを抽象化したもの。
 * 本番は Google ドライブ、開発時は localStorage（タブ間で共有）を使う。
 */
export interface FileStore {
  /** name が prefix で始まるファイルを列挙する */
  list(prefix: string): Promise<StoredFile[]>;
  read(id: string): Promise<Uint8Array>;
  /** 新規作成して ID を返す */
  create(name: string, data: Uint8Array, mimeType?: string): Promise<string>;
  /** 既存ファイルの中身を置き換える */
  overwrite(id: string, data: Uint8Array, mimeType?: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export class AuthExpiredError extends Error {
  constructor() {
    super("認証の有効期限が切れました。再ログインしてください。");
    this.name = "AuthExpiredError";
  }
}
