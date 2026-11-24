# 動態小工具 MCP：讓 Claude 直接操控開著的小工具頁面。
# 只用 Python 內建模組（MCP 的 stdio JSON-RPC 自己處理），不用另外安裝套件。
# 每個工具都轉成 server.py 的 POST /api/cmd，由頁面執行（動畫是頁面畫的）。
# 小工具沒開就幫忙用「啟動.bat」打開（黑色視窗＋瀏覽器），跟雙擊捷徑一樣。
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT") or 8765)
BASE = "http://127.0.0.1:%d" % PORT

SCENE = {"description": "畫板：status 給的 id、標題（可部分）或第幾個（1 起算）；不給 = 目前選的畫板",
         "type": ["string", "integer"]}
SETTINGS_KEYS = (
    "整體：loop（循環秒數，手動）、loopAuto（自動算循環）、pace（'slow'|'normal'|'fast'|'' 節奏，會改所有 *Dur）、bg。"
    "每個特效 k = bob 飄浮／sway 搖擺／pulse 縮放／flash 閃光／sweep 流光：kDur（每次動作秒數）、kTimes（次數）、"
    "kSeq（多層接續 true/false）、kSeqMode（'turn' 輪流｜'stagger' 錯開）。"
    "逐格（bob/sway/pulse）：kStep（面板逐格 true/false）、kFrames（每次幾格）。"
    "其他：bobAmp、swayAngle、swayAnchor（center/bottom/top）、pulseAmp、pulseUp、flashLow、"
    "sweepMove、sweepWidth、sweepPower、sweepAngle、sweepGold。"
    "跳色 k = hue：hueDur、hueTimes、hueSeq、hueSeqMode，hueColors = 色票 [{fill: '#rrggbb' 或 null（原色）, stroke: {color, width} 或 null}]。"
    "描邊：strokeColor、strokeWidth。"
    "輸出：doMp4、mp4Fps、mp4Repeat、mp4Width、doGif、gifFps、gifWidth（0＝原尺寸可縮；數字＝固定寬）、gifMB、stillFmt（png/jpg）。"
    "進場：enterType（同 set_fx 的 enter）、enterDur、enterGap（間隔秒）、enterDelay、enterHold（進完停留秒）、"
    "enterEase（out/back/inout/linear）、enterDist（0＝從畫面外，數字＝滑幾 px 並淡入）、enterOutro（結尾淡出）。"
    "PS 影格（時間軸影格動畫）會自動讀，不用設定。")

