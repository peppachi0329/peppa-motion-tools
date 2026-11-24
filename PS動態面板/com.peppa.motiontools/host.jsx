// Photoshop side. Kept ASCII-only; Chinese text lives in index.html.
var __abr = {};
var ABR_PREFIX_RE = /^\u52D5-\s*\S+\s+/; // "動-xxx " prefix added before

function abrIsArtboard(layer) {
    var r = new ActionReference();
    r.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("artboardEnabled"));
    r.putIdentifier(charIDToTypeID("Lyr "), layer.id);
    var d = executeActionGet(r);
    return d.hasKey(stringIDToTypeID("artboardEnabled")) && d.getBoolean(stringIDToTypeID("artboardEnabled"));
}

function abrSelectedIds() {
    var ids = {};
    try {
        var r = new ActionReference();
        r.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("targetLayersIDs"));
        r.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        var list = executeActionGet(r).getList(stringIDToTypeID("targetLayersIDs"));
        for (var i = 0; i < list.count; i++) ids[list.getReference(i).getIdentifier()] = true;
    } catch (e) {}
    return ids;
}

function abrLayerRef(id) {
    var r = new ActionReference();
    r.putIdentifier(charIDToTypeID("Lyr "), id);
    return r;
}

function abrGetName(id) {
    return executeActionGet(abrLayerRef(id)).getString(charIDToTypeID("Nm  "));
}

// 先單獨選取那層再改名（多選時直接用 ID 改名不可靠）；選取在 abrRestoreSel 還原
function abrSetName(id, name) {
    abrSelect(id, false);
    app.activeDocument.activeLayer.name = name;
}

function abrRestoreSel(ids) {
    var list = [];
    for (var k in ids) list.push(+k);
    for (var i = 0; i < list.length; i++) {
        try { abrSelect(list[i], i > 0); } catch (e) {}
    }
}

// 有選取 -> 選取的圖層／工作區域本身；沒選取 -> 全部工作區域。回傳圖層 ID 陣列
function abrTargets(doc) {
    var picked = [], ids = abrSelectedIds();
    for (var k in ids) picked.push(+k);
    if (picked.length) return picked;
    var all = [];
    for (var i = 0; i < doc.layers.length; i++) {
        if (abrIsArtboard(doc.layers[i])) all.push(doc.layers[i].id);
    }
    return all;
}

function abrRun() {
    var a = __abr, targets = abrTargets(app.activeDocument), count = 0;
    a.total = targets.length;
    for (var i = 0; i < targets.length; i++) {
        var name = abrGetName(targets[i]), base = name;
        if (a.prefix === null || a.replace) {
            base = (a.custom && name.indexOf(a.custom) === 0) ? name.substr(a.custom.length) : name.replace(ABR_PREFIX_RE, "");
        }
        var next = a.prefix === null ? base : a.prefix + base;
        if (next !== name) { abrSetName(targets[i], next); count++; }
    }
    a.count = count;
}

function abrArtboardRect(layer) {
    var r = new ActionReference();
    r.putIdentifier(charIDToTypeID("Lyr "), layer.id);
    var d = executeActionGet(r).getObjectValue(stringIDToTypeID("artboard")).getObjectValue(stringIDToTypeID("artboardRect"));
    return {
        top: d.getDouble(stringIDToTypeID("top")), left: d.getDouble(stringIDToTypeID("left")),
        bottom: d.getDouble(stringIDToTypeID("bottom")), right: d.getDouble(stringIDToTypeID("right"))
    };
}

// 新工作區域放在現有工作區域的最右邊，間隔 100px
function abrAddRun() {
    var a = __abr, doc = app.activeDocument, left = 0, top = 0, found = false;
    for (var i = 0; i < doc.layers.length; i++) {
        if (!abrIsArtboard(doc.layers[i])) continue;
        var b = abrArtboardRect(doc.layers[i]);
        if (!found) { top = b.top; left = b.right; found = true; }
        else { top = Math.min(top, b.top); left = Math.max(left, b.right); }
    }
    if (found) left += 100;
    abrMakeArtboard(left, top, a.w, a.h, a.name);
}

function abrMakeArtboard(left, top, w, h, name) {
    var doc = app.activeDocument;
    // 先取消選取圖層，不然選到的圖層會被包進新工作區域
    var dn = new ActionDescriptor(), rn = new ActionReference();
    rn.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    dn.putReference(charIDToTypeID("null"), rn);
    try { executeAction(stringIDToTypeID("selectNoLayers"), dn, DialogModes.NO); } catch (e) {}

    var desc = new ActionDescriptor(), ref = new ActionReference(), rect = new ActionDescriptor();
    ref.putClass(stringIDToTypeID("artboardSection"));
    desc.putReference(charIDToTypeID("null"), ref);
    rect.putDouble(stringIDToTypeID("top"), top);
    rect.putDouble(stringIDToTypeID("left"), left);
    rect.putDouble(stringIDToTypeID("bottom"), top + h);
    rect.putDouble(stringIDToTypeID("right"), left + w);
    desc.putObject(stringIDToTypeID("artboardRect"), stringIDToTypeID("classFloatRect"), rect);
    executeAction(charIDToTypeID("Mk  "), desc, DialogModes.NO);

    if (name) doc.activeLayer.name = name;
}

// ---- 依據選取的矩形（或任何圖層）的範圍建立工作區域，原本的圖層保留不動 ----
function abrFromRectsRun() {
    var a = __abr, doc = app.activeDocument, rects = [], sel = abrSelectedIds();
    for (var k in sel) {
        abrSelect(+k, false);
        var L = doc.activeLayer;
        if (abrIsArtboard(L)) { a.skipped++; continue; }
        var b = L.boundsNoEffects;
        var r = { left: b[0].as("px"), top: b[1].as("px"), right: b[2].as("px"), bottom: b[3].as("px") };
        if (r.right - r.left < 1 || r.bottom - r.top < 1) { a.skipped++; continue; }
        rects.push(r);
    }
    rects.sort(function (p, q) { return Math.abs(p.top - q.top) > 50 ? p.top - q.top : p.left - q.left; });
    a.total = rects.length;
    for (var i = 0; i < rects.length; i++) {
        var w = Math.round(rects[i].right - rects[i].left), h = Math.round(rects[i].bottom - rects[i].top);
        abrMakeArtboard(Math.round(rects[i].left), Math.round(rects[i].top), w, h, w + "x" + h);
        a.count++;
    }
}

function abrArtboardsFromRects() {
    try {
        if (!app.documents.length) return "err|nodoc";
        var ru = app.preferences.rulerUnits;
        app.preferences.rulerUnits = Units.PIXELS;
        __abr = { count: 0, skipped: 0, total: 0 };
        try {
            app.activeDocument.suspendHistory("Artboards from rectangles", "abrFromRectsRun()");
        } finally {
            app.preferences.rulerUnits = ru;
        }
        if (!__abr.total) return "err|nosel";
        return "fromrect|" + __abr.count + "|" + __abr.skipped;
    } catch (e) {
        return "err|" + e.message;
    }
}

function abrAddArtboard(w, h, name) {
    try {
        if (!app.documents.length) return "err|nodoc";
        var ru = app.preferences.rulerUnits;
        app.preferences.rulerUnits = Units.PIXELS;
        __abr = { w: w, h: h, name: name };
        try {
            app.activeDocument.suspendHistory("New artboard " + w + "x" + h, "abrAddRun()");
        } finally {
            app.preferences.rulerUnits = ru;
        }
        return "added|" + w + "|" + h;
    } catch (e) {
        return "err|" + e.message;
    }
}

function abrSelect(id, add) {
    var d = new ActionDescriptor();
    d.putReference(charIDToTypeID("null"), abrLayerRef(id));
    if (add) d.putEnumerated(stringIDToTypeID("selectionModifier"), stringIDToTypeID("selectionModifierType"), stringIDToTypeID("addToSelection"));
    d.putBoolean(charIDToTypeID("MkVs"), false);
    executeAction(charIDToTypeID("slct"), d, DialogModes.NO);
}

// 文字圖層直接套；群組／工作區域就套裡面所有文字圖層
function abrApplyFont(layer, a) {
    if (layer.typename === "LayerSet") {
        for (var i = 0; i < layer.layers.length; i++) abrApplyFont(layer.layers[i], a);
    } else if (layer.kind === LayerKind.TEXT) {
        try {
            if (a.font) layer.textItem.font = a.font;
            layer.textItem.tracking = a.tracking;
            a.count++;
        } catch (e) { a.failed++; }
    }
}

function abrFontRun() {
    var a = __abr, doc = app.activeDocument, ids = [], sel = abrSelectedIds();
    for (var k in sel) ids.push(+k);
    a.total = ids.length;
    for (var i = 0; i < ids.length; i++) {
        abrSelect(ids[i], false);
        abrApplyFont(doc.activeLayer, a);
    }
    // 還原原本的選取
    for (var j = 0; j < ids.length; j++) abrSelect(ids[j], j > 0);
}

function abrSetFont(font, tracking) {
    try {
        if (!app.documents.length) return "err|nodoc";
        __abr = { font: font, tracking: tracking, count: 0, failed: 0, total: 0 };
        app.activeDocument.suspendHistory(font ? "Font " + font : "Tracking " + tracking, "abrFontRun()");
        if (!__abr.total) return "err|nosel";
        return "font|" + __abr.count + "|" + __abr.failed;
    } catch (e) {
        return "err|" + e.message;
    }
}

// 改目前圖層（即時形狀矩形）的四個圓角
function abrSetRadiusActive(px) {
    var d = new ActionDescriptor(), r = new ActionDescriptor(), px_ = charIDToTypeID("#Pxl");
    d.putInteger(stringIDToTypeID("keyOriginType"), 1);
    r.putInteger(stringIDToTypeID("unitValueQuadVersion"), 1);
    r.putUnitDouble(stringIDToTypeID("topRight"), px_, px);
    r.putUnitDouble(stringIDToTypeID("topLeft"), px_, px);
    r.putUnitDouble(stringIDToTypeID("bottomLeft"), px_, px);
    r.putUnitDouble(stringIDToTypeID("bottomRight"), px_, px);
    d.putObject(stringIDToTypeID("keyOriginRRectRadii"), stringIDToTypeID("radii"), r);
    d.putInteger(stringIDToTypeID("keyActionMode"), 102);
    executeAction(stringIDToTypeID("changePathDetails"), d, DialogModes.NO);
}

// 讀目前圖層的圓角（讀不到就當 0）
function abrGetRadiusActive() {
    try {
        var r = new ActionReference();
        r.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("keyOriginType"));
        r.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        var o = executeActionGet(r).getList(stringIDToTypeID("keyOriginType")).getObjectValue(0);
        if (o.hasKey(stringIDToTypeID("keyOriginRRectRadii"))) {
            return o.getObjectValue(stringIDToTypeID("keyOriginRRectRadii")).getUnitDoubleValue(stringIDToTypeID("topLeft"));
        }
    } catch (e) {}
    return 0;
}

// 形狀圖層直接套；群組／工作區域就套裡面所有形狀圖層
function abrApplyRadius(layer, a) {
    if (layer.typename === "LayerSet") {
        for (var i = 0; i < layer.layers.length; i++) abrApplyRadius(layer.layers[i], a);
        return;
    }
    if (layer.kind !== LayerKind.SOLIDFILL && layer.kind !== LayerKind.GRADIENTFILL && layer.kind !== LayerKind.PATTERNFILL) return;
    try {
        abrSelect(layer.id, false);
        var v = a.add ? abrGetRadiusActive() + a.radius : a.radius;
        abrSetRadiusActive(v);
        a.last = v;
        a.count++;
    } catch (e) { a.failed++; }
}

function abrRadiusRun() {
    var a = __abr, doc = app.activeDocument, ids = [], sel = abrSelectedIds();
    for (var k in sel) ids.push(+k);
    a.total = ids.length;
    for (var i = 0; i < ids.length; i++) {
        abrSelect(ids[i], false);
        abrApplyRadius(doc.activeLayer, a);
    }
    for (var j = 0; j < ids.length; j++) abrSelect(ids[j], j > 0);
}

