// Comercio exterior: precios diarios de lo que Bolivia exporta/importa + comercio mensual del INE → data/comercio.json
// Cada fuente es independiente: si una falla, se conserva lo último guardado.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { leerXlsx } from "./xlsx.mjs";

const UA = { "User-Agent": "Mozilla/5.0 (tco-bolivia)" };
const DESDE = "2023-01-01";

let datos = { precios: {}, ine: {} };
try { datos = JSON.parse(await readFile("data/comercio.json", "utf8")); } catch {}

async function intentar(nombre, fn) {
  try { await fn(); } catch (e) { console.error(`${nombre}: ${e.message}`); }
}

// --- Yahoo Finance (futuros): cierre diario
const YAHOO = [
  ["oro", "Oro", "GC=F", "$us/onza", 1],
  ["plata", "Plata", "SI=F", "$us/onza", 1],
  ["soya", "Soya", "ZS=F", "$us/tonelada", 0.367437], // ¢/bushel → $us/t (1 bushel = 27,2155 kg)
  ["petroleo", "Petróleo WTI", "CL=F", "$us/barril", 1],
];
for (const [clave, nombre, simbolo, unidad, factor] of YAHOO) {
  await intentar(nombre, async () => {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(simbolo)}?range=2y&interval=1d`, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const res = (await r.json()).chart.result[0];
    const cierres = res.indicators.quote[0].close;
    const serie = res.timestamp
      .map((t, i) => [new Date(t * 1000).toISOString().slice(0, 10), cierres[i]])
      .filter(([f, v]) => v != null && f >= DESDE)
      .map(([f, v]) => [f, Math.round(v * factor * 100) / 100]);
    if (serie.length < 10) throw new Error("serie vacía");
    datos.precios[clave] = { nombre, unidad, fuente: `Yahoo Finance (${simbolo}, futuro)`, serie };
  });
}

// --- Westmetall: precio oficial LME (cash settlement), año en curso y anterior
const MESES_EN = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
for (const [clave, nombre, campo] of [["zinc", "Zinc", "LME_Zn_cash"], ["estano", "Estaño", "LME_Sn_cash"]]) {
  await intentar(nombre, async () => {
    const guardado = new Map(datos.precios[clave]?.serie ?? []);
    const anioActual = new Date().getUTCFullYear();
    // año en curso siempre; años anteriores (desde 2024) solo si aún no están guardados
    const paginas = [""];
    for (let y = 2024; y < anioActual; y++) if (![...guardado.keys()].some((f) => f.startsWith(`${y}-`))) paginas.push(`&year=${y}`);
    let html = "";
    for (const p of paginas) {
      const r = await fetch(`https://www.westmetall.com/en/markdaten.php?action=table&field=${campo}${p}`, { headers: UA, signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      html += await r.text();
    }
    const serie = [];
    for (const m of html.matchAll(/<tr[^>]*>\s*<td[^>]*>\s*(\d{1,2})\.\s*(\w+)\s+(\d{4})\s*<\/td>\s*<td[^>]*>\s*([\d,.]+)\s*<\/td>/g)) {
      const mes = MESES_EN[m[2]];
      if (!mes) continue;
      serie.push([`${m[3]}-${String(mes).padStart(2, "0")}-${m[1].padStart(2, "0")}`, Number(m[4].replace(/,/g, ""))]);
    }
    if (serie.length < 10) throw new Error("tabla vacía");
    // se combina con lo ya guardado para conservar historia de años anteriores
    const mapa = guardado;
    for (const [f, v] of serie) mapa.set(f, v);
    datos.precios[clave] = { nombre, unidad: "$us/tonelada", fuente: "LME cash-settlement (Westmetall)", serie: [...mapa].filter(([f]) => f >= DESDE).sort() };
  });
}

