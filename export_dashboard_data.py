"""
Exporta leiloes_receita.xlsx para JSON enxuto consumido pelo dashboard estatico
em site/. Gera:
  site/data/editais.json
  site/data/lotes.json
  site/data/itens/<edle-sanitizado>.json  (um arquivo por edital, so os itens)

Com historico/ (ver historico_arrematacao.py), cada item ganha "hist" (preco unitario
arrematado de produtos semelhantes) e cada lote ganha o lance sugerido pelo historico.

Uso:
    python export_dashboard_data.py [caminho_xlsx] [pasta_saida] [pasta_historico]
"""
from __future__ import annotations

import json
import math
import re
import statistics
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import pandas as pd

XLSX_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("leiloes_receita.xlsx")
OUT_DIR = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("site/data")
HIST_DIR = Path(sys.argv[3]) if len(sys.argv) > 3 else Path("historico")

# >= 7 caracteres com algum digito: IMEI, numero de serie, chassi - nunca se repete entre lotes
RE_SERIAL = re.compile(r"(?=.*\d)[A-Z0-9]{7,}")
RE_IMEI = re.compile(r"IMEI\d?")
RE_GB = re.compile(r"(\d)\s+(GB|TB)\b")  # "64 GB" e "64GB" viram o mesmo token
HIST_MIN_SIM = 0.4
HIST_MAX_ACHADOS = 20


def clean(v):
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if pd.isna(v):
        return None
    return v


def sanitize_edle(edle: str) -> str:
    return edle.replace("/", "-")


def status_estimado(agora: datetime, ini, fim, abertura) -> str:
    try:
        ini = pd.to_datetime(ini) if ini else None
        fim = pd.to_datetime(fim) if fim else None
        abertura = pd.to_datetime(abertura) if abertura else None
    except Exception:
        return "Desconhecido"
    if ini is not None and agora < ini:
        return "Agendado"
    if ini is not None and fim is not None and ini <= agora <= fim:
        return "Recebendo Propostas"
    if fim is not None and abertura is not None and fim < agora <= abertura:
        return "Em Disputa/Lances"
    if abertura is not None and agora > abertura:
        return "Encerrado"
    return "Desconhecido"


def descricao_base(desc: str) -> str:
    return (desc or "").split("////")[0].strip()


def tokens(desc: str) -> set[str]:
    base = unicodedata.normalize("NFD", descricao_base(desc).upper())
    base = RE_GB.sub(r"\1\2", "".join(c for c in base if not unicodedata.combining(c)))
    return {t for t in re.findall(r"[A-Z0-9]+", base) if not RE_SERIAL.fullmatch(t) and not RE_IMEI.fullmatch(t)}


def carregar_historico(pasta: Path):
    """Le historico/*.json. Devolve os pontos de preco unitario e um resumo. So vira ponto
    de preco o lote homogeneo (todos os itens sao o mesmo produto, na mesma unidade):
    ai valor / quantidade total e o preco por unidade."""
    total_lotes = 0
    precos: list[list] = []
    datas: list[str] = []
    arquivos = sorted(pasta.glob("*.json"))
    for f in arquivos:
        with open(f, encoding="utf-8") as fh:
            ed = json.load(fh)
        data = (ed.get("dataLeilao") or "")[:10]
        if data:
            datas.append(data)
        total_lotes += len(ed["lotes"])
        for l in ed["lotes"]:
            itens = l["itens"]
            if not itens:
                continue
            base, un = tokens(itens[0][0]), itens[0][2]
            qtd = sum(i[1] or 0 for i in itens)
            if not base or qtd <= 0:
                continue
            if not all(i[2] == un and len(tokens(i[0]) & base) / len(tokens(i[0]) | base) >= 0.6 for i in itens[1:]):
                continue
            aval = l.get("valorAvaliacao")
            precos.append([
                descricao_base(itens[0][0]), un, round(l["valorArrematacao"] / qtd, 2), qtd, data,
                ed["edle"], l["lote"], round(l["valorArrematacao"] / aval, 3) if aval else None,
            ])
    resumo = {"editais": len(arquivos), "lotesArrematados": total_lotes,
              "precosUnitarios": len(precos), "desde": min(datas) if datas else None}
    return precos, resumo


