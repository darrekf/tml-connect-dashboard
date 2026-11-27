/* TML Connect Archive dashboard.
   Reads the JSON written by scripts/build_dashboard_data.py and the county map
   in vendor/. Every view (tiles, map, lists, charts, table) reflects the same
   filters. The map and the top-places list ignore the place selection itself,
   so the whole state stays visible while the selected places are highlighted. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const fmt = d3.format(",");
  const fmt1 = d3.format(",.1f");
  const MONTH = d3.timeFormat("%b %Y");
  const DAY = d3.timeFormat("%b %-d, %Y");
  const parseDay = d3.timeParse("%Y-%m-%d");
  const PAGE = 50;
  const MIN_POP_PER_CAPITA = 1000; // towns smaller than this swing too widely per resident

  // Rough keyword presets on headlines, not a trained classifier.
  const TOPICS = [
    ["", "All topics", null],
    ["leadership", "Leadership changes", /\b(city manager|town manager|city administrator|police chief|fire chief|city secretary|city attorney|finance director|public works director|interim|resign\w*|retir\w*|appoint\w*|hire[sd]?|fired|terminat\w*|steps? down|stepping down|finalists?|sworn in|new (?:chief|manager|administrator))\b/i],
    ["budget", "Budget and taxes", /\b(budget|tax rate|property tax\w*|taxes|bonds?|certificates of obligation|audit|sales tax|fiscal|revenue|homestead)\b/i],
    ["elections", "Elections", /\b(elections?|ballot|runoff|candidates?|voters?|early voting|canvass|recall|filing period)\b/i],
    ["water", "Water and utilities", /\b(water|wastewater|sewer|utilit(?:y|ies)|drainage|stormwater|boil|electric\w*|power grid|landfill|trash|solid waste)\b/i],
    ["safety", "Public safety", /\b(police|fire\b|firefighters?|EMS|crime|officers?|dispatch|emergency|marshal)\b/i],
    ["development", "Development and housing", /\b(zoning|rezon\w*|development|housing|apartments?|subdivision|annex\w*|comprehensive plan|permits?|short[- ]term rentals?|homeless\w*)\b/i],
    ["streets", "Streets and transportation", /\b(streets?|roads?|traffic|transit|bridges?|sidewalks?|TxDOT|highway|parking|airport)\b/i],
    ["parks", "Parks and libraries", /\b(parks?|library|libraries|trails?|pools?|recreation|splash pad)\b/i],
    ["econdev", "Economic development", /\b(economic development|EDC|incentives?|chapter 380|abatement|data centers?|tourism|hotel)\b/i],
    ["state", "State government and TML", /\b(legislat\w*|lawmakers|Legislature|bills?|Abbott|Paxton|TML|Texas Municipal League|special session|attorney general)\b/i],
  ];

  const state = {
    q: [], range: "all", from: "", to: "", topic: "", texasOnly: false, hideNational: true,
    cities: new Set(), counties: new Set(), layer: "cities", metric: "count", page: 0,
  };

  let S = [], outlets = [], cities = [], issues = [], meta = {}, dataVersion = "";
  let searchText = [], summaries = null, summaryLower = null;
  let countyFeatures = [], countyIndex = new Map(), stateFeature = null;
  let projection, mapSvg, mapG, countiesG, dotsG, zoomK = 1, zoom;
  const tooltip = $("tooltip");

  // ---------------------------------------------------------------- helpers

  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many || one + "s"}`;

  function showTip(evt, value, lines) {
    tooltip.replaceChildren(el("div", "tv", value), ...lines.map((l) => el("div", "tl", l)));
    tooltip.hidden = false;
    const pad = 14, w = tooltip.offsetWidth, h = tooltip.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + w > window.innerWidth - 8) x = evt.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = evt.clientY - h - pad;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }
  const hideTip = () => { tooltip.hidden = true; };

  function topRounded(x, y, w, h, r) {
    // A column with a rounded data end and a square baseline.
    if (h <= 0) return "";
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  // ---------------------------------------------------------------- loading

  async function load() {
    document.body.classList.add("loading");
    const get = (p) => fetch(p).then((r) => {
      if (!r.ok) throw new Error(`${p}: ${r.status}`);
      return r.json();
    });
    // meta.json is read fresh; its build time then stamps every data request, so a
    // cached copy of one file can never be paired with a newer copy of another
    // (summaries are matched to stories by position).
    const me = await fetch("data/meta.json", { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error(`data/meta.json: ${r.status}`);
      return r.json();
    });
    dataVersion = encodeURIComponent(me.built_at);
    const [st, ci, is, topo] = await Promise.all([
      get(`data/stories.json?v=${dataVersion}`), get(`data/cities.json?v=${dataVersion}`),
      get(`data/issues.json?v=${dataVersion}`), get("vendor/counties-10m.json"),
    ]);
    outlets = st.outlets; S = st.stories; cities = ci; issues = is; meta = me;
    searchText = S.map((s) => `${s[1]} ${outlets[s[2]]}`.toLowerCase());

    const all = topojson.feature(topo, topo.objects.counties).features;
    countyFeatures = all.filter((f) => String(f.id).startsWith("48"));
    countyFeatures.forEach((f, i) => countyIndex.set(f.properties.name, i));
    stateFeature = topojson.feature(topo, topo.objects.states).features.find((f) => String(f.id) === "48");

    setupControls();
    setupMap();
    render();
    document.body.classList.remove("loading");

    // Summaries are large; load them after the first render so search can include them.
    get(`data/summaries.json?v=${dataVersion}`).then((arr) => {
      summaries = arr;
      summaryLower = arr.map((s) => (s || "").toLowerCase());
      $("f-search").placeholder = "Headline, outlet or summary";
      if (state.q.length) render(); else renderResults(lastFiltered);
    }).catch(() => { $("f-search").placeholder = "Headline or outlet"; });
  }

  // ---------------------------------------------------------------- controls

  function setupControls() {
    const last = meta.last_issue, lastYear = +last.slice(0, 4), firstYear = +meta.first_issue.slice(0, 4);
    $("subtitle").textContent =
      `${fmt(meta.stories)} stories from ${fmt(meta.issues)} issues of TML Connect News, ` +
      `${DAY(parseDay(meta.first_issue))} to ${DAY(parseDay(last))}`;

    const range = $("f-range");
    const opts = [["all", "All dates"], ["30", "Last 30 days"], ["90", "Last 90 days"], ["365", "Last 12 months"]];
    for (let y = lastYear; y >= firstYear; y--) opts.push([String(y), String(y)]);
    opts.push(["custom", "Custom range…"]);
    opts.forEach(([v, t]) => range.append(new Option(t, v)));
    range.addEventListener("change", () => {
      state.range = range.value;
      document.querySelectorAll(".custom-range").forEach((n) => { n.hidden = state.range !== "custom"; });
      if (state.range === "custom" && !$("f-from").value) {
        $("f-from").value = meta.first_issue; $("f-to").value = last;
      }
      update();
    });
    ["f-from", "f-to"].forEach((id) => $(id).addEventListener("change", update));

    const topic = $("f-topic");
    TOPICS.forEach(([v, t]) => topic.append(new Option(t, v)));
    topic.addEventListener("change", () => { state.topic = topic.value; update(); });

    let timer;
    $("f-search").addEventListener("input", (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        state.q = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
        update();
      }, 180);
    });
    $("f-texas").addEventListener("change", (e) => { state.texasOnly = e.target.checked; update(); });
    $("f-national").checked = state.hideNational;
    $("f-national").addEventListener("change", (e) => { state.hideNational = e.target.checked; update(); });

    document.querySelectorAll("[data-layer]").forEach((b) => b.addEventListener("click", () => {
      state.layer = b.dataset.layer;
      document.querySelectorAll("[data-layer]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      render();
    }));
    document.querySelectorAll("[data-metric]").forEach((b) => b.addEventListener("click", () => {
      state.metric = b.dataset.metric;
      document.querySelectorAll("[data-metric]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      render();
    }));
    $("prev").addEventListener("click", () => { state.page--; renderResults(lastFiltered); });
    $("next").addEventListener("click", () => { state.page++; renderResults(lastFiltered); });
    $("reset-zoom").addEventListener("click", () => mapSvg.transition().duration(300).call(zoom.transform, d3.zoomIdentity));

    try {
      const saved = localStorage.getItem("tml-theme");
      if (saved) document.documentElement.dataset.theme = saved;
    } catch (e) { /* storage may be blocked */ }
    $("theme-toggle").addEventListener("click", () => {
      const dark = document.documentElement.dataset.theme
        ? document.documentElement.dataset.theme === "dark"
        : matchMedia("(prefers-color-scheme: dark)").matches;
      const next = dark ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("tml-theme", next); } catch (e) { /* ignore */ }
      render();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

    $("foot").replaceChildren(
      el("p", "", "Sources: TML Connect News emails (Gmail export, 2016 to 2026) and the tml.org Connect News day pages. " +
        "City locations and populations: U.S. Census Bureau 2025 Gazetteer and population estimates (Vintage 2020 for 2016–2019, Vintage 2025 for 2020–2025)."),
      el("p", "", "Coverage is incomplete. The archive is built from one subscriber's copies of the Connect News email and from the tml.org day pages, " +
        "so issues that never arrived or were not kept are missing, especially from 2023 through 2025 (see the issues chart above). " +
        "A few issues arrived blank or in a form that could not be read, and a story can occasionally be missed within an issue. " +
        "An absence of stories about a city does not mean nothing happened there."),
      el("p", "", "National and out-of-state stories are wire or other-state copy with no Texas place named (\"(AP)\", \"(CNN)\", an out-of-state dateline, another state). " +
        "Stories that name no place at all are kept, since most are local. " +
        "Cities are found by name in each headline and summary, so a story can name several cities and a few matches may be wrong. " +
        "Topic presets are keyword matches on headlines. Summaries are short excerpts written by each news outlet, as they appeared in TML Connect News, " +
        "shortened to about 200 characters; follow a headline's link to read the full story at its source."),
      (() => {
        const p = el("p", "", "Publishers and readers can ask for a correction or removal by ");
        const a = el("a", "", "opening an issue on GitHub");
        a.href = "https://github.com/darrekf/tml-connect-dashboard/issues";
        a.target = "_blank"; a.rel = "noopener";
        p.append(a, document.createTextNode("."));
        return p;
      })(),
      el("p", "", `Data built ${meta.built_at}.`),
    );
  }

  function update() { state.page = 0; render(); }

  function dateBounds() {
    const r = state.range, last = parseDay(meta.last_issue);
    if (r === "all") return ["", ""];
    if (r === "custom") return [$("f-from").value || "", $("f-to").value || ""];
    if (/^\d{4}$/.test(r)) return [`${r}-01-01`, `${r}-12-31`];
    const from = d3.timeDay.offset(last, -(+r - 1));
    return [d3.timeFormat("%Y-%m-%d")(from), meta.last_issue];
  }

  // ---------------------------------------------------------------- filtering

  let lastFiltered = [];
  let hiddenNational = 0; // national stories in the date range left out by the toggle

  function baseIndices() {
    const [from, to] = dateBounds();
    const topic = TOPICS.find((t) => t[0] === state.topic)[2];
    const q = state.q, out = [];
    hiddenNational = 0;
    for (let i = 0; i < S.length; i++) {
      const s = S[i];
      if (from && s[0] < from) continue;
      if (to && s[0] > to) continue;
      if (state.hideNational && s[8] === 1) { hiddenNational++; continue; }
      if (state.texasOnly && !s[5].length) continue;
      if (topic && !topic.test(s[1])) continue;
      if (q.length) {
        const t = searchText[i], u = summaryLower ? summaryLower[i] : "";
        if (!q.every((w) => t.includes(w) || u.includes(w))) continue;
      }
      out.push(i);
    }
    return out;
  }

  const hasPlaces = () => state.cities.size + state.counties.size > 0;
  function inPlaces(s) {
    for (const c of s[5]) {
      if (state.cities.has(c) || state.counties.has(cities[c].county)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- render

  function render() {
    const base = baseIndices();
    const filtered = hasPlaces() ? base.filter((i) => inPlaces(S[i])) : base;
    lastFiltered = filtered;

    // Counts for the map and lists, from the base set (place filter not applied).
    const cityCounts = new Float64Array(cities.length);
    const countyCounts = new Map();
    for (const i of base) {
      const seen = new Set();
      for (const c of S[i][5]) {
        cityCounts[c]++;
        const k = cities[c].county;
        if (k && !seen.has(k)) { seen.add(k); countyCounts.set(k, (countyCounts.get(k) || 0) + 1); }
      }
    }

    renderTiles(filtered);
    renderChips();
    renderMap(cityCounts, countyCounts);
    renderSide(cityCounts, countyCounts, filtered);
    renderTrend(filtered);
    renderResults(filtered);
  }

  function renderTiles(filtered) {
    const [from, to] = dateBounds();
    const inRange = issues.filter(([d]) => (!from || d >= from) && (!to || d <= to)).length;
    const named = new Set(), outs = new Set();
    for (const i of filtered) { S[i][5].forEach((c) => named.add(c)); outs.add(S[i][2]); }
    $("t-stories").textContent = fmt(filtered.length);
    const note = filtered.length === S.length ? "the whole archive" : `of ${fmt(S.length)} in the archive`;
    $("t-stories-note").textContent = hiddenNational
      ? `${note}; ${fmt(hiddenNational)} national or out-of-state ${hiddenNational === 1 ? "story" : "stories"} hidden`
      : note;
    $("t-issues").textContent = fmt(inRange);
    $("t-cities").textContent = fmt(named.size);
    $("t-outlets").textContent = fmt(outs.size);
  }

  function renderChips() {
    const box = $("places");
    const chips = [];
    const add = (label, remove) => {
      const c = el("span", "chip", label);
      const b = el("button", "", "×");
      b.type = "button";
      b.setAttribute("aria-label", `Remove ${label}`);
      b.addEventListener("click", () => { remove(); update(); });
      c.append(b);
      chips.push(c);
    };
    state.cities.forEach((c) => add(cities[c].name, () => state.cities.delete(c)));
    state.counties.forEach((k) => add(`${k} County`, () => state.counties.delete(k)));
    if (chips.length > 1) {
      const b = el("button", "ghost small", "Clear places");
      b.type = "button";
      b.addEventListener("click", () => { state.cities.clear(); state.counties.clear(); update(); });
      chips.push(b);
    }
    box.replaceChildren(...chips);
  }

  // ---------------------------------------------------------------- map

  const W = 640, H = 600;

  function setupMap() {
    mapSvg = d3.select("#map").attr("viewBox", `0 0 ${W} ${H}`);
    projection = d3.geoConicEqualArea().parallels([27.5, 35]).rotate([100, 0])
      .fitExtent([[10, 10], [W - 10, H - 10]], stateFeature);
    const path = d3.geoPath(projection);
    cities.forEach((c) => { [c.x, c.y] = projection([c.lon, c.lat]) || [-99, -99]; });

    mapG = mapSvg.append("g");
    countiesG = mapG.append("g");
    countiesG.selectAll("path").data(countyFeatures).join("path")
      .attr("class", "county").attr("d", path)
      .on("pointermove", (e, f) => countyTip(e, f))
      .on("pointerleave", hideTip)
      .on("click", (e, f) => toggle(state.counties, f.properties.name));
    mapG.append("path").datum(stateFeature).attr("class", "state").attr("d", path);
    dotsG = mapG.append("g");

    zoom = d3.zoom().scaleExtent([1, 14]).translateExtent([[0, 0], [W, H]])
      .on("zoom", (e) => {
        zoomK = e.transform.k;
        mapG.attr("transform", e.transform);
        countiesG.selectAll("path").attr("stroke-width", 0.6 / zoomK);
        mapG.select(".state").attr("stroke-width", 1 / zoomK);
        dotsG.selectAll("circle").attr("r", (d) => d.r / zoomK).attr("stroke-width", (d) => d.sw / zoomK);
      });
    mapSvg.call(zoom);
  }

  function toggle(set, key) {
    if (set.has(key)) set.delete(key); else set.add(key);
    hideTip();
    update();
  }

  let mapValues = { city: null, county: null, countyPop: null };

  function renderMap(cityCounts, countyCounts) {
    const perCap = state.metric === "per10k";
    const countyPop = new Map();
    cities.forEach((c) => { if (c.county) countyPop.set(c.county, (countyPop.get(c.county) || 0) + c.pop); });
    const cityVal = (i) => perCap ? (cities[i].pop >= MIN_POP_PER_CAPITA ? cityCounts[i] / cities[i].pop * 1e4 : null) : cityCounts[i];
    const countyVal = (k) => {
      const n = countyCounts.get(k) || 0, p = countyPop.get(k) || 0;
      return perCap ? (p >= MIN_POP_PER_CAPITA ? n / p * 1e4 : null) : n;
    };
    mapValues = { cityCounts, countyCounts, countyPop, cityVal, countyVal };

    const ramp = d3.interpolateRgb(css("--seq-0"), css("--seq-1"));
    const empty = css("--county-empty");
    let max;

    if (state.layer === "counties") {
      const vals = countyFeatures.map((f) => countyVal(f.properties.name)).filter((v) => v);
      max = d3.max(vals) || 1;
      const color = d3.scaleSequentialSqrt(ramp).domain([0, max]);
      countiesG.selectAll("path")
        .attr("fill", (f) => { const v = countyVal(f.properties.name); return v ? color(v) : empty; })
        .classed("selected", (f) => state.counties.has(f.properties.name))
        .attr("stroke-width", (f) => (state.counties.has(f.properties.name) ? 2 : 0.6) / zoomK);
      dotsG.selectAll("circle").remove();
    } else {
      countiesG.selectAll("path").attr("fill", empty)
        .classed("selected", (f) => state.counties.has(f.properties.name))
        .attr("stroke-width", (f) => (state.counties.has(f.properties.name) ? 2 : 0.6) / zoomK);
      const maxCount = d3.max(cityCounts) || 1;
      const size = d3.scaleSqrt().domain([0, maxCount]).range([0, 24]);
      const data = [];
      cities.forEach((c, i) => {
        if (!cityCounts[i]) return;
        const v = cityVal(i);
        if (v === null) return;
        data.push({ i, v, r: Math.max(2.5, size(cityCounts[i])), sw: state.cities.has(i) ? 2.5 : 1 });
      });
      max = d3.max(data, (d) => d.v) || 1;
      const color = d3.scaleSequentialSqrt(ramp).domain([0, max]);
      data.sort((a, b) => b.r - a.r); // small circles on top
      dotsG.selectAll("circle").data(data, (d) => d.i).join("circle")
        .attr("class", (d) => `dot${state.cities.has(d.i) ? " selected" : ""}`)
        .attr("cx", (d) => cities[d.i].x).attr("cy", (d) => cities[d.i].y)
        .attr("r", (d) => d.r / zoomK).attr("stroke-width", (d) => d.sw / zoomK)
        .attr("fill", (d) => color(d.v))
        .on("pointermove", (e, d) => cityTip(e, d.i))
        .on("pointerleave", hideTip)
        .on("click", (e, d) => { e.stopPropagation(); toggle(state.cities, d.i); })
        .order();
    }

    // Legend
    const lg = $("map-legend");
    const rampBox = el("span", "ramp");
    rampBox.style.background = `linear-gradient(to right, ${css("--seq-0")}, ${css("--seq-1")})`;
    const what = perCap ? "stories per 10,000 residents" : "stories";
    const parts = [el("span", "", "Fewer"), rampBox, el("span", "", `More (up to ${perCap ? fmt1(max) : fmt(max)} ${what})`)];
    if (state.layer === "cities") parts.push(el("span", "", "· Circle size: number of stories"));
    if (hasPlaces()) { parts.push(el("span", "swatch-sel")); parts.push(el("span", "", "Selected")); }
    lg.replaceChildren(...parts);
    $("map-note").textContent = perCap
      ? `Per-resident rates leave out places under ${fmt(MIN_POP_PER_CAPITA)} people. County rates use the combined population of the county's cities, not the whole county.`
      : "";
  }

  function cityTip(e, i) {
    const c = cities[i], n = mapValues.cityCounts[i];
    const lines = [`${c.name}${c.county ? `, ${c.county} County` : ""}`, `Population ${fmt(c.pop)} (2025)`];
    if (c.pop) lines.push(`${fmt1(n / c.pop * 1e4)} stories per 10,000 residents`);
    showTip(e, plural(n, "story", "stories"), lines);
  }

  function countyTip(e, f) {
    const k = f.properties.name, n = mapValues.countyCounts.get(k) || 0, p = mapValues.countyPop.get(k) || 0;
    const lines = [`${k} County`];
    if (p) lines.push(`Cities' population ${fmt(p)} (2025)`);
    if (p && n) lines.push(`${fmt1(n / p * 1e4)} stories per 10,000 city residents`);
    showTip(e, plural(n, "story", "stories"), lines);
  }

  // ---------------------------------------------------------------- side panel

  function renderSide(cityCounts, countyCounts, filtered) {
    const single = state.cities.size === 1 && state.counties.size === 0;
    $("top-places").hidden = single;
    $("city-detail").hidden = !single;
    if (single) return renderCityDetail([...state.cities][0], filtered);

    const perCap = state.metric === "per10k";
    const byCounty = state.layer === "counties";
    let rows;
    if (byCounty) {
      rows = [...countyCounts.keys()].map((k) => ({ key: k, name: `${k} County`, n: countyCounts.get(k), v: mapValues.countyVal(k) }));
    } else {
      rows = [];
      cityCounts.forEach((n, i) => { if (n) rows.push({ key: i, name: cities[i].name, n, v: mapValues.cityVal(i) }); });
    }
    rows = rows.filter((r) => r.v !== null && r.v > 0).sort((a, b) => b.v - a.v).slice(0, 15);
    const max = d3.max(rows, (r) => r.v) || 1;

    const head = el("h2", "", `Most-covered ${byCounty ? "counties" : "cities"}`);
    const hint = el("p", "hint", perCap ? "Stories per 10,000 residents, for the current filters." : "Stories naming each place, for the current filters.");
    const list = el("ul", "bar-list");
    rows.forEach((r) => {
      const li = el("li");
      li.tabIndex = 0;
      const set = byCounty ? state.counties : state.cities;
      li.setAttribute("aria-selected", String(set.has(r.key)));
      const bar = el("span", "bar");
      bar.style.width = `${Math.max(2, (r.v / max) * 100)}%`;
      const val = el("span", "val", perCap ? fmt1(r.v) : fmt(r.v));
      const track = el("span", "track");
      track.style.width = "100%";
      const inner = el("span");
      inner.style.cssText = "display:flex;align-items:center;gap:6px;width:calc(100% - 3.5rem)";
      inner.append(bar);
      track.append(inner, val);
      li.append(el("span", "name", r.name), track);
      const act = () => toggle(set, r.key);
      li.addEventListener("click", act);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } });
      list.append(li);
    });
    const parts = [head, hint, list];
    if (!rows.length) parts.push(el("p", "hint", "No places match these filters."));
    $("top-places").replaceChildren(...parts);
  }

  function renderCityDetail(i, filtered) {
    const c = cities[i];
    const box = $("city-detail");
    const clear = el("button", "ghost small", "Clear");
    clear.type = "button";
    clear.addEventListener("click", () => { state.cities.clear(); update(); });
    const head = el("div", "detail-head");
    const title = el("div");
    title.append(el("h2", "", c.name), el("p", "hint", `${c.kind[0].toUpperCase()}${c.kind.slice(1)} in ${c.county || "Texas"}${c.county ? " County" : ""}`));
    head.append(title, clear);

    const n = filtered.length;
    const dates = filtered.map((j) => S[j][0]);
    const facts = el("div", "facts");
    const fact = (k, v) => { const d = el("div"); d.append(el("span", "k", k), el("span", "v", v)); facts.append(d); };
    fact("Stories", fmt(n));
    fact("Population, 2025", fmt(c.pop));
    fact("Stories per 10,000 residents", c.pop ? fmt1(n / c.pop * 1e4) : "–");
    fact("Latest story", dates.length ? DAY(parseDay(d3.max(dates))) : "–");

    const years = Object.keys(c.series).sort();
    const chart = el("div", "chart");
    const table = el("table", "mini-table");
    if (years.length) {
      chart.append(populationChart(c, years));
      const thead = el("tr");
      ["Year", "Population", "Change"].forEach((t) => thead.append(el("th", "", t)));
      table.append(thead);
      years.slice().reverse().forEach((y) => {
        const [p, g] = c.series[y];
        const tr = el("tr");
        tr.append(el("td", "", y), el("td", "", fmt(p)), el("td", "", g === null ? "–" : `${g > 0 ? "+" : ""}${g.toFixed(1)}%`));
        table.append(tr);
      });
    }
    const note = el("p", "hint", "Census estimates. The series changes in 2020, when estimates restart from the 2020 Census; each year's change is measured within one series.");
    box.replaceChildren(head, facts, el("h3", "minor", "Population"), chart, table, note);
  }

  function populationChart(c, years) {
    const w = 360, h = 140, m = { l: 48, r: 8, t: 10, b: 20 };
    const pts = years.map((y) => ({ y: +y, p: c.series[y][0] }));
    const x = d3.scaleLinear().domain(d3.extent(pts, (d) => d.y)).range([m.l, w - m.r]);
    const yv = d3.scaleLinear().domain(d3.extent(pts, (d) => d.p)).nice(4).range([h - m.b, m.t]);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("role", "img")
      .attr("aria-label", `Population of ${c.name}, ${years[0]} to ${years[years.length - 1]}`);
    yv.ticks(4).forEach((t) => {
      svg.append("line").attr("class", "gridline").attr("x1", m.l).attr("x2", w - m.r).attr("y1", yv(t)).attr("y2", yv(t));
      svg.append("text").attr("x", m.l - 6).attr("y", yv(t) + 4).attr("text-anchor", "end").text(d3.format(".3~s")(t).replace("k", "K"));
    });
    pts.forEach((d) => {
      if (d.y % 2 === 0 || pts.length < 7) svg.append("text").attr("x", x(d.y)).attr("y", h - 4).attr("text-anchor", "middle").text(d.y);
    });
    const line = d3.line().x((d) => x(d.y)).y((d) => yv(d.p));
    const before = pts.filter((d) => d.y < 2020), after = pts.filter((d) => d.y >= 2020);
    if (before.length && after.length) {
      const bx = (x(2019) + x(2020)) / 2;
      svg.append("line").attr("class", "break").attr("x1", bx).attr("x2", bx).attr("y1", m.t).attr("y2", h - m.b);
    }
    [before, after].forEach((seg) => { if (seg.length > 1) svg.append("path").attr("class", "line").attr("d", line(seg)); });
    pts.forEach((d) => {
      svg.append("circle").attr("class", "dot-mark").attr("cx", x(d.y)).attr("cy", yv(d.p)).attr("r", 4);
      svg.append("circle").attr("cx", x(d.y)).attr("cy", yv(d.p)).attr("r", 12).attr("fill", "transparent")
        .on("pointermove", (e) => {
          const g = c.series[d.y][1];
          showTip(e, fmt(d.p), [`${d.y} population`, g === null ? "" : `${g > 0 ? "+" : ""}${g.toFixed(1)}% from the year before`].filter(Boolean));
        })
        .on("pointerleave", hideTip);
    });
    return svg.node();
  }

  // ---------------------------------------------------------------- trend

  function renderTrend(filtered) {
    const [from, to] = dateBounds();
    const start = d3.timeMonth.floor(parseDay(from || meta.first_issue));
    const end = d3.timeMonth.floor(parseDay(to && to < meta.last_issue ? to : meta.last_issue));
    const months = d3.timeMonth.range(start, d3.timeMonth.offset(end, 1));
    const key = d3.timeFormat("%Y-%m");
    const counts = new Map(months.map((m) => [key(m), 0]));
    for (const i of filtered) { const k = S[i][0].slice(0, 7); if (counts.has(k)) counts.set(k, counts.get(k) + 1); }
    const issueCounts = new Map(months.map((m) => [key(m), 0]));
    for (const [d] of issues) { const k = d.slice(0, 7); if (issueCounts.has(k)) issueCounts.set(k, issueCounts.get(k) + 1); }

    const placeLabel = [...state.cities].map((c) => cities[c].name).concat([...state.counties].map((k) => `${k} County`));
    $("trend-title").textContent = placeLabel.length
      ? `Stories per month naming ${placeLabel.slice(0, 3).join(", ")}${placeLabel.length > 3 ? ` and ${placeLabel.length - 3} more` : ""}`
      : "Stories per month";

    columnChart($("trend"), months, counts, { height: 220, unit: ["story", "stories"], muted: false });
    columnChart($("coverage"), months, issueCounts, { height: 90, unit: ["issue", "issues"], muted: true });

    // Table view by year.
    const byYear = d3.rollup(months, (ms) => ({
      s: d3.sum(ms, (m) => counts.get(key(m))), i: d3.sum(ms, (m) => issueCounts.get(key(m))),
    }), (m) => m.getFullYear());
    const t = el("table");
    const hr = el("tr");
    ["Year", "Stories", "Issues", "Stories per issue"].forEach((h) => hr.append(el("th", "", h)));
    t.append(hr);
    [...byYear].sort((a, b) => b[0] - a[0]).forEach(([y, v]) => {
      const tr = el("tr");
      tr.append(el("td", "", String(y)), el("td", "", fmt(v.s)), el("td", "", fmt(v.i)), el("td", "", v.i ? fmt1(v.s / v.i) : "–"));
      t.append(tr);
    });
    $("trend-table").replaceChildren(t);
  }

  function columnChart(host, months, counts, opt) {
    const w = 1200, h = opt.height, m = { l: 44, r: 8, t: 8, b: 22 };
    const key = d3.timeFormat("%Y-%m");
    const vals = months.map((mo) => counts.get(key(mo)) || 0);
    const max = d3.max(vals) || 1;
    const x = d3.scaleBand().domain(months.map(key)).range([m.l, w - m.r]).paddingInner(0);
    const y = d3.scaleLinear().domain([0, max]).nice(opt.height > 120 ? 4 : 2).range([h - m.b, m.t]);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("role", "img")
      .attr("aria-label", `${opt.unit[1]} per month; the table view below lists yearly totals`);

    y.ticks(opt.height > 120 ? 4 : 2).forEach((t) => {
      svg.append("line").attr("class", t === 0 ? "baseline" : "gridline")
        .attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(t)).attr("y2", y(t));
      svg.append("text").attr("x", m.l - 6).attr("y", y(t) + 4).attr("text-anchor", "end")
        .text(t >= 10000 ? d3.format(".2~s")(t).replace("k", "K") : fmt(t));
    });
    const band = x.bandwidth();
    const bw = Math.max(1, Math.min(24, band - 2));
    const yearStep = months.length > 72 ? 2 : 1;
    months.forEach((mo, idx) => {
      const k = key(mo), v = counts.get(k) || 0, x0 = x(k);
      if (mo.getMonth() === 0 && mo.getFullYear() % yearStep === 0 || (months.length <= 14)) {
        svg.append("text").attr("x", x0 + band / 2).attr("y", h - 6).attr("text-anchor", months.length <= 14 ? "middle" : "start")
          .text(months.length <= 14 ? d3.timeFormat("%b")(mo) : mo.getFullYear());
      }
      const bar = svg.append("path").attr("class", `bar${opt.muted ? " muted" : ""}`)
        .attr("d", topRounded(x0 + (band - bw) / 2, y(v), bw, y(0) - y(v), 4));
      svg.append("rect").attr("class", "hit").attr("x", x0).attr("y", m.t).attr("width", band).attr("height", h - m.b - m.t)
        .on("pointermove", (e) => { bar.classed("hover", true); showTip(e, plural(v, opt.unit[0], opt.unit[1]), [MONTH(mo)]); })
        .on("pointerleave", () => { bar.classed("hover", false); hideTip(); });
    });
    host.replaceChildren(svg.node());
  }

  // ---------------------------------------------------------------- results

  function renderResults(filtered) {
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
    state.page = Math.min(Math.max(0, state.page), pages - 1);
    const startAt = state.page * PAGE;
    const rows = filtered.slice(startAt, startAt + PAGE);
    $("results-note").textContent = filtered.length
      ? `Showing ${fmt(startAt + 1)}–${fmt(startAt + rows.length)} of ${fmt(filtered.length)}, newest first.`
      : "No stories match these filters.";
    $("page-label").textContent = `Page ${fmt(state.page + 1)} of ${fmt(pages)}`;
    $("prev").disabled = state.page === 0;
    $("next").disabled = state.page >= pages - 1;

    const body = $("results");
    body.replaceChildren(...rows.map((i) => {
      const s = S[i];
      const tr = el("tr");
      tr.append(el("td", "date", DAY(parseDay(s[0]))));

      const td = el("td");
      if (s[3]) {
        const a = el("a", "", s[1]);
        a.href = s[3]; a.target = "_blank"; a.rel = "noopener noreferrer";
        td.append(a);
      } else {
        td.append(document.createTextNode(s[1]));
      }
      if (s[4]) td.append(el("span", "tag", "Paywall"));
      const sum = summaries && summaries[i];
      if (sum) {
        const more = el("button", "more", "Summary");
        more.type = "button";
        more.setAttribute("aria-expanded", "false");
        const box = el("div", "summary", sum);
        box.hidden = true;
        more.addEventListener("click", () => {
          box.hidden = !box.hidden;
          more.setAttribute("aria-expanded", String(!box.hidden));
        });
        td.append(more, box);
      }
      tr.append(td);

      const tc = el("td");
      if (s[5].length) {
        const first = s[5][0];
        const link = el("span", "city-link", cities[first].name);
        link.title = `Filter to ${cities[first].name}`;
        link.addEventListener("click", () => toggle(state.cities, first));
        tc.append(link);
        if (s[5].length > 1) {
          tc.append(el("span", "muted", ` +${s[5].length - 1}`));
          tc.title = s[5].map((c) => cities[c].name).join(", ");
        }
      } else {
        tc.append(el("span", "muted", "–"));
      }
      tr.append(tc, el("td", "", outlets[s[2]] || "–"), el("td", "num", fmt(s[6])));
      return tr;
    }));
  }

  load().catch((err) => {
    document.body.classList.remove("loading");
    $("subtitle").textContent = `Could not load the archive data (${err.message}). Run scripts/build_dashboard_data.py, then serve the dashboard folder.`;
  });
})();
