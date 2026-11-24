# 動態小工具 — PSD 依圖層名稱套動態，輸出 MP4 / GIF
# 啟動：雙擊「啟動.bat」（或 python server.py），瀏覽器會自動打開 http://127.0.0.1:8765
#
# 分工：這支 Python 負責讀 PSD（psd-tools 拆圖層成 PNG）和呼叫 ffmpeg 壓檔；
# 動畫本身在瀏覽器的 index.html 裡畫（預覽和輸出用同一段程式，所見即所得）。
# 命名規則跟 AE 面板「銷售頁動態.jsx」一樣，同一份 PSD 兩邊都能用。

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np
from psd_tools import PSDImage
from psd_tools.composite import adjustments as _adj

ROOT = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(ROOT, "_cache")
RENDERS = os.path.join(CACHE, "renders")   # 合成過的圖塊（跨版本共用，見 SceneBuilder.render）
PORT = int(os.environ.get("PORT") or 8765)
PARSER_VERSION = "11"   # 改了拆圖層邏輯就加一，舊快取自動作廢
# 改了這支 server.py 的功能就改這個，index.html 的 APP_VERSION 要一起改：
# 頁面發現兩邊不一樣（使用者沒重開黑色視窗），會提醒他重新啟動。
APP_VERSION = "2026-11-13h"


# ---------- psd-tools 沒有的調整圖層：補上「黑白」 ----------
@_adj._preserve_alpha
def apply_blackandwhite(img, colormode, layer):
    """Photoshop 黑白：gray = 最小值 + (最大-中間)×主色權重 + (中間-最小)×二次色權重。"""
    if img.shape[-1] < 3:
        return img
    rgb = img[..., :3]
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    hi, lo = rgb.max(-1), rgb.min(-1)
    mid = rgb.sum(-1) - hi - lo
    w = {k: getattr(layer, k) / 100.0 for k in ("red", "yellow", "green", "cyan", "blue", "magenta")}
    # 最大的通道決定主色，最小的通道決定二次色（另外兩個通道混出來的顏色）
    w_hi = np.where(r >= np.maximum(g, b), w["red"], np.where(g >= b, w["green"], w["blue"]))
    w_mid = np.where(b <= np.minimum(r, g), w["yellow"], np.where(r <= g, w["cyan"], w["magenta"]))
    gray = np.clip(lo + (hi - mid) * w_hi + (mid - lo) * w_mid, 0, 1)
    out = np.repeat(gray[..., None], 3, axis=-1)
    if layer.use_tint and layer.tint_color is not None:
        tc = layer.tint_color
        tint = np.array([float(tc.get(k, 0)) / 255 for k in (b"Rd  ", b"Grn ", b"Bl  ")], dtype=out.dtype)
        # 上色：近似 PS 的效果，暗部偏黑、亮部偏白、中間調帶色
        out = np.where(out < 0.5, 2 * out * tint, 1 - 2 * (1 - out) * (1 - tint))
    return out.astype(img.dtype)


_adj.ADJUSTMENT_FUNC.setdefault("blackandwhite", apply_blackandwhite)
ADJ_NAMES = {"gradientmap": "漸層對應", "colorbalance": "色彩平衡", "selectivecolor": "選取顏色",
             "photofilter": "相片濾鏡", "channelmixer": "色版混合器", "vibrance": "自然飽和度",
             "colorlookup": "顏色查詢"}

# ---------- 命名規則（與 AE 面板一致） ----------
MARK = "動"
WORDS = {
    "bob": ["飄浮", "漂浮", "浮動", "飄", "漂", "浮"],
    "sway": ["搖", "擺", "晃"],
    "flash": ["亮光", "閃"],
    "pulse": ["縮放", "呼吸", "放大"],
    "sweep": ["流光", "光澤"],
    "step": ["逐格"],   # 飄浮／搖擺／縮放改成一格一格跳（不管面板有沒有勾）
    "hue": ["跳色", "變色"],   # 照「跳色」色票輪流換色（AE 面板用填色效果做同一件事）
    "stroke": ["描邊"],        # 固定描邊（只有小工具有，AE 面板沒有）
}
# 進場：從哪裡進來。長的字先比（「上滑入」要先於「滑入」）；比到的字會先拿掉，
# 「放大進場」才不會被當成「縮放」。default = 照面板的「進場方式」。
ENTER_WORDS = [("左滑入", "left"), ("右滑入", "right"), ("上滑入", "top"), ("下滑入", "bottom"),
               ("放大進場", "zoom"), ("模糊進場", "blur"), ("彈出", "pop"), ("淡入", "fade"), ("擦出", "wipe"),
               ("滑入", "default"), ("進場", "default")]


def has(name, words):
    return any(w in name for w in words)


def fx_of(name):
    """圖層名稱 -> 動態設定；沒有要動就回 None。"""
    if MARK not in name:
        return None
    enter = None
    for w, kind in ENTER_WORDS:
        if w in name:
            enter, name = kind, name.replace(w, "")
            break
    main = None
    if has(name, WORDS["flash"]):
        main = "flash"
    elif has(name, WORDS["bob"]):
        main = "bob"
    elif has(name, WORDS["sway"]):
        main = "sway"
    sweep = has(name, WORDS["sweep"])
    hue, stroke = has(name, WORDS["hue"]), has(name, WORDS["stroke"])
    pulse = has(name, WORDS["pulse"])   # 閃光只改透明度，所以也可以疊縮放
    if not (main or sweep or pulse or hue or stroke or enter):
        return None
    return {"main": main, "sweep": sweep, "pulse": pulse, "step": has(name, WORDS["step"]), "hue": hue, "stroke": stroke,
            "enter": enter}


