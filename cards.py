import functools
from http.client import IncompleteRead
import json
import re
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from decklists import MAX_DECK, parse_deck

SCRY = "https://api.scryfall.com"
MPC = "https://mpcfill.com"
USER_AGENT = "MTGPrintStudio/1.0 (local print tool)"
REQUEST_LOCK = threading.Lock()
LAST_REQUEST = {}


class SourceError(Exception):
    pass


def safe_url(url):
    if not isinstance(url, str):
        return False
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        return (parsed.scheme == "https" and parsed.port in (443, None)
                and parsed.username is None and parsed.password is None
                and (host in {"api.scryfall.com", "mpcfill.com", "mpcautofill.com",
                              "drive.google.com", "drive.usercontent.google.com",
                              "lh3.googleusercontent.com"}
                     or host.endswith((".scryfall.io", ".mpcfill.com", ".mpcautofill.com",
                                       ".googleusercontent.com"))))
    except ValueError:
        return False


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not safe_url(newurl):
            raise SourceError("Unsafe image redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def request(url, payload=None, limit=4_000_000, accept="application/json"):
    if not safe_url(url):
        raise SourceError("Unsupported source URL")
    host = urlsplit(url).hostname
    if host in {"api.scryfall.com", "mpcfill.com"}:
        with REQUEST_LOCK:
            interval = 0.15 if host == "api.scryfall.com" else 1.5
            time.sleep(max(0, LAST_REQUEST.get(host, 0) + interval - time.monotonic()))
            LAST_REQUEST[host] = time.monotonic()
    headers = {"User-Agent": USER_AGENT, "Accept": accept}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    data = None if payload is None else json.dumps(payload).encode()
    opener = build_opener(SafeRedirect())
    for attempt in range(3):
        try:
            with opener.open(Request(url, data, headers), timeout=18) as response:
                content = response.read(limit + 1)
                expected = response.headers.get("Content-Length")
                if expected and expected.isdigit() and len(content) < min(int(expected), limit + 1):
                    raise IncompleteRead(content, int(expected) - len(content))
            break
        except (OSError, IncompleteRead) as error:
            retryable = not isinstance(error, HTTPError) or error.code in {502, 503, 504}
            if attempt == 2 or not retryable:
                raise SourceError(f"{host}: {error}") from error
            time.sleep(1.5 * (attempt + 1))
    if len(content) > limit:
        raise SourceError(f"{host}: response too large")
    return content


def json_request(url, payload=None):
    try:
        return json.loads(request(url, payload))
    except (ValueError, UnicodeError) as error:
        raise SourceError("Source returned invalid JSON") from error


def images(card):
    sides = [card["image_uris"]] if card.get("image_uris") else [
        face.get("image_uris", {}) for face in card.get("card_faces", [])]
    return [{"full": side.get("png") or side.get("large") or side.get("normal"),
             "thumb": side.get("normal") or side.get("large") or side.get("png")}
            for side in sides if side.get("png") or side.get("large") or side.get("normal")]


def pack(card):
    return {"id": card["id"], "name": card["name"], "set": card["set"],
            "number": card["collector_number"], "edition": card.get("set_name", ""),
            "artist": card.get("artist", ""), "oracle": card.get("oracle_id"),
            "illustration": card.get("illustration_id"), "status": card.get("image_status"),
            "faces": images(card), "source": "scryfall"}


def name_matches(query, card):
    name = card["name"].casefold()
    return query.casefold() in {name, name.split(" // ")[0]}


def eligible(card):
    return card.get("lang") == "en" and not card.get("digital") and bool(images(card))


def query_cards(query):
    url = SCRY + "/cards/search?" + urlencode({"q": query, "unique": "prints",
                                               "include_variations": "true"})
    result = []
    while url:
        try:
            data = json_request(url)
        except SourceError as error:
            if "HTTP Error 404:" in str(error):
                return result
            raise
        result.extend(data.get("data", []))
        url = data.get("next_page") if data.get("has_more") else None
    return result


def quote(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


@functools.lru_cache(maxsize=128)
def printings(oracle, name):
    identity = f"oracleid:{oracle}" if oracle else "!" + quote(name)
    variants = [pack(card) for card in query_cards(f"{identity} lang:en game:paper")
                if eligible(card)]
    variants.sort(key=lambda card: card["status"] != "highres_scan")
    return variants


@functools.lru_cache(maxsize=128)
def canonical_set(code):
    try:
        return json_request(SCRY + "/sets/" + code)["code"]
    except SourceError as error:
        if "HTTP Error 404:" in str(error):
            return None
        raise


def resolve(deck):
    rows = parse_deck(deck)
    pool = []
    identifiers = list({
        (("set", row["set"]), ("collector_number", row["number"])) if row["number"]
        else (("name", row["name"]),) for row in rows
    })
    for start in range(0, len(identifiers), 75):
        collection = {"identifiers": [dict(item) for item in identifiers[start:start + 75]]}
        pool.extend(json_request(SCRY + "/cards/collection", collection).get("data", []))
    pool = [card for card in pool if eligible(card)]
    for row in rows:
        edition = row["set"]

        def matches(card):
            return (name_matches(row["name"], card)
                    and (not edition or card["set"] == edition)
                    and (not row["number"] or card["collector_number"].casefold() == row["number"].casefold()))

        card = next((card for card in pool if matches(card)), None)
        if card is None and edition:
            edition = canonical_set(edition)
            if edition is None:
                row["card"] = None
                continue
            if edition != row["set"]:
                card = next((card for card in pool if matches(card)), None)
        if card is None:
            query = "!" + quote(row["name"]) + " lang:en game:paper"
            if edition:
                query += f" set:{edition}"
            if row["number"]:
                query += f" cn:{quote(row['number'])}"
            card = next((item for item in query_cards(query) if eligible(item) and matches(item)), None)
        row["card"] = pack(card) if card else None
    return rows


@functools.lru_cache(maxsize=1)
def community_sources():
    results = json_request(MPC + "/2/sources/").get("results", [])
    return [[item["pk"] if isinstance(item, dict) else item, True] for item in results]


@functools.lru_cache(maxsize=64)
def community_cards(name, edition, number):
    base_name = name.split(" // ")[0]
    settings = {
        "searchTypeSettings": {"fuzzySearch": False, "filterCardbacks": False},
        "sourceSettings": {"sources": community_sources()},
        "filterSettings": {"minimumDPI": 0, "maximumDPI": 2400, "maximumSize": 30,
                           "includesTags": [], "excludesTags": [], "languages": []},
    }
    result = json_request(MPC + "/2/editorSearch/", {
        "searchSettings": settings, "queries": [{"query": base_name, "cardType": "CARD"}],
    })
    ids = list(dict.fromkeys(item for group in result.get("results", {}).values()
                             for item in group.get("CARD", [])))[:1000]
    results = {}
    for start in range(0, len(ids), 500):
        data = json_request(MPC + "/2/cards/", {"cardIdentifiers": ids[start:start + 500]})
        results.update(data.get("results", {}))
    cards = []
    for key in ids:
        card = results.get(key, {})
        title = card.get("name", "")
        url = card.get("downloadLink", "")
        if not safe_url(url):
            continue
        lang = str(card.get("language") or card.get("lang") or "").casefold()
        if lang and lang not in {"en", "eng", "english"}:
            continue
        marker = re.search(r"\[([A-Za-z0-9]+)\]\s*\{([^}]+)\}", title)
        match = bool(marker and (marker[1].lower(), marker[2].casefold()) == (edition, number.casefold()))
        dpi = card.get("dpi")
        if not isinstance(dpi, (int, float)) or not 100 <= dpi <= 3000:
            continue
        cards.append({"id": key, "name": title, "edition": card.get("sourceName", ""),
                      "dpi": dpi, "match": match, "language": lang, "source": "mpc",
                      "faces": [{"full": url, "thumb": card.get("mediumThumbnailUrl")
                                 or card.get("smallThumbnailUrl") or url}]})
    return sorted(cards, key=lambda item: (item["match"], item["dpi"]), reverse=True)[:200]
