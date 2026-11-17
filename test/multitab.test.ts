import { describe, expect, it } from "vitest";
import { World } from "../src/model/world";
import { MemoryStore } from "../src/storage/memory";
import { Syncer, UPDATE_PREFIX } from "../src/sync/syncer";
import { Footprints, FOOTPRINT_PREFIX, TILE } from "../src/model/footprints";
import { TabPendingStorage, type KV } from "../src/sync/pending";

/** localStorage の代わり（同じブラウザの複数タブで共有される） */
class MemoryKV implements KV {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  keys() {
    return [...this.m.keys()];
  }
}

describe("同じ人が複数のタブ・端末で同時に開いた場合", () => {
  it("同時に圧縮してもエラーにならず、内容も失われない", async () => {
    const store = new MemoryStore();
    // 圧縮しない設定のタブで、差分ファイルを 5 個作っておく
    const tab0 = new World();
    const s0 = new Syncer(tab0.doc, store, { userId: "alice", compactThreshold: 100 });
    for (let i = 0; i < 5; i++) {
      tab0.createNode("alice", { parentId: null, x: i, y: 0, text: `n${i}` });
      await s0.flush();
    }
    const tab1 = new World();
    const tab2 = new World();
    const s1 = new Syncer(tab1.doc, store, { userId: "alice", compactThreshold: 3 });
    const s2 = new Syncer(tab2.doc, store, { userId: "alice", compactThreshold: 3 });
    await Promise.all([s1.pull(), s2.pull()]);
    tab1.createNode("alice", { parentId: null, x: 8, y: 8, text: "tab1" });
    tab2.createNode("alice", { parentId: null, x: 9, y: 9, text: "tab2" });
    // 両方のタブが同時に「保存 → 圧縮」する（同じファイルを両方が消そうとする）
    await Promise.all([s1.flush(), s2.flush()]);
    await Promise.all([s1.syncNow(), s2.syncNow()]);

    const fresh = new World();
    await new Syncer(fresh.doc, store, { userId: "bob" }).pull();
    const texts = fresh.allNodes().map((n) => n.text).sort();
    expect(texts).toEqual(["n0", "n1", "n2", "n3", "n4", "tab1", "tab2"]);
    expect((await store.list(`${UPDATE_PREFIX}alice_`)).length).toBeLessThanOrEqual(3);
  });

  it("足跡ファイルは1つにまとまり、両方のタブで歩いた跡が残る", async () => {
    const store = new MemoryStore();
    const tab1 = new Footprints(store, "alice");
    const tab2 = new Footprints(store, "alice");
    await Promise.all([tab1.load(), tab2.load()]);
    tab1.record(1, 1);
    tab2.record(TILE * 5 + 1, 1);
    await Promise.all([tab1.save(), tab2.save()]);
    tab1.record(TILE * 2 + 1, 1);
    await tab1.save();

    const files = (await store.list(FOOTPRINT_PREFIX)).filter((f) => f.name === "fp_alice.json");
    expect(files.length).toBe(1);
    const bob = new Footprints(store, "bob");
    await bob.load();
    const cells = Object.keys(bob.others.get("alice")!.cells).sort();
    expect(cells).toEqual(["0,0", "2,0", "5,0"]);
  });

  it("未保存の退避データはタブごとに分かれ、閉じたタブの分だけ引き継ぐ", () => {
    const kv = new MemoryKV();
    let now = 1_000_000;
    const clock = () => now;
    const a = new TabPendingStorage(kv, "mr-pending:room:alice", "tabA", clock);
    const b = new TabPendingStorage(kv, "mr-pending:room:alice", "tabB", clock);
    a.heartbeat();
    b.heartbeat();
    a.save(new Uint8Array([1, 2, 3]));
    // B が保存し終わっても A の退避は消えない
    b.save(null);
    expect(kv.getItem("mr-pending:room:alice:data:tabA")).not.toBeNull();

    // A が生きている間に開いたタブ C は、A の分を横取りしない
    const c = new TabPendingStorage(kv, "mr-pending:room:alice", "tabC", clock);
    expect(c.load()).toBeNull();

    // A が閉じて（心拍が途絶えて）から開いたタブ D は、A の分を引き継ぐ
    now += 10 * 60_000;
    const d = new TabPendingStorage(kv, "mr-pending:room:alice", "tabD", clock);
    expect(d.load()).not.toBeNull();
    expect(kv.getItem("mr-pending:room:alice:data:tabA")).toBeNull();
    expect(kv.getItem("mr-pending:room:alice:data:tabD")).not.toBeNull();
  });
});