# ---------- PS 影格動畫（時間軸 → 影格）----------
def ps_frames(psd):
    """[(影格 id, 停幾秒)]，照第一組影格的順序；沒有影格動畫（或只有 1 格）回 None。"""
    from psd_tools.psd.descriptor import DescriptorBlock
    res = psd.image_resources.get(4000)
    if res is None or not isinstance(res.data, bytes) or b"AnDs" not in res.data:
        return None
    d = res.data
    desc = DescriptorBlock.frombytes(d[d.index(b"AnDs") + 8:])
    info = {f[b"FrID"]: max(0.02, f.get(b"FrDl", 10) / 100.0) for f in desc.get(b"FrIn", [])}
    sets = desc.get(b"FSts") or []
    order = list(sets[0][b"FsFr"]) if sets and b"FsFr" in sets[0] else list(info)
    frames = [(i, info.get(i, 0.1)) for i in order]
    active = sets[0].get(b"AFrm", 0) if sets else 0
    return (frames, active) if len(frames) > 1 else None


def frame_states(layer, ids):
    """這層在每一格：[顯示?]、[(位移 x, y)]。PS 每筆只記跟前一格不同的地方，所以要一路帶下去。"""
    lst = None
    for k, b in (layer.tagged_blocks or {}).items():
        if "METADATA" in str(k):
            for m in b.data:
                if m.key == b"mlst":
                    lst = m.data.get(b"LaSt")
    if not lst:
        return None
    by = {}
    for e in lst:
        for fid in e.get(b"FrLs", []):
            by[fid] = e
    vis, ofs, v, o = [], [], layer.visible, (0.0, 0.0)
    for fid in ids:
        e = by.get(fid, {})
        if b"enab" in e:
            v = bool(e[b"enab"])
        if b"Ofst" in e:
            o = (float(e[b"Ofst"].get(b"Hrzn", 0)), float(e[b"Ofst"].get(b"Vrtc", 0)))
        vis.append(v)
        ofs.append(o)
    return vis, ofs


def apply_frames(psd):
    """讀影格；每格都一樣的圖層照原本處理，會變的圖層：記住每格的顯示／位移，
    並先打開（只改記憶體），之後單獨拆出來。回傳 (每格秒數, {圖層 id: (顯示, 位移)})。"""
    pf = ps_frames(psd)
    if not pf:
        return None, {}
    frames, active = pf
    ids = [i for i, _ in frames]
    varying = {}
    for l in psd.descendants():
        if l.kind == "artboard":
            continue
        st = frame_states(l, ids)
        if not st:
            continue
        vis, ofs = st
        base = ofs[min(active, len(ofs) - 1)]          # 存檔時畫面上是哪一格，像素就在那一格的位置
        rel = [(x - base[0], y - base[1]) for x, y in ofs]
        if all(vis) and not any(x or y for x, y in rel):
            l.visible = True
        elif not any(vis):
            l.visible = False
        else:
            l.visible = True
            varying[l.layer_id] = (vis, rel if any(x or y for x, y in rel) else None)
    return [round(d, 3) for _, d in frames], varying


# ---------- PSD 拆解 ----------
BLEND = {
    "NORMAL": "source-over", "MULTIPLY": "multiply", "SCREEN": "screen", "OVERLAY": "overlay",
    "DARKEN": "darken", "LIGHTEN": "lighten", "COLOR_DODGE": "color-dodge", "LINEAR_DODGE": "lighter",
    "COLOR_BURN": "color-burn", "HARD_LIGHT": "hard-light", "SOFT_LIGHT": "soft-light",
    "DIFFERENCE": "difference", "EXCLUSION": "exclusion", "HUE": "hue", "SATURATION": "saturation",
    "COLOR": "color", "LUMINOSITY": "luminosity",
}


def units_of(container):
    """把同一層的圖層分成「本體＋剪裁遮色片」一組一組（由下往上）。"""
    units = []
    for layer in container:
        if layer.clipping and units:
            units[-1].append(layer)
        else:
            units.append([layer])
    return units


def visible_ids(layer, out):
    if not layer.visible:
        return
    out.add(layer.layer_id)
    if layer.is_group():
        for c in layer:
            visible_ids(c, out)


def animated_inside(layer, split=()):
    if not layer.is_group():
        return False
    return any(l.visible and (fx_of(l.name) or l.layer_id in split) for l in layer.descendants())


def blend_inside(layer):
    """穿透群組裡有濾色這類圖層：要拆開群組，那層才能跟群組底下的東西混合。"""
    if not layer.is_group() or layer.blend_mode.name != "PASS_THROUGH":
        return False
    return any(l.visible and BLEND.get(l.blend_mode.name) not in (None, "source-over") and not is_adjustment(l)
               for l in layer.descendants())


def is_adjustment(layer):
    return type(layer).__module__.endswith("adjustments") and not layer.kind.endswith("fill")


def tree_of(container, vp):
    """畫板裡的圖層，照 PS 圖層面板的順序（上到下），給介面的「圖層」清單用。
    PS 裡隱藏的（自己或上層群組關掉眼睛）也列出來、標 psHidden，介面上可以打開。"""
    rows = []

    def walk(group, depth, off):
        for l in reversed(list(group)):
            hid = off or not l.visible
            x0, y0, x1, y1 = l.bbox
            rows.append({"lid": l.layer_id, "name": l.name, "kind": l.kind, "depth": depth,
                         "x": x0 - vp[0], "y": y0 - vp[1], "w": x1 - x0, "h": y1 - y0,
                         # 調整圖層和剪裁遮色片不能自己動（跟著底下那層）
                         "selectable": not is_adjustment(l) and not l.clipping, "fx": fx_of(l.name),
                         **({"psHidden": True} if hid else {})})
            if l.is_group():
                walk(l, depth + 1, hid)
    walk(container, 0, False)
    return rows


