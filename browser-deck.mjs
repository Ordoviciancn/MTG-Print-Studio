const main = new Set(["deck", "main", "main deck", "mainboard", "commander", "commanders",
  "companion", "主牌", "主牌组", "指挥官", "行侣"]);
const side = new Set(["sideboard", "side", "sb", "备牌", "备牌区"]);
const ignored = new Set(["about", "metadata", "maybeboard", "maybe board", "considering"]);
const setCode = "[A-Za-z0-9]{2,8}";
const numberToken = "[^\\s\\[\\](){}]+";
const parentheses = new RegExp(`^(.+?)\\s+\\((${setCode})\\)(?:\\s+(${numberToken}))?$`);
const prefix = new RegExp(`^\\[(${setCode})(?::(${numberToken}))?\\]\\s+(.+)$`);
const suffix = new RegExp(`^(.+?)\\s+\\[(${setCode})(?::(${numberToken}))?\\](?:\\s+(${numberToken}))?$`);
const aliases = {
  name: ["name", "cardname", "card"],
  quantity: ["quantity", "qty", "count", "amount", "copies"],
  set: ["setcode", "editioncode", "set", "edition"],
  number: ["collectornumber", "collectorno", "cardnumber", "number"],
  board: ["board", "section", "zone", "sideboard", "category", "categories"],
};

function splitPrinting(text) {
  const paren = text.match(parentheses);
  if (paren) return paren.slice(1);
  const before = text.match(prefix);
  if (before) return [before[3], before[1], before[2]];
  const after = text.match(suffix);
  if (after) return [after[1], after[2], after[3] || after[4]];
  return [text, "", ""];
}

function* textRows(text) {
  let section = "main";
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    let line = raw.trim();
    if (!line) continue;
    const heading = line.replace(/^(?:\/\/|#)\s*/, "")
      .replace(/(?:\s*:\s*\d+|\s+\(?\d+\)?)$/, "")
      .replace(/^[\[\]: ]+|[\[\]: ]+$/g, "").toLowerCase();
    if (main.has(heading) || side.has(heading) || ignored.has(heading)) {
      section = main.has(heading) ? "main" : side.has(heading) ? "side" : "";
      continue;
    }
    if (!section || /^(?:#|\/\/|(?:name|deck name)\s*:)/i.test(line)) continue;
    const tag = line.match(/^(?:sb|sideboard|备牌)\s*:\s*/i);
    if (tag) line = line.slice(tag[0].length);
    line = line.replace(/(?:\s+(?:\*[A-Za-z]+\*|\[(?:foil|etched)\]))+$/i, "");
    let quantity = "1";
    const leading = line.match(/^(\d+)(?:[xX×]\s*|\s+[xX×]\s+|\s+)(.+)$/);
    const trailing = line.match(/^(.+?)\s+[xX×]\s*(\d+)$/);
    if (leading) [, quantity, line] = leading;
    else if (trailing) [, line, quantity] = trailing;
    const [name, set, number] = splitPrinting(line);
    yield { name, set, number, quantity, section: tag ? "side" : section, line: index + 1 };
  }
}

function* csvRows(text, delimiter) {
  let row = [], value = "", quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && !value.trim()) {
      quoted = true;
      value = "";
    } else if (char === delimiter || char === "\n" || char === "\r") {
      row.push(value.trim());
      value = "";
      if (char !== delimiter) {
        yield row;
        row = [];
        if (char === "\r" && text[index + 1] === "\n") index++;
      }
    } else value += char;
  }
  if (quoted) throw new Error("Unclosed quote in deck table");
  if (value || row.length) yield [...row, value.trim()];
}

function detectTable(text) {
  const first = text.split(/\r?\n/, 1)[0];
  for (const delimiter of [",", "\t", ";"]) {
    if (!first.includes(delimiter)) continue;
    let headers;
    try {
      headers = [...csvRows(first, delimiter)][0].map(field => field.toLowerCase().replace(/[^a-z0-9]/g, ""));
    } catch {
      continue;
    }
    const columns = Object.fromEntries(Object.entries(aliases).map(([key, options]) =>
      [key, options.map(alias => headers.indexOf(alias)).find(index => index >= 0)]));
    if (columns.name !== undefined && columns.quantity !== undefined) return { delimiter, columns };
  }
  return null;
}

function* tableRows(text, { delimiter, columns }) {
  let line = 0;
  for (const values of csvRows(text, delimiter)) {
    if (++line === 1 || !values.some(Boolean)) continue;
    const field = key => values[columns[key]] || "";
    const zones = field("board").toLowerCase().split(/\s*[,;|]\s*/);
    if (zones.some(zone => ignored.has(zone))) continue;
    yield { name: field("name"), set: field("set"), number: field("number"),
      quantity: field("quantity"), line, section: zones.some(zone =>
        side.has(zone) || ["true", "yes", "1"].includes(zone)) ? "side" : "main" };
  }
}

export function parseBrowserDeck(input) {
  const text = input.trim();
  if (!text) throw new Error("Empty deck");
  const table = detectTable(text);
  const rows = new Map();
  let copies = 0;
  for (const entry of table ? tableRows(text, table) : textRows(text)) {
    const { name, line, section } = entry;
    const set = (entry.set || "").toLowerCase();
    const number = entry.number || "";
    const quantity = Number(entry.quantity);
    if (!name || name.length > 250 || /^\d+\s*[xX×]?$/.test(name)) {
      throw new Error(`Missing or invalid card name at line ${line}`);
    }
    if (!/^\d{1,3}$/.test(entry.quantity) || quantity < 1 || (copies += quantity) > 500) {
      throw new Error(`Deck quantities must total 1–500 (line ${line})`);
    }
    if ((set && !new RegExp(`^${setCode}$`).test(set))
        || (number && (!set || !new RegExp(`^${numberToken}$`).test(number)))) {
      throw new Error(`Invalid set or collector number at line ${line}`);
    }
    const key = JSON.stringify([name.toLowerCase(), set, number.toLowerCase(), section]);
    const current = rows.get(key);
    if (current) current.quantity += quantity;
    else rows.set(key, { name, set, number, quantity, section });
  }
  if (!rows.size) throw new Error("Empty deck");
  return [...rows.values()];
}
