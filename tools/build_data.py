"""mhdb-wilds-data の merged JSON から、シミュ用のコンパクトな data.json を作る。

使い方: python3 -I tools/build_data.py <mhdb-wilds-data/output/merged> <出力data.json>
データの出典: https://github.com/LartTyler/mhdb-wilds-data (GPL-3.0)
"""
import json
import sys
import unicodedata
from pathlib import Path

src = Path(sys.argv[1])
out = Path(sys.argv[2])


def load(name):
    with open(src / name, encoding="utf-8") as f:
        return json.load(f)


def ja(o):
    return unicodedata.normalize("NFKC", o["names"]["ja"]).strip()


PART = {"head": 0, "chest": 1, "arms": 2, "waist": 3, "legs": 4}

# --- スキル -------------------------------------------------------------
skills = {}
for s in load("Skill.json"):
    sid = str(s["game_id"])
    txt = lambda v: unicodedata.normalize("NFKC", (v or {}).get("ja", "") if isinstance(v, dict) else (v or "")).replace("\r\n", "\n").strip()
    skills[sid] = {"n": ja(s), "k": s["kind"], "max": len(s.get("ranks") or [1]),
                   "d": txt(s.get("descriptions")),
                   "lv": [{"l": r.get("level"), "t": txt(r.get("descriptions")), **({"nm": txt(r.get("names"))} if r.get("names") else {}),
                           **({"pc": r["set_pieces_required"]} if r.get("set_pieces_required") else {})}
                          for r in (s.get("ranks") or [])]}

# --- 素材名 -------------------------------------------------------------
item_names = {str(i["game_id"]): ja(i) for i in load("Item.json")}

def mats(c):
    c = c or {}
    return [[item_names.get(str(k), f"#{k}"), n] for k, n in (c.get("inputs") or {}).items()]

# --- 防具 ---------------------------------------------------------------
armors = []
for a in load("Armor.json"):
    if a.get("set_bonus"):
        sb = a["set_bonus"]
        tiers = sorted({(r["pieces"], r["skill_level"]) for r in sb["ranks"]})
        sk = skills.setdefault(str(sb["skill_id"]), {"n": "?", "k": "set", "max": 1})
        sk["tiers"] = [list(t) for t in tiers]
        sk["max"] = max(t[1] for t in tiers)
    if a.get("group_bonus"):
        gb = a["group_bonus"]
        sk = skills.setdefault(str(gb["skill_id"]), {"n": "?", "k": "group", "max": 1})
        sk["tiers"] = [[r["pieces"], r["skill_level"]] for r in gb["ranks"]]
        sk["max"] = 1
    # ワンセット防具：1部位だけに素材があり、残りは素材なし（豪鬼αなど）。一式でしか装備できない
    with_m = [p for p in a["pieces"] if (p.get("crafting") or {}).get("inputs")]
    one_set = len(a["pieces"]) > 1 and len(with_m) == 1
    for p in a["pieces"]:
        d = p.get("defense") or {}
        r = p.get("resistances") or {}
        armors.append({
            "n": ja(p),
            "s": ja(a),
            "p": PART[p["kind"]],
            "r": a["rarity"],
            "d": d.get("max", d.get("base", 0)),
            "res": [r.get(k, 0) for k in ("fire", "water", "thunder", "ice", "dragon")],
            "sl": sorted(p.get("slots") or [], reverse=True),
            "sk": {k: v for k, v in (p.get("skills") or {}).items()},
            "m": mats(with_m[0]["crafting"] if one_set else p.get("crafting")),
            "z": (with_m[0] if one_set else p).get("crafting", {}).get("price", 0),
            **({"one": 1} if one_set else {}),
        })

# --- 装飾品 -------------------------------------------------------------
decos = []
for d in load("Accessory.json"):
    decos.append({
        "n": ja(d),
        "lv": d["level"],
        "on": "w" if d["allowed_on"] == "weapon" else "a",
        "r": d.get("rarity", 0),
        "sk": d["skills"],
    })

# --- 固定護石（製作護石） -------------------------------------------------
amulets = []
for a in load("Amulet.json"):
    if a.get("is_random"):
        continue
    for rk in a["ranks"]:
        amulets.append({"n": ja(rk), "r": rk.get("rarity", 0), "sk": rk["skills"],
                        "sl": sorted(rk.get("slots") or [], reverse=True)})

# --- 武器 ---------------------------------------------------------------
TYPE_JA = {
    "great-sword": "大剣", "long-sword": "太刀", "sword-shield": "片手剣", "dual-blades": "双剣",
    "hammer": "ハンマー", "hunting-horn": "狩猟笛", "lance": "ランス", "gunlance": "ガンランス",
    "switch-axe": "スラッシュアックス", "charge-blade": "チャージアックス", "insect-glaive": "操虫棍",
    "light-bowgun": "ライトボウガン", "heavy-bowgun": "ヘビィボウガン", "bow": "弓",
}
weapons = {}
for f in sorted((src / "weapons").glob("*.json")):
    if f.stem.startswith("HuntingHorn") and f.stem != "HuntingHorn":
        continue
    with open(f, encoding="utf-8") as fh:
        ws = json.load(fh)
    for w in ws:
        t = TYPE_JA.get(w["kind"], w["kind"])
        weapons.setdefault(t, []).append({
            "n": ja(w), "r": w["rarity"], "sl": sorted(w.get("slots") or [], reverse=True),
            "sk": w.get("skills") or {}, "atk": w.get("attack_raw", 0),
        })

for sid, s in skills.items():
    if s["n"] == "?":
        print("warn: unnamed skill", sid, file=sys.stderr)

data = {"skills": skills, "armors": armors, "decos": decos, "amulets": amulets, "weapons": weapons,
        "source": "mhdb-wilds-data (GPL-3.0) https://github.com/LartTyler/mhdb-wilds-data"}
out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"skills={len(skills)} armors={len(armors)} decos={len(decos)} amulets={len(amulets)} "
      f"weapons={sum(len(v) for v in weapons.values())} bytes={out.stat().st_size}")