def safe(s):
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", s).strip(" ._")
    return s[:80] or "未命名"


class SceneBuilder:
    def __init__(self, psd, viewport, outdir, ancestors, split=(), groups=()):
        self.psd = psd
        # 介面上組的群組：[{id, name, lids}]。成員合成一張圖，放在最上面那個成員的位置
        self.member, self.gname, self.left, self.gunits, self.gchain = {}, {}, {}, {}, {}
        for g in groups:
            gid = int(g["id"])
            self.gname[gid] = g.get("name") or "群組"
            for lid in g.get("lids", []):
                self.member[int(lid)] = gid
        self.split = set(split)       # 介面上手動加特效的圖層：名稱沒寫也要單獨拆出來
        self.vp = viewport            # (left, top, right, bottom) 文件座標
        self.outdir = outdir
        self.ancestors = set(ancestors)
        self.count = 0
        self.warnings = []
        self.animated = []
        self.separated = False        # 有圖層被單獨拆出來（之後的靜態塊就不再是一整張）
        self.odd_blend = []           # 瀏覽器疊不出來的混合模式，只能留在靜態塊裡

    def render(self, units, extra_ancestors, adj=()):
        """adj = 疊在這塊上面的調整圖層（曲線等，含遮罩）：一起合成，這塊才會被調到。"""
        ids = set(self.ancestors) | set(extra_ancestors)
        for u in list(units) + [list(a) for a in adj]:
            for l in u:
                visible_ids(l, ids)
        # 合成是最慢的一步（整份 PSD 每塊約 1 秒）。同一份 PSD、同一組圖層合過就記在 renders/，
        # 打開一個隱藏圖層、加一個特效時，只有變動的那一塊要重合，其他塊直接拿來用。
        h = hashlib.md5(("%s|%s|%s" % (self.rkey, sorted(ids), list(self.vp))).encode()).hexdigest()
        rp = os.path.join(RENDERS, h)
        box = None
        try:
            with open(rp + ".json", encoding="utf-8") as f:
                box = json.load(f)
            if box and not os.path.isfile(rp + ".png"):
                box = None
            else:
                os.utime(rp + ".json", None)
                if not box:
                    return None                # 合過，是空的
        except (OSError, ValueError):
            box = None
        self.count += 1
        fn = "%03d.png" % self.count
        if box:
            shutil.copyfile(rp + ".png", os.path.join(self.outdir, fn))
        else:
            img = self.psd.composite(viewport=self.vp, layer_filter=lambda l: l.layer_id in ids)
            img = img.convert("RGBA") if img is not None else None
            box = img.getchannel("A").getbbox() if img is not None else None
            if not box:
                self.count -= 1
                with open(rp + ".json", "w", encoding="utf-8") as f:
                    json.dump(None, f)
                return None
            img.crop(box).save(os.path.join(self.outdir, fn))
            shutil.copyfile(os.path.join(self.outdir, fn), rp + ".png")
            with open(rp + ".json", "w", encoding="utf-8") as f:
                json.dump(list(box), f)
        return {"src": fn, "x": box[0], "y": box[1], "w": box[2] - box[0], "h": box[3] - box[1]}

    def build(self, container, chain, adj_above=()):
        """container 底下的圖層 -> 節點清單（由下往上畫）。chain = 祖先群組 id。
        adj_above = 外層疊在這個群組上面的調整圖層。"""
        nodes, run = [], []
        units = units_of(container)

        def adj_over(i):
            # 調整圖層會作用在它底下的所有東西：把 i 之後（上面）的調整圖層一起帶進去合成
            return [u for u in units[i + 1:] if u[0].visible and is_adjustment(u[0])] + list(adj_above)

        def flush(last):
            if run:
                n = self.render(run, chain, adj_over(last))
                if n:
                    n.update(type="image", name="（靜態）" + " / ".join(u[0].name for u in run[:3])
                             + (" …" if len(run) > 3 else ""), fx=None)
                    nodes.append(n)
                    if self.separated:
                        self.odd_blend += [u[0].name for u in run if u[0].blend_mode.name not in BLEND
                                           and u[0].blend_mode.name != "PASS_THROUGH" and not is_adjustment(u[0])]
                run.clear()

        for i, unit in enumerate(units):
            base = unit[0]
            if not base.visible:
                continue
            gid = self.member.get(base.layer_id)
            if gid is not None and gid in self.left:
                flush(i - 1)
                self.separated = True
                self.gunits.setdefault(gid, []).append(unit)
                self.gchain.setdefault(gid, set()).update(chain)
                self.left[gid].discard(base.layer_id)
                if not self.left[gid]:         # 最上面的成員到了：整組合成一張
                    n = self.render(self.gunits[gid], list(self.gchain[gid]), adj_over(i))
                    if n:
                        n.update(type="image", name=self.gname[gid], fx=None, lid=gid, blend="source-over")
                        nodes.append(n)
                continue
            fx = fx_of(base.name)
            for c in unit[1:]:
                if c.visible and fx_of(c.name):
                    self.warnings.append("「%s」是剪裁遮色片，會跟著底下那層一起處理，不會單獨動" % c.name)
            # 濾色、色彩增值這類：單獨一張，瀏覽器再用同樣的模式疊到底下的東西上
            blend = BLEND.get(base.blend_mode.name)
            own_blend = blend not in (None, "source-over") and not is_adjustment(base)
            if (animated_inside(base, self.split) or blend_inside(base)) and not base.clipping:
                flush(i - 1)
                self.separated = True
                inner_chain = chain + [base.layer_id]
                children = self.build(base, inner_chain, adj_over(i))
                if children:
                    xs = [c["x"] for c in children]; ys = [c["y"] for c in children]
                    xe = [c["x"] + c["w"] for c in children]; ye = [c["y"] + c["h"] for c in children]
                    nodes.append({"type": "group", "name": base.name, "fx": fx, "lid": base.layer_id, "children": children,
                                  "x": min(xs), "y": min(ys), "w": max(xe) - min(xs), "h": max(ye) - min(ys),
                                  "blend": "source-over"})
                    if fx:
                        self.animated.append({"name": base.name, "fx": fx})
                if len(unit) > 1:
                    self.warnings.append("群組「%s」有剪裁遮色片，可能和 PS 看起來不同" % base.name)
            elif fx or base.layer_id in self.split or own_blend:
                flush(i - 1)
                self.separated = True
                # 濾色這類圖層不先套上面的曲線：PS 是疊完才調色，先調再疊反而差更多（實測）
                n = self.render([unit], chain, [] if own_blend else adj_over(i))
                if n:
                    n.update(type="image", name=base.name, fx=fx, lid=base.layer_id, blend=blend or "source-over")
                    nodes.append(n)
                    if fx:
                        self.animated.append({"name": base.name, "fx": fx})
            else:
                run.append(unit)
        flush(len(units) - 1)
        return nodes


