import { describe, expect, it } from "vitest";
import { World } from "../src/model/world";
import { MemoryStore } from "../src/storage/memory";
import { Syncer, UPDATE_PREFIX } from "../src/sync/syncer";
import { Footprints, TILE } from "../src/model/footprints";

describe("Syncer（時間差同期）", () => {
  it("それぞれの変更が共有フォルダ経由でマージされる", async () => {
    const store = new MemoryStore();
    const alice = new World();
    const bob = new World();
    const sa = new Syncer(alice.doc, store, { userId: "alice" });
    const sb = new Syncer(bob.doc, store, { userId: "bob" });

    const root = alice.createNode("alice", { parentId: null, x: 0, y: 0, text: "ルーム" });
    await sa.syncNow();
    await sb.syncNow();
    expect(bob.getNode(root)?.text).toBe("ルーム");

    // 同じノードの別フィールドを、オフラインのまま同時に編集する
    alice.updateNode("alice", root, { text: "ルーム（改）" });
    bob.moveNode("bob", root, 100, 200);
    const child = bob.createNode("bob", { parentId: root, x: 0, y: 0, text: "bob の進捗" });
    await sa.syncNow();
    await sb.syncNow();
    await sa.syncNow();

    for (const w of [alice, bob]) {
      const n = w.getNode(root)!;
      expect(n.text).toBe("ルーム（改）");
      expect([n.x, n.y]).toEqual([100, 200]);
      expect(w.getNode(child)?.authorId).toBe("bob");
    }
  });

  it("自分の差分ファイルだけを圧縮し、内容は失われない", async () => {
    const store = new MemoryStore();
    const alice = new World();
    const sa = new Syncer(alice.doc, store, { userId: "alice", compactThreshold: 3 });
    const sb = new Syncer(new World().doc, store, { userId: "bob" });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(alice.createNode("alice", { parentId: null, x: i, y: 0, text: `n${i}` }));
      await sa.flush();
    }
    const own = await store.list(`${UPDATE_PREFIX}alice_`);
    expect(own.length).toBeLessThanOrEqual(3);

    const late = new World();
    const sl = new Syncer(late.doc, store, { userId: "late" });
    await sl.pull();
    expect(ids.map((id) => late.getNode(id)?.text)).toEqual(["n0", "n1", "n2", "n3", "n4", "n5"]);
    void sb;
  });

  it("未保存の変更を退避しておけば、再起動後に保存される", async () => {
    const store = new MemoryStore();
    let saved: Uint8Array | null = null;
    const pendingStorage = { load: () => saved, save: (u: Uint8Array | null) => (saved = u) };

    const w1 = new World();
    new Syncer(w1.doc, store, { userId: "alice", pendingStorage });
    const id = w1.createNode("alice", { parentId: null, x: 0, y: 0, text: "閉じる前のメモ" });
    expect(saved).not.toBeNull();

    // タブを閉じて開き直した想定
    const w2 = new World();
    const s2 = new Syncer(w2.doc, store, { userId: "alice", pendingStorage });
    await s2.syncNow();
    expect(saved).toBeNull();

    const other = new World();
    await new Syncer(other.doc, store, { userId: "bob" }).pull();
    expect(other.getNode(id)?.text).toBe("閉じる前のメモ");
  });
});

describe("Footprints", () => {
  it("マスが変わったときだけ記録し、他の人の足跡を読める", async () => {
    const store = new MemoryStore();
    const a = new Footprints(store, "alice");
    a.record(1, 1);
    a.record(5, 5); // 同じマス
    a.record(TILE + 1, 1);
    a.record(1, 1);
    expect(a.mine.cells["0,0"][1]).toBe(2);
    expect(a.mine.cells["1,0"][1]).toBe(1);
    await a.save();

    const b = new Footprints(store, "bob");
    await b.load();
    expect(b.others.get("alice")?.cells["0,0"][1]).toBe(2);
  });
});