// add=true：在目前圓角上疊加 px；add=false：直接設成 px
function abrSetRadius(px, add) {
    try {
        if (!app.documents.length) return "err|nodoc";
        __abr = { radius: px, add: add, count: 0, failed: 0, total: 0, last: px };
        app.activeDocument.suspendHistory("Corner radius " + (add ? "+" : "") + px, "abrRadiusRun()");
        if (!__abr.total) return "err|nosel";
        return "radius|" + __abr.count + "|" + __abr.failed + "|" + Math.round(__abr.last);
    } catch (e) {
        return "err|" + e.message;
    }
}

// 在工作區域名稱後面加上「 寬x高」，已經有尺寸就換成最新的
function abrSizeRun() {
    var a = __abr, targets = abrTargets(app.activeDocument);
    a.total = targets.length;
    for (var i = 0; i < targets.length; i++) {
        var L = { id: targets[i] };
        if (!abrIsArtboard(L)) { a.skipped++; continue; }
        var b = abrArtboardRect(L), name = abrGetName(L.id);
        var next = name.replace(/\s*\d+\s*[xX\u00D7]\s*\d+\s*$/, "") + " " + Math.round(b.right - b.left) + "x" + Math.round(b.bottom - b.top);
        if (next !== name) { abrSetName(L.id, next); a.count++; }
    }
}

function abrAddSize() {
    try {
        if (!app.documents.length) return "err|nodoc";
        __abr = { count: 0, skipped: 0, total: 0 };
        var __abrSel = abrSelectedIds();
        app.activeDocument.suspendHistory("Add artboard size", "abrSizeRun()");
        abrRestoreSel(__abrSel);
        if (!__abr.total) return "err|notarget";
        return "size|" + __abr.count + "|" + __abr.skipped;
    } catch (e) {
        return "err|" + e.message;
    }
}

// 對選取的每個圖層跑 fn；群組／工作區域就跑裡面每個圖層。跑完還原選取
function abrEachSelected(fn) {
    var a = __abr, ids = [], sel = abrSelectedIds();
    for (var k in sel) ids.push(+k);
    a.total = ids.length;
    var walk = function (layer) {
        if (layer.typename === "LayerSet") {
            for (var i = 0; i < layer.layers.length; i++) walk(layer.layers[i]);
            return;
        }
        abrSelect(layer.id, false);
        try { if (fn(app.activeDocument.activeLayer, a)) a.count++; } catch (e) { a.failed++; }
    };
    for (var i = 0; i < ids.length; i++) {
        abrSelect(ids[i], false);
        walk(app.activeDocument.activeLayer);
    }
    for (var j = 0; j < ids.length; j++) abrSelect(ids[j], j > 0);
}

function abrRunEach(historyName, fn, extra) {
    try {
        if (!app.documents.length) return "err|nodoc";
        __abr = { count: 0, failed: 0, total: 0, fn: fn };
        for (var k in extra) __abr[k] = extra[k];
        app.activeDocument.suspendHistory(historyName, "abrEachSelected(__abr.fn)");
        if (!__abr.total) return "err|nosel";
        return "each|" + __abr.count + "|" + __abr.failed;
    } catch (e) {
        return "err|" + e.message;
    }
}

// ---- 文字對齊 ----
function abrSetJustify(which) {
    var j = { left: Justification.LEFT, center: Justification.CENTER, right: Justification.RIGHT }[which];
    return abrRunEach("Text align " + which, function (layer) {
        if (layer.kind !== LayerKind.TEXT) return false;
        layer.textItem.justification = j;
        return true;
    });
}

// ---- 顏色 ----
function abrRGBDesc(c) {
    var d = new ActionDescriptor();
    d.putDouble(charIDToTypeID("Rd  "), c.rgb.red);
    d.putDouble(charIDToTypeID("Grn "), c.rgb.green);
    d.putDouble(charIDToTypeID("Bl  "), c.rgb.blue);
    return d;
}

function abrTargetRef(prop) {
    var r = new ActionReference();
    if (prop) r.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID(prop));
    r.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    return r;
}

// 形狀圖層：改填色
function abrFillShape(c) {
    var d = new ActionDescriptor(), r = new ActionReference(), s = new ActionDescriptor();
    r.putEnumerated(stringIDToTypeID("contentLayer"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    d.putReference(charIDToTypeID("null"), r);
    s.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), abrRGBDesc(c));
    d.putObject(charIDToTypeID("T   "), stringIDToTypeID("solidColorLayer"), s);
    executeAction(charIDToTypeID("setd"), d, DialogModes.NO);
}

// 智慧型物件／一般圖層：加「顏色覆蓋」樣式，保留原本其他樣式
function abrColorOverlay(c) {
    var info = executeActionGet(abrTargetRef());
    var fx = info.hasKey(stringIDToTypeID("layerEffects")) ? info.getObjectValue(stringIDToTypeID("layerEffects")) : new ActionDescriptor();
    var sf = new ActionDescriptor();
    sf.putBoolean(charIDToTypeID("enab"), true);
    sf.putBoolean(stringIDToTypeID("present"), true);
    sf.putBoolean(stringIDToTypeID("showInDialog"), true);
    sf.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Nrml"));
    sf.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), abrRGBDesc(c));
    sf.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), 100);
    fx.putObject(stringIDToTypeID("solidFill"), stringIDToTypeID("solidFill"), sf);
    var d = new ActionDescriptor();
    d.putReference(charIDToTypeID("null"), abrTargetRef("layerEffects"));
    d.putObject(charIDToTypeID("T   "), stringIDToTypeID("layerEffects"), fx);
    executeAction(charIDToTypeID("setd"), d, DialogModes.NO);
}

// mode: "hex"（用 hex）、"fg"（用目前前景色）、"pick"（先開檢色器，可直接在畫面上吸色）。取消就回傳 null
function abrResolveColor(mode, hex) {
    if (mode === "pick") return app.showColorPicker() ? app.foregroundColor : null;
    if (mode === "fg") return app.foregroundColor;
    var c = new SolidColor();
    c.rgb.hexValue = hex;
    return c;
}

function abrSetColor(mode, hex) {
    try {
        if (!app.documents.length) return "err|nodoc";
        var c = abrResolveColor(mode, hex);
        if (!c) return "err|cancel";
        var res = abrRunEach("Color #" + c.rgb.hexValue, function (layer, a) {
            if (layer.kind === LayerKind.TEXT) layer.textItem.color = a.color;
            else if (layer.kind === LayerKind.SOLIDFILL) abrFillShape(a.color);
            else if (layer.kind === LayerKind.SMARTOBJECT || layer.kind === LayerKind.NORMAL) abrColorOverlay(a.color);
            else return false;
            return true;
        }, { color: c });
        return res + "|" + c.rgb.hexValue;
    } catch (e) { return "err|" + e.message + " (line " + e.line + ")"; }
}

// ---- 工作區域依序編號：照畫面位置（上到下、同一排左到右）改成「01｜原名」----
// 有「動-xxx 」前綴的話，編號放在前綴後面；已經有編號就換掉
function abrNumberRun() {
    var a = __abr, items = [], ids = abrTargets(app.activeDocument);
    for (var i = 0; i < ids.length; i++) {
        var L = { id: ids[i] };
        if (!abrIsArtboard(L)) { a.skipped++; continue; }
        items.push({ id: ids[i], rect: abrArtboardRect(L) });
    }
    items.sort(function (p, q) {
        return Math.abs(p.rect.top - q.rect.top) > 50 ? p.rect.top - q.rect.top : p.rect.left - q.rect.left;
    });
    a.total = items.length;
    var digits = Math.max(2, String(items.length).length);
    for (var j = 0; j < items.length; j++) {
        var name = abrGetName(items[j].id), m = name.match(ABR_PREFIX_RE), pre = m ? m[0] : "";
        var rest = name.substr(pre.length).replace(/^\d+\s*[\uFF5C|]\s*/, "");
        var num = String(j + 1);
        while (num.length < digits) num = "0" + num;
        var next = pre + num + "\uFF5C" + rest;
        if (next !== name) { abrSetName(items[j].id, next); a.count++; }
    }
}

function abrNumberArtboards() {
    try {
        if (!app.documents.length) return "err|nodoc";
        __abr = { count: 0, skipped: 0, total: 0 };
        var __abrSel = abrSelectedIds();
        app.activeDocument.suspendHistory("Number artboards", "abrNumberRun()");
        abrRestoreSel(__abrSel);
        if (!__abr.total) return "err|notarget";
        return "num|" + __abr.count + "|" + __abr.total;
    } catch (e) {
        return "err|" + e.message;
    }
}

// ---- 筆畫 ----
// 形狀圖層：開形狀本身的筆畫（內容面板那個），對齊內側
function abrShapeStroke(c, px) {
    var d = new ActionDescriptor(), r = new ActionReference(), s = new ActionDescriptor(), ss = new ActionDescriptor(), fill = new ActionDescriptor();
    r.putEnumerated(stringIDToTypeID("contentLayer"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    d.putReference(charIDToTypeID("null"), r);
    ss.putInteger(stringIDToTypeID("strokeStyleVersion"), 2);
    ss.putBoolean(stringIDToTypeID("strokeEnabled"), true);
    ss.putBoolean(stringIDToTypeID("fillEnabled"), true);
    ss.putUnitDouble(stringIDToTypeID("strokeStyleLineWidth"), charIDToTypeID("#Pxl"), px);
    ss.putEnumerated(stringIDToTypeID("strokeStyleLineAlignment"), stringIDToTypeID("strokeStyleLineAlignment"), stringIDToTypeID("strokeStyleAlignInside"));
    fill.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), abrRGBDesc(c));
    ss.putObject(stringIDToTypeID("strokeStyleContent"), stringIDToTypeID("solidColorLayer"), fill);
    s.putObject(stringIDToTypeID("strokeStyle"), stringIDToTypeID("strokeStyle"), ss);
    d.putObject(charIDToTypeID("T   "), stringIDToTypeID("shapeStyle"), s);
    executeAction(charIDToTypeID("setd"), d, DialogModes.NO);
}

// 其他圖層：混合選項的「筆畫」樣式（外側），保留原本其他樣式
function abrFxStroke(c, px) {
    var info = executeActionGet(abrTargetRef());
    var fx = info.hasKey(stringIDToTypeID("layerEffects")) ? info.getObjectValue(stringIDToTypeID("layerEffects")) : new ActionDescriptor();
    if (!fx.hasKey(stringIDToTypeID("scale"))) fx.putUnitDouble(stringIDToTypeID("scale"), charIDToTypeID("#Prc"), 100);
    var fr = new ActionDescriptor();
    fr.putBoolean(charIDToTypeID("enab"), true);
    fr.putBoolean(stringIDToTypeID("present"), true);
    fr.putBoolean(stringIDToTypeID("showInDialog"), true);
    fr.putEnumerated(charIDToTypeID("Styl"), charIDToTypeID("FStl"), charIDToTypeID("OutF"));
    fr.putEnumerated(charIDToTypeID("PntT"), charIDToTypeID("FrFl"), charIDToTypeID("SClr"));
    fr.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Nrml"));
    fr.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), 100);
    fr.putUnitDouble(charIDToTypeID("Sz  "), charIDToTypeID("#Pxl"), px);
    fr.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), abrRGBDesc(c));
    fx.putObject(stringIDToTypeID("frameFX"), stringIDToTypeID("frameFX"), fr);
    var d = new ActionDescriptor();
    d.putReference(charIDToTypeID("null"), abrTargetRef("layerEffects"));
    d.putObject(charIDToTypeID("T   "), stringIDToTypeID("layerEffects"), fx);
    executeAction(charIDToTypeID("setd"), d, DialogModes.NO);
}

function abrAddStroke(mode, hex, px) {
    try {
        if (!app.documents.length) return "err|nodoc";
        var c = abrResolveColor(mode, hex);
        if (!c) return "err|cancel";
        var res = abrRunEach("Stroke " + px + "px #" + c.rgb.hexValue, function (layer, a) {
            if (layer.kind === LayerKind.SOLIDFILL) abrShapeStroke(a.color, a.px);
            else abrFxStroke(a.color, a.px);
            return true;
        }, { color: c, px: px });
        return res + "|" + c.rgb.hexValue;
    } catch (e) { return "err|" + e.message + " (line " + e.line + ")"; }
}

