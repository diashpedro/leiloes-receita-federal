(function () {
  "use strict";

  const state = {
    editais: [],
    lotes: [],
    editaisByEdle: new Map(),
    filtered: [],
    sortKey: null,
    sortDir: 1,
    page: 1,
    pageSize: 100,
    itensCache: new Map(),
    expandedKey: null,
    statusFiltro: new Set(),
    tipoFiltro: new Set(),
    recintoFiltro: new Set(),
    categoriaFiltro: new Set(),
  };

  const STATUS_ORDER = ["Agendado", "Recebendo Propostas", "Em Disputa/Lances", "Encerrado", "Desconhecido"];
  const SEM_CATEGORIA = "(sem categoria)";
  const CATEGORIAS_PADRAO = ["Interesse alto", "Avaliar depois", "Talvez", "Descartado"];
  const LS_KEY = "leilaoReceita.categorias.v1";

  // listas completas de valores possiveis (fixas apos o carregamento), usadas para
  // recalcular quais opcoes ainda tem correspondencia conforme os outros filtros mudam
  let ALL_TIPOS = [];
  let ALL_RECINTOS = [];
  let ALL_CIDADES = [];

  // ---- persistencia local (localStorage) das categorias que o usuario define por lote ----
  // fica no navegador dele, nao no GitHub - cada pessoa que abre o dashboard tem a sua propria lista.
  const MyCategories = (function () {
    let data = { porLote: {}, extras: [] };
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) data = JSON.parse(raw);
    } catch (e) { /* localStorage indisponivel ou corrompido: segue com estado vazio */ }
    if (!data.porLote) data.porLote = {};
    if (!data.extras) data.extras = [];

    function persist() {
      try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (e) { /* quota cheia ou bloqueado */ }
    }
    return {
      get(key) { return data.porLote[key] || ""; },
      set(key, categoria) {
        if (categoria) data.porLote[key] = categoria; else delete data.porLote[key];
        persist();
      },
      listaCategorias() {
        return [...CATEGORIAS_PADRAO, ...data.extras.filter(c => !CATEGORIAS_PADRAO.includes(c))];
      },
      addExtra(categoria) {
        if (categoria && !this.listaCategorias().includes(categoria)) {
          data.extras.push(categoria);
          persist();
        }
      },
    };
  })();

  function fmtMoney(v) {
    if (v === null || v === undefined || isNaN(v)) return "-";
    return Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  }
  function fmtNum(v) {
    if (v === null || v === undefined || isNaN(v)) return "-";
    return Number(v).toLocaleString("pt-BR");
  }
  function sanitizeEdle(edle) { return edle.replace(/\//g, "-"); }
  function loteKey(l) { return `${l.edle}__${l.loteNrAtribuido}`; }
  function statusClass(s) { return "status-" + String(s).replace(/[^A-Za-z]+/g, "-"); }
  function fmtDate(s) {
    if (!s) return "-";
    const [d, t] = String(s).split(" ");
    const parts = (d || "").split("-");
    if (parts.length !== 3) return s;
    const [y, m, day] = parts;
    return `${day}/${m}/${y}${t ? " " + t : ""}`;
  }
  function fmtIndice(v) { return (v === null || v === undefined || isNaN(v)) ? "-" : v.toFixed(2) + "x"; }
  function cleanDescricao(s) { return (s || "").replace(/\/+\s*$/, "").trim(); }
  function mlSearchUrl(q) {
    const slug = q.toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `https://lista.mercadolivre.com.br/${encodeURIComponent(slug)}`;
  }
  function googleShoppingUrl(q) {
    return `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}`;
  }

  async function loadMeta() {
    try {
      const meta = await fetch("data/meta.json").then(r => r.json());
      if (meta.geradoEm) {
        const dt = new Date(meta.geradoEm);
        document.getElementById("lastUpdated").textContent =
          "Dados atualizados em " + dt.toLocaleString("pt-BR");
      }
    } catch (e) { /* meta.json opcional */ }
  }

  async function loadData() {
    loadMeta();
    const [editais, lotes] = await Promise.all([
      fetch("data/editais.json").then(r => r.json()),
      fetch("data/lotes.json").then(r => r.json()),
    ]);
    state.editais = editais;
    state.lotes = lotes;
    editais.forEach(e => state.editaisByEdle.set(e.edle, e));

    // junta info do edital em cada lote para filtro/exibicao, sem duplicar o dataset inteiro em memoria (so referencias)
    state.lotes.forEach(l => {
      const ed = state.editaisByEdle.get(l.edle);
      l._edital = ed ? ed.edital : null;
      l._cidade = l.cidade || (ed ? ed.cidade : null);
      l._orgao = ed ? ed.orgao : null;
      l._statusEstimado = ed ? ed.statusEstimado : "Desconhecido";
      l._dataInicioPropostas = ed ? ed.dataInicioPropostas : null;
      l._dataFimPropostas = ed ? ed.dataFimPropostas : null;
      l._dataAberturaLances = ed ? ed.dataAberturaLances : null;
      l._indiceAvalMin = (l.valorMinimo && l.valorAvaliacao) ? (l.valorAvaliacao / l.valorMinimo) : null;
      l._categoria = MyCategories.get(loteKey(l));
    });

    renderStatTiles();
    populateFilterOptions();
    renderStatusChips();
    applyFilters();
  }

  function renderStatTiles() {
    const totalLotes = state.lotes.length;
    const totalItens = state.lotes.reduce((s, l) => s + (l.qtdItens || 0), 0);
    const somaMin = state.lotes.reduce((s, l) => s + (l.valorMinimo || 0), 0);
    const somaAval = state.lotes.reduce((s, l) => s + (l.valorAvaliacao || 0), 0);
    const tiles = [
      ["Editais", fmtNum(state.editais.length)],
      ["Lotes", fmtNum(totalLotes)],
      ["Itens (declarados)", fmtNum(totalItens)],
      ["Soma Valor Minimo", fmtMoney(somaMin)],
      ["Soma Valor Avaliacao", fmtMoney(somaAval)],
    ];
    document.getElementById("statRow").innerHTML = tiles.map(([label, value]) =>
      `<div class="stat-tile"><div class="label">${label}</div><div class="value">${value}</div></div>`
    ).join("");
  }

  function populateFilterOptions() {
    ALL_TIPOS = [...new Set(state.lotes.map(l => l.tipo).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    ALL_RECINTOS = [...new Set(state.lotes.flatMap(l => l.recintos || []))].sort((a, b) => a.localeCompare(b));
    ALL_CIDADES = [...new Set(state.lotes.map(l => l._cidade).filter(Boolean))].sort((a, b) => a.localeCompare(b));

    // registra os widgets (uma unica vez - liga os listeners); as contagens reais de
    // cada opcao sao preenchidas logo depois, em applyFilters() -> refreshFilterWidgets(),
    // e recalculadas a cada mudanca de filtro (efeito cascata / cross-filter estilo BI).
    setupMultiSelect("msTipo", new Map(), state.tipoFiltro, "tipo(s)");
    setupMultiSelect("msRecinto", new Map(), state.recintoFiltro, "recinto(s)");
    setupMultiSelect("msCategoria", new Map(), state.categoriaFiltro, "categoria(s)");
  }

  // ---- predicado de filtro parametrizado: "skip" deixa de fora UMA dimensao, pra podermos
  // calcular "quantos lotes bateriam se eu ignorasse so este filtro" (cross-filtering) ----
  function currentFilterValues() {
    return {
      busca: document.getElementById("fBusca").value.trim().toLowerCase(),
      cidade: document.getElementById("fCidade").value,
      valorMin: parseFloat(document.getElementById("fValorMin").value),
      valorMax: parseFloat(document.getElementById("fValorMax").value),
      permitePF: document.getElementById("fPermitePF").checked,
    };
  }

  function matchesLote(l, fv, skip) {
    if (skip !== "busca" && fv.busca) {
      const hay = `${l._edital || ""} ${l.tipo || ""} ${l._cidade || ""} ${l._orgao || ""}`.toLowerCase();
      if (!hay.includes(fv.busca)) return false;
    }
    if (skip !== "cidade" && fv.cidade && l._cidade !== fv.cidade) return false;
    if (skip !== "tipo" && state.tipoFiltro.size > 0 && !state.tipoFiltro.has(l.tipo)) return false;
    if (skip !== "recinto" && state.recintoFiltro.size > 0 && !(l.recintos || []).some(r => state.recintoFiltro.has(r))) return false;
    if (skip !== "status" && state.statusFiltro.size > 0 && !state.statusFiltro.has(l._statusEstimado)) return false;
    if (skip !== "categoria" && state.categoriaFiltro.size > 0 && !state.categoriaFiltro.has(l._categoria || SEM_CATEGORIA)) return false;
    if (skip !== "valor" && !isNaN(fv.valorMin) && (l.valorMinimo || 0) < fv.valorMin) return false;
    if (skip !== "valor" && !isNaN(fv.valorMax) && (l.valorMinimo || 0) > fv.valorMax) return false;
    if (skip !== "pf" && fv.permitePF && !l.permitePF) return false;
    return true;
  }

  function refreshFilterWidgets(fv) {
    const tipoCounts = new Map(ALL_TIPOS.map(t => [t, 0]));
    const recintoCounts = new Map(ALL_RECINTOS.map(r => [r, 0]));
    const cidadeCounts = new Map(ALL_CIDADES.map(c => [c, 0]));
    const categoriaCounts = new Map([SEM_CATEGORIA, ...MyCategories.listaCategorias()].map(c => [c, 0]));

    state.lotes.forEach(l => {
      if (l.tipo && matchesLote(l, fv, "tipo")) tipoCounts.set(l.tipo, tipoCounts.get(l.tipo) + 1);
      if (matchesLote(l, fv, "recinto")) {
        (l.recintos || []).forEach(r => recintoCounts.set(r, (recintoCounts.get(r) || 0) + 1));
      }
      if (l._cidade && matchesLote(l, fv, "cidade")) cidadeCounts.set(l._cidade, cidadeCounts.get(l._cidade) + 1);
      if (matchesLote(l, fv, "categoria")) {
        const c = l._categoria || SEM_CATEGORIA;
        categoriaCounts.set(c, (categoriaCounts.get(c) || 0) + 1);
      }
    });

    document.getElementById("msTipo")._msUpdateCounts(tipoCounts);
    document.getElementById("msRecinto")._msUpdateCounts(recintoCounts);
    document.getElementById("msCategoria")._msUpdateCounts(categoriaCounts);
    updateCidadeSelect(cidadeCounts);
  }

  function updateCidadeSelect(cidadeCounts) {
    const sel = document.getElementById("fCidade");
    const current = sel.value;
    const entries = [...cidadeCounts.entries()]
      .filter(([c, cnt]) => cnt > 0 || c === current)
      .sort((a, b) => a[0].localeCompare(b[0]));
    sel.innerHTML = `<option value="">Todas</option>` + entries.map(([c, cnt]) =>
      `<option value="${c.replace(/"/g, "&quot;")}" ${c === current ? "selected" : ""}>${c} (${fmtNum(cnt)})</option>`
    ).join("");
  }

  function setupMultiSelect(containerId, countsMap, selectedSet, unitLabel) {
    const root = document.getElementById(containerId);
    const toggle = root.querySelector(".ms-toggle");
    const panel = root.querySelector(".ms-panel");
    const search = root.querySelector(".ms-search");
    const optionsEl = root.querySelector(".ms-options");
    let entries = [...countsMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    function renderOptions(filterText) {
      const ft = (filterText || "").toLowerCase();
      // some da lista quem nao tem mais correspondencia (count 0) sob os filtros atuais,
      // exceto o que ja estiver marcado - assim a selecao do usuario nunca some sem aviso.
      const visible = entries.filter(([label, count]) =>
        (count > 0 || selectedSet.has(label)) && label.toLowerCase().includes(ft));
      if (visible.length === 0) {
        optionsEl.innerHTML = `<div class="ms-empty">Nenhum resultado.</div>`;
        return;
      }
      optionsEl.innerHTML = visible.map(([label, count]) => `
        <label class="ms-option">
          <input type="checkbox" value="${label.replace(/"/g, "&quot;")}" ${selectedSet.has(label) ? "checked" : ""}>
          <span>${label}</span>
          <span class="cnt">${fmtNum(count)}</span>
        </label>`).join("");
      optionsEl.querySelectorAll("input[type=checkbox]").forEach(cb => {
        cb.addEventListener("change", () => {
          if (cb.checked) selectedSet.add(cb.value); else selectedSet.delete(cb.value);
          updateToggleLabel();
          state.page = 1;
          applyFilters();
        });
      });
    }

    function updateToggleLabel() {
      if (selectedSet.size === 0) {
        toggle.textContent = "Todos";
        root.classList.remove("has-selection");
      } else {
        toggle.textContent = `${selectedSet.size} ${unitLabel} selecionado(s)`;
        root.classList.add("has-selection");
      }
    }

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = panel.classList.contains("hidden");
      document.querySelectorAll(".multiselect .ms-panel").forEach(p => p.classList.add("hidden"));
      if (willOpen) { panel.classList.remove("hidden"); search.value = ""; renderOptions(""); search.focus(); }
    });
    panel.addEventListener("click", (e) => e.stopPropagation());
    search.addEventListener("input", () => renderOptions(search.value));
    root.querySelector('[data-act="all"]').addEventListener("click", (e) => {
      e.preventDefault();
      entries.forEach(([label]) => selectedSet.add(label));
      renderOptions(search.value);
      updateToggleLabel();
      state.page = 1;
      applyFilters();
    });
    root.querySelector('[data-act="none"]').addEventListener("click", (e) => {
      e.preventDefault();
      selectedSet.clear();
      renderOptions(search.value);
      updateToggleLabel();
      state.page = 1;
      applyFilters();
    });

    renderOptions("");
    updateToggleLabel();
    root._msRefresh = () => { renderOptions(search.value); updateToggleLabel(); };
    root._msUpdateCounts = (newCountsMap) => {
      entries = [...newCountsMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      renderOptions(search.value);
      updateToggleLabel();
    };
  }

  document.addEventListener("click", () => {
    document.querySelectorAll(".multiselect .ms-panel").forEach(p => p.classList.add("hidden"));
  });

  function renderStatusChips() {
    const el = document.getElementById("statusChips");
    el.innerHTML = STATUS_ORDER.map(s =>
      `<span class="chip" data-status="${s}">${s}</span>`
    ).join("");
    el.querySelectorAll(".chip").forEach(chip => {
      chip.addEventListener("click", () => {
        const s = chip.dataset.status;
        if (state.statusFiltro.has(s)) { state.statusFiltro.delete(s); chip.classList.remove("active"); }
        else { state.statusFiltro.add(s); chip.classList.add("active"); }
        state.page = 1;
        applyFilters();
      });
    });
  }

  function applyFilters() {
    const fv = currentFilterValues();
    state.filtered = state.lotes.filter(l => matchesLote(l, fv, null));

    if (state.sortKey) {
      const k = state.sortKey, dir = state.sortDir;
      state.filtered.sort((a, b) => {
        let av = a[k], bv = b[k];
        if (k === "cidade") { av = a._cidade; bv = b._cidade; }
        if (k === "statusEstimado") { av = a._statusEstimado; bv = b._statusEstimado; }
        if (k === "recintos") { av = (a.recintos || []).join(", "); bv = (b.recintos || []).join(", "); }
        if (k === "indiceAvalMin") { av = a._indiceAvalMin; bv = b._indiceAvalMin; }
        if (k === "dataInicioPropostas") { av = a._dataInicioPropostas; bv = b._dataInicioPropostas; }
        if (k === "dataFimPropostas") { av = a._dataFimPropostas; bv = b._dataFimPropostas; }
        if (k === "dataAberturaLances") { av = a._dataAberturaLances; bv = b._dataAberturaLances; }
        if (k === "categoria") { av = a._categoria || ""; bv = b._categoria || ""; }
        if (av === null || av === undefined) av = "";
        if (bv === null || bv === undefined) bv = "";
        if (typeof av === "string") return av.localeCompare(bv) * dir;
        return (av - bv) * dir;
      });
    }

    state.page = 1;
    refreshFilterWidgets(fv);
    renderCharts();
    renderTable();
  }

  function renderCharts() {
    const tipoCounts = new Map();
    const statusCounts = new Map();
    const seenEdle = new Set();
    state.filtered.forEach(l => {
      tipoCounts.set(l.tipo || "(sem tipo)", (tipoCounts.get(l.tipo || "(sem tipo)") || 0) + 1);
      if (!seenEdle.has(l.edle)) {
        seenEdle.add(l.edle);
        statusCounts.set(l._statusEstimado, (statusCounts.get(l._statusEstimado) || 0) + 1);
      }
    });

    const topTipos = [...tipoCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const maxTipo = topTipos.length ? topTipos[0][1] : 1;
    document.getElementById("chartTipos").innerHTML = topTipos.map(([label, val]) => `
      <div class="row" title="${label}: ${fmtNum(val)} lote(s)">
        <span class="cat-label">${label}</span>
        <span class="track"><span class="fill" style="width:${(val / maxTipo * 100).toFixed(1)}%"></span></span>
        <span class="val">${fmtNum(val)}</span>
      </div>`).join("") || "<p style='color:var(--text-muted); font-size:12px;'>Sem dados para a selecao atual.</p>";

    const statusEntries = STATUS_ORDER.map(s => [s, statusCounts.get(s) || 0]).filter(([, v]) => v > 0);
    const maxStatus = statusEntries.length ? Math.max(...statusEntries.map(e => e[1])) : 1;
    document.getElementById("chartStatus").innerHTML = statusEntries.map(([label, val]) => `
      <div class="row" title="${label}: ${fmtNum(val)} edital(is)">
        <span class="cat-label">${label}</span>
        <span class="track"><span class="fill" style="width:${(val / maxStatus * 100).toFixed(1)}%"></span></span>
        <span class="val">${fmtNum(val)}</span>
      </div>`).join("") || "<p style='color:var(--text-muted); font-size:12px;'>Sem dados para a selecao atual.</p>";
  }

  function renderTable() {
    const total = state.filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    const start = (state.page - 1) * state.pageSize;
    const pageRows = state.filtered.slice(start, start + state.pageSize);

    document.getElementById("resultCount").textContent = `${fmtNum(total)} lote(s) encontrados de ${fmtNum(state.lotes.length)}`;
    document.getElementById("pageInfo").textContent = `Pagina ${state.page} de ${totalPages} (${fmtNum(total)} resultado(s))`;

    const tbody = document.getElementById("tblBody");
    tbody.innerHTML = "";
    const frag = document.createDocumentFragment();

    pageRows.forEach(l => {
      const key = `${l.edle}__${l.loteNrAtribuido}`;
      const tr = document.createElement("tr");
      tr.className = "lote-row" + (state.expandedKey === key ? " expanded" : "");
      tr.dataset.key = key;
      const catOptions = ["", ...MyCategories.listaCategorias()].map(c =>
        `<option value="${c}" ${l._categoria === c ? "selected" : ""}>${c || "Sem categoria"}</option>`
      ).join("") + `<option value="__new__">+ Nova categoria...</option>`;
      tr.innerHTML = `
        <td>${l._edital || l.edle}</td>
        <td>${l._cidade || "-"}</td>
        <td>${l.tipo || "-"}</td>
        <td>${(l.recintos && l.recintos.length) ? l.recintos.join(", ") : "-"}</td>
        <td>${l.loteNrAtribuido}</td>
        <td>${fmtNum(l.qtdItens)}</td>
        <td>${fmtMoney(l.valorMinimo)}</td>
        <td>${fmtMoney(l.valorAvaliacao)}</td>
        <td>${fmtIndice(l._indiceAvalMin)}</td>
        <td>${l.permitePF ? "Sim" : "Nao"}</td>
        <td><span class="badge ${statusClass(l._statusEstimado)}">${l._statusEstimado}</span></td>
        <td>${fmtDate(l._dataInicioPropostas)}</td>
        <td>${fmtDate(l._dataFimPropostas)}</td>
        <td>${fmtDate(l._dataAberturaLances)}</td>
        <td class="cat-cell"><select class="cat-select">${catOptions}</select></td>
      `;
      tr.addEventListener("click", () => toggleExpand(l, key));
      const catSelect = tr.querySelector(".cat-select");
      catSelect.addEventListener("click", (e) => e.stopPropagation());
      catSelect.addEventListener("change", (e) => {
        e.stopPropagation();
        let val = catSelect.value;
        if (val === "__new__") {
          const nome = (window.prompt("Nome da nova categoria:") || "").trim();
          if (nome) { MyCategories.addExtra(nome); val = nome; }
          else { val = l._categoria || ""; }
        }
        l._categoria = val;
        MyCategories.set(loteKey(l), val);
        applyFilters();
      });
      frag.appendChild(tr);

      if (state.expandedKey === key) {
        const trItens = document.createElement("tr");
        trItens.className = "itens-row";
        const td = document.createElement("td");
        td.colSpan = 15;
        td.className = "itens-wrap";
        td.id = `itens-${key}`;
        td.innerHTML = `<div class="loading">Carregando itens...</div>`;
        trItens.appendChild(td);
        frag.appendChild(trItens);
        loadItensFor(l, key);
      }
    });

    tbody.appendChild(frag);
  }

  function fetchItensEdle(edle) {
    // cacheia a Promise (nao so o resultado) pra cliques repetidos/rapidos no mesmo
    // edital compartilharem uma unica requisicao em vez de disparar varias em paralelo.
    if (state.itensCache.has(edle)) return state.itensCache.get(edle);
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 20000));
    const p = Promise.race([
      fetch(`data/itens/${sanitizeEdle(edle)}.json`).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      timeout,
    ]).catch(err => {
      state.itensCache.delete(edle); // nao guarda falha em cache, permite tentar de novo
      throw err;
    });
    state.itensCache.set(edle, p);
    return p;
  }

  async function loadItensFor(lote, key) {
    const cell = document.getElementById(`itens-${key}`);
    let all;
    try {
      all = await fetchItensEdle(lote.edle);
    } catch (e) {
      if (cell && document.getElementById(`itens-${key}`)) {
        cell.innerHTML = `<div class="loading">Falha ao carregar itens (${e.message}). Clique no lote de novo para tentar outra vez.</div>`;
      }
      return;
    }
    const itens = all.filter(i => i.loteNrAtribuido === lote.loteNrAtribuido);
    if (!document.getElementById(`itens-${key}`)) return; // usuario fechou/trocou de lote enquanto carregava
    if (itens.length === 0) {
      cell.innerHTML = `<div class="loading">Nenhum item detalhado disponivel para este lote.</div>`;
      return;
    }
    cell.innerHTML = `
      <table>
        <thead><tr><th>Recinto</th><th>Qtd</th><th>Un.</th><th>Descricao</th><th>Preco de mercado</th></tr></thead>
        <tbody>
          ${itens.map(i => {
            const desc = cleanDescricao(i.descricao);
            return `<tr>
              <td>${i.recintoArmazenador || "-"}</td>
              <td>${fmtNum(i.quantidade)}</td>
              <td>${i.unMedida || "-"}</td>
              <td>${desc}</td>
              <td class="price-links">
                <a href="${mlSearchUrl(desc)}" target="_blank" rel="noopener">Mercado Livre</a>
                &middot;
                <a href="${googleShoppingUrl(desc)}" target="_blank" rel="noopener">Google Shopping</a>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;
  }

  function toggleExpand(lote, key) {
    state.expandedKey = state.expandedKey === key ? null : key;
    renderTable();
  }

  function exportCsv() {
    const header = ["Edital", "Cidade/Unidade", "Tipo", "Recintos", "Lote", "QtdItens", "ValorMinimo", "ValorAvaliacao",
      "IndiceAvalMinimo", "PermitePF", "StatusEdital", "InicioPropostas", "FimPropostas", "DataLeilao", "MinhaCategoria"];
    const lines = [header.join(";")];
    state.filtered.forEach(l => {
      lines.push([
        l._edital || l.edle, l._cidade || "", l.tipo || "", (l.recintos || []).join(" | "), l.loteNrAtribuido,
        l.qtdItens || 0, l.valorMinimo || 0, l.valorAvaliacao || 0, l._indiceAvalMin ? l._indiceAvalMin.toFixed(2) : "",
        l.permitePF ? "Sim" : "Nao", l._statusEstimado,
        l._dataInicioPropostas || "", l._dataFimPropostas || "", l._dataAberturaLances || "", l._categoria || "",
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(";"));
    });
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "lotes_filtrados.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  function wireControls() {
    ["fBusca", "fCidade", "fValorMin", "fValorMax", "fPermitePF"].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener("input", () => applyFilters());
      el.addEventListener("change", () => applyFilters());
    });

    document.getElementById("btnLimpar").addEventListener("click", () => {
      document.getElementById("fBusca").value = "";
      document.getElementById("fCidade").value = "";
      document.getElementById("fValorMin").value = "";
      document.getElementById("fValorMax").value = "";
      document.getElementById("fPermitePF").checked = false;
      state.statusFiltro.clear();
      document.querySelectorAll("#statusChips .chip").forEach(c => c.classList.remove("active"));
      state.tipoFiltro.clear();
      state.recintoFiltro.clear();
      state.categoriaFiltro.clear();
      applyFilters();
    });

    document.getElementById("btnCsv").addEventListener("click", exportCsv);

    document.querySelectorAll("#tblLotes thead th").forEach(th => {
      th.addEventListener("click", () => {
        const key = th.dataset.key;
        if (state.sortKey === key) { state.sortDir *= -1; }
        else { state.sortKey = key; state.sortDir = 1; }
        document.querySelectorAll("#tblLotes thead th").forEach(t => t.classList.remove("sorted", "sorted-asc"));
        th.classList.add(state.sortDir === 1 ? "sorted-asc" : "sorted");
        applyFilters();
      });
    });

    document.getElementById("btnPrev").addEventListener("click", () => {
      if (state.page > 1) { state.page--; renderTable(); }
    });
    document.getElementById("btnNext").addEventListener("click", () => {
      state.page++; renderTable();
    });
    document.getElementById("pageSize").addEventListener("change", (e) => {
      state.pageSize = parseInt(e.target.value, 10);
      state.page = 1;
      renderTable();
    });
  }

  wireControls();
  loadData();
})();