def artboard_bg(board):
    """畫板背景色（白／黑／透明／自訂）。讀不到就回 None（之後用介面上的背景色）。"""
    try:
        data = board._record.tagged_blocks
        for key in (b"artb", b"artd", b"abdd"):
            blk = data.get_data(key) if hasattr(data, "get_data") else None
            if blk is None:
                continue
            t = int(blk.get(b"artboardBackgroundType", 1))
            if t == 1:
                return "#ffffff"
            if t == 2:
                return "#000000"
            if t == 3:
                return None
            c = blk.get(b"Clr ")
            if c is not None:
                r, g, b = (float(c.get(k, 0)) for k in (b"Rd  ", b"Grn ", b"Bl  "))
                return "#%02x%02x%02x" % (round(r), round(g), round(b))
    except Exception:
        pass
    return None


def prune_cache(keep_per_psd=3, max_age_days=30):
    """快取（拆好的圖層 PNG）會越積越多：每份 PSD 只留最近用過的幾個版本，
    太久沒用、或 PSD 本身已經不在的就刪掉。用過的快取會被 load_psd「摸」一下更新時間。"""
    now, by_psd = time.time(), {}
    for d in os.listdir(CACHE):
        p = os.path.join(CACHE, d)
        if d in ("jobs", "renders") or not os.path.isdir(p):
            continue
        try:
            with open(os.path.join(p, "scenes.json"), encoding="utf-8") as f:
                psd = json.load(f)[0]["psd"]
            age = now - os.path.getmtime(p)
        except Exception:
            psd, age = None, 0
            if not d.endswith(".tmp") or now - os.path.getmtime(p) > 3600:
                shutil.rmtree(p, ignore_errors=True)   # 壞掉／沒寫完的
            continue
        if age > max_age_days * 86400 or not os.path.exists(psd):
            shutil.rmtree(p, ignore_errors=True)
            continue
        by_psd.setdefault(psd, []).append((age, p))
    for lst in by_psd.values():
        lst.sort()
        for _, p in lst[keep_per_psd:]:
            shutil.rmtree(p, ignore_errors=True)
    # 合成快取：太久沒用到的刪掉（用到時會「摸」一下 .json 更新時間）
    rd = os.path.join(CACHE, "renders")
    if os.path.isdir(rd):
        for f in os.listdir(rd):
            fp = os.path.join(rd, f)
            if f.endswith(".json") and now - os.path.getmtime(fp) > 14 * 86400:
                for x in (fp, fp[:-5] + ".png"):
                    try:
                        os.remove(x)
                    except OSError:
                        pass


# 同一份 PSD 一次只拆一次：兩個分頁（或 MCP）同時開同一份時，第二個等第一個拆完直接用快取，
# 不然兩邊會互相刪掉對方寫到一半的圖，頁面就讀不到圖。
_PSD_LOCKS, _PSD_LOCKS_GUARD = {}, threading.Lock()


def load_psd(path, split=(), hide=(), show=(), groups=(), ops=None):
    with _PSD_LOCKS_GUARD:
        lock = _PSD_LOCKS.setdefault(os.path.normcase(os.path.abspath(path)), threading.Lock())
    with lock:
        return _load_psd(path, split, hide, show, groups, ops or {})


def apply_layer_ops(psd, ops):
    """介面上改的名稱和圖層順序，只改記憶體裡的 PSD（不存回檔案）。
    ops = {"rename": {id: 名稱}, "moves": [[id, 目標 id, "above"|"below"|"into"], ...]}（照順序套）"""
    by = {l.layer_id: l for l in psd.descendants()}
    for lid, name in (ops.get("rename") or {}).items():
        l = by.get(int(lid))
        if l is not None and name:
            l.name = str(name)
    for mv in ops.get("moves") or []:
        try:
            x, t, where = by.get(int(mv[0])), by.get(int(mv[1])), mv[2]
        except (ValueError, TypeError, IndexError):
            continue
        if x is None or t is None or x is t or x.kind == "artboard":
            continue
        if x.is_group() and any(d is t for d in x.descendants()):
            continue                          # 不能放進自己裡面
        if where == "into" and t.is_group():
            x.parent.remove(x)
            t.append(x)                       # 群組最上面
        else:
            dest = t.parent
            x.parent.remove(x)
            i = list(dest).index(t)
            dest.insert(i + 1 if where == "above" else i, x)   # 清單由下往上：above = 排在後面


