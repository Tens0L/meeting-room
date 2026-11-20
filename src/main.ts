import { googleSession } from "./auth/google";
import { localSession, type Session } from "./auth/session";
import { Game } from "./game/game";
import { drawAvatar } from "./game/avatars";
import { Footprints } from "./model/footprints";
import { World, type Profile } from "./model/world";
import { DriveStore } from "./storage/drive";
import { LocalStore } from "./storage/local";
import type { FileStore } from "./storage/types";
import { Syncer, type SyncStatus } from "./sync/syncer";
import { TabPendingStorage, localStorageKV } from "./sync/pending";
import { isDialogOpen, openNodeEditor, openProfileEditor } from "./ui/dialogs";
import { h, toast } from "./ui/dom";
import { colorOf, firstFreeColor } from "./ui/palette";

const params = new URLSearchParams(location.search);
const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const mode = params.get("mode") ?? (CLIENT_ID ? "drive" : "local");

const $ = (id: string) => document.getElementById(id)!;

if (mode === "local") {
  void boot(localSession(params.get("user")), new LocalStore(), "local", { pollMs: 3000, flushDelayMs: 1000 });
} else {
  showLogin();
}

// ---------- ログイン画面（ドライブモード） ----------

function showLogin(error?: string) {
  const login = $("login");
  login.hidden = false;
  const savedFolder = params.get("folder") ?? localStorage.getItem("mr-folder") ?? import.meta.env.VITE_DRIVE_FOLDER_ID ?? "";
  const folderIn = h("input", { type: "text", placeholder: "共有フォルダの ID または URL", value: savedFolder });
  const btn = h("button", { type: "button", class: "primary" }, "Google でログイン");
  const msg = h("p", { class: "error" }, error ?? "");

  btn.addEventListener("click", async () => {
    const folderId = parseFolderId(folderIn.value);
    if (!CLIENT_ID) return void (msg.textContent = "VITE_GOOGLE_CLIENT_ID が設定されていません（README 参照）");
    if (!folderId) return void (msg.textContent = "共有フォルダを指定してください");
    btn.disabled = true;
    msg.textContent = "";
    try {
      const session = await googleSession(CLIENT_ID);
      localStorage.setItem("mr-folder", folderId);
      login.hidden = true;
      await boot(session, new DriveStore(folderId, session.getToken), folderId, { pollMs: 30_000, flushDelayMs: 5000 });
    } catch (e) {
      btn.disabled = false;
      msg.textContent = e instanceof Error ? e.message : String(e);
    }
  });

  login.replaceChildren(
    h("div", { class: "card" },
      h("h1", {}, "🗺️ Meeting Room"),
      h("p", {}, "マインドマップの世界を歩きながら、進捗・作業依頼・調査報告を共有する部屋です。データは Google ドライブの共有フォルダに保存されます。"),
      h("label", {}, "共有フォルダ", folderIn),
      btn,
      msg),
  );
}

