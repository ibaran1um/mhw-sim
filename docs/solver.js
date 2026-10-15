// MHWs スキルシミュ ソルバー（HiGHS / CPLEX LP形式で 0-1 整数計画を解く）
import { TALISMAN_GROUPS, TALISMAN_ROWS, TALISMAN_NAMES } from "./talisman_table.js";

const PARTS = ["頭", "胴", "腕", "腰", "脚"];
const EPS = 1e-6;

export class Sim {
  constructor(data, loadHighs) {
    this.data = data;
    this.loadHighs = loadHighs;
    this.skillByName = {};
    for (const [id, s] of Object.entries(data.skills)) this.skillByName[s.n] = id;
    this.setIds = Object.keys(data.skills).filter((id) => data.skills[id].k === "set");
    this.groupIds = Object.keys(data.skills).filter((id) => data.skills[id].k === "group");
    // 鑑定護石テーブルをスキルIDに解決
    this.tGroups = {};
    for (const [g, v] of Object.entries(TALISMAN_GROUPS)) {
      this.tGroups[g] = v.list.map(([n, lv]) => ({ id: this.skillByName[n.normalize("NFKC")], lv, n }))
        .filter((e) => e.id);
    }
    this.solveCount = 0;
  }

  async init() {
    this.highs = await this.loadHighs();
  }

  async _run(built) {
    if (built.meta.impossible) return { Status: "Infeasible", Columns: {} };
    return this._solve(built.lp);
  }

  async _solve(lp) {
    // highs-js はエラー後や大量実行後に状態が壊れることがあるため、定期的に作り直す
    if (++this.solveCount % 200 === 0) this.highs = await this.loadHighs();
    try {
      return this.highs.solve(lp);
    } catch (e) {
      this.highs = await this.loadHighs();
      return this.highs.solve(lp);
    }
  }

  // ---------------------------------------------------------------- 要求の正規化
  // req = {
  //   want: {skillId: level}, weapon: {sl:[3,3,3], sk:{id:pt}, kyo: bool, kyoSet: id|null, kyoGroup: id|null,
  //   kyoSetPool?: [id], kyoGroupPool?: [id]}, talismans: [{name, sk:{id:pt}, sl:[n], wsl:[n]}],
  //   useCrafted: bool, exclude: [armorName], fix: {part: armorName}, minRarity: n,
  //   decoExclude: [name], decoLimit: {name: n}, minDef: n, minRes: [5]
  // }
  _relevant(req, extra) {
    const R = new Set(Object.keys(req.want || {}).filter((k) => req.want[k] > 0));
    if (extra) R.add(extra);
    return R;
  }

  _need(id, lv) {
    // スキルLv → 必要ポイント数（シリーズ/グループは部位数）
    const s = this.data.skills[id];
    if (!s) return lv;
    if (s.tiers) {
      const t = s.tiers.filter(([, l]) => l >= lv).map(([p]) => p);
      return t.length ? Math.min(...t) : Infinity;
    }
    return lv;
  }

  _levelFromPts(id, pts) {
    const s = this.data.skills[id];
    if (!s) return pts;
    if (s.tiers) {
      let lv = 0;
      for (const [p, l] of s.tiers) if (pts >= p) lv = Math.max(lv, l);
      return lv;
    }
    return Math.min(pts, s.max);
  }

  // 限界突破：レア5は3段、レア6は2段（タマミツネ防具は1段）、左のスロットから1段ずつ上がる（上限3）
  // 防御力：データの最大値はレア5〜8で強化1段分（+2）多く入っているので補正する。
  // 限界突破で強化上限が R5 +8段 / R6 +6段 / R7 +5段 / R8 +4段（1段 +2）上がる
  _defense(a, lb) {
    if (a.r < 5) return a.d;
    const extra = { 5: 8, 6: 6, 7: 5, 8: 4 }[a.r] || 0;
    return a.d - 2 + (lb ? extra * 2 : 0);
  }

