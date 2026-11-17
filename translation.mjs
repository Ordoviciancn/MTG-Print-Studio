const serif = '"Noto Serif SC", "Songti SC", SimSun, serif';
const symbols = new Map();
const symbol = /^\{([0-9A-Z½∞/]+)\}$/;

export async function lookupTranslation(card, faceIndex = 0) {
  if (!card?.set || !card?.number) return "";
  const url = "https://mtgch.com/api/v1/card/" +
    [card.set, card.number].map(encodeURIComponent).join("/") + "/";
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("Translation HTTP " + response.status);
  const data = await response.json();
  if (card.oracle && data.oracle_id !== card.oracle) return "";
  const face = [data, ...(Array.isArray(data.other_faces) ? data.other_faces : [])]
    .find(item => Math.max(0, item.face_index ?? 0) === faceIndex);
  const text = face?.atomic_translated_text || face?.zhs_text || "";
  return text.replace(/\\n/g, "\n").trim();
}

function tokens(text) {
  return text.match(/\{[0-9A-Z½∞/]+\}|[A-Za-z0-9]+|[^]/gu) || [];
}

async function loadSymbol(code) {
  if (!symbols.has(code)) {
    symbols.set(code, new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const timeout = setTimeout(() => resolve(null), 4500);
      img.onload = () => { clearTimeout(timeout); resolve(img); };
      img.onerror = () => { clearTimeout(timeout); resolve(null); };
      img.src = "https://svgs.scryfall.io/card-symbols/" + encodeURIComponent(code.replaceAll("/", "")) + ".svg";
    }));
  }
  return symbols.get(code);
}

export async function prepareTranslation(text) {
  const codes = new Set(tokens(text).map(part => part.match(symbol)?.[1]).filter(Boolean));
  const fonts = document.fonts.load("400 20px " + serif, text).catch(() => []);
  const entries = await Promise.all([...codes].map(async code => [code, await loadSymbol(code)]));
  await fonts;
  return new Map(entries);
}

function wrap(ctx, text, width, size, icons) {
  return text.split("\n").flatMap(paragraph => {
    const lines = [[]];
    let length = 0;
    for (const part of tokens(paragraph)) {
      const code = part.match(symbol)?.[1];
      const icon = icons.get(code);
      const value = code ? (icon ? "" : "{" + code + "}") : part;
      const advance = icon ? size * 1.05 : ctx.measureText(value).width;
      if (length && length + advance > width) {
        lines.push([]);
        length = 0;
      }
      if (!length && !value.trim() && !icon) continue;
      lines.at(-1).push({ value, icon, advance });
      length += advance;
    }
    return lines;
  });
}

export function paintTranslation(canvas, image, text, box, icons) {
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  if (!text.trim()) return true;
  const [left, top, width, height] = box;
  if (!box.every(Number.isFinite) || left < 0 || top < 0 ||
      width < 1 || height < 1 || left + width > 100 || top + height > 100) return false;
  const [x, y, w, h] = [left * image.width, top * image.height, width * image.width, height * image.height]
    .map(value => Math.round(value / 100));
  const pad = Math.max(2, Math.round(image.width * .015));
  if (w <= 2 * pad || h <= 2 * pad) return false;
  let fitted;
  const max = Math.max(8, Math.round(image.width * .036));
  const min = Math.max(6, Math.round(image.width * .020));
  for (let size = max; size >= min; size--) {
    ctx.font = "400 " + size + "px " + serif;
    const lines = wrap(ctx, text, w - 2 * pad, size, icons);
    const lineHeight = size * 1.34;
    if (lines.length * lineHeight <= h - 2 * pad &&
        lines.every(line => line.reduce((sum, part) => sum + part.advance, 0) <= w - 2 * pad)) {
      fitted = { size, lines, lineHeight };
      break;
    }
  }
  if (!fitted) return false;
  // Sample the text box margins rather than its inked center.
  const sample = row => {
    const points = [];
    for (const column of [x + Math.max(1, pad >> 2), x + w - Math.max(2, pad >> 2)]) {
      const pixels = ctx.getImageData(column, row, 1, Math.min(5, canvas.height - row)).data;
      for (let i = 0; i < pixels.length; i += 4) points.push([...pixels.slice(i, i + 3)]);
    }
    const median = channel => points.map(pixel => pixel[channel]).sort((a, b) => a - b)[points.length >> 1];
    return [median(0), median(1), median(2)];
  };
  const upper = sample(y + Math.min(pad, h - 1));
  const lower = sample(y + Math.max(0, h - pad - 5));
  const gradient = ctx.createLinearGradient(0, y, 0, y + h);
  gradient.addColorStop(0, "rgb(" + upper.join(",") + ")");
  gradient.addColorStop(1, "rgb(" + lower.join(",") + ")");
  ctx.fillStyle = gradient;
  ctx.fillRect(x, y, w, h);
  const luminance = pixel => .2126 * pixel[0] + .7152 * pixel[1] + .0722 * pixel[2];
  ctx.fillStyle = (luminance(upper) + luminance(lower)) / 2 < 115 ? "#faf7ee" : "#191716";
  ctx.textBaseline = "middle";
  const { size, lines, lineHeight } = fitted;
  for (const [index, parts] of lines.entries()) {
    let cursor = x + pad;
    const baseline = y + (h - lines.length * lineHeight) / 2 + (index + .5) * lineHeight;
    for (const { value, icon, advance } of parts) {
      if (icon) ctx.drawImage(icon, cursor, baseline - size / 2, size, size);
      else ctx.fillText(value, cursor, baseline);
      cursor += advance;
    }
  }
  return true;
}
