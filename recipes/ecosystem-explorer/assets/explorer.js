/* Ecosystem explorer page script. Plain browser JavaScript, no libraries, no network calls.
   Reads the embedded data and builds every element with createElement and textContent. */
(function () {
  "use strict";
  var root = document.getElementById("explorer");
  var source = document.getElementById("explorer-data");
  if (!root || !source) return;
  var data = JSON.parse(source.textContent);
  var techs = data.technologies || [];
  var companies = data.companies || [];
  var pairs = data.pairs || [];
  var listed = {};
  (data.listed || []).forEach(function (k) { listed[k] = true; });
  var MAX_ROWS = 200;
  var state = { category: "", vendor: "", group: "", confidence: "", search: "", selected: "", company: "" };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function show(v) { return v === null || v === undefined || v === "" ? "not returned" : String(v); }
  function uniqueSorted(values) {
    var seen = {}, out = [];
    values.forEach(function (v) {
      if (typeof v === "string" && v && !seen[v]) { seen[v] = true; out.push(v); }
    });
    return out.sort();
  }
  function select(label, options, key, allText) {
    var wrap = el("label", "muted");
    wrap.style.display = "flex";
    wrap.style.flexDirection = "column";
    wrap.style.minWidth = "140px";
    wrap.style.flex = "1 1 140px";
    wrap.appendChild(el("span", null, label));
    var s = el("select");
    s.style.maxWidth = "100%";
    var all = el("option", null, allText);
    all.value = "";
    s.appendChild(all);
    options.forEach(function (o) {
      var opt = el("option", null, o.text);
      opt.value = o.value;
      s.appendChild(opt);
    });
    s.value = state[key];
    s.addEventListener("change", function () { state[key] = s.value; draw(); });
    wrap.appendChild(s);
    return wrap;
  }
  function plain(values) { return values.map(function (v) { return { value: v, text: v }; }); }

  var confidenceValues = [];
  techs.forEach(function (t) { Object.keys(t.by_confidence || {}).forEach(function (k) { confidenceValues.push(k); }); });
  confidenceValues = uniqueSorted(confidenceValues);

  var filters = el("div");
  filters.style.display = "flex";
  filters.style.flexWrap = "wrap";
  filters.style.gap = "8px 12px";
  filters.style.margin = "0 0 12px";
  var searchWrap = el("label", "muted");
  searchWrap.style.display = "flex";
  searchWrap.style.flexDirection = "column";
  searchWrap.style.flex = "1 1 140px";
  searchWrap.appendChild(el("span", null, "Search technology"));
  var search = el("input");
  search.type = "search";
  search.addEventListener("input", function () { state.search = search.value.toLowerCase(); draw(); });
  searchWrap.appendChild(search);
  filters.appendChild(searchWrap);
  filters.appendChild(select("Category", plain(uniqueSorted(techs.map(function (t) { return t.category; }))), "category", "All categories"));
  filters.appendChild(select("Vendor", plain(uniqueSorted(techs.map(function (t) { return t.vendor; }))), "vendor", "All vendors"));
  if ((data.groups || []).length) {
    filters.appendChild(select("Group (" + data.group_by + ")", plain(data.groups), "group", "Whole cohort"));
  }
  filters.appendChild(select("Confidence", plain(confidenceValues), "confidence", "Any confidence"));

  var tableBox = el("div");
  var pairBox = el("div", "card");
  var companyBox = el("div", "card");
  clear(root);
  root.appendChild(filters);
  root.appendChild(tableBox);
  root.appendChild(pairBox);
  root.appendChild(companyBox);

  function measureFor(t) {
    if (state.group && t.by_group) return t.by_group[state.group];
    return t.overall;
  }
  function inGroup(c) { return !state.group || c.group === state.group; }
  function atConfidence(t) {
    var n = 0;
    companies.forEach(function (c) {
      if (!inGroup(c)) return;
      (c.technologies || []).forEach(function (x) { if (x.key === t.key && x.confidence === state.confidence) n += 1; });
    });
    return n;
  }
  function techByKey(k) {
    for (var i = 0; i < techs.length; i++) if (techs[i].key === k) return techs[i];
    return null;
  }
  function name(k) {
    var t = techByKey(k);
    return t && t.product ? t.product + " (" + k + ")" : k;
  }

  function drawTable() {
    clear(tableBox);
    var shown = techs.filter(function (t) {
      if (state.category && t.category !== state.category) return false;
      if (state.vendor && t.vendor !== state.vendor) return false;
      if (state.search) {
        var hay = [t.product, t.key, t.vendor, t.category].join(" ").toLowerCase();
        if (hay.indexOf(state.search) < 0) return false;
      }
      var m = measureFor(t);
      if (!m || m.observed === 0) return false;
      if (state.confidence && atConfidence(t) === 0) return false;
      return true;
    });
    var scope = state.group ? "group " + state.group : "the whole cohort";
    tableBox.appendChild(el("p", "muted", shown.length + " technologies observed in " + scope +
      " match the filters. Click a technology to see what was observed with it."));
    var wrap = el("div", "scroll");
    var tbl = el("table");
    var head = el("tr");
    var cols = ["Technology", "Vendor", "Category", "Observed (of companies with data)", "Share of answered",
      "Not observed in pages retrieved"];
    if (state.confidence) cols.push("Companies at " + state.confidence + " confidence");
    cols.forEach(function (h) { head.appendChild(el("th", null, h)); });
    var thead = el("thead");
    thead.appendChild(head);
    tbl.appendChild(thead);
    var tbody = el("tbody");
    shown.slice(0, MAX_ROWS).forEach(function (t) {
      var m = measureFor(t);
      var tr = el("tr");
      var first = el("td");
      var btn = el("button", null, t.product || t.key);
      btn.type = "button";
      btn.style.background = "none";
      btn.style.border = "0";
      btn.style.padding = "0";
      btn.style.color = state.selected === t.key ? "#913704" : "#F15B06";
      btn.style.fontWeight = state.selected === t.key ? "800" : "600";
      btn.style.cursor = "pointer";
      btn.style.textAlign = "left";
      btn.addEventListener("click", function () { state.selected = t.key; draw(); });
      first.appendChild(btn);
      tr.appendChild(first);
      tr.appendChild(el("td", null, show(t.vendor)));
      tr.appendChild(el("td", null, show(t.category)));
      tr.appendChild(el("td", null, m.observed + " of " + m.companies_with_data));
      tr.appendChild(el("td", null, m.enough_answers ? m.observed_share_pct + "% of " + m.answered : "too few answers to compare"));
      tr.appendChild(el("td", null, String(m.not_observed_in_pages_retrieved)));
      if (state.confidence) tr.appendChild(el("td", null, String(atConfidence(t))));
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    tableBox.appendChild(wrap);
    if (shown.length > MAX_ROWS) {
      tableBox.appendChild(el("p", "muted", "The first " + MAX_ROWS + " of " + shown.length + " are shown. Narrow the filters to see others."));
    }
  }

  function drawPairs() {
    clear(pairBox);
    pairBox.appendChild(el("h3", null, "Observed at the same companies"));
    if (!state.selected) {
      pairBox.appendChild(el("p", "muted", "Select a technology in the table."));
      return;
    }
    var t = techByKey(state.selected);
    pairBox.appendChild(el("p", null, name(state.selected) + ": " + (t ? t.overall.text : "")));
    if (!listed[state.selected]) {
      pairBox.appendChild(el("p", "muted", "This technology was observed in fewer than " + data.min_companies +
        " companies, so it is not in the co-occurrence view."));
      return;
    }
    var mine = pairs.filter(function (p) { return p.a === state.selected || p.b === state.selected; });
    if (!mine.length) {
      pairBox.appendChild(el("p", "muted", "No other listed technology was observed at the same companies."));
      return;
    }
    var wrap = el("div", "scroll");
    var tbl = el("table");
    var head = el("tr");
    ["Other technology", "Companies with both", "Share of companies with the selected technology"].forEach(function (h) {
      head.appendChild(el("th", null, h));
    });
    var thead = el("thead");
    thead.appendChild(head);
    tbl.appendChild(thead);
    var tbody = el("tbody");
    mine.forEach(function (p) {
      var selfIsA = p.a === state.selected;
      var other = selfIsA ? p.b : p.a;
      var withSelf = selfIsA ? p.companies_with_a : p.companies_with_b;
      var share = selfIsA ? p.share_of_a_pct : p.share_of_b_pct;
      var tr = el("tr");
      tr.appendChild(el("td", null, name(other)));
      tr.appendChild(el("td", null, String(p.both)));
      tr.appendChild(el("td", null, p.both + " of " + withSelf +
        (share === null || share === undefined ? " (too few answers to compare)" : " (" + share + "%)")));
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    pairBox.appendChild(wrap);
    pairBox.appendChild(el("p", "muted", "Co-occurrence does not show integration, compatibility or use together."));
  }

  function drawCompany() {
    clear(companyBox);
    companyBox.appendChild(el("h3", null, "Company drilldown"));
    var opts = companies.filter(inGroup).map(function (c) { return { value: c.row_id, text: c.label + " (" + c.row_id + ")" }; });
    companyBox.appendChild(select("Company", opts, "company", "Choose a company"));
    var c = null;
    for (var i = 0; i < companies.length; i++) if (companies[i].row_id === state.company) c = companies[i];
    if (!c) return;
    companyBox.appendChild(el("p", null, "Status: " + c.status.replace(/_/g, " ") + ". " + c.status_reason));
    companyBox.appendChild(el("p", "muted", "Retrieved " + show(c.retrieved) + " of " + show(c.total) +
      " technologies. List complete: " + (c.complete ? "yes" : "no") + "."));
    var list = c.technologies || [];
    if (!list.length) {
      companyBox.appendChild(el("p", "muted", "No technologies were counted for this company."));
      return;
    }
    var wrap = el("div", "scroll");
    var tbl = el("table");
    var head = el("tr");
    ["Technology", "Vendor", "Category", "Confidence", "Recency", "Last observed", "Nature"].forEach(function (h) {
      head.appendChild(el("th", null, h));
    });
    var thead = el("thead");
    thead.appendChild(head);
    tbl.appendChild(thead);
    var tbody = el("tbody");
    list.forEach(function (t) {
      var tr = el("tr");
      [t.product || t.key, t.vendor, t.category, t.confidence, t.recency, t.last_observed, t.nature].forEach(function (v) {
        tr.appendChild(el("td", null, show(v)));
      });
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    companyBox.appendChild(wrap);
  }

  function draw() {
    drawTable();
    drawPairs();
    drawCompany();
  }
  draw();
})();