def montar_busca(precos: list[list]):
    """Busca de produto semelhante no historico: TF-IDF + cosseno sobre as palavras da
    descricao, mesma unidade e numeros compativeis - "IPHONE 13" x "IPHONE 14" ou "64GB" x
    "128GB" nao sao o mesmo produto, entao os numeros de um lado precisam estar todos no outro.
    Devolve buscar(descricao, unidade) -> ate 20 pontos de preco, do mais parecido ao menos."""
    toks = [tokens(p[0]) for p in precos]
    uns = [(p[1] or "").lower() for p in precos]
    n = len(precos)
    peso = {t: (math.log((n + 1) / (c + 1)) + 1) ** 2 for t, c in Counter(t for ts in toks for t in ts).items()}
    peso_novo = (math.log(n + 1) + 1) ** 2  # palavra que nunca apareceu no historico
    normas = [math.sqrt(sum(peso[t] for t in ts)) for ts in toks]
    digitos = [{t for t in ts if any(c.isdigit() for c in t)} for ts in toks]
    postings = defaultdict(list)
    for i, ts in enumerate(toks):
        for t in ts:
            postings[t].append(i)
    cache: dict[tuple, list] = {}

    def buscar(desc: str, un: str) -> list[list]:
        tks = frozenset(tokens(desc))
        chave = ((un or "").lower(), tks)
        if chave not in cache:
            norma_q = math.sqrt(sum(peso.get(t, peso_novo) for t in tks))
            dig_q = {t for t in tks if any(c.isdigit() for c in t)}
            dot: dict[int, float] = defaultdict(float)
            for t in tks:
                for i in postings.get(t, ()):
                    dot[i] += peso[t]
            achados = []
            for i, d in dot.items():
                sim = d / (norma_q * normas[i])
                if sim >= HIST_MIN_SIM and uns[i] == chave[0] and (digitos[i] <= dig_q or dig_q <= digitos[i]):
                    achados.append((sim, precos[i][4], i))
            achados.sort(reverse=True)
            cache[chave] = [precos[i] for _, _, i in achados[:HIST_MAX_ACHADOS]]
        return cache[chave]

    return buscar


def sugestao_lance(razoes: list[float], aval, minimo) -> dict:
    """Lance sugerido = avaliacao x mediana de (arrematado / avaliacao) dos lotes semelhantes
    ja arrematados, nunca abaixo do minimo do edital. Faixa = quartis 25%-75% das razoes."""
    if not razoes or not aval:
        return {}
    q1, med, q3 = statistics.quantiles(razoes, n=4, method="inclusive") if len(razoes) > 1 else razoes * 3
    return {
        "lanceSugerido": round(max(aval * med, minimo or 0)),
        "histRazao": round(med, 3),
        "histN": len(razoes),
        "histFaixa": [round(aval * q1), round(aval * q3)],
    }


