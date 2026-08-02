"""
Coleta os leiloes eletronicos publicos da Receita Federal
(https://www25.receita.fazenda.gov.br/sle-sociedade/portal) e exporta
tres planilhas: Editais, Lotes e Itens.

A pagina e uma SPA Angular que consome uma API JSON publica sob
/sle-sociedade/api/... (sem autenticacao). Este script conversa
diretamente com essa API.

Uso:
    python leilao_receita_scraper.py
    python leilao_receita_scraper.py --situacoes 2 8 --workers 6
    python leilao_receita_scraper.py --edital 900100/9/2026
    python leilao_receita_scraper.py --output meus_leiloes.xlsx --limite-editais 3
"""

from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from threading import Lock

import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util import Retry

BASE_URL = "https://www25.receita.fazenda.gov.br/sle-sociedade/api"
USER_AGENT = "Mozilla/5.0 (compatible; leilao-receita-scraper/1.0)"
TIMEOUT = 30


def build_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Accept": "application/json"})
    retry = Retry(
        total=5,
        backoff_factor=1.5,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


def get_json(session: requests.Session, path: str, params: dict | None = None):
    resp = session.get(f"{BASE_URL}/{path}", params=params, timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.json()


@dataclass(frozen=True)
class EditalRef:
    unidade: str
    numero: str
    exercicio: str

    @property
    def edle(self) -> str:
        return f"{self.unidade}/{self.numero}/{self.exercicio}"

    @classmethod
    def from_edle(cls, edle: str) -> "EditalRef":
        unidade, numero, exercicio = edle.split("/")
        return cls(unidade, numero, exercicio)


def listar_editais(session: requests.Session, situacoes: list[int] | None) -> list[EditalRef]:
    data = get_json(session, "editais-disponiveis")
    refs: list[EditalRef] = []
    for grupo in data.get("situacoes", []):
        if situacoes and grupo.get("situacao") not in situacoes:
            continue
        for item in grupo.get("lista", []):
            refs.append(EditalRef.from_edle(item["edle"]))
    return refs


def detalhar_edital(session: requests.Session, ref: EditalRef) -> dict:
    return get_json(session, f"edital/{ref.unidade}/{ref.numero}/{ref.exercicio}")


def detalhar_lote(session: requests.Session, ref: EditalRef, nr_atribuido) -> dict:
    return get_json(session, f"lote/{ref.unidade}/{ref.numero}/{ref.exercicio}/{nr_atribuido}")


EDITAL_COLS = [
    "edle", "edital", "unidade", "numero", "exercicio", "situacao", "orgao",
    "cidade", "processo", "dataInicioPropostas", "dataFimPropostas",
    "dataClassificacao", "dataAberturaLances", "mercadoriasApreendidas",
    "numeroAvisos", "numeroErratas", "numeroRecursos", "formaContato",
    "dadosPublicacao", "totalLotes",
]

LOTE_COLS = [
    "edle", "edital", "loteNrAtribuido", "loteNrSq", "tipo", "situacaoLote",
    "cidade", "valorMinimo", "valorAvaliacao", "destaque", "permitePF",
    "tipoEdital", "nrAvisos", "nrErratas", "qtdItens",
]

ITEM_COLS = [
    "edle", "edital", "loteNrAtribuido", "recintoArmazenador",
    "nrReferencia", "quantidade", "unMedida", "descricao",
]


def processar_edital(session: requests.Session, ref: EditalRef) -> tuple[dict, list[dict]]:
    edital = detalhar_edital(session, ref)
    lista_lotes = edital.get("listaLotes", [])
    edital_row = {
        "edle": ref.edle,
        "edital": edital.get("edital"),
        "unidade": ref.unidade,
        "numero": ref.numero,
        "exercicio": ref.exercicio,
        "situacao": edital.get("situacao"),
        "orgao": edital.get("orgao"),
        "cidade": edital.get("cidade"),
        "processo": edital.get("processo"),
        "dataInicioPropostas": edital.get("dataInicioPropostas"),
        "dataFimPropostas": edital.get("dataFimPropostas"),
        "dataClassificacao": edital.get("dataClassificacao"),
        "dataAberturaLances": edital.get("dataAberturaLances"),
        "mercadoriasApreendidas": edital.get("mercadoriasApreendidas"),
        "numeroAvisos": edital.get("numeroAvisos"),
        "numeroErratas": edital.get("numeroErratas"),
        "numeroRecursos": edital.get("numeroRecursos"),
        "formaContato": edital.get("formaContato"),
        "dadosPublicacao": edital.get("dadosPublicacao"),
        "totalLotes": len(lista_lotes),
    }
    return edital_row, lista_lotes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--situacoes", type=int, nargs="*", default=None,
                         help="Filtra por codigo(s) de situacao do edital (ex: 2 8). Default: todas.")
    parser.add_argument("--edital", dest="editais", action="append", default=None,
                         help="Restringe a um edle especifico (formato unidade/numero/exercicio). Pode repetir.")
    parser.add_argument("--limite-editais", type=int, default=None, help="Limita quantos editais processar (debug).")
    parser.add_argument("--workers", type=int, default=10, help="Requisicoes de lote em paralelo (default: 10).")
    parser.add_argument("--delay", type=float, default=1.0,
                         help="Pausa (s) entre requisicoes de lote por worker (default: 1.0, teto de ~10 req/s no total).")
    parser.add_argument("--output", default="leiloes_receita.xlsx", help="Caminho do arquivo .xlsx de saida.")
    args = parser.parse_args()

    session = build_session()

    if args.editais:
        refs = [EditalRef.from_edle(e) for e in args.editais]
    else:
        print("Buscando lista de editais disponiveis...")
        refs = listar_editais(session, args.situacoes)

    if args.limite_editais:
        refs = refs[: args.limite_editais]

    print(f"{len(refs)} edital(is) a processar.")

    editais_rows: list[dict] = []
    lotes_rows: list[dict] = []
    lote_jobs: list[tuple[EditalRef, dict]] = []

    for i, ref in enumerate(refs, 1):
        print(f"[{i}/{len(refs)}] edital {ref.edle} ...")
        try:
            edital_row, lista_lotes = processar_edital(session, ref)
        except requests.RequestException as exc:
            print(f"  falha ao buscar edital {ref.edle}: {exc}", file=sys.stderr)
            continue
        editais_rows.append(edital_row)
        for lote in lista_lotes:
            lote_jobs.append((ref, lote))

    print(f"{len(lote_jobs)} lote(s) a detalhar (itens)...")

    itens_rows: list[dict] = []
    lock = Lock()
    done = 0

    def worker(job: tuple[EditalRef, dict]):
        ref, lote_resumo = job
        nr_atribuido = lote_resumo.get("nrAtribuido")
        try:
            detalhe = detalhar_lote(session, ref, nr_atribuido)
        except requests.RequestException as exc:
            print(f"  falha ao buscar lote {ref.edle} lote {nr_atribuido}: {exc}", file=sys.stderr)
            detalhe = {}
        time.sleep(args.delay)
        itens = detalhe.get("itensDetalhesLote", [])
        lote_row = {
            "edle": ref.edle,
            "edital": lote_resumo.get("edital") or detalhe.get("edital"),
            "loteNrAtribuido": nr_atribuido,
            "loteNrSq": lote_resumo.get("loleNrSq"),
            "tipo": lote_resumo.get("tipo"),
            "situacaoLote": lote_resumo.get("situacaoLote"),
            "cidade": lote_resumo.get("cidade") or detalhe.get("cidade"),
            "valorMinimo": lote_resumo.get("valorMinimo"),
            "valorAvaliacao": lote_resumo.get("valorAvaliacao"),
            "destaque": lote_resumo.get("destaque"),
            "permitePF": lote_resumo.get("permitePF"),
            "tipoEdital": lote_resumo.get("tipoEdital"),
            "nrAvisos": lote_resumo.get("nrAvisos"),
            "nrErratas": lote_resumo.get("nrErratas"),
            "qtdItens": len(itens),
        }
        item_rows = [
            {
                "edle": ref.edle,
                "edital": lote_row["edital"],
                "loteNrAtribuido": nr_atribuido,
                "recintoArmazenador": item.get("recintoArmazenador"),
                "nrReferencia": item.get("nrReferencia"),
                "quantidade": item.get("quantidade"),
                "unMedida": item.get("unMedida"),
                "descricao": item.get("descricao"),
            }
            for item in itens
        ]
        return lote_row, item_rows

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(worker, job): job for job in lote_jobs}
        for future in as_completed(futures):
            lote_row, item_rows = future.result()
            with lock:
                lotes_rows.append(lote_row)
                itens_rows.extend(item_rows)
                done += 1
                print(f"  lotes processados: {done}/{len(lote_jobs)}")

    df_editais = pd.DataFrame(editais_rows, columns=EDITAL_COLS)
    df_lotes = pd.DataFrame(lotes_rows, columns=LOTE_COLS).sort_values(["edle", "loteNrAtribuido"])
    df_itens = pd.DataFrame(itens_rows, columns=ITEM_COLS).sort_values(["edle", "loteNrAtribuido"])

    with pd.ExcelWriter(args.output, engine="openpyxl") as writer:
        df_editais.to_excel(writer, sheet_name="Editais", index=False)
        df_lotes.to_excel(writer, sheet_name="Lotes", index=False)
        df_itens.to_excel(writer, sheet_name="Itens", index=False)

    print(f"\nPronto! {len(df_editais)} editais, {len(df_lotes)} lotes, {len(df_itens)} itens -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
