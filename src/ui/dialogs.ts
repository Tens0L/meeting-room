import { AVATARS, AVATAR_KEYS, drawAvatar } from "../game/avatars";
import { STATUS_LABEL, TYPE_META, timeAgo } from "../game/labels";
import type { NodeStatus, NodeType, Profile, World } from "../model/world";
import { h } from "./dom";
import { PALETTE, PALETTE_KEYS, colorOf } from "./palette";

let open: HTMLDialogElement | null = null;

export function isDialogOpen() {
  // close() 直後は close イベントがまだ来ていないので、open 属性で判定する
  return open?.open ?? false;
}

function showDialog(dlg: HTMLDialogElement, onClose?: () => void) {
  document.body.append(dlg);
  open = dlg;
  dlg.addEventListener("close", () => {
    open = null;
    dlg.remove();
    onClose?.();
  });
  dlg.showModal();
}

/** ノードの編集ダイアログ */
export function openNodeEditor(world: World, me: string, nodeId: string, onClosed?: () => void) {
  const n = world.getNode(nodeId);
  if (!n) return;
  const editable = world.canEdit(nodeId, me);
  const author = world.getProfile(n.authorId);
  const name = (id: string | null) => (id ? (world.getProfile(id)?.displayName ?? "?") : "");

  const text = h("textarea", { rows: "6", placeholder: "内容を書く（Markdown 可）", disabled: !editable });
  text.value = n.text;

  const typeSel = h("select", { disabled: !editable });
  for (const [k, m] of Object.entries(TYPE_META)) typeSel.append(h("option", { value: k }, `${m.icon} ${m.label}`));
  typeSel.value = n.type;

  const statusSel = h("select", { disabled: !editable });
  for (const [k, l] of Object.entries(STATUS_LABEL)) statusSel.append(h("option", { value: k }, l));
  statusSel.value = n.status ?? "todo";

  const assigneeSel = h("select", { disabled: !editable }, h("option", { value: "" }, "（未定）"));
  world.profiles.forEach((p, id) => assigneeSel.append(h("option", { value: id }, p.displayName)));
  assigneeSel.value = n.assigneeId ?? "";

  const statusRow = h("label", {}, "状態", statusSel);
  const assigneeRow = h("label", {}, "担当", assigneeSel);
  const syncRows = () => {
    const t = typeSel.value as NodeType;
    statusRow.hidden = !(t === "progress" || t === "request");
    assigneeRow.hidden = t !== "request";
  };
  typeSel.addEventListener("change", syncRows);
  syncRows();

  const lockInfo = n.lock
    ? h("p", { class: "lock-info" }, `🔒 ${name(n.lock.by)}さんがロック中（${timeAgo(n.lock.at)}）`,
        editable ? "" : "。閲覧のみできます")
    : null;

  const dlg = h("dialog", { class: "panel" });
  const save = () => {
    if (editable) {
      const type = typeSel.value as NodeType;
      const hasStatus = type === "progress" || type === "request";
      world.updateNode(me, nodeId, {
        text: text.value,
        type,
        status: hasStatus ? (statusSel.value as NodeStatus) : null,
        assigneeId: type === "request" ? assigneeSel.value || null : null,
      });
    }
    dlg.close();
  };
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
  });

  dlg.append(
    h("h2", {}, h("span", { class: "dot", style: `background:${colorOf(author?.color)}` }), `${TYPE_META[n.type].icon} ノード`),
    h("p", { class: "meta" },
      `作成: ${author?.displayName ?? "?"}（${timeAgo(n.createdAt)}）`,
      n.updatedBy !== n.authorId ? ` / 最終更新: ${name(n.updatedBy)}（${timeAgo(n.updatedAt)}）` : ""),
    lockInfo ?? "",
    h("div", { class: "row" }, h("label", {}, "種類", typeSel), statusRow, assigneeRow),
    text,
    h("div", { class: "actions" },
      h("span", { class: "hint" }, editable ? "Ctrl+Enter で保存" : ""),
      h("button", { type: "button", onclick: () => dlg.close() }, editable ? "キャンセル" : "閉じる"),
      editable ? h("button", { type: "button", class: "primary", onclick: save }, "保存") : null),
  );
  showDialog(dlg, onClosed);
  if (editable) text.focus();
}

/** プロフィール設定ダイアログ */
export function openProfileEditor(world: World, me: string, initial: Profile, onSaved?: () => void) {
  const taken = new Map<string, string>();
  world.profiles.forEach((p, id) => {
    if (id !== me) taken.set(p.color, p.displayName);
  });

  let color = initial.color;
  let avatar = initial.avatar;

  const nameIn = h("input", { type: "text", maxlength: "20", value: initial.displayName });
  const statusIn = h("input", { type: "text", maxlength: "30", placeholder: "例: 作業中☕", value: initial.statusText });

  const colors = h("div", { class: "swatches" });
  const renderColors = () => {
    colors.replaceChildren(
      ...PALETTE_KEYS.map((k) => {
        const owner = taken.get(k);
        return h("button", {
          type: "button",
          class: `swatch${k === color ? " selected" : ""}`,
          style: `background:${colorOf(k)}`,
          title: owner ? `${PALETTE[k].label}（${owner}さんが使用中）` : PALETTE[k].label,
          "aria-label": PALETTE[k].label,
          disabled: !!owner,
          onclick: () => {
            color = k;
            renderColors();
            renderAvatars();
          },
        });
      }),
    );
  };

  const avatars = h("div", { class: "avatars" });
  const renderAvatars = () => {
    avatars.replaceChildren(
      ...AVATAR_KEYS.map((k) => {
        const c = h("canvas", { width: "96", height: "96" });
        const ctx = c.getContext("2d")!;
        ctx.scale(2, 2);
        drawAvatar(ctx, k, 24, 40, colorOf(color), 0);
        return h("button", {
          type: "button",
          class: `avatar${k === avatar ? " selected" : ""}`,
          title: AVATARS[k],
          onclick: () => {
            avatar = k;
            renderAvatars();
          },
        }, c, h("span", {}, AVATARS[k]));
      }),
    );
  };
  renderColors();
  renderAvatars();

  const dlg = h("dialog", { class: "panel" });
  const save = () => {
    world.setProfile(me, {
      displayName: nameIn.value.trim() || initial.displayName,
      color,
      avatar,
      statusText: statusIn.value.trim(),
    });
    dlg.close();
    onSaved?.();
  };
  dlg.append(
    h("h2", {}, "プロフィール"),
    h("label", {}, "表示名", nameIn),
    h("label", {}, "ひとこと", statusIn),
    h("div", { class: "field" }, h("span", {}, "テーマカラー"), colors),
    h("div", { class: "field" }, h("span", {}, "アバター"), avatars),
    h("div", { class: "actions" },
      h("button", { type: "button", onclick: () => dlg.close() }, "キャンセル"),
      h("button", { type: "button", class: "primary", onclick: save }, "保存")),
  );
  showDialog(dlg);
  nameIn.focus();
}
