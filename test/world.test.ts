import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { World } from "../src/model/world";

const sync = (a: World, b: World) => {
  Y.applyUpdate(b.doc, Y.encodeStateAsUpdate(a.doc));
  Y.applyUpdate(a.doc, Y.encodeStateAsUpdate(b.doc));
};

describe("World", () => {
  it("作成者が記録され、ロック中は作成者以外が編集・移動・削除できない", () => {
    const w = new World();
    const id = w.createNode("alice", { parentId: null, x: 0, y: 0, text: "調査" });
    expect(w.getNode(id)?.authorId).toBe("alice");

    expect(w.lock("alice", id)).toBe(true);
    expect(w.updateNode("bob", id, { text: "書き換え" })).toBe(false);
    expect(w.moveNode("bob", id, 10, 10)).toBe(false);
    expect(w.deleteNode("bob", id)).toBe(false);
    expect(w.unlock("bob", id)).toBe(false);
    expect(w.getNode(id)?.text).toBe("調査");

    // ロックした本人は編集できる
    expect(w.updateNode("alice", id, { text: "調査（更新）" })).toBe(true);
    // 子ノードの追加は誰でもできる
    const child = w.createNode("bob", { parentId: id, x: 0, y: 50, text: "質問" });
    expect(w.getNode(child)?.parentId).toBe(id);

    expect(w.unlock("alice", id)).toBe(true);
    expect(w.updateNode("bob", id, { text: "bob が更新" })).toBe(true);
    expect(w.getNode(id)?.updatedBy).toBe("bob");
  });

  it("削除すると子ノードは親に付け替えられる", () => {
    const w = new World();
    const root = w.createNode("a", { parentId: null, x: 0, y: 0 });
    const mid = w.createNode("a", { parentId: root, x: 0, y: 0 });
    const leaf = w.createNode("a", { parentId: mid, x: 0, y: 0 });
    w.deleteNode("a", mid);
    expect(w.getNode(leaf)?.parentId).toBe(root);
  });

  it("自分の子孫の下には付け替えられない", () => {
    const w = new World();
    const a = w.createNode("u", { parentId: null, x: 0, y: 0 });
    const b = w.createNode("u", { parentId: a, x: 0, y: 0 });
    expect(w.reparent("u", a, b)).toBe(false);
  });

  it("同時の付け替えで循環ができても、決定的にルートを1つ選んで解消する", () => {
    const alice = new World();
    const root = alice.createNode("alice", { parentId: null, x: 0, y: 0 });
    const a = alice.createNode("alice", { parentId: root, x: 0, y: 0 });
    const b = alice.createNode("alice", { parentId: root, x: 0, y: 0 });
    const bob = new World();
    sync(alice, bob);

    // オフライン中にそれぞれが付け替える：alice は A を B の下へ、bob は B を A の下へ
    expect(alice.reparent("alice", a, b)).toBe(true);
    expect(bob.reparent("bob", b, a)).toBe(true);
    sync(alice, bob);

    const pa = alice.resolveParents();
    const pb = bob.resolveParents();
    expect([...pa]).toEqual([...pb]);
    const breaker = [a, b].sort()[0];
    expect(pa.get(breaker)).toBeNull();
    // 循環が切れていること
    const other = breaker === a ? b : a;
    expect(pa.get(other)).toBe(breaker);
  });

  it("削除済みの親を指すノードはルート扱いになる", () => {
    const alice = new World();
    const p = alice.createNode("alice", { parentId: null, x: 0, y: 0 });
    const bob = new World();
    sync(alice, bob);
    alice.deleteNode("alice", p);
    const c = bob.createNode("bob", { parentId: p, x: 0, y: 0 });
    sync(alice, bob);
    expect(alice.resolveParents().get(c)).toBeNull();
  });
});
