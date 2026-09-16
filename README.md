# TCO Bolivia

Seguimiento diario del **Tipo de Cambio Oficial (TCO)** del dólar estadounidense en Bolivia.

- Página: https://frf88.github.io/tco-bolivia/
- Fuente: CSV público del Banco Central de Bolivia (`bcb_tco_publico_descargar_csv.php`).
- `scripts/update.mjs` descarga el CSV y genera `data/tco.json` y `data/tco_diario.csv`.
- `.github/workflows/actualizar.yml` lo ejecuta a las 08:00, 14:00 y 20:00 (hora Bolivia) y guarda los cambios.

Columnas de `data/tco_diario.csv`: fecha de corte, vigencia, TCO, monto en $us, transacciones y la distribución (mín., p10, mediana, p90, máx.) de los tipos de cambio ponderados por monto.

Ejecutar a mano: `node scripts/update.mjs` (Node 20+).
