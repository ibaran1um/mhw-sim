// 画面ロジック（計算は worker.js に依頼）
import { TALISMAN_GROUPS, TALISMAN_ROWS } from "./talisman_table.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const PARTS = ["頭", "胴", "腕", "腰", "脚"];
const KIND = { weapon: "武器", armor: "防具", set: "シリーズ", group: "グループ" };
const RES = ["火", "水", "雷", "氷", "龍"];

let data = null;
let skillsSorted = [];
let obtainable = new Set();
const decoLv = {}; // スキル → そのスキルだけが付く装飾品の最小スロットLv // 防具・装飾品・護石・シリーズ/グループで付けられるスキル
const curWeapon = () => (data.weapons[state.wType] || []).find((x) => x.n === state.wName) || null;
// 武器固有スキル（その武器にしか付かない）は、選んだ武器が持っているときだけ扱う
const usable = (id) => obtainable.has(id) || !!curWeapon()?.sk?.[id];
const LS = "mhws-sim-v1";
const state = {
  want: {}, cat: "all", wType: "", wName: "", wSl: [3, 3, 3], kyo: false, kyoSet: "", kyoGroup: "", kyoCount: 1,
  kyoOff: [], minRar: 1, minDef: "", minRes: ["", "", "", "", ""], useCrafted: true, talismans: [],
  exclude: [], fix: {}, decoExclude: [], decoLimit: {}, tab: "cond", mysets: [], limitBreak: true,
};
const cards = []; // 画面に出した結果（マイセット登録用）
let firstVisit = true;
try { const saved = localStorage.getItem(LS); if (saved) { Object.assign(state, JSON.parse(saved)); firstVisit = false; } } catch (e) { /* 保存なしで動く */ }
const save = () => { try { localStorage.setItem(LS, JSON.stringify(state)); } catch (e) { /* 無視 */ } };

// ---------------------------------------------------------------- Worker
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let seq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const { id, result, error, progress } = e.data;
  const p = pending.get(id);
  if (!p) return;
  if (progress) { setProg(progress[0] / progress[1]); return; }
  pending.delete(id);
  error ? p.reject(new Error(error)) : p.resolve(result);
};
worker.onerror = (e) => setStatus(`計算エンジンを起動できませんでした（${esc(e.message || "不明なエラー")}）。ページを再読み込みしてください。`, "ng");
const call = (cmd, req, opts) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ id, cmd, req, opts }); });
const setProg = (r) => { $("prog").style.width = `${Math.round(r * 100)}%`; };

// ---------------------------------------------------------------- 表示ヘルパ
const sn = (id) => data.skills[id]?.n || id;
const slotHtml = (sl = [], wsl = [], free = false) =>
  `<span class="slots">${wsl.map((l) => `<span class="slot w${free ? " free" : ""}">${l}</span>`).join("")}${sl.map((l) => `<span class="slot${free ? " free" : ""}">${l}</span>`).join("")}</span>`;