def _load_psd(path, split=(), hide=(), show=(), groups=(), ops=None):
    ops = ops or {}
    """split = 介面上手動加特效的圖層 id，要單獨拆出來。快取依 split 分開存。
    hide = 介面上「刪除」的圖層 id：當成隱藏，預覽和輸出都不出現（PSD 本身不改）。"""
    split = sorted({int(x) for x in split})
    hide = sorted({int(x) for x in hide})
    show = sorted({int(x) for x in show})   # PS 裡隱藏、介面上打開的圖層（連同上層群組一起打開）
    st = os.stat(path)
    key = hashlib.md5(("%s|%s|%s|%s|%s" % (path, st.st_mtime, st.st_size, PARSER_VERSION, split)
                       + ("|hide%s" % hide if hide else "") + ("|show%s" % show if show else "")
                       + ("|grp%s" % json.dumps(groups, sort_keys=True) if groups else "")
                       + ("|ops%s" % json.dumps(ops, sort_keys=True) if ops.get("rename") or ops.get("moves") else "")).encode()).hexdigest()[:16]
    pid = hashlib.md5(path.encode()).hexdigest()[:12]   # 畫板 id 不隨 split 變，介面的參考線等設定才接得上
    outdir = os.path.join(CACHE, key)
    meta = os.path.join(outdir, "scenes.json")
    if os.path.exists(meta):
        with open(meta, encoding="utf-8") as f:
            cached = json.load(f)

        def srcs(ns):
            for n in ns:
                if "src" in n:
                    yield n["src"]
                yield from srcs(n.get("children", []))
        # 圖不齊（以前兩邊同時拆、互相蓋掉留下的）就整份重拆
        if all(os.path.isfile(os.path.join(CACHE, *u[len("/cache/"):].split("/"))) for sc in cached for u in srcs(sc["nodes"])):
            os.utime(outdir, None)             # 標記最近用過，清快取時才不會被當成舊的
            return cached
    tmp = outdir + ".tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)
    os.makedirs(RENDERS, exist_ok=True)

    psd = PSDImage.open(path)
    stem = os.path.splitext(os.path.basename(path))[0]
    apply_layer_ops(psd, ops)
    # PS 影格動畫：每格會變的圖層單獨拆出來，介面照每格的顯示／位移畫
    delays, varying = apply_frames(psd)
    split = sorted(set(split) | set(varying) | {int(l) for g in groups for l in g.get("lids", [])})
    boards = [l for l in psd if l.kind == "artboard" and l.visible]
    jobs = []   # (title, viewport, container, chain, bg)
    if boards:
        for b in boards:
            jobs.append((b.name, b.bbox, b, [b.layer_id], artboard_bg(b)))
    else:
        jobs.append((None, (0, 0, psd.width, psd.height), psd, [], None))
    # 圖層清單先照 PS 原樣列（刪掉的也列出來、標 hidden，才能在介面上恢復），之後才把它們關掉
    trees = [tree_of(container, vp) for _, vp, container, _, _ in jobs]
    for t in trees:
        for r in t:
            if r["lid"] in hide:
                r["hidden"] = True
    if show:
        for l in psd.descendants():
            if l.layer_id in show:
                p = l
                while p is not None and getattr(p, "kind", "") not in ("artboard", "psdimage"):
                    p.visible = True  # 只改記憶體裡的，不會存回 PSD
                    p = p.parent
    if hide:
        for l in psd.descendants():
            if l.layer_id in hide:
                l.visible = False     # 只改記憶體裡的，不會存回 PSD

    scenes = []
    for i, (title, vp, container, chain, bg) in enumerate(jobs):
        sub = "s%d" % i
        os.makedirs(os.path.join(tmp, sub))
        sb = SceneBuilder(psd, vp, os.path.join(tmp, sub), chain, split, groups)
        vis = set()                            # 群組成員裡，這個畫板看得到的：最後一個到了才合成
        for c in container:
            visible_ids(c, vis)
        for g in groups:
            sb.left[int(g["id"])] = {int(l) for l in g.get("lids", []) if int(l) in vis}
        sb.rkey = "%s|%s|%s|%s" % (path, st.st_mtime, st.st_size, PARSER_VERSION)   # 合成快取用：PSD 一改就作廢
        nodes = sb.build(container, chain)
        if sb.odd_blend:
            sb.warnings.append("「%s」的混合模式（例如線性加深、實色疊印混合）小工具疊不出來，只會跟同一塊的靜態圖層混合；"
                               "如果它底下有會動的圖層，看起來會跟 PS 不同" % "、".join(sorted(set(sb.odd_blend))[:5]))
        for l in container.descendants():
            if l.visible and is_adjustment(l) and l.kind not in _adj.ADJUSTMENT_FUNC:
                sb.warnings.append("調整圖層「%s」（%s）畫不出來，請在 PS 先合併到底下圖層"
                                   % (l.name, ADJ_NAMES.get(l.kind, l.kind)))

        def prefix(ns):
            for n in ns:
                if "src" in n:
                    n["src"] = "/cache/%s/%s/%s" % (key, sub, n["src"])
                prefix(n.get("children", []))
        prefix(nodes)

        def mark(ns):
            for n in ns:
                if n.get("lid") in varying:
                    vis, rel = varying[n["lid"]]
                    n["fv"] = vis
                    if rel:
                        n["fo"] = rel
                mark(n.get("children", []))
        mark(nodes)
        out_name = safe(stem if title is None else "%s_%s" % (stem, title))
        scenes.append({
            "id": "%s-%d" % (pid, i), "psd": path, "psdName": os.path.basename(path),
            "title": title or stem, "outName": out_name,
            "w": vp[2] - vp[0], "h": vp[3] - vp[1], "bg": bg,
            "nodes": nodes, "animated": sb.animated, "warnings": sb.warnings,
            "tree": trees[i], "frames": delays,
        })
    with open(os.path.join(tmp, "scenes.json"), "w", encoding="utf-8") as f:
        json.dump(scenes, f, ensure_ascii=False)
    shutil.rmtree(outdir, ignore_errors=True)
    os.replace(tmp, outdir)
    try:
        prune_cache()                          # 剛多了一個版本：順便把同一份 PSD 太舊的版本清掉
    except Exception:
        pass
    return scenes


