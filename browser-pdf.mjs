const mm = value => value * 72 / 25.4;
const width = 63;
const height = 88;
const gap = 2;
const left = (210 - 3 * width - 2 * gap) / 2;
const bottom = (297 - 3 * height - 2 * gap) / 2;
let library;

function pdfLibrary() {
  if (!library) {
    library = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = new URL("./vendor/pdf-lib.min.js", import.meta.url);
      script.onload = () => resolve(globalThis.PDFLib);
      script.onerror = () => {
        library = null;
        reject(new Error("Unable to load the PDF component"));
      };
      document.head.append(script);
    });
  }
  return library;
}

async function download(face) {
  const url = new URL(face.url);
  const localImage = url.protocol === "blob:" && url.origin === location.origin;
  if (!localImage && (url.protocol !== "https:" || url.hostname !== "cards.scryfall.io")) {
    throw new Error("Unexpected card image source");
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw new Error(`Card image HTTP ${response.status}`);
  if (localImage && face.trim) return trimBleed(await response.blob());
  return new Uint8Array(await response.arrayBuffer());
}

async function trimBleed(blob) {
  const image = await createImageBitmap(blob);
  try {
    const bleed = 3.175;
    const scale = Math.min(image.width / (width + 2 * bleed), image.height / (height + 2 * bleed));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.getContext("2d").drawImage(image, Math.floor((image.width - canvas.width) / 2),
      Math.floor((image.height - canvas.height) / 2), canvas.width, canvas.height,
      0, 0, canvas.width, canvas.height);
    const trimmed = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    if (!trimmed) throw new Error("Unable to trim the card image");
    return new Uint8Array(await trimmed.arrayBuffer());
  } finally {
    image.close();
  }
}
function marks(page, slots, font, rgb) {
  const line = (x1, y1, x2, y2, dark = false) => page.drawLine({
    start: { x: mm(x1), y: mm(y1) }, end: { x: mm(x2), y: mm(y2) },
    color: dark ? rgb(0, 0, 0) : rgb(.45, .45, .45), thickness: dark ? .5 : .28,
  });
  const xs = new Set(slots.flatMap(({ x }) => [x, x + width]));
  const ys = new Set(slots.flatMap(({ y }) => [y, y + height]));
  const last = Math.min(...slots.map(({ y }) => y));
  const right = Math.max(...slots.map(({ x }) => x)) + width;
  for (const x of xs) {
    line(x, 297 - bottom + 1, x, 297 - bottom + 4);
    line(x, last - 1, x, last - 4);
  }
  for (const y of ys) {
    line(left - 4, y, left - 1, y);
    line(right + 1, y, right + 4, y);
  }
  line(left, 7, left + 50, 7, true);
  line(left, 6, left, 8, true);
  line(left + 50, 6, left + 50, 8, true);
  page.drawText("50 mm / 100%", { x: mm(left + 53), y: mm(6), size: 7, font });
}

export async function makeBrowserPdf(rows) {
  const { PDFDocument, PrintScaling, StandardFonts, rgb } = await pdfLibrary();
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.catalog.getOrCreateViewerPreferences().setPrintScaling(PrintScaling.None);
  const faces = [];
  const assets = new Map();
  for (const row of rows) {
    for (const face of row.faces) {
      if (!assets.has(face.url)) assets.set(face.url, face);
      faces.push(...Array(row.quantity).fill(face.url));
    }
  }
  if (!faces.length) throw new Error("No card faces to print");
  const unique = [...assets.values()];
  for (let start = 0; start < unique.length; start += 4) {
    const batch = unique.slice(start, start + 4);
    const data = await Promise.all(batch.map(download));
    for (const [index, bytes] of data.entries()) {
      const image = bytes[0] === 0xff && bytes[1] === 0xd8
        ? await pdf.embedJpg(bytes) : await pdf.embedPng(bytes);
      assets.set(batch[index].url, image);
    }
  }
  for (let start = 0; start < faces.length; start += 9) {
    const page = pdf.addPage([mm(210), mm(297)]);
    const slots = faces.slice(start, start + 9).map((url, index) => {
      const x = left + (index % 3) * (width + gap);
      const y = 297 - bottom - height - Math.floor(index / 3) * (height + gap);
      page.drawImage(assets.get(url), { x: mm(x), y: mm(y), width: mm(width), height: mm(height) });
      return { x, y };
    });
    marks(page, slots, font, rgb);
  }
  return new Blob([await pdf.save()], { type: "application/pdf" });
}