  _limitBreak(a) {
    let n = a.r === 5 ? 3 : a.r === 6 ? (a.s.includes("ミツネ") ? 1 : 2) : 0;
    if (!n) return a;
    const sl = [0, 1, 2].map((i) => a.sl[i] || 0);
    for (let i = 0; i < 3 && n > 0; i++) if (sl[i] < 3) { sl[i]++; n--; }
    return { ...a, sl: sl.filter((x) => x > 0).sort((x, y) => y - x), lb: true };
  }

  _candidates(req, R) {
    const fix = req.fix || {};
    const exclude = new Set(req.exclude || []);
    const minR = req.minRarity || 0;
    const relPts = (sk) => [...R].map((id) => sk[id] || 0);
    const pad = (sl) => [0, 1, 2].map((i) => sl[i] || 0);
    const parts = [[], [], [], [], []];
    const allowed = (a) => (fix[a.p] ? fix[a.p] === a.n : !(exclude.has(a.n) || a.r < minR));
    // ワンセット防具は1部位でも使えなければ一式ごと使わない
    const bannedSets = new Set(this.data.armors.filter((a) => a.one && !allowed(a)).map((a) => a.s));
    this.data.armors.forEach((a, i) => {
      if (!allowed(a)) return;
      if (a.one && bannedSets.has(a.s)) return;
      const a1 = req.limitBreak ? this._limitBreak(a) : a;
      const a2 = { ...a1, d: this._defense(a, !!req.limitBreak), lb: !!req.limitBreak && a.r >= 5 };
      parts[a.p].push({ i, a: a2, rp: relPts(a2.sk), sl: pad(a2.sl) });
    });
    const needRes = req.minRes && req.minRes.some((v) => v != null && v !== "");
    const out = [];
    for (let p = 0; p < 5; p++) {
      const list = parts[p];
      if (!fix[p]) list.push({ i: -1 - p, a: { n: `（${PARTS[p]}なし）`, p, d: 0, res: [0, 0, 0, 0, 0], sl: [], sk: {} }, rp: [...R].map(() => 0), sl: [0, 0, 0] });
      // 支配される防具を除外（関連スキル・スロット・防御力がすべて以下）
      const keep = list.filter((b, bi) => !list.some((a, ai) => {
        if (ai === bi) return false;
        if (a.a.one || b.a.one) return false; // ワンセット防具は単体で比べられない
        let strict = false;
        for (let k = 0; k < a.rp.length; k++) { if (a.rp[k] < b.rp[k]) return false; if (a.rp[k] > b.rp[k]) strict = true; }
        for (let k = 0; k < 3; k++) { if (a.sl[k] < b.sl[k]) return false; if (a.sl[k] > b.sl[k]) strict = true; }
        if (a.a.d < b.a.d) return false; if (a.a.d > b.a.d) strict = true;
        if (needRes) for (let k = 0; k < 5; k++) { if (a.a.res[k] < b.a.res[k]) return false; if (a.a.res[k] > b.a.res[k]) strict = true; }
        return strict || ai < bi; // 完全同値は先頭だけ残す
      }));
      out.push(...keep);
    }
    return out;
  }

