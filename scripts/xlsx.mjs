// Lector mínimo de .xlsx sin dependencias: devuelve cada hoja como matriz de celdas (texto o número)
import { inflateRawSync } from "node:zlib";

function unzip(buf) {
  // fin del directorio central
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("No es un zip");
  const total = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const files = {};
  for (let i = 0; i < total; i++) {
    const metodo = buf.readUInt16LE(p + 10);
    const tam = buf.readUInt32LE(p + 20);
    const nLen = buf.readUInt16LE(p + 28), xLen = buf.readUInt16LE(p + 30), cLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nombre = buf.toString("utf8", p + 46, p + 46 + nLen);
    const ini = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const datos = buf.subarray(ini, ini + tam);
    files[nombre] = () => (metodo === 0 ? datos : inflateRawSync(datos)).toString("utf8");
    p += 46 + nLen + xLen + cLen;
  }
  return files;
}

const texto = (s) =>
  s.replace(/<rPh[\s\S]*?<\/rPh>/g, "").replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

const col = (ref) => [...ref.replace(/\d+/g, "")].reduce((a, c) => a * 26 + c.charCodeAt(0) - 64, 0) - 1;

export function leerXlsx(buf) {
  const f = unzip(buf);
  const ss = f["xl/sharedStrings.xml"] ? [...f["xl/sharedStrings.xml"]().matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => texto(m[1])) : [];
  const libro = f["xl/workbook.xml"]();
  const rels = f["xl/_rels/workbook.xml.rels"]();
  const hojas = {};
  for (const m of libro.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const destino = rels.match(new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${m[2]}"`));
    const ruta = "xl/" + (destino[1] ?? destino[2]).replace(/^\/?xl\//, "");
    const filas = [];
    for (const r of f[ruta]().matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const fila = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = c[1].match(/r="([A-Z]+\d+)"/)?.[1];
        const t = c[1].match(/t="(\w+)"/)?.[1];
        const v = c[2]?.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        const is = c[2]?.match(/<is>([\s\S]*?)<\/is>/)?.[1];
        let val = null;
        if (t === "s" && v != null) val = ss[+v];
        else if (t === "inlineStr" && is) val = texto(is);
        else if (t === "str" && v != null) val = texto(v);
        else if (v != null) val = Number(v);
        if (ref) fila[col(ref)] = val;
      }
      filas.push(fila);
    }
    hojas[texto(m[1])] = filas;
  }
  return hojas;
}