def expand_paths(items):
    out = []
    for p in items:
        p = p.strip().strip('"')
        if not p:
            continue
        if os.path.isdir(p):
            for fn in sorted(os.listdir(p)):
                if fn.lower().endswith((".psd", ".psb")):
                    out.append(os.path.join(p, fn))
        elif os.path.isfile(p):
            out.append(p)
    return out


# ---------- 拖曳載入：瀏覽器只給檔名，不給路徑 ----------
# 先用「檔名＋大小＋修改時間」到常用資料夾找回原檔（輸出才會在原 PSD 旁邊），找不到才上傳一份。
UPLOADS = os.path.join(ROOT, "拖進來的PSD")
SKIP_DIRS = {"node_modules", ".git", "AppData", "$RECYCLE.BIN", "_cache"}


def locate(name, size, mtime_ms, hints=()):
    home = os.path.expanduser("~")
    roots = list(hints) + [os.path.join(home, d) for d in ("Desktop", "Documents", "Downloads", "Pictures", "OneDrive")]
    best, seen = None, set()
    for root in roots:
        if not os.path.isdir(root) or root in seen:
            continue
        seen.add(root)
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
            if name not in filenames:
                continue
            p = os.path.join(dirpath, name)
            try:
                st = os.stat(p)
            except OSError:
                continue
            if st.st_size != size:
                continue
            diff = abs(st.st_mtime * 1000 - mtime_ms)
            if diff < 2000:
                return p                      # 名稱、大小、時間都對上：就是它
            if best is None or diff < best[0]:
                best = (diff, p)
    return best[1] if best else None


def save_upload(name, data):
    os.makedirs(UPLOADS, exist_ok=True)
    stem, ext = os.path.splitext(safe(name))
    p = os.path.join(UPLOADS, stem + ext)
    n = 1
    while os.path.exists(p) and os.path.getsize(p) != len(data):   # 同名不同檔：另存一份
        n += 1
        p = os.path.join(UPLOADS, "%s (%d)%s" % (stem, n, ext))
    if not os.path.exists(p):
        with open(p, "wb") as f:
            f.write(data)
    return p


# ---------- 選檔視窗（另開 process 跑 tkinter，避免卡住 server） ----------
PICK = r"""
import json, sys, tkinter as tk, tkinter.filedialog as fd
r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True)
if sys.argv[1] == 'folder':
    p = fd.askdirectory(title='選擇放 PSD 的資料夾'); p = [p] if p else []
else:
    p = list(fd.askopenfilenames(title='選擇 PSD（可多選）', filetypes=[('Photoshop', '*.psd *.psb')]))
sys.stdout.write(json.dumps(p, ensure_ascii=True))
"""


def pick(mode):
    r = subprocess.run([sys.executable, "-c", PICK, mode], capture_output=True, text=True)
    try:
        return json.loads(r.stdout or "[]")
    except ValueError:
        return []


# ---------- 指令介面（給 MCP／腳本操控開著的頁面）----------
# 外面 POST /api/cmd 丟一個指令進來，等頁面做完；頁面一直用 GET /api/cmd/next 等指令，
# 做完 POST /api/cmd/done 回報。動畫是頁面畫的，所以指令都交給頁面執行。
CMDS = []                 # 還沒被頁面拿走的指令
WAITING = {}              # id -> {"ev": Event, "res": 結果}
CMD_LOCK = threading.Condition()
LAST_POLL = [0.0]         # 頁面最後一次來拿指令的時間
# 開了好幾個分頁時只讓一個接指令（不然指令會輪流跑到不同分頁，設定跟圖層各說各話）。
# 最後開的或最後點過的分頁搶到；接指令的分頁關掉超過 25 秒，下一個來問的接手。
TABS = {}                 # 分頁 id -> 最後一次來拿指令的時間
OWNER = [None]


def page_alive():
    return time.time() - LAST_POLL[0] < 30


def claim_tab(tab):
    with CMD_LOCK:
        OWNER[0] = tab
        TABS[tab] = time.time()
        CMD_LOCK.notify_all()


