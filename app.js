import { labels } from "./labels.js";

const get = (id) => document.getElementById(id);
const deck = get("deck");
const picker = get("picker");
const webEdition = location.hostname !== "127.0.0.1";
const messages = {};
let language = localStorage.getItem("mtg-print-language") === "en" ? "en" : "zh";
let rows = [];
let resolvedText = null;
let importing = false;
let exporting = false;
let activeRow = null;
let gallery = { token: 0, tab: "official", status: "", items: [] };

function t(key, values = {}) {
  return labels[language][key].replace(/\{(\w+)\}/g, (_, k) => values[k] ?? "");
}

function message(id, key, values = {}, detail = "") {
  messages[id] = { key, values, detail };
  renderMessage(id);
}

function renderMessage(id) {
  const { key, values, detail } = messages[id];
  get(id).textContent = key ? [t(key, values), detail].filter(Boolean).join(" ") : "";
  get(id).dataset.error = String(Boolean(detail) || ["fileError", "importError", "pdfError"].includes(key));
}

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value) element.textContent = value;
  return element;
}

function preview(url, name, fallback) {
  if (!url || !/^(https:\/\/|blob:)/.test(url)) return node("div", "card-placeholder");
  const img = node("img");
  img.src = url;
  img.alt = name;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  if (fallback?.startsWith("https://") && fallback !== url) {
    img.addEventListener("error", () => { img.src = fallback; }, { once: true });
  }
  return img;
}

function chooseLanguage(value) {
  language = value;
  localStorage.setItem("mtg-print-language", value);
  document.documentElement.lang = value === "zh" ? "zh-Hans" : "en";
  document.title = t("title");
  for (const element of document.querySelectorAll("[data-label]")) {
    element.textContent = t(element.dataset.label);
  }
  for (const element of document.querySelectorAll("[data-aria]")) {
    element.setAttribute("aria-label", t(element.dataset.aria));
  }
  for (const element of document.querySelectorAll("[data-placeholder]")) {
    element.placeholder = t(element.dataset.placeholder);
  }
  for (const key of ["zh", "en"]) get(key).setAttribute("aria-pressed", String(value === key));
  for (const id of Object.keys(messages)) renderMessage(id);
  renderCards();
  renderSummary();
  if (picker.open) renderGallery();
}

async function api(path, payload) {
  if (webEdition) {
    const { browserApi } = await import("./browser-api.mjs");
    return browserApi(path, payload);
  }
  const response = await fetch("/api/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || String(response.status));
  }
  return path === "pdf" ? response.blob() : response.json();
}

function renderCards() {
  const container = get("cards");
  container.replaceChildren();
  get("count").textContent = t("cards", { n: rows.reduce((sum, row) => sum + row.quantity, 0) });
  if (!rows.length) {
    const empty = node("div", "empty");
    empty.append(node("span", "symbol", "◇"), node("b", "", t("empty")), node("p", "", t("emptyHelp")));
    container.append(empty);
    return;
  }
  for (const row of rows) {
    const selected = row.selected;
    const item = node("div", "card-row");
    const front = selected?.faces[0];
    item.append(preview(front?.thumb, selected?.name || row.name, front?.full));
    const info = node("div", "card-info");
    info.append(node("b", "", row.quantity + " × " + row.name));
    const details = selected ? description(selected) : t("missing");
    info.append(node("small", "", t(row.section) + " · " + details));
    const button = node("button", "button ghost", t("choose"));
    button.type = "button";
    button.setAttribute("aria-label", t("choose") + " " + row.name);
    button.addEventListener("click", () => openPicker(row));
    item.append(info, button);
    container.append(item);
  }
}

function description(card) {
  if (card.source === "upload") return t("localImage");
  if (card.source === "mpc") {
    return [card.edition || "MPC Autofill", t("ppi", { n: card.dpi })].join(" · ");
  }
  const status = card.status === "lowres" ? t("lowres") : "";
  return [card.edition, card.set.toUpperCase() + " #" + card.number, status].filter(Boolean).join(" · ");
}

function renderSummary() {
  const stale = resolvedText !== null && resolvedText !== deck.value;
  const missing = rows.filter(row => !row.selected).length;
  const reverse = get("backs").checked;
  const missingBack = reverse && rows.some(row =>
    row.official?.faces.length === 2 && row.selected && row.selected.source !== "scryfall" && row.selected.faces.length < 2);
  const faces = rows.reduce((sum, row) =>
    sum + row.quantity * (reverse ? row.selected?.faces.length || 0 : Number(Boolean(row.selected))), 0);
  get("summary").textContent = stale ? t("stale") : missing ? t("pending", { n: missing })
    : missingBack ? t("missingBack") : faces ? t("pages", { faces, pages: Math.ceil(faces / 9) }) : t("pdfPending");
  get("pdf").disabled = !faces || Boolean(missing) || stale || missingBack || importing || exporting;
  get("resolve").disabled = !deck.value.trim() || importing || exporting;
  for (const button of get("cards").querySelectorAll("button")) button.disabled = exporting;
}

async function resolveDeck() {
  const input = deck.value;
  importing = true;
  renderSummary();
  message("notice", "loading");
  message("exportNotice", "");
  try {
    const result = await api("resolve", { deck: input });
    resolvedText = input;
    for (const row of rows) releaseUpload(row);
    rows = result.map(row => ({ ...row, official: row.card, selected: row.card }));
    const counts = { main: 0, side: 0 };
    for (const row of rows) counts[row.section] += row.quantity;
    message("notice", "imported", {
      found: rows.filter(row => row.selected).length, total: rows.length, ...counts,
    });
    renderCards();
  } catch (error) {
    message("notice", "importError", {}, error.message);
  } finally {
    importing = false;
    renderSummary();
  }
}

