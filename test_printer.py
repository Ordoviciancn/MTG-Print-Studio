import io
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from PIL import Image

from cards import SourceError, parse_deck, resolve, community_cards, request
from print_pdf import crop_card, make_pdf
from server import pdf_items


class PrinterTest(unittest.TestCase):
    def test_transient_connection_retries_but_rate_limit_stops(self):
        url = "https://cards.scryfall.io/image.png"
        with patch("cards.build_opener") as opener, patch("cards.time.sleep"):
            open_url = opener.return_value.open
            truncated, complete = io.BytesIO(b"im"), io.BytesIO(b"image")
            truncated.headers = complete.headers = {"Content-Length": "5"}
            open_url.side_effect = [URLError("unexpected TLS EOF"), truncated, complete]
            self.assertEqual(request(url), b"image")
            self.assertEqual(open_url.call_count, 3)
            open_url.reset_mock()
            open_url.side_effect = HTTPError(url, 429, "Rate limited", {}, None)
            with self.assertRaises(SourceError):
                request(url)
            open_url.assert_called_once()

    def test_deck_preserves_prints_and_sections(self):
        rows = parse_deck("Deck\n2 Lightning Bolt (M11) 149\n1x Fire // Ice\nSideboard\nSB: 3 Hydroblast")
        self.assertEqual([(r["quantity"], r["name"], r["set"], r["number"], r["section"]) for r in rows],
                         [(2, "Lightning Bolt", "m11", "149", "main"),
                          (1, "Fire // Ice", "", "", "main"),
                          (3, "Hydroblast", "", "", "side")])

    def test_arena_and_moxfield_exports_keep_letter_prefixes(self):
        rows = parse_deck(
            "About\nName Sample\n\nDeck\n1 Crystal Vein (PLST) MIR-325\n"
            "4 Tinker (PLST) ULG-45 *F*\n\nSideboard (3)\n"
            "1 Rushing River (PLST) PLS-30\n1 Rushing River (PLST) pls-30\n"
            "1 Rushing River (PLS) 30"
        )
        self.assertEqual([(r["quantity"], r["name"], r["set"], r["number"], r["section"]) for r in rows],
                         [(1, "Crystal Vein", "plst", "MIR-325", "main"),
                          (4, "Tinker", "plst", "ULG-45", "main"),
                          (2, "Rushing River", "plst", "PLS-30", "side"),
                          (1, "Rushing River", "pls", "30", "side")])

    def test_bracket_printings_and_plain_text_variations(self):
        rows = parse_deck("NAME: Sample\n[Main]\n4 [MH1:218] Altar of Dementia\n"
                          "1 [INV] Tsabo's Web\n[Sideboard]\n"
                          "SB: 3xOverload [INV:157]\nMana Short x1\n")
        self.assertEqual([(r["quantity"], r["name"], r["set"], r["number"], r["section"]) for r in rows],
                         [(4, "Altar of Dementia", "mh1", "218", "main"),
                          (1, "Tsabo's Web", "inv", "", "main"),
                          (3, "Overload", "inv", "157", "side"),
                          (1, "Mana Short", "", "", "side")])

    def test_csv_and_tsv_detect_columns_without_splitting_card_names(self):
        for delimiter in (",", "\t"):
            with self.subTest(delimiter=delimiter):
                header = delimiter.join(["Count", "Name", "Edition", "Collector Number", "Board"])
                row = delimiter.join(["1", '"Thalia, Guardian of Thraben"', "DKA", "24", "sideboard"])
                [item] = parse_deck("\ufeff" + header + "\n" + row)
                self.assertEqual((item["name"], item["set"], item["number"], item["section"]),
                                 ("Thalia, Guardian of Thraben", "dka", "24", "side"))

    def test_collection_preserves_number_case_and_matches_set_only(self):
        reprint = {"id": "vein", "name": "Crystal Vein", "set": "plst", "collector_number": "MIR-325",
                   "lang": "en", "image_uris": {"png": "image"}}
        other = dict(reprint, id="other", set="c14", collector_number="290")
        with patch("cards.json_request", side_effect=[{"data": [other, reprint]}, {"code": "mir"},
                                                      {"data": []}]) as call:
            rows = resolve("1 Crystal Vein (PLST) MIR-325\n2 [C14] Crystal Vein\n1 [MIR] Crystal Vein")
        self.assertEqual([row["card"]["id"] if row["card"] else None for row in rows], ["vein", "other", None])
        self.assertIn({"set": "plst", "collector_number": "MIR-325"}, call.call_args_list[0].args[1]["identifiers"])
        self.assertNotIn("cn%3A", call.call_args_list[2].args[0])

    def test_set_alias_uses_the_same_collector_number(self):
        card = {"id": "nem139", "name": "Tangle Wire", "set": "nem", "collector_number": "139",
                "lang": "en", "image_uris": {"png": "image"}}
        with patch("cards.json_request", side_effect=[{"data": []}, {"code": "nem"},
                                                      {"data": [card]}]) as call:
            [row] = resolve("3 Tangle Wire (NMS) 139")
        self.assertEqual((row["card"]["set"], row["card"]["number"]), ("nem", "139"))
        self.assertTrue(call.call_args_list[1].args[0].endswith("/sets/nms"))
        self.assertIn("set%3Anem", call.call_args_list[2].args[0])

    def test_collection_never_substitutes_another_print(self):
        other = {"name": "Lightning Bolt", "set": "m10", "collector_number": "146", "lang": "en"}
        with patch("cards.json_request", side_effect=[{"data": [other]}, {"code": "m11"}, {"data": []}]):
            self.assertIsNone(resolve("1 Lightning Bolt (M11) 149")[0]["card"])

    def test_community_keeps_exact_match_separate(self):
        a = {"name": "Lightning Bolt [M11] {149}", "dpi": 800, "downloadLink": "https://drive.google.com/file"}
        b = {"name": "Lightning Bolt [M10] {146}", "dpi": 1200, "downloadLink": "https://drive.google.com/file"}
        with patch("cards.json_request", side_effect=[{"results": [{"pk": 1}]},
                   {"results": {"Lightning Bolt": {"CARD": ["a", "b"]}}},
                   {"results": {"a": a, "b": b}}]):
            items = community_cards("Lightning Bolt", "m11", "149")
        self.assertEqual([(x["id"], x["match"]) for x in items], [("a", True), ("b", False)])

    def test_crop_uses_trim_dimensions_at_source_resolution(self):
        im = Image.new("RGB", (3288, 4488))
        self.assertEqual(crop_card(im, 1200).size, (2976, 4157))

    def test_pdf_page_count_card_size_and_image_reuse(self):
        image = Image.new("RGB", (63, 88), "navy")
        result = make_pdf([("sample", image, 10)])
        self.assertIn(b"/Count 2", result)
        self.assertIn(b"/MediaBox [0 0 595.275591 841.889764]", result)
        self.assertIn(b"178.582677 0 0 249.448819", result)
        self.assertEqual(result.count(b"/Subtype /Image"), 1)

    def test_mixed_source_double_face_keeps_the_official_back_uncropped(self):
        source = io.BytesIO()
        Image.new("RGB", (820, 1120)).save(source, format="PNG")
        with patch("server.request", return_value=source.getvalue()):
            items = pdf_items({"rows": [{"quantity": 2, "faces": [
                {"url": "community", "ppi": 300}, {"url": "official", "ppi": 0}
            ]}]})
            self.assertEqual([(image.size, count) for _, image, count in items],
                             [((744, 1039), 2), ((820, 1120), 2)])


if __name__ == "__main__":
    unittest.main()