const pips = (lv, max) => `<span class="pips">${"■".repeat(Math.min(lv, max))}<i>${"■".repeat(Math.max(0, max - lv))}</i> <span class="lvnum">${lv}/${max}</span></span>`;
function setStatus(html, cls = "") { const el = $("status"); el.className = `status ${cls}`; el.innerHTML = html; }
function busy(on) {
  document.querySelectorAll("#resultActions button[data-act]").forEach((b) => { if (b.dataset.act !== "reset") b.disabled = on; });
  if (!on) setProg(0);
}
function toResults() {
  showTab("search");
  requestAnimationFrame(() => $("resultArea").scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
}
function showTab(t) {
  if (!["search", "own", "myset"].includes(t)) t = "search";
  state.tab = t; $("layout").dataset.tab = t;
  for (const b of document.querySelectorAll(".tabs button")) b.classList.toggle("on", b.dataset.tab === t);
  save();
}

// ---------------------------------------------------------------- スキル選択
function renderWant() {
  const ids = Object.keys(state.want).filter((k) => state.want[k] > 0 && usable(k));
  const html = ids.length
    ? ids.map((id) => `<span class="chip">${esc(sn(id))} <b>${data.skills[id].k === "group" ? "" : "Lv" + state.want[id]}</b><button data-rm="${id}" aria-label="${esc(sn(id))}を外す">×</button></span>`).join("")
    : `<span class="empty">まだ選んでいません。下の一覧からLvを押して追加します。</span>`;
  $("wantChips").innerHTML = html;
}
function renderSkillList() {
  const q = $("skillQ").value.trim();
  const row = (s) => {
    const cur = state.want[s.id] || 0;
    const levels = s.k === "group" ? [1] : Array.from({ length: s.max }, (_, i) => i + 1);
    const label = (l) => (s.k === "set" ? ["", "Ⅰ", "Ⅱ", "Ⅲ"][l] || l : s.k === "group" ? "発動" : l);
    const own = !obtainable.has(s.id) ? `<span class="kind">この武器のみ</span>` : "";
    return `<div class="skill-row${cur ? " picked" : ""}"><span class="nm">${esc(s.n)}</span>${own}
      <span class="lv">${levels.map((l) => `<button class="${cur === l ? "on" : ""}" data-sk="${s.id}" data-lv="${l}">${label(l)}</button>`).join("")}</span></div>`;
  };
  // 武器・防具スキルは「装飾品のスロットLv」ごとに分ける
  const sub = (k, lv) => {
    const icon = (n) => `<span class="slot${k === "weapon" ? " w" : ""}">${n}</span>`;
    return lv ? `${icon(lv)} スロット${lv}の装飾品で付く` : "装飾品なし（防具・武器・護石のみ）";
  };
  const html = ["weapon", "armor", "set", "group"].map((k) => {
    const rows = skillsSorted.filter((s) => s.k === k && usable(s.id) && (!q || s.n.includes(q)));
    if (!rows.length) return "";
    if (k === "set" || k === "group") return `<div><h3>${KIND[k]}スキル</h3><div class="skill-grid">${rows.map(row).join("")}</div></div>`;
    const parts = [3, 2, 1, 0].map((lv) => {
      const rs = rows.filter((s) => (decoLv[s.id] || 0) === lv);
      return rs.length ? `<div class="skill-sub"><h4>${sub(k, lv)}<span class="cnt">${rs.length}</span></h4><div class="skill-grid">${rs.map(row).join("")}</div></div>` : "";
    }).join("");
    return `<div><h3>${KIND[k]}スキル</h3>${parts}</div>`;
  }).join("");
  $("skillList").innerHTML = html || `<div class="empty">該当するスキルがありません。</div>`;
}

// ---------------------------------------------------------------- 武器
function optList(el, items, cur) { el.innerHTML = items.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(cur) ? " selected" : ""}>${esc(t)}</option>`).join(""); }
function renderWeapon() {
  optList($("wType"), Object.keys(data.weapons).map((t) => [t, t]), state.wType);
  state.wType = $("wType").value;
  const ws = data.weapons[state.wType] || [];
  optList($("wSel"), [["", "手入力"], ...ws.filter((w) => w.r >= 5 && !w.n.includes("アーティア")).sort((a, b) => b.r - a.r).map((w) => [w.n, `R${w.r} ${w.n}`])], state.wName);
  const w = ws.find((x) => x.n === state.wName);
  // 生産武器のスロットは表示だけ。手入力のスロット設定は残しておく
  const shown = w ? [0, 1, 2].map((i) => w.sl[i] || 0) : state.wSl;
  ["wS0", "wS1", "wS2"].forEach((id, i) => { optList($(id), [[0, "－"], [1, "[1]"], [2, "[2]"], [3, "[3]"]], shown[i] || 0); $(id).disabled = !!w; });
  $("wSkills").textContent = w && Object.keys(w.sk).length ? "武器スキル: " + Object.entries(w.sk).map(([id, l]) => `${sn(id)}${l}`).join("・") : "";
  // 巨戟アーティアは手入力のときだけ。生産武器では使わない
  const kyoOn = state.kyo && !w;
  $("kyo").closest("label").hidden = !!w;
  $("kyo").checked = state.kyo;
  $("kyoBox").hidden = !kyoOn;
  document.querySelector('#resultActions [data-act="kyo"]').hidden = !kyoOn;
  const sets = skillsSorted.filter((s) => s.k === "set"), grps = skillsSorted.filter((s) => s.k === "group");
  optList($("kyoSet"), [["", "未定（成立するものを探す）"], ...sets.map((s) => [s.id, s.n])], state.kyoSet);
  optList($("kyoGroup"), [["", "未定（成立するものを探す）"], ...grps.map((s) => [s.id, s.n])], state.kyoGroup);
  $("kyoCount").value = state.kyoCount;
  $("kyoPool").innerHTML = [...sets, ...grps].map((s) => `<label class="chk"><input type="checkbox" data-pool="${s.id}"${state.kyoOff.includes(s.id) ? "" : " checked"}> ${esc(s.n)}</label>`).join("");
}

// ---------------------------------------------------------------- 防具条件
function renderArmorCond() {
  optList($("minRar"), [1, 2, 3, 4, 5, 6, 7, 8].map((r) => [r, r === 1 ? "指定なし" : `R${r}以上`]), state.minRar);
  $("minDef").value = state.minDef;
  $("resRow").innerHTML = `<span class="muted">耐性下限</span>` + RES.map((r, k) => `<label class="row" style="gap:4px">${r}<input type="number" data-res="${k}" value="${esc(state.minRes[k])}" style="width:3.6em"></label>`).join("");
  $("useCrafted").checked = state.useCrafted;
  $("limitBreak").checked = state.limitBreak;
}

// ---------------------------------------------------------------- 護石
function renderTalismanForm() {
  const skillOpts = [["", "（スキルなし）"], ...skillsSorted.filter((s) => s.k === "weapon" || s.k === "armor").map((s) => [s.id, s.n])];
  for (let i = 0; i < 3; i++) {
    optList($(`tk${i}`), skillOpts, "");
    optList($(`tl${i}`), [1, 2, 3, 4, 5].map((l) => [l, `Lv${l}`]), 1);
    optList($(`ts${i}`), [[0, "－"], [1, "①"], [2, "②"], [3, "③"]], 0);
  }
}
function renderTalismans() {
  $("talList").innerHTML = state.talismans.length ? state.talismans.map((t, i) => `<div class="row" style="justify-content:space-between">
      <span>${esc(Object.entries(t.sk).map(([id, l]) => `${sn(id)}${l}`).join(" / ") || "スキルなし")} ${slotHtml(t.sl, t.wsl)}</span>
      <button class="mini" data-trm="${i}">削除</button></div>`).join("")
    : `<div class="empty">登録された護石はありません。護石なしでも検索できます。</div>`;
}

// ---------------------------------------------------------------- 固定・除外
function renderFix() {
  const fx = Object.entries(state.fix).map(([p, n]) => `<div class="row" style="justify-content:space-between"><span><span class="muted small">${PARTS[p]}固定</span> ${esc(n)}</span><button class="mini" data-unfix="${p}">解除</button></div>`);
  const ex = state.exclude.map((n) => `<div class="row" style="justify-content:space-between"><span><span class="muted small">除外</span> ${esc(n)}</span><button class="mini" data-unex="${esc(n)}">戻す</button></div>`);
  $("fixList").innerHTML = [...fx, ...ex].join("") || `<div class="empty">結果の防具から「固定」「除外」を押すとここに並びます。</div>`;
}

// ---------------------------------------------------------------- マイセット
function renderMysets() {
  const list = state.mysets || [];
  $("mysetList").innerHTML = list.length ? list.map((m, i) => `<div class="tal">
      <div class="row"><input type="text" class="grow" data-mname="${i}" value="${esc(m.name)}" aria-label="セット名"><span class="def small">防御 <b>${m.s.def}</b></span></div>
      <div class="small muted">${m.s.armors.map((a) => esc(a.n)).join("／")}${m.s.talisman ? "／" + esc(m.s.talisman.name) : ""}</div>
      <div class="small">${m.s.skills.filter((k) => m.want && m.want[k.id]).map((k) => `${esc(k.n)}${k.k === "group" ? "" : k.k === "set" ? ["", "Ⅰ", "Ⅱ", "Ⅲ"][k.lv] : k.lv}`).join("・")}</div>
      <div class="row"><button class="mini" data-mshow="${i}">表示</button><button class="mini" data-mdel="${i}">削除</button></div></div>`).join("")
    : `<div class="empty">検索結果の「マイセット登録」を押すと、ここに保存されます。</div>`;
}

// ---------------------------------------------------------------- 装飾品
function renderDecos() {
  const q = $("decoQ").value.trim();
  const rows = data.decos.map((d, i) => ({ d, i, sk: Object.entries(d.sk).map(([id, l]) => `${sn(id)}${l}`).join("・") }))
    .filter(({ d, sk }) => !q || d.n.includes(q) || sk.includes(q)).slice(0, 120);
  $("decoList").innerHTML = rows.map(({ d, sk }) => {
    const off = state.decoExclude.includes(d.n);
    return `<div class="skill-row"><label class="chk nm"><input type="checkbox" data-deco="${esc(d.n)}"${off ? "" : " checked"}> ${esc(d.n)}</label>
      <span class="small muted">${esc(sk)}</span><input type="number" min="0" placeholder="所持" aria-label="${esc(d.n)}の所持数" data-dlim="${esc(d.n)}" value="${state.decoLimit[d.n] ?? ""}" style="width:3.8em"></div>`;
  }).join("");
}

// ---------------------------------------------------------------- リクエスト
function buildReq() {
  const ws = data.weapons[state.wType] || [];
  const w = ws.find((x) => x.n === state.wName);
  const pool = (k) => skillsSorted.filter((s) => s.k === k && !state.kyoOff.includes(s.id)).map((s) => s.id);
  return {
    want: Object.fromEntries(Object.entries(state.want).filter(([id, l]) => l > 0 && usable(id))),
    weapon: {
      sl: (w ? w.sl : state.wSl).filter((l) => l > 0), sk: w ? w.sk : {},
      kyo: state.kyo && !w, kyoSet: state.kyoSet || null, kyoGroup: state.kyoGroup || null,
      kyoSetPool: pool("set"), kyoGroupPool: pool("group"),
    },
    kyoCount: +state.kyoCount || 1,
    talismans: state.talismans.map((t, i) => ({ name: `登録護石${i + 1}`, ...t })),
    useCrafted: state.useCrafted, limitBreak: state.limitBreak,
    exclude: state.exclude, fix: state.fix, minRarity: +state.minRar || 0,
    decoExclude: state.decoExclude, decoLimit: state.decoLimit,
    minDef: +state.minDef || 0, minRes: state.minRes.map((v) => (v === "" ? null : +v)),
  };
}

// ---------------------------------------------------------------- 結果描画
function resultCard(s, idx, req, opts = {}) {
  const wantIds = new Set(Object.keys(req.want));
  const rows = s.armors.map((a) => `<tr><td class="part">${PARTS[a.p]}</td><td class="nm">${esc(a.n)} ${slotHtml(a.sl)}${a.lb ? ` <span class="kind">限界突破</span>` : ""}${a.deco.length ? `<div class="decos">${a.deco.map(esc).join("、")}</div>` : ""}</td>
    <td class="ops">${a.n.startsWith("（") || opts.noSave ? "" : `<button class="mini" data-fix="${a.p}" data-n="${esc(a.n)}">固定</button> <button class="mini" data-ex="${esc(a.n)}">除外</button>`}</td></tr>`).join("");
  let tal = "";
  if (s.talisman) tal = `<tr><td class="part">護石</td><td colspan="2">${esc(s.talisman.name)} <span class="small muted">${esc(Object.entries(s.talisman.sk).map(([id, l]) => sn(id) + l).join(" / "))}</span> ${slotHtml(s.talisman.sl, s.talisman.wsl)}${s.talisman.deco.length ? `<div class="decos">${s.talisman.deco.map(esc).join("、")}</div>` : ""}</td></tr>`;
  else if (s.vtal) tal = `<tr><td class="part">護石</td><td colspan="2"><span class="rar r${s.vtal.rar}">R${s.vtal.rar}</span> ${esc(s.vtal.name)}（下の条件）${s.vtal.deco.length ? `<div class="decos">${s.vtal.deco.map(esc).join("、")}</div>` : ""}</td></tr>`;
  else tal = `<tr><td class="part">護石</td><td colspan="2" class="muted">なし</td></tr>`;
  const wrow = `<tr><td class="part">武器</td><td colspan="2">${s.weaponDeco.length ? `<span class="decos">${s.weaponDeco.map(esc).join("、")}</span>` : `<span class="muted small">装飾品なし</span>`}${s.kyo.set || s.kyo.group ? `<div class="small">巨戟付与: <b>${esc(s.kyo.set ? sn(s.kyo.set) : "－")}</b> ＋ <b>${esc(s.kyo.group ? sn(s.kyo.group) : "－")}</b></div>` : ""}</td></tr>`;
  const skills = s.skills.map((k) => `<div class="sk${wantIds.has(k.id) ? " want" : ""}"><span class="${k.k === "set" || k.k === "group" ? "tag-set" : ""}">${esc(k.n)}</span>${k.k === "group" ? "発動" : k.k === "set" ? `<span class="lvnum" style="font-size:.9rem;color:var(--ink)">Lv${k.lv}<span class="muted small">（${k.pts}部位）</span></span>` : pips(k.lv, k.max)}</div>`).join("");
  const free = s.free.w.length + s.free.a.length ? `<span class="small muted">空き ${slotHtml(s.free.a, s.free.w, true)}</span>` : `<span class="small muted">空きなし</span>`;
  const saveBtn = opts.noSave ? "" : `<button class="mini" data-save="${cards.push({ s, want: req.want }) - 1}">マイセット登録</button>`;
  return `<article class="result"><header><span class="def">${opts.title ? esc(opts.title) : "#" + (idx + 1)} 防御 <b>${s.def}</b></span>${saveBtn}<span class="res">${RES.map((r, k) => `${r}${s.res[k] > 0 ? "+" : ""}${s.res[k]}`).join(" ")}</span>${free}</header>
    <div class="list-scroll"><table class="gear">${wrow}${rows}${tal}</table></div><div class="sk-grid">${skills}</div></article>`;
}
// 同じ必要スキルの提案を1枚にまとめる。スロットは「これ以上あれば成立」の最小形だけ残す
function parseSlots(pat) {
  const a = [], w = [];
  for (const x of pat.split(",")) x === "w1" ? w.push(1) : a.push(+x);
  return { w: w.length, a: a.sort((x, y) => y - x) };
}
function slotLE(q, p) { // q の要求が p 以下（q で足りるなら p でも足りる）
  if (q.w > p.w) return false;
  for (let i = 0; i < 3; i++) if ((q.a[i] || 0) > (p.a[i] || 0)) return false;
  return true;
}
function groupSuggestions(res) {
  const groups = new Map();
  for (const s of res) {
    const need = s.vtal.picks.filter((p) => p && p.id).map((p) => ({ n: p.n, lv: p.lv })).sort((a, b) => a.n.localeCompare(b.n, "ja"));
    const key = need.map((x) => x.n + x.lv).join("+");
    const g = groups.get(key) || { need, rars: new Set(), pats: [], sol: s };
    g.rars.add(s.vtal.rar);
    if (s.vtal.rar < g.sol.vtal.rar) g.sol = s;
    if (!g.pats.includes(s.vtal.slots)) g.pats.push(s.vtal.slots);
    groups.set(key, g);
  }
  for (const g of groups.values()) {
    const ps = g.pats.map((x) => ({ x, v: parseSlots(x) }));
    g.minPats = ps.filter((p) => !ps.some((q) => q.x !== p.x && slotLE(q.v, p.v))).map((p) => p.v);
    // 抽選テーブルから、この必要スキルとスロットが出うるレア度を全部求める
    for (const [rar, g1, g2, g3, pats] of TALISMAN_ROWS) {
      if (g.rars.has(rar)) continue;
      const gs = [g1, g2, g3].filter(Boolean);
      const has = (grp, x) => TALISMAN_GROUPS[grp].list.some(([n, lv]) => n.normalize("NFKC") === x.n && lv === x.lv);
      const assign = (k, used) => k === g.need.length || gs.some((grp, i) => !used.has(i) && has(grp, g.need[k]) && assign(k + 1, new Set([...used, i])));
      if (!assign(0, new Set())) continue;
      if (pats.some((pt) => g.minPats.some((mp) => slotLE(mp, parseSlots(pt))))) g.rars.add(rar);
    }
    g.minRar = Math.min(...g.rars);
  }
  // 他の提案より条件が厳しいだけのもの（攻撃Lv2で足りるのに攻撃Lv3 など）は省く
  const list = [...groups.values()];
  const covers = (h, g) => h !== g && h.need.every((x) => g.need.some((y) => y.n === x.n && y.lv >= x.lv))
    && g.minPats.every((pg) => h.minPats.some((ph) => slotLE(ph, pg)));
  return list.filter((g) => !list.some((h) => covers(h, g) && !(covers(g, h) && list.indexOf(g) < list.indexOf(h))))
    .sort((a, b) => a.minRar - b.minRar || a.need.length - b.need.length);
}
const NAMES = { 5: "未開の護石", 6: "史伝の護石", 7: "秘歴の護石", 8: "栄世の護石" };
function talCard(g) {
  const need = g.need.length ? g.need.map((x) => `<b>${esc(x.n)} Lv${x.lv}</b><span class="muted small">以上</span>`).join(" ＋ ") : `<b>スキルは何でもよい</b>`;
  const slotStr = (v) => [...Array(v.w).fill(`<span class="slot w">1</span>`), ...v.a.map((l) => `<span class="slot">${l}</span>`)].join("") || "なし";
  const slots = g.minPats.map((v) => `<span class="slots">${slotStr(v)}</span>`).join(`<span class="muted small"> または </span>`);
  const rars = [...g.rars].sort().map((r) => `<span style="white-space:nowrap"><span class="rar r${r}">R${r}</span> ${NAMES[r]}</span>`).join(" ");
  return `<div class="tal"><div class="nm">${need}</div>
    <div class="row small"><span class="muted">スロット</span>${slots}<span class="muted">以上</span></div>
    <div class="row small"><span class="muted">出る護石</span>${rars}</div>
    <details><summary>この護石での装備例（防御${g.sol.def}）</summary>${resultCard(g.sol, 0, lastReq)}</details></div>`;
}

let lastReq = null;
async function doSearch() {
  const req = buildReq(); lastReq = req;
  if (!Object.keys(req.want).length) { setStatus("スキルを1つ以上選んでください。", "ng"); toResults(); return; }
  busy(true); toResults(); setStatus("検索中…"); $("out").innerHTML = "";
  try {
    const t0 = performance.now();
    const res = await call("search", req, { limit: 30 });
    if (res.length) {
      setStatus(`<b>${res.length}件</b>見つかりました（防御力の高い順、${Math.round(performance.now() - t0)}ms）。`, "ok");
      $("out").innerHTML = res.map((s, i) => resultCard(s, i, req)).join("");
      if (state.kyo && !state.wName && !state.kyoSet) $("out").insertAdjacentHTML("afterbegin", `<p class="small muted" style="margin:0">巨戟のシリーズ・グループが「未定」のため、成立する組み合わせを自動で選んでいます。</p>`);
    } else {
      setStatus("この条件では装備が組めません。あれば成立する護石と、巨戟の切替候補を調べています…", "ng");
      const nTal = await doSuggest(true);
      const kyo = state.kyo && !state.wName ? await doKyo(true) : null;
      const parts = [`この条件では装備が組めません。`];
      parts.push(nTal ? `下の<b>${nTal}種類</b>の護石のどれかがあれば成立します。` : "抽選テーブル上のどの護石でも成立しません。");
      if (kyo) parts.push(`巨戟はシリーズ${kyo[0]}種・グループ${kyo[1]}種で成立します。`);
      setStatus(parts.join(""), "ng");
    }
  } catch (e) { setStatus(`計算に失敗しました: ${esc(e.message)}`, "ng"); }
  busy(false);
}
async function doSuggest(append = false) {
  const req = buildReq(); lastReq = req;
  if (!Object.keys(req.want).length) { setStatus("スキルを1つ以上選んでください。", "ng"); return; }
  if (!append) { busy(true); toResults(); setStatus("鑑定護石の抽選テーブルから探しています…"); $("out").innerHTML = ""; }
  try {
    const res = groupSuggestions(await call("suggest", req, { limit: 24 }));
    const head = `<h3>この護石があれば成立</h3><p class="small muted" style="margin:0">登録済み・製作護石の代わりに、光るおまもりの抽選テーブルに存在する護石を当てはめた結果です。必要なスキルとスロットだけ表示しています。ほかに何のスキルが付いていても成立します。</p>`;
    const body = res.length ? res.map(talCard).join("") : `<div class="empty">抽選テーブル上のどの護石を使っても成立しません。スキルを減らすか、Lvを下げてください。</div>`;
    $("out").insertAdjacentHTML("beforeend", `<section class="stack">${head}${body}</section>`);
    if (!append) setStatus(res.length ? `<b>${res.length}種類</b>の護石で成立します。` : "どの護石でも成立しません。", res.length ? "ok" : "ng");
    if (!append) busy(false);
    return res.length;
  } catch (e) { setStatus(`計算に失敗しました: ${esc(e.message)}`, "ng"); }
  if (!append) busy(false);
  return 0;
}
async function doKyo(append = false) {
  const req = buildReq(); lastReq = req;
  if (!append) { busy(true); toResults(); setStatus("巨戟のシリーズ・グループを順に切り替えて確認しています…"); $("out").innerHTML = ""; }
  try {
    const r = await call("kyogeki", req);
    const block = (title, list) => {
      const ok = list.filter((x) => x.ok);
      return `<div class="stack"><h3>${title}：成立 ${ok.length} / ${list.length}</h3>
        <div class="okng">${[...ok, ...list.filter((x) => !x.ok)].map((x) => `<span class="${x.ok ? "y" : "n"}">${esc(x.n)}</span>`).join("")}</div>
        ${ok.length && ok.length < list.length ? `<details><summary>成立例を見る</summary>${ok.slice(0, 3).map((x, i) => resultCard(x.sol, i, req)).join("")}</details>` : ""}</div>`;
    };
    $("out").insertAdjacentHTML("beforeend", `<section class="stack"><p class="small muted" style="margin:0">シリーズを確認するときはグループを、グループを確認するときはシリーズを自由に選んだ場合で判定しています。</p>${block("シリーズを切り替えたら", r.sets)}${block("グループを切り替えたら", r.groups)}</section>`);
    const nS = r.sets.filter((x) => x.ok).length, nG = r.groups.filter((x) => x.ok).length;
    if (!append) { setStatus(`シリーズ ${nS}種・グループ ${nG}種で成立します。`, nS || nG ? "ok" : "ng"); busy(false); }
    return [nS, nG];
  } catch (e) { setStatus(`計算に失敗しました: ${esc(e.message)}`, "ng"); }
  if (!append) busy(false);
  return null;
}
async function doAdditional() {
  const req = buildReq(); lastReq = req;
  busy(true); toResults(); setStatus("追加できるスキルを調べています…"); $("out").innerHTML = "";
  try {
    const res = await call("additional", req);
    setStatus(res.length ? `<b>${res.length}個</b>のスキルを追加・上乗せできます。Lvを押すと条件に入り、もう一度押すと元に戻ります。` : "これ以上追加できるスキルはありません。", res.length ? "ok" : "ng");
    const by = {};
    res.forEach((s) => (by[s.k] ||= []).push(s));
    // 到達できるLvを全部ボタンで出す（低いLvを選んで残りを他スキルに回せるように）
    const lvLabel = (k, l) => (k === "group" ? "発動" : k === "set" ? ["", "Ⅰ", "Ⅱ", "Ⅲ"][l] || l : `Lv${l}`);
    $("out").innerHTML = Object.entries(by).map(([k, list]) => `<section class="box"><h2>${KIND[k]}スキル</h2><div class="skill-list" style="max-height:none">${list.map((sk) => {
      const lvs = [];
      for (let l = sk.cur + 1; l <= sk.lv; l++) lvs.push(l);
      return `<div class="skill-row"><span class="nm">${esc(sk.n)}${sk.cur ? `<span class="small muted">（現在Lv${sk.cur}）</span>` : ""}</span>
        <span class="lv">${lvs.map((l) => `<button class="${state.want[sk.id] === l ? "on" : ""}" data-addsk="${sk.id}" data-lv="${l}" data-cur="${sk.cur}">${lvLabel(k, l)}</button>`).join("")}</span></div>`;
    }).join("")}</div></section>`).join("");
  } catch (e) { setStatus(`計算に失敗しました: ${esc(e.message)}`, "ng"); }
  busy(false);
}

// ---------------------------------------------------------------- イベント
function bind() {
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("skillQ").addEventListener("input", renderSkillList);
  $("skillList").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-sk]"); if (!b) return;
    const id = b.dataset.sk, lv = +b.dataset.lv;
    state.want[id] = state.want[id] === lv ? 0 : lv;
    if (!state.want[id]) delete state.want[id];
    renderWant(); renderSkillList(); save();
  });
  $("wantChips").addEventListener("click", (e) => { const b = e.target.closest("button[data-rm]"); if (!b) return; delete state.want[b.dataset.rm]; renderWant(); renderSkillList(); save(); });
  // 結果の下の操作欄
  $("resultActions").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]"); if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === "search") doSearch();
    else if (act === "add") doAdditional();
    else if (act === "suggest") doSuggest(false);
    else if (act === "kyo") doKyo(false);
    else if (act === "reset") doReset();
  });
  $("wType").addEventListener("change", () => { state.wType = $("wType").value; state.wName = ""; renderWeapon(); renderWant(); renderSkillList(); save(); });
  $("wSel").addEventListener("change", () => { state.wName = $("wSel").value; renderWeapon(); renderWant(); renderSkillList(); save(); });
  ["wS0", "wS1", "wS2"].forEach((id, i) => $(id).addEventListener("change", () => { state.wSl[i] = +$(id).value; state.wSl.sort((a, b) => b - a); renderWeapon(); save(); }));
  $("kyo").addEventListener("change", () => { state.kyo = $("kyo").checked; renderWeapon(); save(); });
  $("kyoSet").addEventListener("change", () => { state.kyoSet = $("kyoSet").value; save(); });
  $("kyoGroup").addEventListener("change", () => { state.kyoGroup = $("kyoGroup").value; save(); });
  $("kyoCount").addEventListener("change", () => { state.kyoCount = +$("kyoCount").value || 1; save(); });
  $("kyoPool").addEventListener("change", (e) => {
    const id = e.target.dataset.pool; if (!id) return;
    state.kyoOff = e.target.checked ? state.kyoOff.filter((x) => x !== id) : [...state.kyoOff, id]; save();
  });
  $("minRar").addEventListener("change", () => { state.minRar = +$("minRar").value; save(); });
  $("minDef").addEventListener("change", () => { state.minDef = $("minDef").value; save(); });
  $("resRow").addEventListener("change", (e) => { const k = e.target.dataset.res; if (k == null) return; state.minRes[k] = e.target.value; save(); });
  $("useCrafted").addEventListener("change", () => { state.useCrafted = $("useCrafted").checked; save(); });
  $("limitBreak").addEventListener("change", () => { state.limitBreak = $("limitBreak").checked; save(); });
  $("talAdd").addEventListener("click", () => {
    const sk = {};
    for (let i = 0; i < 3; i++) { const id = $(`tk${i}`).value; if (id) sk[id] = (sk[id] || 0) + +$(`tl${i}`).value; }
    const sl = [0, 1, 2].map((i) => +$(`ts${i}`).value).filter((x) => x > 0).sort((a, b) => b - a);
    const wsl = +$("tws").value ? [1] : [];
    if (!Object.keys(sk).length && !sl.length && !wsl.length) return;
    state.talismans.push({ sk, sl, wsl }); renderTalismans(); renderTalismanForm(); save();
  });
  $("talList").addEventListener("click", (e) => { const b = e.target.closest("button[data-trm]"); if (!b) return; state.talismans.splice(+b.dataset.trm, 1); renderTalismans(); save(); });
  $("fixList").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.unfix != null) delete state.fix[b.dataset.unfix];
    if (b.dataset.unex != null) state.exclude = state.exclude.filter((n) => n !== b.dataset.unex);
    renderFix(); save();
  });
  $("mysetList").addEventListener("change", (e) => {
    const i = e.target.dataset.mname; if (i == null) return;
    state.mysets[+i].name = e.target.value.trim() || `セット${+i + 1}`; save();
  });
  $("mysetList").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.mshow != null) {
      const m = state.mysets[+b.dataset.mshow];
      // マイセットのタブ内で、一覧の下に詳細を出す
      $("mysetView").innerHTML = resultCard(m.s, 0, { want: m.want || {} }, { noSave: true, title: m.name });
      requestAnimationFrame(() => $("mysetView").scrollIntoView({ block: "start" }));
    }
    if (b.dataset.mdel != null) {
      // 誤操作防止のため2回押しで削除
      if (b.dataset.armed) { state.mysets.splice(+b.dataset.mdel, 1); renderMysets(); save(); }
      else { b.dataset.armed = "1"; b.textContent = "もう一度押すと削除"; }
    }
  });
  $("decoQ").addEventListener("input", renderDecos);
  $("decoList").addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.deco) state.decoExclude = t.checked ? state.decoExclude.filter((n) => n !== t.dataset.deco) : [...state.decoExclude, t.dataset.deco];
    if (t.dataset.dlim) { if (t.value === "") delete state.decoLimit[t.dataset.dlim]; else state.decoLimit[t.dataset.dlim] = Math.max(0, +t.value); }
    save();
  });
  $("out").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.dataset.save != null) {
      const c = cards[+b.dataset.save]; if (!c) return;
      state.mysets.push({ name: `セット${state.mysets.length + 1}`, s: c.s, want: c.want, at: Date.now() });
      renderMysets(); save(); b.textContent = "登録済"; b.disabled = true;
    }
    if (b.dataset.fix != null) { state.fix[b.dataset.fix] = b.dataset.n; renderFix(); save(); b.textContent = "固定済"; }
    if (b.dataset.ex != null) { if (!state.exclude.includes(b.dataset.ex)) state.exclude.push(b.dataset.ex); renderFix(); save(); b.textContent = "除外済"; }
    if (b.dataset.addsk) {
      const id = b.dataset.addsk, lv = +b.dataset.lv;
      state.want[id] = state.want[id] === lv ? +b.dataset.cur : lv; // 同じLvをもう一度押すと元のLvに戻す
      if (!state.want[id]) delete state.want[id];
      renderWant(); renderSkillList(); save();
      b.parentElement.querySelectorAll("button").forEach((x) => x.classList.toggle("on", state.want[id] === +x.dataset.lv));
    }
  });
}
function doReset() {
  state.want = {}; state.fix = {}; state.exclude = []; renderWant(); renderSkillList(); renderFix(); save();
  setStatus("条件をクリアしました。"); $("out").innerHTML = "";
}

// ---------------------------------------------------------------- 起動
(async () => {
  data = await (await fetch(new URL("./data.json", import.meta.url))).json();
  skillsSorted = Object.entries(data.skills).map(([id, s]) => ({ id, ...s }))
    .filter((s) => s.n !== "?")
    .sort((a, b) => ["weapon", "armor", "set", "group"].indexOf(a.k) - ["weapon", "armor", "set", "group"].indexOf(b.k) || a.n.localeCompare(b.n, "ja"));
  for (const a of data.armors) for (const id in a.sk) obtainable.add(id);
  for (const d of data.decos) for (const id in d.sk) obtainable.add(id);
  for (const d of data.decos) { const ids = Object.keys(d.sk); if (ids.length === 1) decoLv[ids[0]] = Math.min(decoLv[ids[0]] || 9, d.lv); }
  for (const t of data.amulets) for (const id in t.sk) obtainable.add(id);
  for (const s of skillsSorted) if (s.k === "set" || s.k === "group") obtainable.add(s.id);
  for (const g of Object.values(TALISMAN_GROUPS)) for (const [n] of g.list) { const s = skillsSorted.find((x) => x.n === n.normalize("NFKC")); if (s) obtainable.add(s.id); }
  for (const t of state.talismans || []) for (const id in t.sk) obtainable.add(id);
  if (!state.wType || !data.weapons[state.wType]) state.wType = Object.keys(data.weapons)[0];
  if (firstVisit) {
    // 初回は作例を入れておく（そのまま検索できる）
    const byN = Object.fromEntries(skillsSorted.map((s) => [s.n, s.id]));
    for (const [n, l] of [["挑戦者", 5], ["弱点特効", 5], ["渾身", 3], ["見切り", 3], ["攻撃", 3]]) if (byN[n]) state.want[byN[n]] = l;
    state.wType = data.weapons["太刀"] ? "太刀" : state.wType;
    setStatus("作例として火力スキルを選んであります。そのまま「検索」を押すか、スキルを入れ替えてください。");
  }
  $("dataInfo").textContent = `防具${data.armors.length}・装飾品${data.decos.length}・スキル${skillsSorted.length}`;
  renderWant(); renderSkillList(); renderWeapon(); renderArmorCond(); renderTalismanForm(); renderTalismans(); renderFix(); renderDecos(); renderMysets();
  bind(); showTab(state.tab || "cond");
  call("ping").catch((e) => setStatus(`計算エンジンを起動できませんでした（${esc(e.message)}）。`, "ng"));
})();
export { TALISMAN_GROUPS };
