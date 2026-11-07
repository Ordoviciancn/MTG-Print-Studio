import csv
import io
import re

MAX_DECK = 500
MAIN = {"deck", "main", "main deck", "mainboard", "commander", "commanders",
        "companion", "主牌", "主牌组", "指挥官", "行侣"}
SIDE = {"sideboard", "side", "sb", "备牌", "备牌区"}
IGNORED = {"about", "metadata", "maybeboard", "maybe board", "considering"}
SET_CODE = r"[A-Za-z0-9]{2,8}"
NUMBER = r"[^\s\[\](){}]+"
LEADING_COUNT = re.compile(r"(\d+)(?:[xX×]\s*|\s+[xX×]\s+|\s+)(.+)")
TRAILING_COUNT = re.compile(r"(.+?)\s+[xX×]\s*(\d+)")
PAREN_PRINT = re.compile(rf"(.+?)\s+\(({SET_CODE})\)(?:\s+({NUMBER}))?")
FRONT_PRINT = re.compile(rf"\[({SET_CODE})(?::({NUMBER}))?\]\s+(.+)")
BACK_PRINT = re.compile(rf"(.+?)\s+\[({SET_CODE})(?::({NUMBER}))?\](?:\s+({NUMBER}))?")
SIDE_PREFIX = re.compile(r"(?:sb|sideboard|备牌)\s*:\s*", re.IGNORECASE)
EXTRAS = re.compile(r"(?:\s+(?:\*[A-Za-z]+\*|\[(?:foil|etched)\]))+$", re.IGNORECASE)
COLUMNS = {
    "name": ("name", "cardname", "card"),
    "quantity": ("quantity", "qty", "count", "amount", "copies"),
    "set": ("setcode", "editioncode", "set", "edition"),
    "number": ("collectornumber", "collectorno", "cardnumber", "number"),
    "board": ("board", "section", "zone", "sideboard", "category", "categories"),
}


def split_printing(text):
    if match := PAREN_PRINT.fullmatch(text):
        return match.groups()
    if match := FRONT_PRINT.fullmatch(text):
        edition, number, name = match.groups()
        return name, edition, number
    if match := BACK_PRINT.fullmatch(text):
        name, edition, inner, outer = match.groups()
        return name, edition, inner or outer
    return text, "", ""


def text_entries(deck):
    section = "main"
    for line_number, raw in enumerate(deck.splitlines(), 1):
        line = raw.strip().lstrip("\ufeff")
        if not line:
            continue
        comment = line.startswith(("#", "//"))
        heading = re.sub(r"^(?://|#)\s*", "", line)
        heading = re.sub(r"(?:\s*:\s*\d+|\s+\(?\d+\)?)$", "", heading)
        heading = heading.strip("[]: ").casefold()
        if heading in MAIN | SIDE | IGNORED:
            section = "main" if heading in MAIN else "side" if heading in SIDE else None
            continue
        if comment or section is None or re.match(r"(?:name|deck name)\s*:", line, re.IGNORECASE):
            continue
        group = section
        if prefix := SIDE_PREFIX.match(line):
            group, line = "side", line[prefix.end():]
        line = EXTRAS.sub("", line)
        if leading := LEADING_COUNT.fullmatch(line):
            quantity, line = leading.groups()
        elif trailing := TRAILING_COUNT.fullmatch(line):
            line, quantity = trailing.groups()
        else:
            quantity = "1"
        name, edition, number = split_printing(line)
        yield line_number, quantity, name, edition, number, group


def table_header(line):
    for delimiter in (",", "\t", ";"):
        headers = next(csv.reader([line], delimiter=delimiter, skipinitialspace=True))
        positions = {re.sub(r"[^a-z0-9]", "", field.casefold()): index
                     for index, field in enumerate(headers)}
        columns = {key: next((positions[name] for name in names if name in positions), None)
                   for key, names in COLUMNS.items()}
        if columns["name"] is not None and columns["quantity"] is not None:
            return delimiter, columns
    return None


def table_entries(deck, delimiter, columns):
    reader = csv.reader(io.StringIO(deck), delimiter=delimiter, skipinitialspace=True, strict=True)
    next(reader)
    try:
        for fields in reader:
            if not any(value.strip() for value in fields):
                continue
            line_number = reader.line_num

            def field(key):
                index = columns[key]
                return fields[index].strip() if index is not None and index < len(fields) else ""

            board = set(re.split(r"\s*[,;|]\s*", field("board").casefold()))
            if board & IGNORED:
                continue
            side = bool(board & (SIDE | {"true", "yes", "1"}))
            yield (line_number, field("quantity"), field("name"), field("set"),
                   field("number"), "side" if side else "main")
    except csv.Error as error:
        raise ValueError(f"Invalid deck table near line {reader.line_num}") from error


def parse_deck(deck):
    if not isinstance(deck, str):
        raise ValueError("Deck must be text")
    deck = deck.lstrip("\ufeff\r\n").strip()
    if not deck:
        raise ValueError("Empty deck")
    table = table_header(deck.splitlines()[0])
    entries = table_entries(deck, *table) if table else text_entries(deck)
    rows = {}
    total = 0
    for line, count, name, edition, number, section in entries:
        if not name or len(name) > 250 or re.fullmatch(r"\d+\s*[xX×]?", name):
            raise ValueError(f"Missing or invalid card name at line {line}")
        if not re.fullmatch(r"\d{1,3}", count):
            raise ValueError(f"Invalid quantity at line {line}")
        quantity = int(count)
        total += quantity
        if quantity < 1 or total > MAX_DECK:
            raise ValueError(f"Deck quantities must total 1–{MAX_DECK}")
        edition, number = (edition or "").lower(), number or ""
        if edition and not re.fullmatch(SET_CODE, edition):
            raise ValueError(f"Invalid set code at line {line}")
        if number and (not edition or not re.fullmatch(NUMBER, number)):
            raise ValueError(f"Invalid collector number at line {line}")
        key = (name.casefold(), edition, number.casefold(), section)
        row = rows.setdefault(key, {"name": name, "set": edition, "number": number,
                                    "section": section, "quantity": 0})
        row["quantity"] += quantity
    if not rows:
        raise ValueError("Empty deck")
    return list(rows.values())