def main() -> int:
    print(f"Lendo {XLSX_PATH} ...")
    xl = pd.ExcelFile(XLSX_PATH)
    df_editais = xl.parse("Editais")
    df_lotes = xl.parse("Lotes")
    df_itens = xl.parse("Itens")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "itens").mkdir(parents=True, exist_ok=True)
    # edital que saiu da planilha (encerrou) nao deixa arquivo de itens orfao para tras;
    # os itens dele ficam em historico/
    for antigo in (OUT_DIR / "itens").glob("*.json"):
        antigo.unlink()

    agora = datetime.now()

    editais_out = []
    for _, r in df_editais.iterrows():
        editais_out.append({
            "edle": clean(r.get("edle")),
            "edital": clean(r.get("edital")),
            "unidade": clean(r.get("unidade")),
            "situacao": clean(r.get("situacao")),
            "orgao": clean(r.get("orgao")),
            "cidade": clean(r.get("cidade")),
            "processo": clean(r.get("processo")),
            "dataInicioPropostas": clean(r.get("dataInicioPropostas")),
            "dataFimPropostas": clean(r.get("dataFimPropostas")),
            "dataClassificacao": clean(r.get("dataClassificacao")),
            "dataAberturaLances": clean(r.get("dataAberturaLances")),
            "mercadoriasApreendidas": bool(r.get("mercadoriasApreendidas")) if clean(r.get("mercadoriasApreendidas")) is not None else None,
            "numeroAvisos": clean(r.get("numeroAvisos")),
            "numeroErratas": clean(r.get("numeroErratas")),
            "numeroRecursos": clean(r.get("numeroRecursos")),
            "formaContato": clean(r.get("formaContato")),
            "dadosPublicacao": clean(r.get("dadosPublicacao")),
            "totalLotes": clean(r.get("totalLotes")),
            "statusEstimado": status_estimado(
                agora, r.get("dataInicioPropostas"), r.get("dataFimPropostas"), r.get("dataAberturaLances")
            ),
        })

    with open(OUT_DIR / "editais.json", "w", encoding="utf-8") as f:
        json.dump(editais_out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"editais.json: {len(editais_out)} registros")

    precos, resumo_hist = carregar_historico(HIST_DIR)
    buscar = montar_busca(precos)
    print(f"historico: {resumo_hist['lotesArrematados']} lotes arrematados, {len(precos)} com preco unitario")

    # primeiro passo pelos itens: monta os arquivos por edital, o indice de
    # recintos por lote (edle, loteNrAtribuido) -> lista de locais de armazenagem,
    # que nao existe no nivel de lote na planilha original, e o historico de cada item.
    itens_por_edle: dict[str, list] = {}
    recintos_por_lote: dict[tuple, set] = {}
    razoes_por_lote: dict[tuple, dict] = defaultdict(dict)  # lote -> {lote historico semelhante: arrematado/avaliacao}
    for _, r in df_itens.iterrows():
        edle = clean(r.get("edle"))
        if not edle:
            continue
        lote_nr = clean(r.get("loteNrAtribuido"))
        recinto = clean(r.get("recintoArmazenador"))
        item = {
            "loteNrAtribuido": lote_nr,
            "recintoArmazenador": recinto,
            "quantidade": clean(r.get("quantidade")),
            "unMedida": clean(r.get("unMedida")),
            "descricao": clean(r.get("descricao")),
        }
        achados = buscar(item["descricao"], item["unMedida"])
        if achados:
            # med = mediana do preco unitario; ex = [precoUnit, qtd, data, edle, lote, descricao] dos 3 mais parecidos
            item["hist"] = {
                "med": round(statistics.median(p[2] for p in achados), 2),
                "n": len(achados),
                "ex": [[p[2], p[3], p[4], p[5], p[6], p[0][:80]] for p in achados[:3]],
            }
            razoes_por_lote[(edle, lote_nr)].update({(p[5], p[6]): p[7] for p in achados if p[7]})
        itens_por_edle.setdefault(edle, []).append(item)
        if recinto:
            recintos_por_lote.setdefault((edle, lote_nr), set()).add(recinto)

    lotes_out = []
    for _, r in df_lotes.iterrows():
        edle = clean(r.get("edle"))
        if not edle:
            continue
        lote_nr = clean(r.get("loteNrAtribuido"))
        recintos = sorted(recintos_por_lote.get((edle, lote_nr), []))
        lotes_out.append({
            "edle": edle,
            "loteNrAtribuido": lote_nr,
            "tipo": clean(r.get("tipo")),
            "situacaoLote": clean(r.get("situacaoLote")),
            "cidade": clean(r.get("cidade")),
            "valorMinimo": clean(r.get("valorMinimo")),
            "valorAvaliacao": clean(r.get("valorAvaliacao")),
            "destaque": bool(r.get("destaque")) if clean(r.get("destaque")) is not None else None,
            "permitePF": bool(r.get("permitePF")) if clean(r.get("permitePF")) is not None else None,
            "qtdItens": clean(r.get("qtdItens")),
            "recintos": recintos,
            **sugestao_lance(list(razoes_por_lote.get((edle, lote_nr), {}).values()),
                             clean(r.get("valorAvaliacao")), clean(r.get("valorMinimo"))),
        })

    with open(OUT_DIR / "lotes.json", "w", encoding="utf-8") as f:
        json.dump(lotes_out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"lotes.json: {len(lotes_out)} registros")

    total_itens = 0
    for edle, itens in itens_por_edle.items():
        fname = OUT_DIR / "itens" / f"{sanitize_edle(edle)}.json"
        with open(fname, "w", encoding="utf-8") as f:
            json.dump(itens, f, ensure_ascii=False, separators=(",", ":"))
        total_itens += len(itens)
    print(f"itens/: {len(itens_por_edle)} arquivos, {total_itens} itens no total")

    # indice auxiliar: lista de edles que tem arquivo de itens (pro front saber o que pode buscar)
    with open(OUT_DIR / "itens_index.json", "w", encoding="utf-8") as f:
        json.dump(sorted(itens_por_edle.keys()), f, ensure_ascii=False)

    with open(OUT_DIR / "meta.json", "w", encoding="utf-8") as f:
        json.dump({"geradoEm": agora.isoformat(timespec="seconds"), "historico": resumo_hist}, f, ensure_ascii=False)

    print("OK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