  // ---------------------------------------------------------------- モデル構築
  _build(req, opt = {}) {
    const R = this._relevant(req, opt.maxSkill);
    const want = { ...(req.want || {}) };
    const V = []; // 変数名
    const bins = new Set();
    const gens = [];
    const bounds = [];
    const terms = {}; // skillId -> [[coef, var]]
    const konst = {}; // skillId -> 定数
    const addTerm = (id, c, v) => { if (!R.has(id) || !c) return; (terms[id] ||= []).push([c, v]); };
    const armorSlots = { 1: [], 2: [], 3: [] }; // lv -> [[count, var]] (lv以上を数えるのは後で)
    const weaponSlots = { 1: [], 2: [], 3: [] };
    const slotConst = { a: { 1: 0, 2: 0, 3: 0 }, w: { 1: 0, 2: 0, 3: 0 } };
    const defTerms = [];
    const resTerms = [[], [], [], [], []];
    const cons = [];
    // 同一変数をまとめ、長い行を折り返す（LP形式の1行長制限対策）
    const lin = (ts) => {
      const agg = new Map();
      for (const [c, v] of ts) agg.set(v, (agg.get(v) || 0) + c);
      const parts = [];
      for (const [v, c] of agg) if (Math.abs(c) > 1e-12) parts.push(`${c < 0 ? "-" : "+"} ${Math.abs(c)} ${v}`);
      if (!parts.length) parts.push("+ 0 a0");
      const lines = [];
      for (let i = 0; i < parts.length; i += 12) lines.push(parts.slice(i, i + 12).join(" "));
      return lines.join("\n   ");
    };
    const wrap = (vs) => { const o = []; for (let i = 0; i < vs.length; i += 20) o.push(" " + vs.slice(i, i + 20).join(" ")); return o; };
    const C = (name, ts, op, rhs) => cons.push(` ${name}: ${lin(ts)} ${op} ${rhs}`);
    const meta = { armors: [], tal: [], decos: [], ks: [], kg: [], vt: [] };

    // 防具
    const cands = this._candidates(req, R);
    const byPart = [[], [], [], [], []];
    cands.forEach((c, j) => {
      const v = `a${j}`;
      V.push(v); bins.add(v); byPart[c.a.p].push(v);
      meta.armors.push({ v, ...c });
      for (const [id, pt] of Object.entries(c.a.sk)) addTerm(id, pt, v);
      for (const lv of c.a.sl) armorSlots[lv].push([1, v]);
      if (c.a.d) defTerms.push([c.a.d, v]);
      c.a.res.forEach((r, k) => r && resTerms[k].push([r, v]));
    });
    byPart.forEach((vs, p) => C(`part${p}`, vs.map((v) => [1, v]), "=", 1));
    // ワンセット防具：同じシリーズの全部位を一緒に選ぶ
    const oneSets = {};
    meta.armors.forEach((m) => { if (m.a.one) (oneSets[m.a.s] ||= []).push(m.v); });
    Object.values(oneSets).forEach((vs, n) => vs.slice(1).forEach((v, k) => C(`one${n}_${k}`, [[1, v], [-1, vs[0]]], "=", 0)));

    // 武器
    const w = req.weapon || { sl: [], sk: {} };
    for (const [id, pt] of Object.entries(w.sk || {})) if (R.has(id)) konst[id] = (konst[id] || 0) + pt;
    for (const lv of w.sl || []) slotConst.w[lv]++;
    if (w.kyo) {
      const cnt = req.kyoCount ?? 1;
      const setPool = w.kyoSet ? [w.kyoSet] : (w.kyoSetPool || this.setIds);
      const grpPool = w.kyoGroup ? [w.kyoGroup] : (w.kyoGroupPool || this.groupIds);
      const mk = (pool, prefix, list) => {
        const vs = [];
        const rel = pool.filter((id) => R.has(id));
        for (const id of rel) { const v = `${prefix}${list.length}`; list.push({ v, id }); vs.push(v); V.push(v); bins.add(v); addTerm(id, cnt, v); }
        if (rel.length < pool.length) { const v = `${prefix}${list.length}`; list.push({ v, id: null }); vs.push(v); V.push(v); bins.add(v); }
        if (vs.length) C(`${prefix}one`, vs.map((v) => [1, v]), "=", 1);
      };
      mk(setPool, "ks", meta.ks);
      mk(grpPool, "kg", meta.kg);
    }

    // 護石
    const tVars = [];
    if (opt.suggest) {
      // 鑑定護石テーブルから「あれば成立する護石」を探す
      const rw = { 5: 0, 6: 1, 7: 2, 8: 3 };
      TALISMAN_ROWS.forEach(([rar, g1, g2, g3, slotPats], r) => {
        if (opt.suggestRarity && !opt.suggestRarity.includes(rar)) return;
        const z = `z${r}`; V.push(z); bins.add(z); tVars.push(z);
        const row = { v: z, r, rar, gs: [g1, g2, g3], ys: [], qs: [] };
        const byName = {};
        [g1, g2, g3].forEach((g, k) => {
          if (!g) return;
          const ys = [];
          const ents = this.tGroups[g];
          const rel = ents.filter((e) => R.has(e.id));
          rel.forEach((e) => {
            const y = `y${r}_${k}_${ys.length}`; V.push(y); bins.add(y); ys.push(y);
            row.ys.push({ v: y, k, g, id: e.id, lv: e.lv });
            addTerm(e.id, e.lv, y);
            (byName[e.id] ||= []).push(y);
          });
          if (rel.length < ents.length) { const y = `y${r}_${k}_${ys.length}`; V.push(y); bins.add(y); ys.push(y); row.ys.push({ v: y, k, g, id: null }); }
          C(`ysum${r}_${k}`, [...ys.map((v) => [1, v]), [-1, z]], "=", 0);
        });
        // 同じスキルは1つの護石に重複しない
        Object.entries(byName).forEach(([id, ys], n) => { if (ys.length > 1) C(`ydup${r}_${n}`, ys.map((v) => [1, v]), "<=", 1); });
        const qs = slotPats.map((pat, p) => {
          const q = `q${r}_${p}`; V.push(q); bins.add(q);
          const sl = pat.split(","); row.qs.push({ v: q, pat });
          for (const s of sl) { if (s === "w1") weaponSlots[1].push([1, q]); else armorSlots[+s].push([1, q]); }
          return q;
        });
        C(`qsum${r}`, [...qs.map((v) => [1, v]), [-1, z]], "=", 0);
        row.cost = rw[rar];
        meta.vt.push(row);
      });
      if (tVars.length) C("talone", tVars.map((v) => [1, v]), "=", 1);
    } else {
      const tals = [...(req.talismans || [])];
      if (req.useCrafted) for (const a of this.data.amulets) tals.push({ name: a.n, sk: a.sk, sl: a.sl || [], wsl: [] });
      tals.forEach((t, j) => {
        const rel = Object.keys(t.sk).some((id) => R.has(id));
        if (!rel && !(t.sl || []).length && !(t.wsl || []).length) return;
        const v = `t${j}`; V.push(v); bins.add(v); tVars.push(v);
        meta.tal.push({ v, t });
        for (const [id, pt] of Object.entries(t.sk)) addTerm(id, pt, v);
        for (const lv of t.sl || []) armorSlots[lv].push([1, v]);
        for (const lv of t.wsl || []) weaponSlots[lv].push([1, v]);
      });
      if (tVars.length) C("talone", tVars.map((v) => [1, v]), "<=", 1);
    }

    // 装飾品
    const dex = new Set(req.decoExclude || []);
    const dlim = req.decoLimit || {};
    const decoUse = { a: { 1: [], 2: [], 3: [] }, w: { 1: [], 2: [], 3: [] } };
    this.data.decos.forEach((d, k) => {
      if (dex.has(d.n)) return;
      if (!Object.keys(d.sk).some((id) => R.has(id))) return;
      const v = `d${k}`; V.push(v); gens.push(v);
      const ub = dlim[d.n] ?? 20;
      bounds.push(`0 <= ${v} <= ${ub}`);
      meta.decos.push({ v, d });
      for (const [id, pt] of Object.entries(d.sk)) addTerm(id, pt, v);
      decoUse[d.on][d.lv].push(v);
    });
    // スロット容量（Lv L 以上の装飾品数 ≤ Lv L 以上のスロット数）
    for (const pool of ["a", "w"]) {
      const slots = pool === "a" ? armorSlots : weaponSlots;
      for (const L of [1, 2, 3]) {
        const used = [];
        for (let l = L; l <= 3; l++) used.push(...decoUse[pool][l]);
        if (!used.length) continue;
        const cap = [];
        let c0 = 0;
        for (let l = L; l <= 3; l++) { cap.push(...slots[l].map(([c, v]) => [-c, v])); c0 += slotConst[pool][l]; }
        C(`slot${pool}${L}`, [...used.map((v) => [1, v]), ...cap], "<=", c0);
      }
    }

    // スキル要求
    let ci = 0;
    for (const [id, lv] of Object.entries(want)) {
      if (!(lv > 0)) continue;
      const need = this._need(id, lv) - (konst[id] || 0);
      if (need <= 0) continue;
      if (need === Infinity || !terms[id]) { meta.impossible = true; continue; }
      C(`sk${ci++}`, terms[id], ">=", need);
    }
    if (req.minDef) C("mindef", defTerms, ">=", req.minDef);
    (req.minRes || []).forEach((m, k) => {
      if (m == null || m === "") return;
      C(`minres${k}`, resTerms[k], ">=", +m);
    });
    // 既出解の除外（no-good cut）
    (opt.cuts || []).forEach((vs, n) => C(`cut${n}`, vs.map((v) => [1, v]), "<=", vs.length - 1));

    // 目的関数
    let obj;
    if (opt.maxSkill) {
      const id = opt.maxSkill;
      const s = this.data.skills[id];
      const cap = s.tiers ? Math.max(...s.tiers.map(([p]) => p)) : s.max;
      // 上限を超えて積んでも意味がないので、上限付き補助変数 u を最大化
      V.push("u"); gens.push("u"); bounds.push(`0 <= u <= ${Math.max(0, cap - (konst[id] || 0))}`);
      C("ucap", [[1, "u"], ...(terms[id] || []).map(([c, v]) => [-c, v])], "<=", 0);
      obj = [[1, "u"]];
    } else if (opt.suggest) {
      // 入手しやすさ優先（低レア）、次に不要スキルを「任意」にする、次に防御
      const t = [];
      meta.vt.forEach((row) => {
        if (row.cost) t.push([-row.cost * 1000, row.v]);
        row.ys.forEach((y) => y.id && t.push([-10, y.v]));
      });
      defTerms.forEach(([c, v]) => t.push([c * 0.01, v]));
      obj = t;
    } else {
      const t = [...defTerms];
      meta.decos.forEach(({ v }) => t.push([-0.01, v]));
      obj = t;
    }

    const lp = ["Maximize", " obj: " + lin(obj.length ? obj : [[0, "a0"]]), "Subject To", ...cons,
      "Bounds", ...bounds.map((b) => " " + b),
      ...(gens.length ? ["General", ...wrap(gens)] : []),
      ...(bins.size ? ["Binary", ...wrap([...bins])] : []), "End"].join("\n");
    return { lp, meta, R, konst };
  }