// ---- 尋找並選取所有有智慧型濾鏡的圖層 ----
function abrHasSmartFilter(index) {
    var r = new ActionReference();
    r.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("smartObject"));
    r.putIndex(charIDToTypeID("Lyr "), index);
    try {
        var d = executeActionGet(r);
        return d.hasKey(stringIDToTypeID("smartObject")) &&
            d.getObjectValue(stringIDToTypeID("smartObject")).hasKey(stringIDToTypeID("filterFX"));
    } catch (e) { return false; }
}

function abrFindSmartFilters() {
    try {
        if (!app.documents.length) return "err|nodoc";
        var r = new ActionReference();
        r.putProperty(charIDToTypeID("Prpr"), stringIDToTypeID("numberOfLayers"));
        r.putEnumerated(charIDToTypeID("Dcmn"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        var n = executeActionGet(r).getInteger(stringIDToTypeID("numberOfLayers"));

        var ids = [], names = [];
        for (var i = 1; i <= n; i++) {
            if (!abrHasSmartFilter(i)) continue;
            var lr = new ActionReference();
            lr.putIndex(charIDToTypeID("Lyr "), i);
            var d = executeActionGet(lr);
            ids.push(d.getInteger(stringIDToTypeID("layerID")));
            names.push(d.getString(charIDToTypeID("Nm  ")));
        }
        if (!ids.length) return "found|0|";
        for (var j = 0; j < ids.length; j++) abrSelect(ids[j], j > 0);
        return "found|" + ids.length + "|" + names.join("\u3001");
    } catch (e) {
        return "err|" + e.message;
    }
}

// ---- 動態前綴疊加：名稱變成「動-飄浮-流光-逐格 原名」----
// op="main"：飄浮／搖擺／亮光三選一（換掉 syn 裡的任何一個；同一個再按就取消）
// op="toggle"：有就拿掉、沒有就加上（逐格永遠排最後）
function abrMotionTokens(tokens, op, word, syn) {
    var hit = function (t) {
        for (var i = 0; i < syn.length; i++) if (t.indexOf(syn[i]) >= 0) return true;
        return false;
    };
    var had = false, sameMain = false, out = [];
    for (var i = 0; i < tokens.length; i++) {
        if (hit(tokens[i])) { had = true; if (tokens[i] === word) sameMain = true; }
        else out.push(tokens[i]);
    }
    if (op === "main") {
        if (!sameMain) out.unshift(word);
    } else if (op === "set") {
        // 動畫效果標記：同一種效果換成新的（例如 飄浮12 → 飄浮20）；完全一樣再按就取消
        if (!sameMain) out.push(word);
    } else if (!had) {
        var last = out.length ? out[out.length - 1] : "";
        if (word !== "\u9010\u683C" && last.indexOf("\u9010\u683C") >= 0) out.splice(out.length - 1, 0, word);
        else out.push(word);
    }
    return out;
}

function abrMotionRun() {
    var a = __abr, targets = abrTargets(app.activeDocument);
    a.total = targets.length;
    for (var i = 0; i < targets.length; i++) {
        var name = abrGetName(targets[i]), m = name.match(ABR_PREFIX_RE);
        var rest = m ? name.substr(m[0].length) : name;
        var tokens = [];
        if (m) {
            var parts = m[0].replace(/^\u52D5-?/, "").split(/[-\s]+/);
            for (var k = 0; k < parts.length; k++) if (parts[k]) tokens.push(parts[k]);
        }
        tokens = abrMotionTokens(tokens, a.op, a.word, a.syn);
        var next = tokens.length ? "\u52D5-" + tokens.join("-") + " " + rest : rest;
        if (next !== name) { abrSetName(targets[i], next); a.count++; if (!a.sample) a.sample = next; }
    }
}

function abrMotion(op, word, syn) {
    try {
        if (!app.documents.length) return "err|nodoc";
        __abr = { op: op, word: word, syn: syn, count: 0, total: 0, sample: "" };
        var __abrSel = abrSelectedIds();
        app.activeDocument.suspendHistory("Motion " + word, "abrMotionRun()");
        abrRestoreSel(__abrSel);
        if (!__abr.total) return "err|notarget";
        return "motion|" + __abr.count + "|" + __abr.total + "|" + __abr.sample;
    } catch (e) {
        return "err|" + e.message;
    }
}

// ---- 剪裁遮色片＋底下那層一起轉成智慧型物件（名稱用底下那層的）----
// 選剪裁層或底層都可以；選多組就各自轉
function abrClipBase(L) {
    var sib = L.parent.layers, idx = -1;
    for (var i = 0; i < sib.length; i++) if (sib[i].id === L.id) { idx = i; break; }
    while (idx < sib.length - 1 && sib[idx].grouped) idx++;   // 往下找到被剪裁的底層
    var base = sib[idx], clips = [];
    for (var j = idx - 1; j >= 0 && sib[j].grouped; j--) clips.push(sib[j].id);
    return { base: base, clips: clips };
}

// 整份文件（含群組、工作區域裡面）找出所有「底層＋剪裁層」
function abrCollectClipGroups(container, groups) {
    var sib = container.layers;
    for (var i = 0; i < sib.length; i++) {
        var L = sib[i];
        if (!L.grouped && i > 0 && sib[i - 1].grouped) {
            var clips = [];
            for (var j = i - 1; j >= 0 && sib[j].grouped; j--) clips.push(sib[j].id);
            groups.push({ id: L.id, name: L.name, clips: clips });
        }
        if (L.typename === "LayerSet") abrCollectClipGroups(L, groups);
    }
}

function abrClipToSORun() {
    var a = __abr, doc = app.activeDocument, sel = abrSelectedIds(), groups = [], seen = {};
    if (a.all) { abrCollectClipGroups(doc, groups); sel = {}; }
    for (var k in sel) {
        abrSelect(+k, false);
        var g = abrClipBase(doc.activeLayer);
        if (seen[g.base.id]) continue;
        seen[g.base.id] = true;
        if (!g.clips.length) { a.skipped++; continue; }
        groups.push({ id: g.base.id, name: g.base.name, clips: g.clips });
    }
    a.total = groups.length;
    var made = [];
    for (var i = 0; i < groups.length; i++) {
        abrSelect(groups[i].id, false);
        for (var c = 0; c < groups[i].clips.length; c++) abrSelect(groups[i].clips[c], true);
        executeAction(stringIDToTypeID("newPlacedLayer"), undefined, DialogModes.NO);
        doc.activeLayer.name = groups[i].name;
        made.push(doc.activeLayer.id);
        a.count++;
    }
    for (var m = 0; m < made.length; m++) abrSelect(made[m], m > 0);
}

// all=true：整份文件全部一起轉；false：只轉選取的
function abrClipToSmartObject(all) {
    try {
        if (!app.documents.length) return "err|nodoc";
        __abr = { count: 0, skipped: 0, total: 0, all: all };
        var hasSel = all;
        for (var k in abrSelectedIds()) { hasSel = true; break; }
        if (!hasSel) return "err|nosel";
        app.activeDocument.suspendHistory("Clipping to smart object", "abrClipToSORun()");
        return "clipso|" + __abr.count + "|" + __abr.skipped;
    } catch (e) {
        return "err|" + e.message;
    }
}

// prefix: string 或 null(移除前綴)；回傳 "ok|改了幾個|總數" 或 "err|原因"
function abrRename(prefix, replace, custom) {
    try {
        if (!app.documents.length) return "err|nodoc";
        __abr = { prefix: prefix, replace: replace, custom: custom, count: 0, total: 0 };
        var __abrSel = abrSelectedIds();
        app.activeDocument.suspendHistory("\u5DE5\u4F5C\u5340\u57DF\u6539\u540D", "abrRun()");
        abrRestoreSel(__abrSel);
        if (!__abr.total) return "err|notarget";
        return "ok|" + __abr.count + "|" + __abr.total;
    } catch (e) {
        return "err|" + e.message;
    }
}

// ---- 新增矩形：放在目前圖層所在工作區域的左上角（不在工作區域裡就放在 0,0），顏色用前景色 ----
function abrAddRectRun() {
    var a = __abr, doc = app.activeDocument, left = 0, top = 0;
    try {
        var L = doc.activeLayer;
        while (L.parent && L.parent.typename !== "Document") L = L.parent;
        if (abrIsArtboard(L)) { var b = abrArtboardRect(L); left = b.left; top = b.top; }
    } catch (e) {}

    var d = new ActionDescriptor(), ref = new ActionReference(), cl = new ActionDescriptor(), fill = new ActionDescriptor(), shp = new ActionDescriptor();
    ref.putClass(stringIDToTypeID("contentLayer"));
    d.putReference(charIDToTypeID("null"), ref);
    fill.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), abrRGBDesc(app.foregroundColor));
    cl.putObject(charIDToTypeID("Type"), stringIDToTypeID("solidColorLayer"), fill);
    shp.putUnitDouble(charIDToTypeID("Top "), charIDToTypeID("#Pxl"), top);
    shp.putUnitDouble(charIDToTypeID("Left"), charIDToTypeID("#Pxl"), left);
    shp.putUnitDouble(charIDToTypeID("Btom"), charIDToTypeID("#Pxl"), top + a.h);
    shp.putUnitDouble(charIDToTypeID("Rght"), charIDToTypeID("#Pxl"), left + a.w);
    cl.putObject(charIDToTypeID("Shp "), charIDToTypeID("Rctn"), shp);
    d.putObject(charIDToTypeID("Usng"), stringIDToTypeID("contentLayer"), cl);
    executeAction(charIDToTypeID("Mk  "), d, DialogModes.NO);
    doc.activeLayer.name = a.w + "x" + a.h;
}

function abrAddRect(w, h) {
    try {
        if (!app.documents.length) return "err|nodoc";
        var ru = app.preferences.rulerUnits;
        app.preferences.rulerUnits = Units.PIXELS;
        __abr = { w: w, h: h };
        try {
            app.activeDocument.suspendHistory("Rectangle " + w + "x" + h, "abrAddRectRun()");
        } finally {
            app.preferences.rulerUnits = ru;
        }
        return "rect|" + w + "|" + h;
    } catch (e) {
        return "err|" + e.message;
    }
}

// ---- 一鍵 PDF：影像平面化 -> 存 PDF 拷貝（放 PSD 旁邊、同檔名）-> 回到平面化前的步驟 ----
// 用「回到記錄點」還原，原本的 PSD 不會被存成平面化版本
function abrExportPDF() {
    try {
        if (!app.documents.length) return "err|nodoc";
        var doc = app.activeDocument, out;
        try {
            out = new File(doc.fullName.parent + "/" + doc.name.replace(/\.[^.]+$/, "") + ".pdf");
        } catch (e) {
            // 還沒存過的新文件：問要存哪裡
            out = File.saveDialog("PDF", "PDF:*.pdf");
            if (!out) return "err|cancel";
        }
        var before = doc.activeHistoryState;
        try {
            doc.flatten();
            var o = new PDFSaveOptions();
            o.layers = false;
            o.preserveEditing = false;
            o.embedThumbnail = false;
            o.encoding = PDFEncoding.JPEG;
            o.jpegQuality = 10;
            doc.saveAs(out, o, true, Extension.LOWERCASE);
        } catch (e) {
            doc.activeHistoryState = before;
            return "err|" + e.message;
        }
        doc.activeHistoryState = before;
        return "pdf|" + decodeURI(out.fsName);
    } catch (e) { return "err|" + e.message + " (line " + e.line + ")"; }
}

// ---- 出血：畫布上下左右各加 mm（依文件解析度換算成 px），從中間往外加 ----
function abrAddBleed(mm) {
    try {
        if (!app.documents.length) return "err|nodoc";
        var doc = app.activeDocument, ru = app.preferences.rulerUnits;
        app.preferences.rulerUnits = Units.PIXELS;
        try {
            var px = Math.round(mm / 25.4 * doc.resolution);
            var w = doc.width.as("px") + px * 2, h = doc.height.as("px") + px * 2;
            doc.resizeCanvas(UnitValue(w, "px"), UnitValue(h, "px"), AnchorPosition.MIDDLECENTER);
            return "bleed|" + px + "|" + w + "|" + h + "|" + Math.round(doc.resolution);
        } finally {
            app.preferences.rulerUnits = ru;
        }
    } catch (e) {
        return "err|" + e.message;
    }
}