function renderGallery() {
  get("official").setAttribute("aria-pressed", String(gallery.tab === "official"));
  get("community").setAttribute("aria-pressed", String(gallery.tab === "community"));
  get("galleryStatus").textContent = (gallery.status ? t(gallery.status) : "") +
    (gallery.detail ? " " + gallery.detail : "");
  get("webUpload").hidden = !webEdition || gallery.tab !== "community";
  const list = get("choices");
  list.replaceChildren();
  for (const card of gallery.items) {
    const choice = node("button", "choice");
    choice.type = "button";
    const face = card.faces[0];
    const selected = activeRow.selected?.source === card.source && activeRow.selected?.id === card.id;
    choice.setAttribute("aria-pressed", String(selected));
    choice.append(preview(face.thumb, card.name), node("b", "", card.name),
      node("small", "", description(card)));
    if (selected) choice.append(node("small", "", t("selected")));
    if (card.artist) choice.append(node("small", "", card.artist));
    if (card.match) choice.append(node("small", "", t("exact")));
    if (card.source === "mpc" && !card.language) choice.append(node("small", "", t("unknownLanguage")));
    choice.addEventListener("click", () => {
      if (card.source === "scryfall") activeRow.official = card;
      const back = card.match && activeRow.official?.faces[1];
      selectImage(activeRow, back ? { ...card, faces: [...card.faces, { ...back, ppi: 0 }] } : card);
    });
    list.append(choice);
  }
}

function releaseUpload(row) {
  if (row.selected?.source === "upload") URL.revokeObjectURL(row.selected.faces[0].full);
}

function selectImage(row, card) {
  releaseUpload(row);
  row.selected = card;
  picker.close();
  renderCards();
  renderSummary();
  get("cards").children[rows.indexOf(row)]?.querySelector("button")?.focus();
}

async function loadGallery(tab) {
  const row = activeRow;
  const token = gallery.token + 1;
  const uploadOnly = webEdition && tab === "community";
  gallery = { token, tab, status: uploadOnly ? "webCommunity" : "loadingGallery", items: [] };
  renderGallery();
  if (uploadOnly) return;
  const current = row.official;
  try {
    const result = tab === "official"
      ? await api("prints", { oracle: current?.oracle, name: current?.name || row.name })
      : await api("community", { name: current?.name || row.name,
        set: current?.set || row.set, number: current?.number || row.number });
    if (gallery.token !== token || !picker.open) return;
    gallery.items = result;
    gallery.status = result.length ? (tab === "official" ? "galleryOfficial" : "galleryCommunity") : "noChoices";
  } catch (error) {
    if (gallery.token !== token || !picker.open) return;
    gallery.status = "sourceError";
    gallery.detail = error.message;
  }
  renderGallery();
}

function openPicker(row) {
  activeRow = row;
  get("pickerTitle").textContent = row.name;
  picker.showModal();
  loadGallery(["mpc", "upload"].includes(row.selected?.source) ? "community" : "official");
}

async function exportPdf() {
  exporting = true;
  renderSummary();
  message("exportNotice", "pdfBusy");
  try {
    const items = rows.map(row => ({
      quantity: row.quantity,
      faces: row.selected.faces.slice(0, get("backs").checked ? 2 : 1).map(face => ({
        url: face.full,
        ppi: face.ppi ?? row.selected.dpi ?? 0,
        trim: face.trim,
      })),
    }));
    const file = await api("pdf", { rows: items });
    const url = URL.createObjectURL(file);
    const link = node("a");
    link.href = url;
    link.download = "mtg-a4.pdf";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    message("exportNotice", "pdfReady");
  } catch (error) {
    message("exportNotice", "pdfError", {}, error.message);
  } finally {
    exporting = false;
    renderSummary();
  }
}

get("zh").addEventListener("click", () => chooseLanguage("zh"));
get("en").addEventListener("click", () => chooseLanguage("en"));
get("resolve").addEventListener("click", resolveDeck);
get("backs").addEventListener("change", renderSummary);
get("pdf").addEventListener("click", exportPdf);
get("close").addEventListener("click", () => picker.close());
get("official").addEventListener("click", () => loadGallery("official"));
get("community").addEventListener("click", () => loadGallery("community"));
get("cardFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  const row = activeRow;
  const token = gallery.token;
  const trim = get("trimImage").checked;
  event.target.value = "";
  if (!file) return;
  try {
    if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 30_000_000) throw new Error();
    const image = await createImageBitmap(file);
    const pixels = image.width * image.height;
    image.close();
    if (pixels > 30_000_000) throw new Error();
    if (!picker.open || token !== gallery.token) return;
    const full = URL.createObjectURL(file);
    selectImage(row, { name: row.name, source: "upload", faces: [{ full, thumb: full, trim }] });
  } catch {
    if (!picker.open || token !== gallery.token) return;
    gallery.status = "imageError";
    renderGallery();
  }
});
deck.addEventListener("input", renderSummary);
get("sample").addEventListener("click", () => {
  deck.value = labels.en.placeholder + "\n1 Delver of Secrets";
  renderSummary();
  deck.focus();
});
get("file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  try {
    if (file) {
      if (file.size > 200_000) throw new Error("200 KB");
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        deck.value = new TextDecoder("utf-16le").decode(bytes);
      } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        deck.value = new TextDecoder("utf-16be").decode(bytes);
      } else {
        deck.value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
      message("notice", "");
      renderSummary();
    }
  } catch (error) {
    message("notice", "fileError", {}, error.message);
  } finally {
    event.target.value = "";
  }
});
chooseLanguage(language);