  _val(res, v) {
    const c = res.Columns[v];
    return c ? Math.round(c.Primal + EPS) : 0;
  }

  _decode(req, res, meta) {
    const val = (v) => this._val(res, v);
    const armors = meta.armors.filter((m) => val(m.v) === 1).sort((x, y) => x.a.p - y.a.p);
    const tal = meta.tal.find((m) => val(m.v) === 1);
    const vrow = meta.vt.find((row) => val(row.v) === 1);
    const decos = [];
    meta.decos.forEach((m) => { const n = val(m.v); for (let i = 0; i < n; i++) decos.push(m.d); });
    const w = req.weapon || { sl: [], sk: {} };
    const ks = meta.ks.find((m) => val(m.v) === 1);
    const kg = meta.kg.find((m) => val(m.v) === 1);

    // 実際の全スキル合計（関連外も含めて表示用に計算）
    const pts = {};
    const add = (sk, mul = 1) => { for (const [id, p] of Object.entries(sk || {})) pts[id] = (pts[id] || 0) + p * mul; };
    armors.forEach((m) => add(m.a.sk));
    add(w.sk);
    if (tal) add(tal.t.sk);
    decos.forEach((d) => add(d.sk));
    const kyoCount = req.kyoCount ?? 1;
    const kyo = {};
    if (w.kyo) {
      const setId = w.kyoSet || ks?.id || null;
      const grpId = w.kyoGroup || kg?.id || null;
      if (setId) { pts[setId] = (pts[setId] || 0) + kyoCount; kyo.set = setId; }
      if (grpId) { pts[grpId] = (pts[grpId] || 0) + kyoCount; kyo.group = grpId; }
    }
    let vtal = null;
    if (vrow) {
      const slotsUsed = vrow.qs.find((q) => val(q.v) === 1);
      const picks = vrow.gs.map((g, k) => {
        if (!g) return null;
        const y = vrow.ys.find((y) => y.k === k && val(y.v) === 1);
        return { g, id: y?.id || null, lv: y?.lv || 0, n: y?.id ? this.data.skills[y.id].n : null };
      });
      picks.forEach((p) => p?.id && (pts[p.id] = (pts[p.id] || 0) + p.lv));
      vtal = { rar: vrow.rar, name: TALISMAN_NAMES[vrow.rar], picks, slots: slotsUsed?.pat || "" };
    }

    // 装飾品の配置（降順に詰める）
    const slotList = { a: [], w: [] };
    armors.forEach((m) => m.a.sl.forEach((lv) => slotList.a.push({ lv, at: m.a.n })));
    (w.sl || []).forEach((lv) => slotList.w.push({ lv, at: "武器" }));
    if (tal) { (tal.t.sl || []).forEach((lv) => slotList.a.push({ lv, at: "護石" })); (tal.t.wsl || []).forEach((lv) => slotList.w.push({ lv, at: "護石" })); }
    if (vtal) vtal.slots.split(",").forEach((s) => s === "w1" ? slotList.w.push({ lv: 1, at: "護石" }) : slotList.a.push({ lv: +s, at: "護石" }));
    const placed = {};
    const free = { a: [], w: [] };
    for (const pool of ["a", "w"]) {
      const sl = slotList[pool].sort((x, y) => y.lv - x.lv);
      const ds = decos.filter((d) => d.on === pool).sort((x, y) => y.lv - x.lv);
      sl.forEach((s, i) => {
        if (ds[i]) (placed[s.at] ||= []).push(ds[i].n);
        else free[pool].push(s.lv);
      });
    }

    const skills = Object.entries(pts)
      .map(([id, p]) => ({ id, n: this.data.skills[id]?.n || id, k: this.data.skills[id]?.k, pts: p, lv: this._levelFromPts(id, p), max: this.data.skills[id]?.max }))
      .filter((s) => s.lv > 0 || s.k === "set" || s.k === "group")
      .filter((s) => !(s.k === "set" || s.k === "group") || s.lv > 0)
      .sort((a, b) => (a.k === b.k ? b.lv - a.lv : ["weapon", "armor", "set", "group"].indexOf(a.k) - ["weapon", "armor", "set", "group"].indexOf(b.k)));
    const def = armors.reduce((s, m) => s + (m.a.d || 0), 0);
    const resist = [0, 1, 2, 3, 4].map((k) => armors.reduce((s, m) => s + (m.a.res[k] || 0), 0));
    return {
      armors: armors.map((m) => ({ n: m.a.n, p: m.a.p, sl: m.a.sl, lb: !!m.a.lb, deco: placed[m.a.n] || [] })),
      talisman: tal ? { name: tal.t.name, sk: tal.t.sk, sl: tal.t.sl, wsl: tal.t.wsl, deco: placed["護石"] || [] } : null,
      vtal: vtal ? { ...vtal, deco: placed["護石"] || [] } : null,
      weaponDeco: placed["武器"] || [],
      kyo, skills, def, res: resist, free,
      cutVars: [...armors.map((m) => m.v), ...(tal ? [tal.v] : []), ...(vrow ? [vrow.v] : [])],
    };
  }

