"""
Coleta o resultado (valor de arrematacao por lote) dos leiloes ja encerrados,
junto com os itens de cada lote arrematado, e grava um arquivo por edital em
historico/<edle-sanitizado>.json. Edital encerrado nao muda mais, entao cada
arquivo e escrito uma unica vez; rodadas seguintes so buscam editais novos.

O valor vem do "Extrato do Leilao" (PDF em base64 servido por
/api/edital/<u>/<n>/<e>/extrato-leilao), conferido contra o "Total Geral".

Uso:
    python historico_arrematacao.py                     # editais da listagem padrao (incremental, diario)
    python historico_arrematacao.py --desde 01-01-2024  # backfill: todos os leiloes desde a data
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import requests
from pypdf import PdfReader

from leilao_receita_scraper import EditalRef, build_session, detalhar_edital, detalhar_lote, get_json

# ENCERRADA_SESSAO_PUBLICA, ENCERRADO, HOMOLOGADO, ENCERRADA_SESSAO_PUBLICA_ATA_PUBLICADA
SITUACOES_ENCERRADAS = {10, 11, 12, 15}
MAX_DESCRICAO = 160

RE_ARREMATADO = re.compile(r"^\s*(\d+)\s+\S.*?\s(\d{1,3}(?:\.\d{3})*,\d{2})\s*$")
RE_TOTAL = re.compile(r"Total Geral[ \t]*(\d{1,3}(?:\.\d{3})*,\d{2})?")  # sem valor = nenhum lote arrematado


def brl(s: str) -> float:
    return float(s.replace(".", "").replace(",", "."))


def parse_extrato(pdf_bytes: bytes) -> dict[int, float]:
    """Lote -> valor arrematado. Levanta ValueError se a soma nao bater com o Total Geral."""
    texto = "\n".join(p.extract_text(extraction_mode="layout") for p in PdfReader(io.BytesIO(pdf_bytes)).pages)
    valores: dict[int, float] = {}
    for linha in texto.splitlines():
        m = RE_ARREMATADO.match(linha)
        if m:
            valores[int(m.group(1))] = brl(m.group(2))
    total = RE_TOTAL.search(texto)
    if not total:
        raise ValueError("extrato sem Total Geral")
    esperado = brl(total.group(1)) if total.group(1) else 0.0
    if abs(sum(valores.values()) - esperado) > 0.01:
        raise ValueError(f"soma {sum(valores.values()):.2f} != Total Geral {esperado:.2f}")
    return valores


def janelas_anuais(desde: date) -> list[str]:
    hoje = date.today()
    return [
        f"{max(desde, date(ano, 1, 1)):%d-%m-%Y},{min(hoje, date(ano, 12, 31)):%d-%m-%Y}"
        for ano in range(desde.year, hoje.year + 1)
    ]


def listar_encerrados(session: requests.Session, desde: date | None) -> list[str]:
    consultas = [{"l": j} for j in janelas_anuais(desde)] if desde else [{}]
    edles: list[str] = []
    for params in consultas:
        data = get_json(session, "editais-disponiveis", params=params)
        for grupo in data.get("situacoes", []):
            if grupo.get("situacao") in SITUACOES_ENCERRADAS:
                edles.extend(item["edle"] for item in grupo.get("lista", []))
    return sorted(set(edles))


def coletar_edital(session: requests.Session, ref: EditalRef, workers: int, delay: float) -> dict:
    extrato = get_json(session, f"edital/{ref.unidade}/{ref.numero}/{ref.exercicio}/extrato-leilao")
    valores = parse_extrato(base64.b64decode(extrato["data"]))
    edital = detalhar_edital(session, ref)
    resumo = {l["nrAtribuido"]: l for l in edital.get("listaLotes", [])}

    def itens_do_lote(nr: int):
        try:
            detalhe = detalhar_lote(session, ref, nr)
        except requests.HTTPError as exc:
            if exc.response is not None and exc.response.status_code == 422:
                return []  # lote que a API nao expoe mais: guarda o valor, sem itens
            raise
        finally:
            time.sleep(delay)
        return [
            [(i.get("descricao") or "")[:MAX_DESCRICAO], i.get("quantidade"), i.get("unMedida")]
            for i in detalhe.get("itensDetalhesLote", [])
        ]

    nrs = sorted(valores)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        itens = list(ex.map(itens_do_lote, nrs))  # qualquer falha de rede propaga: edital fica para a proxima rodada

    return {
        "edle": ref.edle,
        "dataLeilao": edital.get("dataAberturaLances"),
        "cidade": edital.get("cidade"),
        "lotes": [
            {
                "lote": nr,
                "tipo": resumo.get(nr, {}).get("tipo"),
                "valorArrematacao": valores[nr],
                "valorAvaliacao": resumo.get(nr, {}).get("valorAvaliacao"),
                "valorMinimo": resumo.get(nr, {}).get("valorMinimo"),
                "itens": it,
            }
            for nr, it in zip(nrs, itens)
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--desde", help="Backfill: data inicial do leilao (dd-mm-aaaa). Default: so a listagem padrao.")
    parser.add_argument("--pasta", default="historico", help="Pasta de saida (default: historico).")
    parser.add_argument("--workers", type=int, default=10)
    parser.add_argument("--delay", type=float, default=1.0)
    args = parser.parse_args()

    desde = date(*reversed([int(p) for p in args.desde.split("-")])) if args.desde else None
    pasta = Path(args.pasta)
    pasta.mkdir(parents=True, exist_ok=True)
    session = build_session()

    edles = listar_encerrados(session, desde)
    pendentes = [e for e in edles if not (pasta / f"{e.replace('/', '-')}.json").exists()]
    print(f"{len(edles)} editais encerrados, {len(pendentes)} ainda sem historico.")

    falhas = 0
    for i, edle in enumerate(pendentes, 1):
        try:
            dados = coletar_edital(session, EditalRef.from_edle(edle), args.workers, args.delay)
        except (requests.RequestException, ValueError, KeyError) as exc:
            falhas += 1
            print(f"[{i}/{len(pendentes)}] {edle}: pulado ({exc})", file=sys.stderr)
            continue
        with open(pasta / f"{edle.replace('/', '-')}.json", "w", encoding="utf-8") as f:
            json.dump(dados, f, ensure_ascii=False, separators=(",", ":"))
        print(f"[{i}/{len(pendentes)}] {edle}: {len(dados['lotes'])} lotes arrematados")

    print(f"Pronto. {len(pendentes) - falhas} editais gravados, {falhas} pulados (tentados de novo na proxima rodada).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