// --- INE: exportaciones por producto e importaciones totales (mensual)
const MESES_ES = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
async function archivoIne(pagina, patron) {
  const html = await (await fetch(pagina, { headers: UA })).text();
  const ids = [...new Set([...html.matchAll(/nube\.ine\.gob\.bo\/index\.php\/s\/(\w+)\/download/g)].map((m) => m[1]))];
  for (const id of ids) {
    const url = `https://nube.ine.gob.bo/index.php/s/${id}/download`;
    const h = await fetch(url, { method: "HEAD", headers: UA });
    const nombre = decodeURIComponent(h.headers.get("content-disposition") ?? "");
    if (patron.test(nombre)) return Buffer.from(await (await fetch(url, { headers: UA })).arrayBuffer());
  }
  throw new Error(`no se encontró ${patron}`);
}
const anio = (v) => String(v ?? "").match(/\d{4}/)?.[0];

await intentar("INE exportaciones", async () => {
  const libro = leerXlsx(await archivoIne("https://www.ine.gob.bo/index.php/estadisticas-economicas/comercio-exterior/cuadros-estadisticos-exportaciones/", /Tradicionales y No Tradicionales por A.o y Mes/i));
  const hoja = libro[Object.keys(libro).find((k) => /Mes.*Valor/i.test(k))];
  const iAnio = hoja.findIndex((r) => r?.includes("PRODUCTO"));
  const cols = [];
  hoja[iAnio].forEach((v, c) => {
    const a = anio(v), m = MESES_ES.indexOf(hoja[iAnio + 1]?.[c]) + 1;
    if (a && m && `${a}-${String(m).padStart(2, "0")}` >= DESDE.slice(0, 7)) cols.push([c, `${a}-${String(m).padStart(2, "0")}`]);
  });
  const filas = { total: "TOTAL", minerales: "MINERALES", hidrocarburos: "HIDROCARBUROS", noTradicionales: "NO TRADICIONALES",
    oro: "Oro", plata: "Plata", zinc: "Zinc", estano: "Estaño", gas: "Gas Natural", soya: "Soya" };
  const series = {};
  for (const [clave, etiqueta] of Object.entries(filas)) {
    const fila = hoja.find((r) => String(r?.[1] ?? "").trim() === etiqueta);
    if (fila) series[clave] = cols.map(([c]) => (fila[c] == null ? 0 : Math.round(fila[c] * 100) / 100));
  }
  if (!series.total) throw new Error("sin fila TOTAL");
  datos.ine.exportaciones = { unidad: "millones de $us (FOB)", meses: cols.map(([, m]) => m), series };
});

await intentar("INE importaciones", async () => {
  const libro = leerXlsx(await archivoIne("https://www.ine.gob.bo/index.php/estadisticas-economicas/comercio-exterior/importaciones-cuadros-estadisticos/", /Importaciones por A.o y Mes/i));
  const hoja = Object.values(libro)[0];
  const meses = [], cif = [];
  let a = null;
  for (const r of hoja) {
    const y = anio(r?.[1]);
    if (y && /^\d{4}/.test(String(r[1]).trim())) { a = y; continue; }
    const m = MESES_ES.indexOf(String(r?.[2] ?? "").trim()) + 1;
    if (a && m && typeof r[5] === "number") {
      const clave = `${a}-${String(m).padStart(2, "0")}`;
      if (clave >= DESDE.slice(0, 7)) { meses.push(clave); cif.push(Math.round(r[5] / 1e4) / 100); }
    }
  }
  if (!meses.length) throw new Error("sin meses");
  datos.ine.importaciones = { unidad: "millones de $us (CIF)", meses, cif };
});

datos.actualizado = new Date().toISOString();
await mkdir("data", { recursive: true });
await writeFile("data/comercio.json", JSON.stringify(datos));
for (const [k, p] of Object.entries(datos.precios)) console.log(`${p.nombre}: ${p.serie.at(-1)?.join(" = ")} ${p.unidad}`);
const ex = datos.ine.exportaciones, im = datos.ine.importaciones;
if (ex) console.log(`INE exportaciones hasta ${ex.meses.at(-1)}: ${ex.series.total.at(-1)} M`);
if (im) console.log(`INE importaciones hasta ${im.meses.at(-1)}: ${im.cif.at(-1)} M`);