  // ---------------------------------------------------------------- 公開API
  async search(req, { limit = 20 } = {}) {
    const results = [];
    const cuts = [];
    for (let n = 0; n < limit; n++) {
      const built = this._build(req, { cuts });
      const { meta } = built;
      const res = await this._run(built);
      if (res.Status !== "Optimal") break;
      const sol = this._decode(req, res, meta);
      results.push(sol);
      cuts.push(sol.cutVars);
    }
    return results;
  }

  async feasible(req) {
    const r = await this.search(req, { limit: 1 });
    return r[0] || null;
  }

  // 追加スキル検索：各スキルを最大どこまで積めるか
  async additional(req, onProgress) {
    const out = [];
    const ids = Object.keys(this.data.skills).filter((id) => {
      const s = this.data.skills[id];
      if (s.k === "group") return true;
      return (req.want?.[id] || 0) < s.max;
    });
    let i = 0;
    for (const id of ids) {
      onProgress?.(++i, ids.length);
      const built = this._build(req, { maxSkill: id });
      const res = await this._run(built);
      if (res.Status !== "Optimal") continue;
      const u = this._val(res, "u");
      // u は「上限付きの到達ポイント」。武器の固定分を足してLv換算
      const { konst } = built;
      const lv = this._levelFromPts(id, u + (konst[id] || 0));
      const cur = req.want?.[id] || 0;
      if (lv > cur) out.push({ id, n: this.data.skills[id].n, k: this.data.skills[id].k, lv, cur, max: this.data.skills[id].max });
    }
    return out.sort((a, b) => ["weapon", "armor", "set", "group"].indexOf(a.k) - ["weapon", "armor", "set", "group"].indexOf(b.k) || b.lv - a.lv);
  }

