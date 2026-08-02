"""
Exporta leiloes_receita.xlsx para JSON enxuto consumido pelo dashboard estatico
em site/. Gera:
  site/data/editais.json
  site/data/lotes.json
  site/data/itens/<edle-sanitizado>.json  (um arquivo por edital, so os itens)

Uso:
    python export_dashboard_data.py [caminho_xlsx] [pasta_saida]
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd

XLSX_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("leiloes_receita.xlsx")
OUT_DIR = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("site/data")


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


def main() -> int:
    print(f"Lendo {XLSX_PATH} ...")
    xl = pd.ExcelFile(XLSX_PATH)
    df_editais = xl.parse("Editais")
    df_lotes = xl.parse("Lotes")
    df_itens = xl.parse("Itens")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "itens").mkdir(parents=True, exist_ok=True)

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

    lotes_out = []
    for _, r in df_lotes.iterrows():
        edle = clean(r.get("edle"))
        if not edle:
            continue
        lotes_out.append({
            "edle": edle,
            "loteNrAtribuido": clean(r.get("loteNrAtribuido")),
            "tipo": clean(r.get("tipo")),
            "situacaoLote": clean(r.get("situacaoLote")),
            "cidade": clean(r.get("cidade")),
            "valorMinimo": clean(r.get("valorMinimo")),
            "valorAvaliacao": clean(r.get("valorAvaliacao")),
            "destaque": bool(r.get("destaque")) if clean(r.get("destaque")) is not None else None,
            "permitePF": bool(r.get("permitePF")) if clean(r.get("permitePF")) is not None else None,
            "qtdItens": clean(r.get("qtdItens")),
        })

    with open(OUT_DIR / "lotes.json", "w", encoding="utf-8") as f:
        json.dump(lotes_out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"lotes.json: {len(lotes_out)} registros")

    itens_por_edle: dict[str, list] = {}
    for _, r in df_itens.iterrows():
        edle = clean(r.get("edle"))
        if not edle:
            continue
        itens_por_edle.setdefault(edle, []).append({
            "loteNrAtribuido": clean(r.get("loteNrAtribuido")),
            "recintoArmazenador": clean(r.get("recintoArmazenador")),
            "quantidade": clean(r.get("quantidade")),
            "unMedida": clean(r.get("unMedida")),
            "descricao": clean(r.get("descricao")),
        })

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

    print("OK.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
