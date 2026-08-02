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
  };

  const STATUS_ORDER = ["Agendado", "Recebendo Propostas", "Em Disputa/Lances", "Encerrado", "Desconhecido"];

  function fmtMoney(v) {
    if (v === null || v === undefined || isNaN(v)) return "-";
    return Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
  }
  function fmtNum(v) {
    if (v === null || v === undefined || isNaN(v)) return "-";
    return Number(v).toLocaleString("pt-BR");
  }
  function sanitizeEdle(edle) { return edle.replace(/\//g, "-"); }
  function statusClass(s) { return "status-" + String(s).replace(/[^A-Za-z]+/g, "-"); }

  async function loadData() {
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
    const cidades = new Set();
    const tipos = new Set();
    state.lotes.forEach(l => {
      if (l._cidade) cidades.add(l._cidade);
      if (l.tipo) tipos.add(l.tipo);
    });
    const selCidade = document.getElementById("fCidade");
    [...cidades].sort().forEach(c => {
      const opt = document.createElement("option");
      opt.value = c; opt.textContent = c;
      selCidade.appendChild(opt);
    });
    const selTipo = document.getElementById("fTipo");
    [...tipos].sort().forEach(t => {
      const opt = document.createElement("option");
      opt.value = t; opt.textContent = t;
      selTipo.appendChild(opt);
    });
  }

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
    const busca = document.getElementById("fBusca").value.trim().toLowerCase();
    const cidade = document.getElementById("fCidade").value;
    const tipo = document.getElementById("fTipo").value;
    const valorMin = parseFloat(document.getElementById("fValorMin").value);
    const valorMax = parseFloat(document.getElementById("fValorMax").value);
    const permitePF = document.getElementById("fPermitePF").checked;

    state.filtered = state.lotes.filter(l => {
      if (busca) {
        const hay = `${l._edital || ""} ${l.tipo || ""} ${l._cidade || ""} ${l._orgao || ""}`.toLowerCase();
        if (!hay.includes(busca)) return false;
      }
      if (cidade && l._cidade !== cidade) return false;
      if (tipo && l.tipo !== tipo) return false;
      if (state.statusFiltro.size > 0 && !state.statusFiltro.has(l._statusEstimado)) return false;
      if (!isNaN(valorMin) && (l.valorMinimo || 0) < valorMin) return false;
      if (!isNaN(valorMax) && (l.valorMinimo || 0) > valorMax) return false;
      if (permitePF && !l.permitePF) return false;
      return true;
    });

    if (state.sortKey) {
      const k = state.sortKey, dir = state.sortDir;
      state.filtered.sort((a, b) => {
        let av = a[k], bv = b[k];
        if (k === "cidade") { av = a._cidade; bv = b._cidade; }
        if (k === "statusEstimado") { av = a._statusEstimado; bv = b._statusEstimado; }
        if (av === null || av === undefined) av = "";
        if (bv === null || bv === undefined) bv = "";
        if (typeof av === "string") return av.localeCompare(bv) * dir;
        return (av - bv) * dir;
      });
    }

    state.page = 1;
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
      tr.innerHTML = `
        <td>${l._edital || l.edle}</td>
        <td>${l._cidade || "-"}</td>
        <td>${l.tipo || "-"}</td>
        <td>${l.loteNrAtribuido}</td>
        <td>${fmtNum(l.qtdItens)}</td>
        <td>${fmtMoney(l.valorMinimo)}</td>
        <td>${fmtMoney(l.valorAvaliacao)}</td>
        <td>${l.permitePF ? "Sim" : "Nao"}</td>
        <td><span class="badge ${statusClass(l._statusEstimado)}">${l._statusEstimado}</span></td>
      `;
      tr.addEventListener("click", () => toggleExpand(l, key));
      frag.appendChild(tr);

      if (state.expandedKey === key) {
        const trItens = document.createElement("tr");
        trItens.className = "itens-row";
        const td = document.createElement("td");
        td.colSpan = 9;
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

  async function loadItensFor(lote, key) {
    let all = state.itensCache.get(lote.edle);
    if (!all) {
      try {
        all = await fetch(`data/itens/${sanitizeEdle(lote.edle)}.json`).then(r => {
          if (!r.ok) throw new Error("not found");
          return r.json();
        });
      } catch (e) {
        all = [];
      }
      state.itensCache.set(lote.edle, all);
    }
    const itens = all.filter(i => i.loteNrAtribuido === lote.loteNrAtribuido);
    const cell = document.getElementById(`itens-${key}`);
    if (!cell) return;
    if (itens.length === 0) {
      cell.innerHTML = `<div class="loading">Nenhum item detalhado disponivel para este lote.</div>`;
      return;
    }
    cell.innerHTML = `
      <table>
        <thead><tr><th>Recinto</th><th>Qtd</th><th>Un.</th><th>Descricao</th></tr></thead>
        <tbody>
          ${itens.map(i => `<tr>
            <td>${i.recintoArmazenador || "-"}</td>
            <td>${fmtNum(i.quantidade)}</td>
            <td>${i.unMedida || "-"}</td>
            <td>${(i.descricao || "").replace(/\/+$/, "")}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  }

  function toggleExpand(lote, key) {
    state.expandedKey = state.expandedKey === key ? null : key;
    renderTable();
  }

  function exportCsv() {
    const header = ["Edital", "Cidade/Unidade", "Tipo", "Lote", "QtdItens", "ValorMinimo", "ValorAvaliacao", "PermitePF", "StatusEdital"];
    const lines = [header.join(";")];
    state.filtered.forEach(l => {
      lines.push([
        l._edital || l.edle, l._cidade || "", l.tipo || "", l.loteNrAtribuido,
        l.qtdItens || 0, l.valorMinimo || 0, l.valorAvaliacao || 0,
        l.permitePF ? "Sim" : "Nao", l._statusEstimado,
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
    ["fBusca", "fCidade", "fTipo", "fValorMin", "fValorMax", "fPermitePF"].forEach(id => {
      const el = document.getElementById(id);
      el.addEventListener("input", () => applyFilters());
      el.addEventListener("change", () => applyFilters());
    });

    document.getElementById("btnLimpar").addEventListener("click", () => {
      document.getElementById("fBusca").value = "";
      document.getElementById("fCidade").value = "";
      document.getElementById("fTipo").value = "";
      document.getElementById("fValorMin").value = "";
      document.getElementById("fValorMax").value = "";
      document.getElementById("fPermitePF").checked = false;
      state.statusFiltro.clear();
      document.querySelectorAll("#statusChips .chip").forEach(c => c.classList.remove("active"));
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