// ---- 一鍵 PNG-24：存 PNG 拷貝（24 位元＋透明，存到「下載」資料夾、同檔名），不用平面化 ----
// 不用「儲存為網頁用」，因為它超過 8192px 會出問題（銷售頁常常 20000 高）
function abrExportPNG() {
    if (!app.documents.length) return "err|nodoc";
    var doc = app.activeDocument;
    var out = new File($.getenv("USERPROFILE") + "/Downloads/" + doc.name.replace(/\.[^.]+$/, "") + ".png");
    try {
        var o = new PNGSaveOptions();
        o.compression = 6;
        o.interlaced = false;
        doc.saveAs(out, o, true, Extension.LOWERCASE);
    } catch (e) {
        return "err|" + e.message;
    }
    return "png|" + decodeURI(out.fsName);
}

// ---- 選取的圖層各存一張 PNG（裁掉透明邊，存到「下載」資料夾，檔名＝圖層名稱）----
// 做法：每層「複製到新文件」→ 裁透明邊 → 存 PNG → 關掉新文件，原檔不動
function abrSafeName(s) {
    // 不用正規表示式：Photoshop 2020 的舊引擎讀到 [ ] 裡沒跳脫的 / 會整支程式載入失敗
    var bad = "\\/:*?\"<>|", out = "";
    for (var i = 0; i < s.length; i++) out += bad.indexOf(s.charAt(i)) >= 0 ? "_" : s.charAt(i);
    s = out.replace(/^\s+|\s+$/g, "");
    return s || "layer";
}

function abrExportLayersPNG() {
    try {
        if (!app.documents.length) return "err|nodoc";
        var doc = app.activeDocument, sel = abrSelectedIds(), ids = [];
        for (var k in sel) ids.push(+k);
        if (!ids.length) return "err|nosel";
    
        var dir = $.getenv("USERPROFILE") + "/Downloads/", used = {}, count = 0, failed = 0, names = [];
        var o = new PNGSaveOptions();
        o.compression = 6;
        o.interlaced = false;
    
        for (var i = 0; i < ids.length; i++) {
            var tmp = null;
            try {
                app.activeDocument = doc;
                abrSelect(ids[i], false);
                var base = abrSafeName(doc.activeLayer.name), name = base, n = 2;
                while (used[name.toLowerCase()]) name = base + "_" + (n++);
                used[name.toLowerCase()] = true;
    
                var d = new ActionDescriptor(), r = new ActionReference(), u = new ActionReference();
                r.putClass(charIDToTypeID("Dcmn"));
                d.putReference(charIDToTypeID("null"), r);
                d.putString(charIDToTypeID("Nm  "), name);
                u.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
                d.putReference(charIDToTypeID("Usng"), u);
                executeAction(charIDToTypeID("Mk  "), d, DialogModes.NO);
                tmp = app.activeDocument;
    
                try { tmp.activeLayer.visible = true; } catch (e) {}
                try { tmp.trim(TrimType.TRANSPARENT, true, true, true, true); } catch (e) {}
                tmp.saveAs(new File(dir + name + ".png"), o, true, Extension.LOWERCASE);
                count++;
                if (names.length < 5) names.push(name);
            } catch (e) {
                failed++;
            }
            if (tmp) { try { tmp.close(SaveOptions.DONOTSAVECHANGES); } catch (e) {} }
        }
        app.activeDocument = doc;
        abrRestoreSel(sel);
        return "layerspng|" + count + "|" + failed + "|" + names.join("\u3001") + (count > names.length ? "\u2026" : "");
    } catch (e) { return "err|" + e.message + " (line " + e.line + ")"; }
}

// ================= 自訂資料：存在 %APPDATA%\PeppaTools =================
function abrDataDir(sub) {
    var f = new Folder($.getenv("APPDATA") + "/PeppaTools" + (sub ? "/" + sub : ""));
    if (!f.exists) f.create();
    return f;
}

// 面板把設定整包當 JSON 字串存讀（ExtendScript 沒有 JSON，這邊只負責檔案）
function abrReadPresets() {
    try {
        var f = new File(abrDataDir().fsName + "/presets.json");
        if (!f.exists) return "";
        f.encoding = "UTF-8";
        f.open("r");
        var s = f.read();
        f.close();
        return s;
    } catch (e) { return "err|" + e.message + " (line " + e.line + ")"; }
}

function abrWritePresets(s) {
    try {
        var f = new File(abrDataDir().fsName + "/presets.json");
        f.encoding = "UTF-8";
        f.open("w");
        f.write(s);
        f.close();
        return "ok";
    } catch (e) { return "err|" + e.message + " (line " + e.line + ")"; }
}

// ---- 陰影：讀目前圖層的陰影參數 -> "shadow|mode|r|g|b|opacity|angle|distance|spread|size" ----
function abrReadShadow() {
    try {
        if (!app.documents.length) return "err|nodoc";
        var info = executeActionGet(abrTargetRef());
        if (!info.hasKey(stringIDToTypeID("layerEffects"))) return "err|noshadow";
        var fx = info.getObjectValue(stringIDToTypeID("layerEffects"));
        if (!fx.hasKey(stringIDToTypeID("dropShadow"))) return "err|noshadow";
        var ds = fx.getObjectValue(stringIDToTypeID("dropShadow"));
        var g = function (cid, def) { return ds.hasKey(charIDToTypeID(cid)) ? ds.getUnitDoubleValue(charIDToTypeID(cid)) : def; };
        var r = 0, gr = 0, b = 0;
        try {
            var c = ds.getObjectValue(charIDToTypeID("Clr "));
            r = c.getDouble(charIDToTypeID("Rd  ")); gr = c.getDouble(charIDToTypeID("Grn ")); b = c.getDouble(charIDToTypeID("Bl  "));
        } catch (e) {}
        var mode = "multiply";
        try { mode = typeIDToStringID(ds.getEnumerationValue(charIDToTypeID("Md  "))); } catch (e) {}
        return ["shadow", mode, Math.round(r), Math.round(gr), Math.round(b),
            g("Opct", 75), g("lagl", 90), g("Dstn", 5), g("Ckmt", 0), g("blur", 5)].join("|");
    } catch (e) {
        return "err|" + e.message;
    }
}

// 套陰影到目前圖層，保留其他樣式。角度一律用自己的（不勾整體光源），免得動到整份文件的光源
function abrShadowActive(p) {
    var info = executeActionGet(abrTargetRef());
    var fx = info.hasKey(stringIDToTypeID("layerEffects")) ? info.getObjectValue(stringIDToTypeID("layerEffects")) : new ActionDescriptor();
    if (!fx.hasKey(stringIDToTypeID("scale"))) fx.putUnitDouble(stringIDToTypeID("scale"), charIDToTypeID("#Prc"), 100);
    var ds = new ActionDescriptor(), c = new ActionDescriptor();
    ds.putBoolean(charIDToTypeID("enab"), true);
    ds.putBoolean(stringIDToTypeID("present"), true);
    ds.putBoolean(stringIDToTypeID("showInDialog"), true);
    ds.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), stringIDToTypeID(p.mode));
    c.putDouble(charIDToTypeID("Rd  "), p.r); c.putDouble(charIDToTypeID("Grn "), p.g); c.putDouble(charIDToTypeID("Bl  "), p.b);
    ds.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), c);
    ds.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), p.opacity);
    ds.putBoolean(charIDToTypeID("uglg"), false);
    ds.putUnitDouble(charIDToTypeID("lagl"), charIDToTypeID("#Ang"), p.angle);
    ds.putUnitDouble(charIDToTypeID("Dstn"), charIDToTypeID("#Pxl"), p.distance);
    ds.putUnitDouble(charIDToTypeID("Ckmt"), charIDToTypeID("#Pxl"), p.spread);
    ds.putUnitDouble(charIDToTypeID("blur"), charIDToTypeID("#Pxl"), p.size);
    ds.putUnitDouble(charIDToTypeID("Nose"), charIDToTypeID("#Prc"), 0);
    ds.putBoolean(charIDToTypeID("AntA"), false);
    ds.putBoolean(stringIDToTypeID("layerConceals"), true);
    fx.putObject(stringIDToTypeID("dropShadow"), stringIDToTypeID("dropShadow"), ds);
    var d = new ActionDescriptor();
    d.putReference(charIDToTypeID("null"), abrTargetRef("layerEffects"));
    d.putObject(charIDToTypeID("T   "), stringIDToTypeID("layerEffects"), fx);
    executeAction(charIDToTypeID("setd"), d, DialogModes.NO);
}

// 選群組就套到裡面每一層
function abrApplyShadow(mode, r, g, b, opacity, angle, distance, spread, size) {
    var p = { mode: mode, r: r, g: g, b: b, opacity: opacity, angle: angle, distance: distance, spread: spread, size: size };
    return abrRunEach("Drop shadow", function (layer, a) {
        abrShadowActive(a.p);
        return true;
    }, { p: p });
}

// ================= 常用圖層庫：%APPDATA%\PeppaTools\LayerLibrary\名稱.psd =================
function abrLibList() {
    try {
        var files = abrDataDir("LayerLibrary").getFiles("*.psd"), names = [];
        for (var i = 0; i < files.length; i++) names.push(decodeURI(files[i].name).replace(/\.psd$/i, ""));
        names.sort();
        return "lib|" + names.join("\n");
    } catch (e) { return "err|" + e.message + " (line " + e.line + ")"; }
}

