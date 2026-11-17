/** ログイン中のユーザー */
export interface Session {
  /** 不変な ID（Google の sub）。ファイル名にも使うので英数字とハイフンのみ */
  userId: string;
  /** Google アカウントの名前（プロフィール未設定時の初期値） */
  defaultName: string;
  getToken(): string | null;
  /** トークンを取り直す（期限切れ時の再ログイン） */
  reauth(): Promise<void>;
}

/** 開発用：ログインせずに ?user=alice のように名乗る */
export function localSession(rawUser: string | null): Session {
  const userId = (rawUser ?? "alice").replace(/[^A-Za-z0-9-]/g, "").slice(0, 32) || "alice";
  return { userId, defaultName: userId, getToken: () => "local", reauth: async () => {} };
}