def run_cmd(o):
    """把指令交給頁面，等它回報。沒有頁面開著就幫忙打開，最多等 20 秒它連上。"""
    if not page_alive():
        webbrowser.open("http://127.0.0.1:%d" % PORT)
        for _ in range(40):
            time.sleep(0.5)
            if page_alive():
                break
        else:
            return {"ok": False, "error": "小工具頁面沒有開著（已試著打開瀏覽器，20 秒內沒連上）"}
    cid = uuid.uuid4().hex
    w = WAITING[cid] = {"ev": threading.Event(), "res": None}
    with CMD_LOCK:
        CMDS.append({"id": cid, "cmd": o.get("cmd"), "args": o.get("args") or {}})
        CMD_LOCK.notify_all()
    if not w["ev"].wait(float(o.get("timeout") or 120)):
        with CMD_LOCK:
            CMDS[:] = [c for c in CMDS if c["id"] != cid]
        WAITING.pop(cid, None)
        return {"ok": False, "error": "等太久，頁面沒有回應"}
    return WAITING.pop(cid)["res"]


def next_cmd(tab="", wait=20.0):
    end = time.time() + wait
    with CMD_LOCK:
        while True:
            now = LAST_POLL[0] = TABS[tab] = time.time()
            if OWNER[0] is None or now - TABS.get(OWNER[0], 0) > 25:
                OWNER[0] = tab
            mine = OWNER[0] == tab
            if mine and CMDS:
                return CMDS.pop(0)
            left = end - time.time()
            if left <= 0:
                return {} if mine else {"standby": True}
            CMD_LOCK.wait(min(left, 5))


# ---------- 輸出 ----------
JOBS = {}


def run_ffmpeg(args):
    r = subprocess.run(["ffmpeg", "-v", "error", "-y"] + args, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-800:])