// 把選取的圖層複製到新文件（保留位置），存成圖層庫裡的 PSD
function abrLibSave(name) {
    try {
        if (!app.documents.length) return "err|nodoc";
        var doc = app.activeDocument, sel = abrSelectedIds(), any = false;
        for (var k in sel) { any = true; break; }
        if (!any) return "err|nosel";
        name = abrSafeName(name);
        var tmp = null;
        try {
            var d = new ActionDescriptor(), r = new ActionReference(), u = new ActionReference();
            r.putClass(charIDToTypeID("Dcmn"));
            d.putReference(charIDToTypeID("null"), r);
            d.putString(charIDToTypeID("Nm  "), name);
            u.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            d.putReference(charIDToTypeID("Usng"), u);
            executeAction(charIDToTypeID("Mk  "), d, DialogModes.NO);
            tmp = app.activeDocument;
            var o = new PhotoshopSaveOptions();
            o.layers = true;
            o.embedColorProfile = true;
            tmp.saveAs(new File(abrDataDir("LayerLibrary").fsName + "/" + name + ".psd"), o, true, Extension.LOWERCASE);
        } catch (e) {
            if (tmp) { try { tmp.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {} }
            app.activeDocument = doc;
            return "err|" + e.message;
        }
        tmp.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = doc;
        abrRestoreSel(sel);
        return "libsaved|" + name;
    } catch (e) { return "err|" + e.message + " (line " + e.line + ")"; }
}

// 打開圖層庫的 PSD，把裡面所有圖層包成一個群組，複製到目前文件、放在目前圖層上面
function abrLibInsert(name) {
    try {
        if (!app.documents.length) return "err|nodoc";
        var doc = app.activeDocument, f = new File(abrDataDir("LayerLibrary").fsName + "/" + name + ".psd");
        if (!f.exists) return "err|nofile";
        var anchor = null;
        try { anchor = doc.activeLayer; } catch (e) {}
        var src = app.open(f);
        try {
            var grp;
            if (src.layers.length === 1 && src.layers[0].typename === "LayerSet") {
                grp = src.layers[0];
            } else {
                // 全選再「從圖層建立群組」
                var ds = new ActionDescriptor(), rs = new ActionReference();
                rs.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
                ds.putReference(charIDToTypeID("null"), rs);
                executeAction(stringIDToTypeID("selectAllLayers"), ds, DialogModes.NO);
                var dg = new ActionDescriptor(), rg = new ActionReference(), rf = new ActionReference();
                rg.putClass(stringIDToTypeID("layerSection"));
                dg.putReference(charIDToTypeID("null"), rg);
                rf.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
                dg.putReference(charIDToTypeID("From"), rf);
                executeAction(charIDToTypeID("Mk  "), dg, DialogModes.NO);
                grp = src.activeLayer;
                grp.name = name;
            }
            var copy = grp.duplicate(doc, ElementPlacement.PLACEATBEGINNING);
            src.close(SaveOptions.DONOTSAVECHANGES);
            app.activeDocument = doc;
            if (anchor) { try { copy.move(anchor, ElementPlacement.PLACEBEFORE); } catch (e) {} }
            doc.activeLayer = copy;
            return "libinserted|" + name;
        } catch (e) {
            try { src.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
            app.activeDocument = doc;
            return "err|" + e.message;
        }
    } catch (e) { return "err|" + e.message + " (line " + e.line + ")"; }
}

function abrLibDelete(name) {
    try {
        var f = new File(abrDataDir("LayerLibrary").fsName + "/" + name + ".psd");
        if (f.exists) f.remove();
        return "libdeleted|" + name;
    } catch (e) { return "err|" + e.message + " (line " + e.line + ")"; }
}

function abrLibOpenFolder() {
    try {
        abrDataDir("LayerLibrary").execute();
        return "ok";
    } catch (e) { return "err|" + e.message + " (line " + e.line + ")"; }
}

// ---- 一鍵解散群組：選取的群組解散（工作區域不動，免得整個工作區域被拆掉）----
function abrUngroup() {
    try {
        if (!app.documents.length) return "err|nodoc";
        var doc = app.activeDocument, sel = abrSelectedIds(), ids = [];
        for (var k in sel) ids.push(+k);
        if (!ids.length) return "err|nosel";
        __abr = { ids: ids, count: 0, skipped: 0 };
        doc.suspendHistory("Ungroup", "abrUngroupRun()");
        return "ungroup|" + __abr.count + "|" + __abr.skipped;
    } catch (e) {
        return "err|" + e.message;
    }
}

function abrUngroupRun() {
    var a = __abr, doc = app.activeDocument;
    for (var i = 0; i < a.ids.length; i++) {
        try {
            abrSelect(a.ids[i], false);
            var L = doc.activeLayer;
            if (L.typename !== "LayerSet" || abrIsArtboard(L)) { a.skipped++; continue; }
            var d = new ActionDescriptor(), r = new ActionReference();
            r.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
            d.putReference(charIDToTypeID("null"), r);
            executeAction(stringIDToTypeID("ungroupLayersEvent"), d, DialogModes.NO);
            a.count++;
        } catch (e) { a.skipped++; }
    }
}

// ---- 逐格 GIF：選取的圖層／群組各當一格（圖層面板由下往上＝第 1 格起），存到「下載」資料夾 ----
// 做法：把選取的圖層複製到新文件 → 裁成所有格合起來的範圍 → 影格動畫「從圖層製作影格」
//      → 每格秒數 → 儲存為網頁用 GIF → 關掉新文件。原檔不動
function abrFrameGIF(delay) {
    if (!app.documents.length) return "err|nodoc";
    var doc = app.activeDocument, sel = abrSelectedIds(), n = 0;
    for (var k in sel) n++;
    if (n < 2) return "err|needtwo";

    var out = new File($.getenv("USERPROFILE") + "/Downloads/" + abrSafeName(doc.name.substr(0, doc.name.lastIndexOf(".") > 0 ? doc.name.lastIndexOf(".") : doc.name.length)) + ".gif");
    var tmp = null, step = "copy";
    try {
        var d = new ActionDescriptor(), r = new ActionReference(), u = new ActionReference();
        r.putClass(charIDToTypeID("Dcmn"));
        d.putReference(charIDToTypeID("null"), r);
        d.putString(charIDToTypeID("Nm  "), "GIF");
        u.putEnumerated(charIDToTypeID("Lyr "), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        d.putReference(charIDToTypeID("Usng"), u);
        executeAction(charIDToTypeID("Mk  "), d, DialogModes.NO);
        tmp = app.activeDocument;

        step = "trim";
        for (var i = 0; i < tmp.layers.length; i++) { try { tmp.layers[i].visible = true; } catch (e) {} }
        try { tmp.trim(TrimType.TRANSPARENT, true, true, true, true); } catch (e) {}

        step = "frames";
        var da = new ActionDescriptor(), ra = new ActionReference();
        ra.putClass(stringIDToTypeID("animationClass"));
        da.putReference(charIDToTypeID("null"), ra);
        try { executeAction(charIDToTypeID("Mk  "), da, DialogModes.NO); } catch (e) {}
        executeAction(stringIDToTypeID("animationFramesFromLayers"), new ActionDescriptor(), DialogModes.NO);

        step = "delay";
        executeAction(stringIDToTypeID("animationSelectAll"), new ActionDescriptor(), DialogModes.NO);
        var dd = new ActionDescriptor(), rd = new ActionReference(), fd = new ActionDescriptor();
        rd.putEnumerated(stringIDToTypeID("animationFrameClass"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
        dd.putReference(charIDToTypeID("null"), rd);
        fd.putDouble(stringIDToTypeID("animationFrameDelay"), delay);
        dd.putObject(charIDToTypeID("T   "), stringIDToTypeID("animationFrameClass"), fd);
        executeAction(charIDToTypeID("setd"), dd, DialogModes.NO);

        step = "export";
        var o = new ExportOptionsSaveForWeb();
        o.format = SaveDocumentType.COMPUSERVEGIF;
        o.colors = 256;
        o.colorReduction = ColorReductionType.SELECTIVE;
        o.dither = Dither.DIFFUSION;
        o.ditherAmount = 100;
        o.transparency = true;
        o.lossy = 0;
        o.optimized = true;
        o.interlaced = false;
        tmp.exportDocument(out, ExportType.SAVEFORWEB, o);
    } catch (e) {
        if (tmp) { try { tmp.close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {} }
        app.activeDocument = doc;
        return "err|" + step + ": " + e.message;
    }
    var w = Math.round(tmp.width.as("px")), h = Math.round(tmp.height.as("px"));
    tmp.close(SaveOptions.DONOTSAVECHANGES);
    app.activeDocument = doc;
    abrRestoreSel(sel);
    return "gif|" + decodeURI(out.fsName) + "|" + n + "|" + Math.round(new File(out.fsName).length / 1024) + "|" + w + "x" + h;
}

// ================= 基礎動畫（影格動畫）=================
// 整份文件共用同一組影格（格數、每格秒數由面板決定）。每個按鈕只改「選取的圖層」在每一格的位置／不透明度，
// 所以不同圖層可以各套不同動態、一起動。第 1 格永遠是原位，重按會直接覆蓋，不會越疊越多。

function abrFrameSelect(i) {
    var d = new ActionDescriptor(), r = new ActionReference();
    r.putIndex(stringIDToTypeID("animationFrameClass"), i);
    d.putReference(charIDToTypeID("null"), r);
    executeAction(charIDToTypeID("slct"), d, DialogModes.NO);
}

function abrFrameCount() {
    var n = 0;
    for (var i = 1; i <= 300; i++) {
        try { abrFrameSelect(i); n = i; } catch (e) { break; }
    }
    return n;
}

function abrFrameTargetRef() {
    var r = new ActionReference();
    r.putEnumerated(stringIDToTypeID("animationFrameClass"), charIDToTypeID("Ordn"), charIDToTypeID("Trgt"));
    return r;
}

// 讓影格剛好 total 格，每格 delay 秒
function abrEnsureFrames(total, delay) {
    var n = abrFrameCount();
    if (n === 0) {
        // 依序試不同版本的「建立影格動畫」指令；都不行就請使用者在時間軸手動按一次
        try { executeAction(stringIDToTypeID("makeFrameAnimation"), undefined, DialogModes.NO); } catch (e) {}
        n = abrFrameCount();
        if (n === 0) {
            try {
                var da = new ActionDescriptor(), ra = new ActionReference();
                ra.putClass(stringIDToTypeID("animationClass"));
                da.putReference(charIDToTypeID("null"), ra);
                executeAction(charIDToTypeID("Mk  "), da, DialogModes.NO);
            } catch (e) {}
            n = abrFrameCount();
        }
        if (n === 0) throw new Error("NEEDFRAMES");
    }
    while (n < total) {
        abrFrameSelect(n);
        var dd = new ActionDescriptor();
        dd.putReference(charIDToTypeID("null"), abrFrameTargetRef());
        executeAction(charIDToTypeID("Dplc"), dd, DialogModes.NO);
        n++;
    }
    while (n > total) {
        abrFrameSelect(n);
        var dl = new ActionDescriptor();
        dl.putReference(charIDToTypeID("null"), abrFrameTargetRef());
        executeAction(charIDToTypeID("Dlt "), dl, DialogModes.NO);
        n--;
    }
    // 一格一格設秒數。不用「全選影格」：全選後移動圖層會套到每一格，動畫就看不出來
    for (var i = 1; i <= n; i++) {
        abrFrameSelect(i);
        var ds = new ActionDescriptor(), fs = new ActionDescriptor();
        ds.putReference(charIDToTypeID("null"), abrFrameTargetRef());
        fs.putDouble(stringIDToTypeID("animationFrameDelay"), delay);
        ds.putObject(charIDToTypeID("T   "), stringIDToTypeID("animationFrameClass"), fs);
        executeAction(charIDToTypeID("setd"), ds, DialogModes.NO);
    }
    return n;
}

// 檢查用：回傳每一格裡這個圖層的 y 位置，例如 "100,88"
function abrFramePositions(id, n) {
    var ys = [];
    for (var i = 1; i <= n; i++) {
        abrFrameSelect(i);
        abrSelect(id, false);
        ys.push(Math.round(app.activeDocument.activeLayer.bounds[1].as("px")));
    }
    abrFrameSelect(1);
    return ys.join(",");
}

// 第 i 格（從 0 起）的變化量，0＝原位、1＝最大幅度
// 2 格：原位 ↔ 最大；3 格：原位 → 最大 → 一半；4 格以上：平順來回
function abrAnimLevel(kind, i, n) {
    if (n === 2) return i === 0 ? 0 : 1;
    if (n === 3) return [0, 1, 0.5][i];
    if (kind === "sway") return Math.sin(2 * Math.PI * i / n);
    return (1 - Math.cos(2 * Math.PI * i / n)) / 2;
}

// kind: "float"（往上）、"sway"（左右）、"blink"（變暗）、"reset"（回原位）；amount: px 或 %
function abrAnimRun() {
    var a = __abr, doc = app.activeDocument, n = abrEnsureFrames(a.frames, a.delay);
    for (var t = 0; t < a.ids.length; t++) {
        var id = a.ids[t];
        abrFrameSelect(1);
        abrSelect(id, false);
        var L = doc.activeLayer, b0 = L.bounds, x0 = b0[0].as("px"), y0 = b0[1].as("px"), op0 = L.opacity;
        for (var i = 1; i <= n; i++) {
            abrFrameSelect(i);
            abrSelect(id, false);
            L = doc.activeLayer;
            var lv = abrAnimLevel(a.kind, i - 1, n), b = L.bounds, tx = 0, ty = 0;
            if (a.kind === "float") ty = -a.amount * lv;
            if (a.kind === "sway") tx = a.amount * lv;
            var dx = Math.round(tx - (b[0].as("px") - x0)), dy = Math.round(ty - (b[1].as("px") - y0));
            if (a.kind !== "blink" && (dx || dy)) L.translate(UnitValue(dx, "px"), UnitValue(dy, "px"));
            if (a.kind === "blink") L.opacity = Math.max(0, op0 * (1 - a.amount / 100 * lv));
            if (a.kind === "reset") L.opacity = op0;
        }
        a.count++;
    }
    abrFrameSelect(1);
}

function abrAnimate(kind, amount, frames, delay) {
    try {
        if (!app.documents.length) return "err|nodoc";
        var sel = abrSelectedIds(), ids = [];
        for (var k in sel) ids.push(+k);
        if (!ids.length) return "err|nosel";
        var ru = app.preferences.rulerUnits;
        app.preferences.rulerUnits = Units.PIXELS;
        __abr = { kind: kind, amount: amount, frames: frames, delay: delay, ids: ids, count: 0 };
        try {
            app.activeDocument.suspendHistory("Animation " + kind, "abrAnimRun()");
        } finally {
            app.preferences.rulerUnits = ru;
        }
        abrRestoreSel(sel);
        var ys = "";
        app.preferences.rulerUnits = Units.PIXELS;
        try { ys = abrFramePositions(ids[0], frames); } catch (e) {}
        app.preferences.rulerUnits = ru;
        abrRestoreSel(sel);
        return "anim|" + __abr.count + "|" + frames + "|" + ys;
    } catch (e) {
        return "err|" + e.message + " (line " + e.line + ")";
    }
}

// 把目前文件的影格動畫存成 GIF 到「下載」資料夾
function abrExportAnimGIF() {
    try {
        if (!app.documents.length) return "err|nodoc";
        var doc = app.activeDocument, dot = doc.name.lastIndexOf(".");
        var out = new File($.getenv("USERPROFILE") + "/Downloads/" + abrSafeName(dot > 0 ? doc.name.substr(0, dot) : doc.name) + "_anim.gif");
        var o = new ExportOptionsSaveForWeb();
        o.format = SaveDocumentType.COMPUSERVEGIF;
        o.colors = 256;
        o.colorReduction = ColorReductionType.SELECTIVE;
        o.dither = Dither.DIFFUSION;
        o.ditherAmount = 100;
        o.transparency = true;
        o.lossy = 0;
        o.optimized = true;
        doc.exportDocument(out, ExportType.SAVEFORWEB, o);
        return "animgif|" + decodeURI(out.fsName) + "|" + Math.round(new File(out.fsName).length / 1024);
    } catch (e) {
        return "err|" + e.message + " (line " + e.line + ")";
    }
}

// ================= 逐格動畫 → GIF =================
// Photoshop 2020 用腳本建不了影格動畫，所以 Photoshop 這邊只負責「每一格存一張 PNG」：
// 把選取的圖層移動／變暗 → 拷貝合併範圍內的畫面 → 貼到新文件存 PNG → 原檔回到原狀。
// 面板再用 ffmpeg 把這幾張 PNG 合成 GIF。原檔不會留下任何改變。
function abrAnimFramesRun() {
    var a = __abr, doc = app.activeDocument;

    // 範圍：1) 圖層上下最近的兩條水平參考線之間 2) 所在的工作區域 3) 整張畫布
    abrSelect(a.ids[0], false);
    var top = doc.activeLayer, lb = top.bounds, ly0 = lb[1].as("px"), ly1 = lb[3].as("px"), rect = null;
    var gUp = null, gDown = null;
    for (var g = 0; g < doc.guides.length; g++) {
        var gd = doc.guides[g];
        if (gd.direction !== Direction.HORIZONTAL) continue;
        var gy = gd.coordinate.as("px");
        if (gy <= ly0 && (gUp === null || gy > gUp)) gUp = gy;
        if (gy >= ly1 && (gDown === null || gy < gDown)) gDown = gy;
    }
    while (top.parent && top.parent.typename !== "Document") top = top.parent;
    var ab = abrIsArtboard(top) ? abrArtboardRect(top) : null;
    if (gUp !== null && gDown !== null) {
        rect = ab ? { left: ab.left, top: gUp, right: ab.right, bottom: gDown } : { left: 0, top: gUp, right: doc.width.as("px"), bottom: gDown };
    }
    if (!rect && ab) rect = ab;
    if (!rect) rect = { left: 0, top: 0, right: doc.width.as("px"), bottom: doc.height.as("px") };
    var W = Math.round(rect.right - rect.left), H = Math.round(rect.bottom - rect.top);

    var base = {};
    for (var t = 0; t < a.ids.length; t++) { abrSelect(a.ids[t], false); base[a.ids[t]] = doc.activeLayer.opacity; }

    // A／B 切換：依圖層面板由下往上排，一格只顯示一個
    if (a.kind === "swap") {
        a.ids.sort(function (p, q) {
            return executeActionGet(abrLayerRef(p)).getInteger(stringIDToTypeID("itemIndex")) -
                   executeActionGet(abrLayerRef(q)).getInteger(stringIDToTypeID("itemIndex"));
        });
        a.frames = a.ids.length;
    }
    // 輪流亮：照畫面位置排（上到下、同一排左到右，跟 01、02、03、04 一樣），一格亮一個
    if (a.kind === "chase") {
        var pos = {};
        for (var c = 0; c < a.ids.length; c++) {
            abrSelect(a.ids[c], false);
            var cb = doc.activeLayer.bounds;
            pos[a.ids[c]] = { x: cb[0].as("px"), y: cb[1].as("px") };
        }
        a.ids.sort(function (p, q) {
            return Math.abs(pos[p].y - pos[q].y) > 50 ? pos[p].y - pos[q].y : pos[p].x - pos[q].x;
        });
        a.frames = a.ids.length;
    }

    a.orig = doc.activeHistoryState;
    // 流光：每個圖層上面加一道剪裁在它身上的斜白光帶（最後會整個退掉）
    var bands = [];
    if (a.kind === "sweep") {
        for (var s = 0; s < a.ids.length; s++) {
            abrSelect(a.ids[s], false);
            var T = doc.activeLayer, tb = T.bounds, lx0 = tb[0].as("px"), ly0 = tb[1].as("px"), lx1 = tb[2].as("px"), ly1 = tb[3].as("px");
            var bw = Math.max(20, (lx1 - lx0) * 0.18), sk = (ly1 - ly0) * 0.35, sx = lx0 - bw - sk;
            // doc.artLayers.add() 會把新圖層放到最上層（群組外面），要搬到目標圖層正上方才剪裁得到
            var nl = doc.artLayers.add();
            nl.move(T, ElementPlacement.PLACEBEFORE);
            doc.activeLayer = nl;
            doc.selection.select([[sx + sk, ly0], [sx + sk + bw, ly0], [sx + bw, ly1], [sx, ly1]]);
            doc.selection.feather(Math.max(2, Math.round(bw * 0.35)));
            var white = new SolidColor();
            white.rgb.hexValue = "FFFFFF";
            doc.selection.fill(white);
            doc.selection.deselect();
            nl.blendMode = BlendMode.SCREEN;
            nl.opacity = 75;
            nl.grouped = true;
            bands.push({ id: nl.id, dist: (lx1 - lx0) + bw + sk * 2 });
        }
    }

    var png = new PNGSaveOptions();
    png.compression = 1;
    var before = doc.activeHistoryState;
    for (var i = 0; i < a.frames; i++) {
        app.activeDocument = doc;
        var lv = abrAnimLevel(a.kind, i, a.frames);
        if (a.kind === "sweep") {
            // 前 10 格光帶掃過，之後停在右邊外面（＝原本的樣子）當作休息
            var move = i < 10 ? (i + 1) / 11 : 1;
            for (var bi = 0; bi < bands.length; bi++) {
                abrSelect(bands[bi].id, false);
                doc.activeLayer.translate(UnitValue(Math.round(bands[bi].dist * move), "px"), UnitValue(0, "px"));
            }
        }
        for (var t2 = 0; t2 < a.ids.length; t2++) {
            abrSelect(a.ids[t2], false);
            var L = doc.activeLayer;
            if (a.kind === "float" && lv) L.translate(UnitValue(0, "px"), UnitValue(Math.round(-a.amount * lv), "px"));
            if (a.kind === "sway" && lv) L.translate(UnitValue(Math.round(a.amount * lv), "px"), UnitValue(0, "px"));
            if (a.kind === "blink") L.opacity = Math.max(0, base[a.ids[t2]] * (1 - a.amount / 100 * lv));
            if (a.kind === "scale" && lv) L.resize(100 + a.amount * lv, 100 + a.amount * lv, AnchorPosition.MIDDLECENTER);
            if (a.kind === "rotate") {
                // 2 格：左 ↔ 右；3 格：左 → 正 → 右
                var ang = a.frames === 2 ? (i === 0 ? -1 : 1) : (a.frames === 3 ? [-1, 0, 1][i] : Math.sin(2 * Math.PI * i / a.frames));
                if (ang) L.rotate(a.amount * ang, AnchorPosition.MIDDLECENTER);
            }
            if (a.kind === "bounce" && lv) {
                L.translate(UnitValue(0, "px"), UnitValue(Math.round(-a.amount * lv), "px"));
                L.resize(100 - 3 * lv, 100 + 4 * lv, AnchorPosition.BOTTOMCENTER);
            }
            if (a.kind === "glow") abrGlowActive(app.foregroundColor, a.amount, 100 * lv);
            if (a.kind === "swap") L.visible = (t2 === i);
            if (a.kind === "chase" && t2 !== i) L.opacity = Math.max(0, base[a.ids[t2]] * (1 - a.amount / 100));
        }
        doc.selection.select([[rect.left, rect.top], [rect.right, rect.top], [rect.right, rect.bottom], [rect.left, rect.bottom]]);
        doc.selection.copy(true);
        doc.selection.deselect();
        doc.activeHistoryState = before;

        var tmp = app.documents.add(UnitValue(W, "px"), UnitValue(H, "px"), doc.resolution, "GIFFRAME", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
        tmp.paste();
        tmp.saveAs(new File(a.dir.fsName + "/f" + (i + 1) + ".png"), png, true, Extension.LOWERCASE);
        tmp.close(SaveOptions.DONOTSAVECHANGES);
    }
    app.activeDocument = doc;
    doc.activeHistoryState = a.orig;
    a.size = W + "x" + H;
}

// 外光暈：顏色、尺寸 px、不透明 %，保留其他樣式
function abrGlowActive(c, size, opacity) {
    var info = executeActionGet(abrTargetRef());
    var fx = info.hasKey(stringIDToTypeID("layerEffects")) ? info.getObjectValue(stringIDToTypeID("layerEffects")) : new ActionDescriptor();
    if (!fx.hasKey(stringIDToTypeID("scale"))) fx.putUnitDouble(stringIDToTypeID("scale"), charIDToTypeID("#Prc"), 100);
    var og = new ActionDescriptor();
    og.putBoolean(charIDToTypeID("enab"), opacity > 0);
    og.putBoolean(stringIDToTypeID("present"), true);
    og.putBoolean(stringIDToTypeID("showInDialog"), true);
    og.putEnumerated(charIDToTypeID("Md  "), charIDToTypeID("BlnM"), charIDToTypeID("Scrn"));
    og.putObject(charIDToTypeID("Clr "), charIDToTypeID("RGBC"), abrRGBDesc(c));
    og.putUnitDouble(charIDToTypeID("Opct"), charIDToTypeID("#Prc"), Math.max(0, Math.min(100, opacity)));
    og.putEnumerated(charIDToTypeID("GlwT"), charIDToTypeID("BETE"), charIDToTypeID("SfBL"));
    og.putUnitDouble(charIDToTypeID("Ckmt"), charIDToTypeID("#Pxl"), 0);
    og.putUnitDouble(charIDToTypeID("blur"), charIDToTypeID("#Pxl"), size);
    og.putUnitDouble(charIDToTypeID("Nose"), charIDToTypeID("#Prc"), 0);
    og.putUnitDouble(charIDToTypeID("ShdN"), charIDToTypeID("#Prc"), 0);
    og.putBoolean(charIDToTypeID("AntA"), false);
    og.putUnitDouble(charIDToTypeID("Inpr"), charIDToTypeID("#Prc"), 50);
    fx.putObject(stringIDToTypeID("outerGlow"), stringIDToTypeID("outerGlow"), og);
    var d = new ActionDescriptor();
    d.putReference(charIDToTypeID("null"), abrTargetRef("layerEffects"));
    d.putObject(charIDToTypeID("T   "), stringIDToTypeID("layerEffects"), fx);
    executeAction(charIDToTypeID("setd"), d, DialogModes.NO);
}

// 回傳 "frames|暫存資料夾|GIF 檔路徑|尺寸"，面板接著用 ffmpeg 合成
function abrAnimFrames(kind, amount, frames) {
    if (!app.documents.length) return "err|nodoc";
    var doc = app.activeDocument, sel = abrSelectedIds(), ids = [];
    for (var k in sel) ids.push(+k);
    if (!ids.length) return "err|nosel";
    var ru = app.preferences.rulerUnits, dot = doc.name.lastIndexOf(".");
    app.preferences.rulerUnits = Units.PIXELS;
    abrSelect(ids[0], false);
    var label = abrSafeName(doc.activeLayer.name);
    var dir = new Folder(Folder.temp.fsName + "/PeppaGIF");
    if (dir.exists) { var old = dir.getFiles(); for (var f = 0; f < old.length; f++) old[f].remove(); } else dir.create();
    __abr = {
        kind: kind, amount: amount, frames: kind === "sweep" ? 30 : frames, ids: ids, size: "", dir: dir, orig: null,
        out: new File($.getenv("USERPROFILE") + "/Downloads/" + abrSafeName(dot > 0 ? doc.name.substr(0, dot) : doc.name) + "_" + label + "_" + kind + ".gif")
    };
    try {
        abrAnimFramesRun();
    } catch (e) {
        // 出錯也要回到原檔、關掉暫存文件
        try { for (var d = app.documents.length - 1; d >= 0; d--) if (app.documents[d].name.indexOf("GIFFRAME") === 0) app.documents[d].close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
        app.activeDocument = doc;
        if (__abr.orig) { try { doc.activeHistoryState = __abr.orig; } catch (e3) {} }
        app.preferences.rulerUnits = ru;
        return "err|" + e.message + " (line " + e.line + ")";
    }
    app.preferences.rulerUnits = ru;
    abrRestoreSel(sel);
    return "frames|" + __abr.dir.fsName + "|" + __abr.out.fsName + "|" + __abr.size + "|" + __abr.frames;
}

// ---- 依參考線切圖：用水平參考線把整張切成一段一段，各存一張（存到「下載\檔名_切圖」）----
function abrSliceExport(fmt) {
    if (!app.documents.length) return "err|nodoc";
    var doc = app.activeDocument, ru = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;
    var W = doc.width.as("px"), H = doc.height.as("px"), ys = [0, H];
    for (var g = 0; g < doc.guides.length; g++) {
        if (doc.guides[g].direction !== Direction.HORIZONTAL) continue;
        var y = Math.round(doc.guides[g].coordinate.as("px"));
        if (y > 0 && y < H) ys.push(y);
    }
    ys.sort(function (p, q) { return p - q; });
    if (ys.length < 3) { app.preferences.rulerUnits = ru; return "err|noguides"; }

    var dot = doc.name.lastIndexOf("."), base = abrSafeName(dot > 0 ? doc.name.substr(0, dot) : doc.name);
    var dir = new Folder($.getenv("USERPROFILE") + "/Downloads/\u5207\u5716");
    if (!dir.exists) dir.create();
    var opt;
    if (fmt === "jpg") { opt = new JPEGSaveOptions(); opt.quality = 10; }
    else { opt = new PNGSaveOptions(); opt.compression = 6; }

    var count = 0, skipped = 0;
    for (var i = 0; i < ys.length - 1; i++) {
        var t = ys[i], b = ys[i + 1];
        if (b - t < 2) continue;
        var tmp = null;
        try {
            app.activeDocument = doc;
            doc.selection.select([[0, t], [W, t], [W, b], [0, b]]);
            doc.selection.copy(true);
            doc.selection.deselect();
            tmp = app.documents.add(UnitValue(W, "px"), UnitValue(b - t, "px"), doc.resolution, "SLICE", NewDocumentMode.RGB, fmt === "jpg" ? DocumentFill.WHITE : DocumentFill.TRANSPARENT);
            tmp.paste();
            var num = String(count + 1);
            while (num.length < 2) num = "0" + num;
            tmp.saveAs(new File(dir.fsName + "/" + base + "_" + num + "." + (fmt === "jpg" ? "jpg" : "png")), opt, true, Extension.LOWERCASE);
            count++;
        } catch (e) {
            skipped++;
            try { doc.selection.deselect(); } catch (e2) {}
        }
        if (tmp) { try { tmp.close(SaveOptions.DONOTSAVECHANGES); } catch (e3) {} }
    }
    app.activeDocument = doc;
    app.preferences.rulerUnits = ru;
    return "slice|" + count + "|" + skipped + "|" + decodeURI(dir.fsName);
}

// ================= 一鍵輸出全部動畫 GIF =================
// 圖層名稱開頭有「動-效果 」標記的（例如「動-飄浮12-流光 主標」）就會動。
// 依水平參考線分段：同一段裡所有標記的圖層一起動，合成一張 GIF；每段各一張。
// fxMap：面板傳來的 [{k:"float", w:"飄浮", d:12}, ...]（中文關鍵字在面板那邊）

function abrParseFx(name, fxMap) {
    var m = name.match(ABR_PREFIX_RE);
    if (!m) return [];
    var parts = m[0].replace(/^\u52D5-?/, "").split(/[-\s]+/), list = [];
    for (var i = 0; i < parts.length; i++) {
        if (!parts[i]) continue;
        for (var j = 0; j < fxMap.length; j++) {
            var w = fxMap[j].w;
            if (parts[i].indexOf(w) === 0) {
                var num = parseFloat(parts[i].substr(w.length));
                list.push({ kind: fxMap[j].k, amount: isNaN(num) ? fxMap[j].d : num });
                break;
            }
        }
    }
    return list;
}

function abrCollectFxLayers(container, fxMap, out) {
    for (var i = 0; i < container.layers.length; i++) {
        var L = container.layers[i];
        if (!L.visible) continue;
        var fx = abrParseFx(L.name, fxMap);
        if (fx.length) out.push({ id: L.id, fx: fx });
        if (L.typename === "LayerSet") abrCollectFxLayers(L, fxMap, out);
    }
}

// 圖層所在的段落：上下最近的水平參考線；沒有就用工作區域或整張
function abrBandOf(doc, L) {
    var lb = L.bounds, ly0 = lb[1].as("px"), ly1 = lb[3].as("px"), gUp = null, gDown = null;
    for (var g = 0; g < doc.guides.length; g++) {
        var gd = doc.guides[g];
        if (gd.direction !== Direction.HORIZONTAL) continue;
        var gy = gd.coordinate.as("px");
        if (gy <= ly0 && (gUp === null || gy > gUp)) gUp = gy;
        if (gy >= ly1 && (gDown === null || gy < gDown)) gDown = gy;
    }
    var top = L;
    while (top.parent && top.parent.typename !== "Document") top = top.parent;
    var ab = abrIsArtboard(top) ? abrArtboardRect(top) : null;
    var left = ab ? ab.left : 0, right = ab ? ab.right : doc.width.as("px");
    if (gUp !== null && gDown !== null) return { left: left, top: gUp, right: right, bottom: gDown };
    if (ab) return ab;
    return { left: 0, top: 0, right: doc.width.as("px"), bottom: doc.height.as("px") };
}

// 一個圖層在第 i 格（共 n 格）的變化
function abrApplyFx(doc, L, f, i, n, baseOp, chase) {
    var lv = abrAnimLevel(f.kind, i, n);
    if (f.kind === "float" && lv) L.translate(UnitValue(0, "px"), UnitValue(Math.round(-f.amount * lv), "px"));
    if (f.kind === "sway" && lv) L.translate(UnitValue(Math.round(f.amount * lv), "px"), UnitValue(0, "px"));
    if (f.kind === "blink") L.opacity = Math.max(0, baseOp * (1 - f.amount / 100 * lv));
    if (f.kind === "scale" && lv) L.resize(100 + f.amount * lv, 100 + f.amount * lv, AnchorPosition.MIDDLECENTER);
    if (f.kind === "rotate") {
        var ang = n === 2 ? (i === 0 ? -1 : 1) : (n === 3 ? [-1, 0, 1][i] : Math.sin(2 * Math.PI * i / n));
        if (ang) L.rotate(f.amount * ang, AnchorPosition.MIDDLECENTER);
    }
    if (f.kind === "bounce" && lv) {
        L.translate(UnitValue(0, "px"), UnitValue(Math.round(-f.amount * lv), "px"));
        L.resize(100 - 3 * lv, 100 + 4 * lv, AnchorPosition.BOTTOMCENTER);
    }
    if (f.kind === "glow") abrGlowActive(app.foregroundColor, f.amount, 100 * lv);
    if (f.kind === "chase" && chase && chase.order !== Math.floor(i * chase.total / n)) L.opacity = Math.max(0, baseOp * (1 - f.amount / 100));
    // 輪流放大：輪到的那個放大，其他不動
    if (f.kind === "chasescale" && chase && chase.order === Math.floor(i * chase.total / n)) L.resize(100 + f.amount, 100 + f.amount, AnchorPosition.MIDDLECENTER);
}

function abrExportAllRun() {
    var a = __abr, doc = app.activeDocument, items = [];
    abrCollectFxLayers(doc, a.fxMap, items);

    // 分段：用水平參考線把整張切開（沒有參考線就整張一段），每個標記圖層歸到它中心所在的那段
    var Wd = doc.width.as("px"), Hd = doc.height.as("px"), ys = [0, Hd];
    for (var g = 0; g < doc.guides.length; g++) {
        if (doc.guides[g].direction !== Direction.HORIZONTAL) continue;
        var gy = Math.round(doc.guides[g].coordinate.as("px"));
        if (gy > 0 && gy < Hd) ys.push(gy);
    }
    ys.sort(function (p, q) { return p - q; });
    var bands = [];
    for (var y = 0; y < ys.length - 1; y++) {
        if (ys[y + 1] - ys[y] >= 2) bands.push({ rect: { left: 0, top: ys[y], right: Wd, bottom: ys[y + 1] }, items: [] });
    }
    for (var t = 0; t < items.length; t++) {
        abrSelect(items[t].id, false);
        var L = doc.activeLayer, lb = L.bounds;
        items[t].op = L.opacity;
        items[t].x = lb[0].as("px");
        items[t].y = lb[1].as("px");
        var cy = (lb[1].as("px") + lb[3].as("px")) / 2;
        for (var bb = 0; bb < bands.length; bb++) {
            if (cy >= bands[bb].rect.top && cy < bands[bb].rect.bottom) { bands[bb].items.push(items[t]); break; }
        }
    }

    var dot0 = doc.name.lastIndexOf("."), base0 = abrSafeName(dot0 > 0 ? doc.name.substr(0, dot0) : doc.name);
    var outDir = new Folder($.getenv("USERPROFILE") + "/Downloads/\u5207\u5716");
    if (!outDir.exists) outDir.create();
    a.outDir = outDir.fsName;
    a.pngCount = 0;
    if (a.onlySel) {
        for (var si = 0; si < a.selIds.length; si++) {
            abrSelect(a.selIds[si], false);
            var sb = doc.activeLayer.bounds, scy = (sb[1].as("px") + sb[3].as("px")) / 2;
            for (var sbb = 0; sbb < bands.length; sbb++) {
                if (scy >= bands[sbb].rect.top && scy < bands[sbb].rect.bottom) bands[sbb].pick = true;
            }
        }
    }

    var png = new PNGSaveOptions();
    png.compression = 1;
    var root = new Folder(Folder.temp.fsName + "/PeppaGIF");
    if (!root.exists) root.create();

    for (var b = 0; b < bands.length; b++) {
        var B = bands[b], rect = B.rect, W = Math.round(rect.right - rect.left), H = Math.round(rect.bottom - rect.top);
        var numB = String(b + 1);
        while (numB.length < 2) numB = "0" + numB;
        if (a.onlySel && !B.pick) continue;
        if (!B.items.length) {
            // 沒動態的段：直接存 PNG
            try {
                app.activeDocument = doc;
                doc.selection.select([[rect.left, rect.top], [rect.right, rect.top], [rect.right, rect.bottom], [rect.left, rect.bottom]]);
                doc.selection.copy(true);
                doc.selection.deselect();
                var st = app.documents.add(UnitValue(W, "px"), UnitValue(H, "px"), doc.resolution, "GIFFRAME", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
                st.paste();
                var spng = new PNGSaveOptions();
                spng.compression = 6;
                st.saveAs(new File(outDir.fsName + "/" + base0 + "_" + numB + ".png"), spng, true, Extension.LOWERCASE);
                st.close(SaveOptions.DONOTSAVECHANGES);
                a.pngCount++;
            } catch (eS) { try { doc.selection.deselect(); } catch (eS2) {} }
            continue;
        }
        var hasSweep = false, chaseList = [];
        for (var k = 0; k < B.items.length; k++) {
            for (var e = 0; e < B.items[k].fx.length; e++) {
                if (B.items[k].fx[e].kind === "sweep") hasSweep = true;
                // 同一個圖層同時標了「輪流」和「輪流放大」也只算一次，不然格數會多出來
                if ((B.items[k].fx[e].kind === "chase" || B.items[k].fx[e].kind === "chasescale") && !B.items[k].inChase) {
                    B.items[k].inChase = true;
                    chaseList.push(B.items[k]);
                }
            }
        }
        // 輪流亮：照畫面位置排（上到下、同一排左到右）
        chaseList.sort(function (p, q) { return Math.abs(p.y - q.y) > 50 ? p.y - q.y : p.x - q.x; });
        for (var c = 0; c < chaseList.length; c++) chaseList[c].chase = { order: c, total: chaseList.length };
        var n = hasSweep ? 30 : (chaseList.length > 1 ? chaseList.length : a.frames);
        var delay = hasSweep ? 0.05 : a.delay;

        var dir = new Folder(root.fsName + "/b" + (b + 1));
        if (dir.exists) { var old = dir.getFiles(); for (var f = 0; f < old.length; f++) old[f].remove(); } else dir.create();

        app.activeDocument = doc;
        var orig = doc.activeHistoryState;
        a.orig = orig;

        // 流光光帶（剪裁在圖層上）
        var sweeps = [];
        for (var s = 0; s < B.items.length; s++) {
            for (var e2 = 0; e2 < B.items[s].fx.length; e2++) {
                if (B.items[s].fx[e2].kind !== "sweep") continue;
                abrSelect(B.items[s].id, false);
                var T = doc.activeLayer, tb = T.bounds, lx0 = tb[0].as("px"), ly0 = tb[1].as("px"), lx1 = tb[2].as("px"), ly1 = tb[3].as("px");
                var bw = Math.max(20, (lx1 - lx0) * 0.18), sk = (ly1 - ly0) * 0.35, sx = lx0 - bw - sk;
                var nl = doc.artLayers.add();
                nl.move(T, ElementPlacement.PLACEBEFORE);
                doc.activeLayer = nl;
                doc.selection.select([[sx + sk, ly0], [sx + sk + bw, ly0], [sx + bw, ly1], [sx, ly1]]);
                doc.selection.feather(Math.max(2, Math.round(bw * 0.35)));
                var white = new SolidColor();
                white.rgb.hexValue = "FFFFFF";
                doc.selection.fill(white);
                doc.selection.deselect();
                nl.blendMode = BlendMode.SCREEN;
                nl.opacity = 75;
                nl.grouped = true;
                sweeps.push({ id: nl.id, dist: (lx1 - lx0) + bw + sk * 2 });
            }
        }

        var before = doc.activeHistoryState;
        for (var i = 0; i < n; i++) {
            app.activeDocument = doc;
            var move = i < 10 ? (i + 1) / 11 : 1;
            for (var sw = 0; sw < sweeps.length; sw++) {
                abrSelect(sweeps[sw].id, false);
                doc.activeLayer.translate(UnitValue(Math.round(sweeps[sw].dist * move), "px"), UnitValue(0, "px"));
            }
            for (var it = 0; it < B.items.length; it++) {
                var item = B.items[it];
                for (var e3 = 0; e3 < item.fx.length; e3++) {
                    if (item.fx[e3].kind === "sweep") continue;
                    abrSelect(item.id, false);
                    abrApplyFx(doc, doc.activeLayer, item.fx[e3], i, n, item.op, item.chase);
                }
            }
            doc.selection.select([[rect.left, rect.top], [rect.right, rect.top], [rect.right, rect.bottom], [rect.left, rect.bottom]]);
            doc.selection.copy(true);
            doc.selection.deselect();
            doc.activeHistoryState = before;

            var tmp = app.documents.add(UnitValue(W, "px"), UnitValue(H, "px"), doc.resolution, "GIFFRAME", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
            tmp.paste();
            tmp.saveAs(new File(dir.fsName + "/f" + (i + 1) + ".png"), png, true, Extension.LOWERCASE);
            tmp.close(SaveOptions.DONOTSAVECHANGES);
        }
        app.activeDocument = doc;
        doc.activeHistoryState = orig;

        var out = new File(outDir.fsName + "/" + base0 + "_" + numB + ".gif");
        a.lines.push([dir.fsName, out.fsName, W + "x" + H, n, delay].join("|"));
    }
}

// onlySel＝true：只輸出選取圖層所在的那幾段（單獨輸出）
function abrExportAll(fxMap, frames, delay, onlySel) {
    if (!app.documents.length) return "err|nodoc";
    var doc = app.activeDocument, sel = abrSelectedIds(), ru = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;
    var selIds = [];
    for (var k in sel) selIds.push(+k);
    if (onlySel && !selIds.length) { app.preferences.rulerUnits = ru; return "err|nosel"; }
    __abr = { fxMap: fxMap, frames: frames, delay: delay, lines: [], none: false, orig: null, onlySel: !!onlySel, selIds: selIds };
    try {
        abrExportAllRun();
    } catch (e) {
        try { for (var d = app.documents.length - 1; d >= 0; d--) if (app.documents[d].name.indexOf("GIFFRAME") === 0) app.documents[d].close(SaveOptions.DONOTSAVECHANGES); } catch (e2) {}
        app.activeDocument = doc;
        if (__abr.orig) { try { doc.activeHistoryState = __abr.orig; } catch (e3) {} }
        app.preferences.rulerUnits = ru;
        return "err|" + e.message + " (line " + e.line + ")";
    }
    app.preferences.rulerUnits = ru;
    abrRestoreSel(sel);
    return "all|" + __abr.pngCount + "|" + decodeURI(__abr.outDir) + "\n" + __abr.lines.join("\n");
}

// ================= 線稿去背（黑線白底 → 透明底）=================
// 跟手動做法一樣：拷貝藍色版 → 拉高對比（＝加亮白底、加深黑線）→ 反轉 → 載入成選取範圍
// → 新圖層填色。用「填色」不用遮色片，邊緣不會留白邊。原圖層只是隱藏，不會被改。
// black／white：色階的黑白點，越靠近，邊緣越硬；fill：線條要填的顏色（hex）
function abrLineArtRun() {
    var a = __abr, doc = app.activeDocument, src = doc.activeLayer;

    // 1. 拷貝藍色版
    var blue = doc.channels[2], dup = blue.duplicate();
    dup.name = "lineart_tmp";

    // 2. 在拷貝的色版上拉高對比，再反轉（黑線變白＝要選的地方）
    doc.activeChannels = [dup];
    src.adjustLevels(a.black, a.white, 1.0, 0, 255);
    src.invert();
    doc.activeChannels = doc.componentChannels;

    // 3. 載入成選取範圍 → 新圖層填色
    doc.selection.load(dup, SelectionType.REPLACE);
    var nl = doc.artLayers.add();
    nl.move(src, ElementPlacement.PLACEBEFORE);
    doc.activeLayer = nl;
    nl.name = src.name + "_\u53BB\u80CC";
    var c = new SolidColor();
    c.rgb.hexValue = a.fill;
    doc.selection.fill(c);
    doc.selection.deselect();

    // 4. 收尾：刪掉暫存色版、隱藏原圖
    dup.remove();
    src.visible = false;
    a.name = nl.name;
}

function abrLineArt(black, white, fill) {
    try {
        if (!app.documents.length) return "err|nodoc";
        var doc = app.activeDocument;
        if (doc.mode !== DocumentMode.RGB) return "err|notrgb";
        var L = doc.activeLayer;
        if (L.typename === "LayerSet" || (L.kind !== LayerKind.NORMAL && L.kind !== LayerKind.SMARTOBJECT)) return "err|notpixel";
        if (L.kind === LayerKind.SMARTOBJECT) return "err|smart";
        __abr = { black: black, white: white, fill: fill, name: "" };
        doc.suspendHistory("Line art cutout", "abrLineArtRun()");
        return "lineart|" + __abr.name;
    } catch (e) {
        return "err|" + e.message + " (line " + e.line + ")";
    }
}

// ---- 放大／縮小 10%（以原尺寸計算，可疊加）----
// 第一次按時記下圖層當時的大小當「原尺寸」，之後每按一次 +1 或 -1 格，
// 目標大小＝原尺寸 ×（1 ＋ 0.1 × 格數），所以 +10% +10% = 120%，不是 121%。
// 記錄只存在這次開著的 Photoshop 裡；重開 Photoshop 後會以當時大小重新當原尺寸。
var __abrScaleMemo = {};

function abrStepScaleActive(L, delta, a) {
    var key = app.activeDocument.name + "_" + L.id, b = L.boundsNoEffects;
    var w = b[2].as("px") - b[0].as("px"), h = b[3].as("px") - b[1].as("px");
    if (w < 1 || h < 1) return false;
    var m = __abrScaleMemo[key];
    if (!m) m = __abrScaleMemo[key] = { w0: w, step: 0 };
    m.step = delta === 0 ? 0 : m.step + delta;
    if (1 + 0.1 * m.step < 0.1) m.step = -9;   // 最小 10%
    var pct = m.w0 * (1 + 0.1 * m.step) / w * 100;
    if (Math.abs(pct - 100) > 0.01) L.resize(pct, pct, AnchorPosition.MIDDLECENTER);
    a.last = Math.round((1 + 0.1 * m.step) * 100);
    return true;
}

function abrStepScale(delta) {
    if (!app.documents.length) return "err|nodoc";
    var doc = app.activeDocument, sel = abrSelectedIds(), ids = [];
    for (var k in sel) ids.push(+k);
    if (!ids.length) return "err|nosel";
    var ru = app.preferences.rulerUnits;
    app.preferences.rulerUnits = Units.PIXELS;
    __abr = { ids: ids, delta: delta, count: 0, last: 100 };
    try {
        doc.suspendHistory("Scale step", "abrStepScaleRun()");
    } catch (e) {
        app.preferences.rulerUnits = ru;
        return "err|" + e.message + " (line " + e.line + ")";
    }
    app.preferences.rulerUnits = ru;
    abrRestoreSel(sel);
    return "stepscale|" + __abr.count + "|" + __abr.last;
}

function abrStepScaleRun() {
    var a = __abr, doc = app.activeDocument;
    for (var i = 0; i < a.ids.length; i++) {
        abrSelect(a.ids[i], false);
        if (abrStepScaleActive(doc.activeLayer, a.delta, a)) a.count++;
    }
}

// ---- 一鍵解除整份文件所有圖層的鎖定（含群組、工作區域裡面；背景圖層轉成一般圖層）----
function abrUnlockWalk(container, a) {
    for (var i = 0; i < container.layers.length; i++) {
        var L = container.layers[i], was = false;
        try {
            if (L.allLocked) { L.allLocked = false; was = true; }
            if (L.typename === "ArtLayer") {
                if (L.isBackgroundLayer) { L.isBackgroundLayer = false; was = true; }
                if (L.pixelsLocked) { L.pixelsLocked = false; was = true; }
                if (L.positionLocked) { L.positionLocked = false; was = true; }
                if (L.transparentPixelsLocked) { L.transparentPixelsLocked = false; was = true; }
            }
        } catch (e) { a.failed++; }
        if (was) a.count++;
        if (L.typename === "LayerSet") abrUnlockWalk(L, a);
    }
}

function abrUnlockAll() {
    try {
        if (!app.documents.length) return "err|nodoc";
        __abr = { count: 0, failed: 0 };
        app.activeDocument.suspendHistory("Unlock all layers", "abrUnlockWalk(app.activeDocument, __abr)");
        return "unlock|" + __abr.count + "|" + __abr.failed;
    } catch (e) {
        return "err|" + e.message + " (line " + e.line + ")";
    }
}
