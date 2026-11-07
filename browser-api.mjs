import { parseBrowserDeck } from "./browser-deck.mjs";

const apiRoot = "https://api.scryfall.com";
let nextRequest = 0;
const setCodes = new Map();

async function getJSON(path, payload) {
  const url = new URL(path, apiRoot);
  if (url.origin !== apiRoot) throw new Error("Unexpected card source");
  const now = Date.now();
  const start = Math.max(now, nextRequest);
  nextRequest = start + 150;
  if (start > now) await new Promise(resolve => setTimeout(resolve, start - now));
  const response = await fetch(url, {
    method: payload ? "POST" : "GET",
    headers: payload ? { Accept: "application/json", "Content-Type": "application/json" }
      : { Accept: "application/json" },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Scryfall HTTP ${response.status}`);
  return response.json();
}

function facesOf(card) {
  const images = card.image_uris ? [card.image_uris] : (card.card_faces || []).map(face => face.image_uris);
  return images.filter(uri => uri && (uri.png || uri.large || uri.normal)).map(uri => ({
    full: uri.png || uri.large || uri.normal, thumb: uri.normal || uri.large || uri.png,
  }));
}

function eligible(card) {
  return card.lang === "en" && !card.digital && facesOf(card).length > 0;
}

function pack(card) {
  return { id: card.id, name: card.name, set: card.set, number: card.collector_number,
    edition: card.set_name, artist: card.artist, oracle: card.oracle_id, status: card.image_status,
    faces: facesOf(card), source: "scryfall" };
}

async function search(query) {
  const results = [];
  let url = "/cards/search?" + new URLSearchParams({
    q: query, unique: "prints", include_variations: "true",
  });
  while (url) {
    const page = await getJSON(url);
    if (!page) break;
    results.push(...page.data);
    url = page.has_more ? page.next_page : "";
  }
  return results.filter(eligible);
}

async function canonicalSet(set) {
  if (!setCodes.has(set)) {
    const info = await getJSON("/sets/" + encodeURIComponent(set));
    setCodes.set(set, info?.code || null);
  }
  return setCodes.get(set);
}

async function resolveDeck(text) {
  const rows = parseBrowserDeck(text);
  const requests = new Map();
  for (const row of rows) {
    const identifier = row.number ? { set: row.set, collector_number: row.number } : { name: row.name };
    requests.set(JSON.stringify(identifier), identifier);
  }
  const pool = [];
  const identifiers = [...requests.values()];
  for (let start = 0; start < identifiers.length; start += 75) {
    const data = await getJSON("/cards/collection", { identifiers: identifiers.slice(start, start + 75) });
    pool.push(...(data?.data || []).filter(eligible));
  }
  for (const row of rows) {
    let edition = row.set;
    const name = row.name.toLowerCase();
    const number = row.number.toLowerCase();
    const matches = card => [card.name.toLowerCase(), card.name.split(" // ")[0].toLowerCase()].includes(name)
      && (!edition || card.set === edition)
      && (!number || card.collector_number.toLowerCase() === number);
    let card = pool.find(matches);
    if (!card && edition) {
      edition = await canonicalSet(edition);
      if (!edition) {
        row.card = null;
        continue;
      }
      if (edition !== row.set) card = pool.find(matches);
    }
    if (!card) {
      const query = [`!${JSON.stringify(row.name)}`, "lang:en", "game:paper"];
      if (edition) query.push("set:" + edition);
      if (number) query.push("cn:" + JSON.stringify(row.number));
      card = (await search(query.join(" "))).find(matches);
    }
    row.card = card ? pack(card) : null;
  }
  return rows;
}

async function printings({ oracle, name }) {
  const term = oracle ? "oracleid:" + oracle : "!" + JSON.stringify(name);
  return (await search(term + " lang:en game:paper")).map(pack)
    .sort((a, b) => Number(b.status === "highres_scan") - Number(a.status === "highres_scan"));
}

export async function browserApi(path, payload) {
  if (path === "resolve") return resolveDeck(payload.deck);
  if (path === "prints") return printings(payload);
  if (path === "pdf") {
    const { makeBrowserPdf } = await import("./browser-pdf.mjs");
    return makeBrowserPdf(payload.rows);
  }
  throw new Error("This source is available in the desktop edition");
}