def export(job, o):
    d = JOBS[job]
    psd = o["psd"]
    outdir = os.path.join(os.path.dirname(psd), "輸出")
    os.makedirs(outdir, exist_ok=True)
    fps = float(o["fps"])
    frames = len([f for f in os.listdir(d) if f.endswith(".png")])
    src = ["-framerate", str(fps), "-i", os.path.join(d, "%05d.png")]
    bg = o.get("bg") or "#ffffff"
    if o["fmt"] == "mp4":
        out = os.path.join(outdir, o["outName"] + ".mp4")
        rep = max(1, int(o.get("repeat", 1)))
        vf = "loop=loop=%d:size=%d:start=0," % (rep - 1, frames) if rep > 1 else ""
        mw = int(o.get("mp4Width") or 0)        # 0 = 原尺寸；-2 讓高度維持比例又是偶數
        if mw:
            vf += "scale=%d:-2:flags=lanczos," % (mw // 2 * 2)
        vf += "pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=%s,format=yuv420p" % bg
        run_ffmpeg(src + ["-vf", vf, "-c:v", "libx264", "-preset", "slow", "-crf", "16",
                          "-r", str(fps), "-movflags", "+faststart", out])
        note = ("寬 %d、" % (mw // 2 * 2) if mw else "") + "%d fps、%g 秒" % (fps, frames / fps * rep)
    else:
        out = os.path.join(outdir, o["outName"] + ".gif")
        fixed = int(o.get("width") or 0) > 0      # 使用者指定了寬度：寬度不動，只降 fps／色數
        width = int(o.get("width") or 0) or int(o["w"])
        max_mb = float(o.get("maxMB") or 3)
        # 由清楚到小檔：先減色數，再「每兩格取一格」降 fps，壓不下來才縮尺寸（指定寬度時不縮，最後頂多超過上限）。
        # GIF 每格時間只能是 0.01 秒的整數倍：fps 只用 25／12.5／6.25 這種整齊的（畫面送來的就是這種），
        # 而且只對半減，每格時間才會一樣長，不會一快一慢看起來卡卡的。
        half, quarter = fps / 2, fps / 4
        if fixed:
            presets = [(1, fps, 256), (1, fps, 192), (1, half, 256), (1, half, 192), (1, half, 128),
                       (1, half, 96), (1, quarter, 128), (1, quarter, 96), (1, quarter, 64)]
        else:
            presets = [(1, fps, 256), (1, fps, 192), (1, half, 256), (1, half, 192), (1, half, 128),
                       (0.9, half, 128), (0.8, half, 128), (0.7, half, 128), (0.6, half, 96), (0.5, quarter, 96), (0.4, quarter, 64)]
        tmp = out + ".tmp.gif"
        for s, f, c in presets:
            w = max(2, int(round(width * s)))
            vf = ("fps=%g,scale=%d:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=%d:stats_mode=full[p];"
                  "[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" % (f, w, c))
            run_ffmpeg(src + ["-filter_complex", vf, "-loop", "0", "-f", "gif", tmp])
            mb = os.path.getsize(tmp) / 1048576
            if mb <= max_mb:
                break
        os.replace(tmp, out)
        note = "寬 %d、%g fps、%d 色" % (w, f, c) + ("" if mb <= max_mb else
                                                 "（寬度照你指定的，最省設定仍超過 %g MB：建議在預覽上拉參考線切開）" % max_mb if fixed else
                                                 "（最小設定仍超過 %g MB：建議在預覽上拉參考線切開）" % max_mb)
    shutil.rmtree(d, ignore_errors=True)
    JOBS.pop(job, None)
    return {"path": out, "mb": round(os.path.getsize(out) / 1048576, 2), "note": note}


# ---------- HTTP ----------
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"   # 連線重複使用，送幾十張畫格比較快也比較穩

    def log_message(self, *a):
        pass

    def send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        u = urlparse(self.path)
        path = unquote(u.path)
        if path in ("/", "/index.html"):
            with open(os.path.join(ROOT, "index.html"), "rb") as f:
                return self.send(200, f.read(), "text/html; charset=utf-8")
        if path == "/api/version":
            return self.send(200, {"version": APP_VERSION, "page": page_alive()})
        if path == "/api/cmd/next":
            return self.send(200, next_cmd(parse_qs(u.query).get("tab", [""])[0]))
        if path == "/icon.png":
            with open(os.path.join(ROOT, "icon.png"), "rb") as f:
                return self.send(200, f.read(), "image/png")
        if path.startswith("/cache/"):
            fp = os.path.normpath(os.path.join(CACHE, path[len("/cache/"):]))
            if fp.startswith(CACHE + os.sep) and os.path.isfile(fp):
                with open(fp, "rb") as f:
                    return self.send(200, f.read(), "image/png")
        self.send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        try:
            if u.path == "/api/pick":
                return self.send(200, {"paths": pick(json.loads(self.body() or b"{}").get("mode", "files"))})
            if u.path == "/api/load":
                req = json.loads(self.body())
                paths = expand_paths(req["paths"])
                split = req.get("split") or {}     # {PSD 路徑: [圖層 id]}
                hide = req.get("hide") or {}       # {PSD 路徑: [刪除的圖層 id]}
                show = req.get("show") or {}       # {PSD 路徑: [PS 隱藏、介面打開的圖層 id]}
                groups = req.get("groups") or {}   # {PSD 路徑: [{id, name, lids}]} 介面上組的群組
                ops = req.get("ops") or {}         # {PSD 路徑: {rename, moves}} 介面上改的名稱／順序
                scenes, errors = [], []
                for p in paths:
                    try:
                        scenes += load_psd(p, split.get(p, []), hide.get(p, []), show.get(p, []), groups.get(p, []), ops.get(p))
                    except Exception as e:
                        errors.append("%s：%s" % (os.path.basename(p), e))
                if not paths:
                    errors.append("找不到 PSD")
                return self.send(200, {"scenes": scenes, "errors": errors})
            if u.path == "/api/locate":
                o = json.loads(self.body())
                hints = [os.path.dirname(p) for p in o.get("hints", []) if p]
                return self.send(200, {"path": locate(o["name"], int(o["size"]), float(o.get("mtime") or 0), hints)})
            if u.path == "/api/upload":
                name = parse_qs(u.query)["name"][0]
                if not name.lower().endswith((".psd", ".psb")):
                    raise ValueError("只能拖 PSD／PSB")
                return self.send(200, {"path": save_upload(name, self.body())})
            if u.path == "/api/export/begin":
                job = uuid.uuid4().hex
                d = os.path.join(CACHE, "jobs", job)
                os.makedirs(d)
                JOBS[job] = d
                return self.send(200, {"job": job})
            if u.path == "/api/export/frame":
                q = parse_qs(u.query)
                d = JOBS[q["job"][0]]
                with open(os.path.join(d, "%05d.png" % int(q["i"][0])), "wb") as f:
                    f.write(self.body())
                return self.send(200, {"ok": True})
            if u.path == "/api/export/still":
                # 切圖的靜態段：瀏覽器已經畫好 PNG/JPG，直接存進「輸出」
                q = parse_qs(u.query)
                psd, name, ext = q["psd"][0], safe(q["name"][0]), q["ext"][0]
                if ext not in ("png", "jpg"):
                    raise ValueError("不支援的格式")
                outdir = os.path.join(os.path.dirname(psd), "輸出")
                os.makedirs(outdir, exist_ok=True)
                out = os.path.join(outdir, name + "." + ext)
                with open(out, "wb") as f:
                    f.write(self.body())
                return self.send(200, {"path": out, "mb": round(os.path.getsize(out) / 1048576, 2)})
            if u.path == "/api/export/end":
                o = json.loads(self.body())
                return self.send(200, export(o["job"], o))
            if u.path == "/api/cmd":
                return self.send(200, run_cmd(json.loads(self.body() or b"{}")))
            if u.path == "/api/cmd/claim":
                claim_tab(json.loads(self.body() or b"{}").get("tab", ""))
                return self.send(200, {"ok": True})
            if u.path == "/api/cmd/done":
                o = json.loads(self.body())
                w = WAITING.get(o.get("id"))
                if w:
                    w["res"] = {k: v for k, v in o.items() if k != "id"}
                    w["ev"].set()
                return self.send(200, {"ok": True})
            if u.path == "/api/reveal":
                p = json.loads(self.body())["path"]
                if os.path.exists(p):
                    subprocess.Popen(["explorer", "/select,", os.path.normpath(p)])
                return self.send(200, {"ok": True})
        except Exception as e:
            return self.send(500, {"error": str(e)})
        self.send(404, {"error": "not found"})


class Server(ThreadingHTTPServer):
    # Windows 上 SO_REUSEADDR 會讓第二份也綁得上同一個 port，關掉才偵測得到「已經開著」
    allow_reuse_address = False


def main():
    url = "http://127.0.0.1:%d" % PORT
    try:
        srv = Server(("127.0.0.1", PORT), H)
    except OSError:
        # 已經開著了（又點了一次捷徑）：直接打開頁面就好
        webbrowser.open(url)
        return
    os.makedirs(CACHE, exist_ok=True)
    shutil.rmtree(os.path.join(CACHE, "jobs"), ignore_errors=True)
    threading.Thread(target=prune_cache, daemon=True).start()
    print("動態小工具已啟動：%s（關掉這個視窗就結束）" % url)
    if "--no-browser" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    srv.serve_forever()


if __name__ == "__main__":
    main()
