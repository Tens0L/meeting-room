import type { Session } from "./session";

/**
 * Google Identity Services（ブラウザだけで完結するトークン方式）でログインする。
 * アクセストークンは約1時間で切れるので、切れたら reauth() で取り直す。
 */
const SCOPES = [
  "openid",
  "profile",
  // テスト段階ではドライブ全体（テストユーザーなら審査不要）。
  // 一般公開時は drive.file + Google Picker への移行を検討する（docs/design.md 参照）
  "https://www.googleapis.com/auth/drive",
].join(" ");

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(opts?: { prompt?: string }): void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient(cfg: {
            client_id: string;
            scope: string;
            callback: (r: TokenResponse) => void;
            error_callback?: (e: { type: string; message?: string }) => void;
          }): TokenClient;
        };
      };
    };
  }
}

function loadGis(): Promise<void> {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Google ログインのスクリプトを読み込めませんでした"));
    document.head.appendChild(s);
  });
}

export async function googleSession(clientId: string): Promise<Session> {
  await loadGis();
  let token: string | null = null;
  let expiresAt = 0;
  let waiting: { resolve: () => void; reject: (e: Error) => void } | null = null;

  const client = window.google!.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: (r) => {
      if (r.access_token) {
        token = r.access_token;
        expiresAt = Date.now() + (r.expires_in ?? 3600) * 1000 - 60_000;
        waiting?.resolve();
      } else {
        waiting?.reject(new Error(r.error_description ?? r.error ?? "ログインに失敗しました"));
      }
      waiting = null;
    },
    error_callback: (e) => {
      const msg: Record<string, string> = {
        popup_closed: "ログイン画面が閉じられました。もう一度お試しください。",
        popup_failed_to_open: "ログイン画面を開けませんでした。ブラウザのポップアップブロックを解除してください。",
      };
      waiting?.reject(new Error(msg[e.type] ?? e.message ?? e.type));
      waiting = null;
    },
  });

  const request = (prompt: string) =>
    new Promise<void>((resolve, reject) => {
      waiting = { resolve, reject };
      client.requestAccessToken({ prompt });
    });

  await request("");

  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`ユーザー情報を取得できませんでした (${res.status})`);
  const info = (await res.json()) as { sub: string; name?: string };

  return {
    userId: info.sub.replace(/[^A-Za-z0-9-]/g, ""),
    defaultName: info.name ?? "ゲスト",
    getToken: () => (token && Date.now() < expiresAt ? token : null),
    reauth: () => request(""),
  };
}
