// Dólar paralelo desde Binance P2P (USDT/BOB): guarda una foto por ejecución en data/binance.json
// Método: anuncios confiables (≥90% completados, ≥50 órdenes en 30 días, ≥100 USDT disponibles),
// se descartan precios a más de 3% de la mediana y se promedian los 10 mejores.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const URL = "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search";
const TOP = 10;

async function anuncios(tradeType) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const r = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (tco-bolivia)" },
      body: JSON.stringify({ asset: "USDT", fiat: "BOB", tradeType, page, rows: 20, payTypes: [], publisherType: null }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.code !== "000000") throw new Error(`Binance ${j.code} ${j.message ?? ""}`);
    out.push(...(j.data ?? []));
    if ((j.data ?? []).length < 20) break;
  }
  return out;
}

function precio(lista, mejorPrimero) {
  const validos = lista
    .map(({ adv, advertiser }) => ({
      p: Number(adv.price),
      disp: Number(adv.surplusAmount),
      ord: advertiser.monthOrderCount,
      fin: advertiser.monthFinishRate,
    }))
    .filter((x) => x.fin >= 0.9 && x.ord >= 50 && x.disp >= 100);
  if (validos.length < 3) return null;
  const ord = [...validos].sort((a, b) => a.p - b.p);
  const mediana = ord[Math.floor(ord.length / 2)].p;
  const sinOutliers = validos.filter((x) => Math.abs(x.p / mediana - 1) <= 0.03);
  sinOutliers.sort((a, b) => (mejorPrimero === "alto" ? b.p - a.p : a.p - b.p));
  const top = sinOutliers.slice(0, TOP);
  return { precio: Math.round((top.reduce((a, x) => a + x.p, 0) / top.length) * 1000) / 1000, n: top.length };
}

// SELL = anuncios que compran USDT: lo que te pagan por 1 USDT (comparable al TCO de compra)
// BUY  = anuncios que venden USDT: lo que pagas por 1 USDT
const [compra, venta] = [precio(await anuncios("SELL"), "alto"), precio(await anuncios("BUY"), "bajo")];
if (!compra || !venta) throw new Error("Muy pocos anuncios válidos");

await mkdir("data", { recursive: true });
let datos = { fuente: "Binance P2P USDT/BOB", metodo: "promedio de los 10 mejores anuncios confiables sin outliers", fotos: [] };
try { datos = JSON.parse(await readFile("data/binance.json", "utf8")); } catch {}
const foto = { t: new Date().toISOString().slice(0, 16) + "Z", compra: compra.precio, venta: venta.precio, n: [compra.n, venta.n] };
datos.fotos.push(foto);
await writeFile("data/binance.json", JSON.stringify(datos));
console.log(`Binance P2P: compra ${foto.compra} · venta ${foto.venta} (${foto.n.join("/")} anuncios)`);
