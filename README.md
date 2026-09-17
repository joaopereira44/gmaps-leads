# GMaps Leads KISS

Extensão Chrome (Manifest V3) que captura os negócios do Google Maps em tempo
real enquanto você navega, sem repetir e sem limite, busca e-mails nos sites e
exporta XLSX ou CSV.

## Instalar

1. Abra `chrome://extensions`
2. Ligue **Modo do desenvolvedor** (canto superior direito)
3. Clique **Carregar sem compactação** e escolha esta pasta (`extensao/`)
4. Abra https://www.google.com/maps e pesquise algo, ex.: `clínica curitiba`

## Usar

- A extensão começa desligada e sem nada na tela. Clique no ícone dela na
  barra do Chrome para abrir o painel; o X fecha, o ícone reabre. Dá para
  arrastar pelo cabeçalho.
- **Iniciar** liga a captura e marca sozinho a caixa "Atualizar resultados ao
  mover o mapa". **Pausar** desliga sem perder a lista.
- Arraste o mapa, mude o zoom ou troque a pesquisa: cada área nova soma ao
  contador só o que ainda não estava na lista. Trocar a busca não recarrega a
  página, então a lista acumula.
- **F5 zera tudo**: lista, captura e painel voltam ao estado inicial. Exporte
  antes de recarregar.
- **E-mails são automáticos**: todo lead com site entra numa fila e o service
  worker visita 3 sites por vez. A linha abaixo do status mostra o progresso.
- **Exportar ▾** abre XLSX (Excel) ou CSV (`;` e UTF-8 com BOM).
- **Reiniciar** só zera a lista (pede confirmação). Quem liga é o Iniciar.

## Colunas do export

nome, categorias, telefone (`+55 16 3942-1100`), email (vários separados por
` | `), instagram, facebook, site, nota, avaliacoes, reivindicado, endereco,
bairro, cidade, estado, maps_url, busca.

## Arquivos

| Arquivo | Papel |
|---|---|
| `hook.js` | MAIN world; intercepta o XHR de `/search?tbm=map` e emite no `readyState 3` |
| `content.js` | parser, dedupe, storage, painel, export, fila de e-mails |
| `background.js` | Email Finder (fila, 3 em paralelo) e clique no ícone |
| `panel.css` | visual do painel |
| `vendor/xlsx.mini.min.js` | SheetJS 0.20.3 (Apache 2.0) para gerar XLSX |
| `icons/gerar.py` | gera os PNGs do ícone (`py -3.12 gerar.py`) |

## Quando o Maps mudar o formato

O parser está em `content.js` (`parseSearch`, `extractPlaces`, `toLead`). Os
índices estão em `../padroes.md`. Para validar, DevTools no Maps, aba Network,
filtro `search?tbm=map`, copiar a resposta e inspecionar.