TOOLS = [
    ("motion_status", "小工具狀態：版本、是否正在輸出、開著的畫板清單（id、標題、PSD、尺寸、循環秒數、參考線數）。",
     {}, [], "status"),
    ("motion_open", "載入 PSD（或資料夾）。每個畫板變成一支影片；回傳畫板清單與讀取錯誤。",
     {"paths": {"type": "array", "items": {"type": "string"}, "description": "PSD／資料夾的完整路徑"}}, ["paths"], "open"),
    ("motion_select", "切換到某個畫板（預覽會換過去）。", {"scene": SCENE}, ["scene"], "select"),
    ("motion_layers", "列出畫板的圖層（照 PS 面板上到下）：lid、名稱、目前生效的特效 fx、手動設定 manual、接續 slot {特效: [第幾個, 共幾個]}。",
     {"scene": SCENE}, [], "layers"),
    ("motion_set_fx", "手動設定圖層特效（跟在左邊圖層清單點選一樣，可 Ctrl+Z）。fx 欄位：main = 'bob'|'sway'|'flash'|null（主動作），"
     "pulse（縮放）、sweep（流光）、hue（跳色）、stroke（描邊）= true/false，step（逐格）= true/false，order = 接續順序數字（同號同時），solo = true 不參加接續（自己一直連續動），hidden = true 刪除這層（預覽和輸出都不出現，PSD 不改；false/null 恢復），show = true 打開 PS 裡隱藏的圖層（layers 的 psHidden；連上層群組一起開，PSD 不改），name = 改名稱（名稱裡的關鍵字會生效，空字串＝回到 PS 名稱），move = [x, y] 位移 px，enter = 進場方式 'left'|'right'|'top'|'bottom'|'zoom'|'pop'|'fade'|'blur'|'wipe'|'default'（照面板）或 false。"
     "欄位給 null = 回到圖層名稱的設定；reset: true = 先清掉這層所有手動設定。",
     {"scene": SCENE, "lids": {"type": "array", "items": {"type": "integer"}},
      "fx": {"type": "object"}, "reset": {"type": "boolean"}}, ["lids"], "set_fx"),
    ("motion_get_settings", "讀取右邊設定面板全部數值。", {}, [], "get_settings"),
    ("motion_set_settings", "改設定面板（可 Ctrl+Z），回傳改後數值和節奏說明。可用的鍵：" + SETTINGS_KEYS,
     {"values": {"type": "object", "description": "{鍵: 值}，照順序套用"}}, ["values"], "set_settings"),
    ("motion_rhythm", "面板「整體」寫的節奏說明：循環秒數、每個特效每次幾秒、逐格多久跳一格、輪流文字時間軸。",
     {"scene": SCENE}, [], "rhythm"),
    ("motion_sample", "不出圖就檢查動態：各圖層在指定時間點的 [位移 px, 旋轉 °, 縮放, 透明度]。times 不給 = 一個循環平均取 9 點。",
     {"scene": SCENE, "lids": {"type": "array", "items": {"type": "integer"}},
      "times": {"type": "array", "items": {"type": "number"}}}, [], "sample"),
    ("motion_set_guides", "設定參考線（切圖用），guides = 畫板內的 y 座標 px；空陣列 = 清掉。",
     {"scene": SCENE, "guides": {"type": "array", "items": {"type": "number"}}}, ["guides"], "set_guides"),
    ("motion_export", "輸出到 PSD 旁的「輸出」資料夾。scenes = 要輸出的畫板（陣列或 'all'；不給 = 照目前勾選），"
     "formats = ['gif'] / ['mp4'] / 兩個都要（不給 = 照面板）。回傳每個檔案的路徑和 MB。",
     {"scenes": {"type": ["array", "string"]}, "formats": {"type": "array", "items": {"type": "string", "enum": ["gif", "mp4"]}}},
     [], "export"),
    ("motion_template", "動態範本：把目前畫板的手動特效（照圖層名稱）＋右邊設定存起來，套到圖層名稱一樣的其他畫板。"
     "action = 'list'｜'save'｜'apply'｜'delete'，save/apply/delete 要給 name；apply 作用在目前選的畫板，回傳對到／沒對到的圖層名稱。",
     {"action": {"type": "string", "enum": ["list", "save", "apply", "delete"]}, "name": {"type": "string"}}, ["action"], "template"),
    ("motion_reorder", "改圖層順序（像 PS 圖層面板拖曳，只改小工具裡的，PSD 不改）：lids 放到 target 的 where = 'above'｜'below'｜'into'（放進資料夾最上面）；reset: true = 還原成 PS 的順序。",
     {"scene": SCENE, "lids": {"type": "array", "items": {"type": "integer"}}, "target": {"type": "integer"},
      "where": {"type": "string", "enum": ["above", "below", "into"]}, "reset": {"type": "boolean"}}, [], "reorder"),
    ("motion_group", "群組：把好幾個圖層組在一起，合成一張、一起動（特效用 set_fx 加在群組的 id 上）。"
     "action = 'make'（lids 至少兩個、name）｜'ungroup'（id）｜'list'。群組在 layers 裡是 kind 'vgroup' 的列。",
     {"scene": SCENE, "action": {"type": "string", "enum": ["make", "ungroup", "list"]},
      "lids": {"type": "array", "items": {"type": "integer"}}, "name": {"type": "string"}, "id": {"type": "integer"}},
     ["action"], "group"),
    ("motion_undo", "復原上一步（redo: true = 重做）。", {"redo": {"type": "boolean"}}, [], "undo"),
]
TIMEOUT = {"export": 1800, "open": 600}


def http(path, body=None, timeout=10):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def ensure_server():
    try:
        return http("/api/version")
    except Exception:
        pass
    os.startfile(os.path.join(ROOT, "啟動.bat"))     # 跟雙擊捷徑一樣：黑色視窗＋瀏覽器
    for _ in range(60):
        time.sleep(0.5)
        try:
            return http("/api/version")
        except Exception:
            pass
    raise RuntimeError("小工具伺服器沒有啟動起來（試著執行了 啟動.bat）")


def call(cmd, args):
    ensure_server()
    if cmd == "undo" and args.pop("redo", False):
        cmd = "redo"
    t = TIMEOUT.get(cmd, 120)
    return http("/api/cmd", {"cmd": cmd, "args": args, "timeout": t}, timeout=t + 30)


def reply(mid, result=None, error=None):
    o = {"jsonrpc": "2.0", "id": mid}
    if error:
        o["error"] = error
    else:
        o["result"] = result
    sys.stdout.buffer.write((json.dumps(o, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.buffer.flush()


def handle(msg):
    mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
    if mid is None:
        return                                      # notification
    if method == "initialize":
        return reply(mid, {"protocolVersion": params.get("protocolVersion") or "2024-11-05",
                           "capabilities": {"tools": {}},
                           "serverInfo": {"name": "motion-tool", "version": "1"}})
    if method == "ping":
        return reply(mid, {})
    if method == "tools/list":
        return reply(mid, {"tools": [{"name": n, "description": d,
                                      "inputSchema": {"type": "object", "properties": p, "required": r}}
                                     for n, d, p, r, _ in TOOLS]})
    if method == "tools/call":
        cmd = {n: c for n, _, _, _, c in TOOLS}.get(params.get("name"))
        if not cmd:
            return reply(mid, error={"code": -32602, "message": "unknown tool"})
        try:
            r = call(cmd, dict(params.get("arguments") or {}))
            ok = r.get("ok", False)
            text = json.dumps(r.get("result") if ok else r.get("error"), ensure_ascii=False)
        except Exception as e:
            ok, text = False, str(e)
        return reply(mid, {"content": [{"type": "text", "text": text}], "isError": not ok})
    reply(mid, error={"code": -32601, "message": "method not found"})


def main():
    for line in sys.stdin.buffer:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line.decode("utf-8")))
        except Exception as e:
            sys.stderr.write("motion_mcp: %s\n" % e)


if __name__ == "__main__":
    main()