  // 巨戟アーティア：シリーズ/グループを何にすれば成立するか
  async kyogekiScan(req) {
    const w = req.weapon;
    const setPool = w.kyoSetPool || this.setIds;
    const grpPool = w.kyoGroupPool || this.groupIds;
    const sets = [];
    for (const id of setPool) {
      const sol = await this.feasible({ ...req, weapon: { ...w, kyo: true, kyoSet: id, kyoGroup: null } });
      sets.push({ id, n: this.data.skills[id].n, ok: !!sol, sol });
    }
    const groups = [];
    for (const id of grpPool) {
      const sol = await this.feasible({ ...req, weapon: { ...w, kyo: true, kyoSet: null, kyoGroup: id } });
      groups.push({ id, n: this.data.skills[id].n, ok: !!sol, sol });
    }
    return { sets, groups };
  }

  // 鑑定護石テーブルから「この護石があれば成立」を列挙
  async suggestTalismans(req, { limit = 10, rarity } = {}) {
    const out = [];
    const cuts = [];
    const seen = new Set();
    for (let n = 0; n < limit * 3 && out.length < limit; n++) {
      const built = this._build({ ...req, talismans: [], useCrafted: false }, { suggest: true, suggestRarity: rarity, cuts });
      const { meta } = built;
      const res = await this._run(built);
      if (res.Status !== "Optimal") break;
      const sol = this._decode(req, res, meta);
      if (!sol.vtal) break;
      // 同じ護石（レア・必要スキル・スロット）は1件にまとめる。行とスキル選択でカット
      const row = meta.vt.find((r) => this._val(res, r.v) === 1);
      const pickVars = row.ys.filter((y) => y.id && this._val(res, y.v) === 1).map((y) => y.v);
      const slotVar = row.qs.find((q) => this._val(res, q.v) === 1).v;
      cuts.push([row.v, ...pickVars, slotVar]);
      const req0 = sol.vtal.picks.filter((p) => p && p.id).map((p) => `${p.n}${p.lv}`).sort().join("+");
      const key = `${sol.vtal.rar}|${req0}|${sol.vtal.slots}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(sol);
    }
    return out;
  }
}

export { PARTS, TALISMAN_NAMES };