function parseFolderId(v: string): string {
  const s = v.trim();
  const m = s.match(/folders\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : s;
}

// ---------- 本体 ----------

async function boot(
  session: Session,
  store: FileStore,
  roomKey: string,
  timing: { pollMs: number; flushDelayMs: number },
) {
  const me = session.userId;
  const world = new World();
  const statusEl = $("sync-status");
  // 未保存の変更の退避先（タブごとに分ける）
  const pending = new TabPendingStorage(
    localStorageKV(),
    `mr-pending:${roomKey}:${me}`,
    crypto.randomUUID(),
    Date.now,
    `mr-pending:${roomKey}:${me}`, // 以前の版のキー
  );
  setInterval(() => pending.heartbeat(), 10_000);

  const syncer = new Syncer(world.doc, store, {
    userId: me,
    pendingStorage: pending,
    onStatus: (s, detail) => renderStatus(s, detail),
  });

  function renderStatus(s: SyncStatus, detail?: string) {
    const label: Record<SyncStatus, string> = {
      synced: "✓ 保存済み",
      dirty: "● 未保存の変更あり",
      syncing: "⟳ 同期中…",
      error: "⚠ 同期エラー",
      auth: "⚠ 再ログインが必要",
    };
    statusEl.textContent = label[s];
    statusEl.className = `chip ${s}`;
    statusEl.title = detail ?? "";
    if (s === "auth") showReauth();
    if (s === "error" && detail) console.warn(detail);
  }

  const banner = $("banner");
  function showReauth() {
    if (!banner.hidden) return;
    banner.replaceChildren(
      h("span", {}, "ログインの有効期限が切れました。"),
      h("button", {
        type: "button",
        onclick: async () => {
          try {
            await session.reauth();
            banner.hidden = true;
            await syncer.syncNow();
          } catch (e) {
            toast(e instanceof Error ? e.message : String(e));
          }
        },
      }, "再ログイン"),
    );
    banner.hidden = false;
  }

  // 前回の訪問時刻（これより後の他人の更新に NEW を付ける）
  const visitKey = `mr-last-visit:${roomKey}:${me}`;
  const lastVisit = Number(localStorage.getItem(visitKey) ?? Date.now());
  const saveVisit = () => localStorage.setItem(visitKey, String(Date.now()));

  const footprints = new Footprints(store, me);
  try {
    await syncer.pull();
    await footprints.load();
  } catch (e) {
    toast(`読み込みに失敗しました: ${e instanceof Error ? e.message : e}`);
  }

  // プロフィールがなければ初期値を作って設定画面を出す
  let firstTime = false;
  if (!world.getProfile(me)) {
    firstTime = true;
    const taken = new Set<string>();
    world.profiles.forEach((p) => taken.add(p.color));
    world.setProfile(me, { displayName: session.defaultName, color: firstFreeColor(taken), avatar: "slime", statusText: "" });
  }

  // 空の部屋なら中心ノードを置く
  if (world.nodes.size === 0) {
    world.createNode(me, { parentId: null, x: 0, y: 0, text: "ミーティングルーム", type: "note" });
  }

  $("topbar").hidden = false;
  const game = new Game(
    $("world") as HTMLCanvasElement,
    world,
    footprints,
    me,
    {
      openEditor: (id, isNew, onClose) =>
        openNodeEditor(world, me, id, () => {
          // 作ったばかりの箱を空のまま閉じたら消す
          if (isNew && world.getNode(id) && !world.getNode(id)!.text.trim()) world.deleteNode(me, id);
          onClose();
        }),
      toast,
      isBlocked: () => isDialogOpen() || !$("login").hidden,
    },
    lastVisit,
  );
  const root = world.allNodes().find((n) => n.parentId == null);
  if (import.meta.env.DEV) Object.assign(window, { __mr: { game, world, syncer, footprints } });
  // 前回編集した場所（なければ最初の箱）を画面の中央にして始める
  game.start(footprints.mine.lastPos ?? { x: root?.x ?? 0, y: root?.y ?? 0 });

  // ---------- ヘッダー ----------
  const renderHeader = () => {
    const p = world.getProfile(me)!;
    const c = h("canvas", { width: "48", height: "48", style: "width:24px;height:24px" });
    const ctx = c.getContext("2d")!;
    drawAvatar(ctx, p.avatar, 24, 42, colorOf(p.color), 0);
    $("profile-btn").replaceChildren(c, p.displayName);

    const members: HTMLElement[] = [];
    world.profiles.forEach((pr: Profile, id) => {
      if (id === me) return;
      const fp = footprints.others.get(id);
      members.push(
        h("span", { class: "member", title: fp ? `最終: ${new Date(fp.lastSeen).toLocaleString()}` : "" },
          h("span", { class: "dot", style: `background:${colorOf(pr.color)}` }), pr.displayName),
      );
    });
    $("members").replaceChildren(...members);
  };
  world.profiles.observe(renderHeader);
  renderHeader();

  const editProfile = () => openProfileEditor(world, me, world.getProfile(me)!, () => toast("プロフィールを保存しました"));
  $("profile-btn").addEventListener("click", editProfile);
  $("sync-now").addEventListener("click", () => {
    Promise.all([syncer.syncNow(), footprints.save(true), footprints.pullOthers()])
      .then(() => toast("同期しました"))
      .catch(() => {});
  });
  const help = $("help");
  $("help-btn").addEventListener("click", () => (help.hidden = !help.hidden));
  $("help-close").addEventListener("click", () => (help.hidden = true));

  const touch = window.matchMedia("(pointer: coarse)").matches || params.has("touch");
  document.body.classList.toggle("touch", touch);

  if (firstTime) {
    // 説明は、画面の広いパソコンでだけ最初から開く。スマホでは「？」で開く
    if (!touch) help.hidden = false;
    editProfile();
  }

  // ---------- 定期処理 ----------
  syncer.start(timing);
  setInterval(() => {
    footprints.save().catch(() => {});
    footprints.pullOthers().then(renderHeader).catch(() => {});
  }, Math.max(timing.pollMs, 3000));

  const flushAll = () => {
    saveVisit();
    void syncer.flush().catch(() => {});
    void footprints.save(true).catch(() => {});
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAll();
  });
  window.addEventListener("pagehide", () => {
    flushAll();
    pending.retire();
  });
  // bfcache から戻ってきたら、また生きていることを知らせる
  window.addEventListener("pageshow", () => pending.heartbeat());
}
