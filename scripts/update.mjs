// Descarga el CSV oficial del TCO publicado por el BCB y genera data/tco.json y data/tco_diario.csv
import { writeFile, mkdir } from "node:fs/promises";

const INICIO = "2026-06-01"; // el BCB tiene datos de TCO desde la fecha de corte 2026-06-26
const BASE = "https://www.bcb.gob.bo/bcb_tco_publico_descargar_csv.php";

const hoyBolivia = () =>
  new Date(Date.now() - 4 * 3600 * 1000).toISOString().slice(0, 10); // UTC-4

const num = (s) => {
  s = (s ?? "").replace(/"/g, "").trim();
  if (s === "" || s === "-") return null;
  return Number(s.replace(/\./g, "").replace(",", "."));
};

function percentilPonderado(puntos, p) {
  const total = puntos.reduce((a, x) => a + x.w, 0);
  let acum = 0;
  for (const x of puntos) {
    acum += x.w;
    if (acum >= total * p) return x.v;
  }
  return puntos.at(-1)?.v ?? null;
}

async function descargar() {
  const url = `${BASE}?desde=${INICIO}&hasta=${hoyBolivia()}`;
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "tco-bolivia (GitHub Actions)" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const txt = await r.text();
      if (!txt.includes("Fecha de corte")) throw new Error("Respuesta sin formato esperado");
      return txt;
    } catch (e) {
      console.error(`Intento ${intento} falló: ${e.message}`);
      if (intento === 3) throw e;
      await new Promise((ok) => setTimeout(ok, 10000 * intento));
    }
  }
}

const txt = (await descargar()).replace(/^﻿/, "");
const lineas = txt.split(/\r?\n/).map((l) => l.split(";"));

const iHeader = lineas.findIndex((c) => c[0].replace(/"/g, "") === "Fecha de corte");
if (iHeader < 0) throw new Error("No se encontró el encabezado");
const header = lineas[iHeader];
// Encabezado: Fecha de corte; Vigencia; TC; BANCO A; ; BANCO B; ; ... ; TOTAL BANCOS;
const bancos = [];
for (let i = 3; i < header.length; i += 2) {
  const n = header[i].replace(/"/g, "").trim();
  if (n && n !== "TOTAL BANCOS") bancos.push({ nombre: n, col: i });
}
const colTotal = header.findIndex((h) => h.replace(/"/g, "").trim() === "TOTAL BANCOS");

const dias = new Map();
for (const c of lineas.slice(iHeader + 2)) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c[0] ?? "")) continue;
  const corte = c[0];
  const vig = c[1].replace(/"/g, "").trim();
  const [vigDesde, vigHasta = vigDesde] = vig.split(" al ").map((s) => s.trim());
  if (!dias.has(corte)) dias.set(corte, { corte, vigDesde, vigHasta, puntos: [], bancos: {} });
  const d = dias.get(corte);
  const tc = c[2].replace(/"/g, "").trim();

  if (tc === "TOTAL") {
    d.n = num(c[colTotal]);
    d.monto = num(c[colTotal + 1]);
    for (const b of bancos) {
      const n = num(c[b.col]);
      if (n) (d.bancos[b.nombre] ??= {}).n = n, (d.bancos[b.nombre].monto = num(c[b.col + 1]));
    }
  } else if (tc === "TCO") {
    d.tco = num(c[colTotal]);
    for (const b of bancos) {
      const v = num(c[b.col]);
      if (v != null) (d.bancos[b.nombre] ??= {}).tco = v;
    }
  } else {
    const v = num(tc);
    const w = num(c[colTotal + 1]);
    if (v != null && w) d.puntos.push({ v, w });
    if (v != null) {
      for (const b of bancos) {
        const n = num(c[b.col]);
        if (!n) continue;
        const monto = num(c[b.col + 1]);
        const s = ((d.stats ??= {})[b.nombre] ??= { min: v, max: v, montoMin: monto, montoMax: monto, sumVN: 0, sumN: 0 });
        if (v < s.min) (s.min = v), (s.montoMin = monto);
        if (v > s.max) (s.max = v), (s.montoMax = monto);
        s.sumVN += v * n;
        s.sumN += n;
      }
    }
  }
}

const salida = [...dias.values()]
  .filter((d) => d.tco != null)
  .sort((a, b) => a.corte.localeCompare(b.corte))
  .map((d) => {
    d.puntos.sort((a, b) => a.v - b.v);
    for (const [nombre, s] of Object.entries(d.stats ?? {})) {
      Object.assign((d.bancos[nombre] ??= {}), {
        min: s.min,
        max: s.max,
        montoMin: s.montoMin, // $us comprados al TC mínimo
        montoMax: s.montoMax, // $us comprados al TC máximo
        prom: Math.round((s.sumVN / s.sumN) * 10000) / 10000, // promedio simple por transacción
      });
    }
    const { puntos, stats, ...resto } = d;
    return {
      ...resto,
      min: puntos[0]?.v ?? null,
      max: puntos.at(-1)?.v ?? null,
      montoMin: puntos[0]?.w ?? null,
      montoMax: puntos.at(-1)?.w ?? null,
      p10: percentilPonderado(puntos, 0.1),
      p50: percentilPonderado(puntos, 0.5),
      p90: percentilPonderado(puntos, 0.9),
    };
  });

if (salida.length === 0) throw new Error("No se obtuvieron datos");

await mkdir("data", { recursive: true });
await writeFile(
  "data/tco.json",
  JSON.stringify({ fuente: "Banco Central de Bolivia", url: BASE, dias: salida }, null, 1)
);
const csv = [
  "fecha_corte,vigencia_desde,vigencia_hasta,tco,monto_usd,transacciones,tc_min,tc_p10,tc_mediana,tc_p90,tc_max",
  ...salida.map((d) =>
    [d.corte, d.vigDesde, d.vigHasta, d.tco, d.monto, d.n, d.min, d.p10, d.p50, d.p90, d.max].join(",")
  ),
].join("\n");
await writeFile("data/tco_diario.csv", csv + "\n");

const u = salida.at(-1);
console.log(`OK: ${salida.length} fechas de corte. Último: corte ${u.corte}, vigencia ${u.vigDesde}, TCO ${u.tco}`);
