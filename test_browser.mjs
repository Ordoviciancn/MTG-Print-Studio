import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBrowserDeck } from "./browser-deck.mjs";
import { browserApi } from "./browser-api.mjs";
import { lookupTranslation } from "./translation.mjs";

test("translation lookup handles single-face indexes and prefers current wording", async t => {
  const card = { set: "tsp", number: "269", oracle: "ruins" };
  t.mock.method(globalThis, "fetch", async url => {
    assert.equal(url, "https://mtgch.com/api/v1/card/tsp/269/");
    return Response.json({ oracle_id: "ruins", face_index: -1,
      atomic_translated_text: "{T}：加{C}。\\n规则文本", zhs_text: "旧版文本" });
  });
  assert.equal(await lookupTranslation(card), "{T}：加{C}。\n规则文本");
  assert.equal(await lookupTranslation(card, 1), "");
  assert.equal(await lookupTranslation({ ...card, oracle: "wrong" }), "");
});

test("static edition keeps printing identifiers and merges repeated sideboard entries", () => {
  const rows = parseBrowserDeck("About\nName Deck\n\nDeck\n1 Crystal Vein (PLST) MIR-325\n"
    + "4 [MH1:218] Altar of Dementia\nSideboard (2)\n1 Rushing River (PLST) PLS-30\n"
    + "SB: 1 Rushing River (PLST) pls-30");
  assert.deepEqual(rows, [
    { name: "Crystal Vein", set: "plst", number: "MIR-325", quantity: 1, section: "main" },
    { name: "Altar of Dementia", set: "mh1", number: "218", quantity: 4, section: "main" },
    { name: "Rushing River", set: "plst", number: "PLS-30", quantity: 2, section: "side" },
  ]);
});

test("static edition recognizes quoted CSV and TSV tables", () => {
  for (const separator of [",", "\t", ";"]) {
    const header = ["Name", "Quantity", "Set Code", "Collector Number", "Board"].join(separator);
    const row = ['"Thalia, Guardian of Thraben"', "2", "DKA", "24", "sideboard"].join(separator);
    assert.deepEqual(parseBrowserDeck(header + "\n" + row), [
      { name: "Thalia, Guardian of Thraben", set: "dka", number: "24", quantity: 2, section: "side" },
    ]);
  }
});

test("static edition asks Scryfall for canonical aliases and retains the collector number", async (t) => {
  const paths = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    paths.push(url.pathname);
    if (url.pathname === "/cards/collection") {
      assert.deepEqual(JSON.parse(options.body), { identifiers: [{ set: "nms", collector_number: "139" }] });
      return Response.json({ data: [] });
    }
    if (url.pathname === "/sets/nms") return Response.json({ code: "nem" });
    assert.match(url.searchParams.get("q"), /set:nem cn:"139"/);
    return Response.json({ data: [{ id: "example", lang: "en", name: "Tangle Wire",
      set: "nem", collector_number: "139", image_uris: { png: "https://cards.scryfall.io/example" } }] });
  });
  const [row] = await browserApi("resolve", { deck: "1 Tangle Wire (NMS) 139" });
  assert.equal(row.card.set, "nem");
  assert.equal(row.card.number, "139");
  assert.deepEqual(paths, ["/cards/collection", "/sets/nms", "/cards/search"]);
});
