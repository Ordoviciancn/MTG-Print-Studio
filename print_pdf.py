import zlib

from PIL import Image

MM = 72 / 25.4
PAGE_WIDTH, PAGE_HEIGHT = 210, 297
CARD_WIDTH, CARD_HEIGHT = 63, 88
GAP = 2
LEFT = (PAGE_WIDTH - 3 * CARD_WIDTH - 2 * GAP) / 2
BOTTOM = (PAGE_HEIGHT - 3 * CARD_HEIGHT - 2 * GAP) / 2


def crop_card(image, ppi):
    if not 100 <= ppi <= 3000:
        raise ValueError("Community image requires a known source PPI")
    width, height = round(CARD_WIDTH * ppi / 25.4), round(CARD_HEIGHT * ppi / 25.4)
    if width > image.width + 2 or height > image.height + 2:
        raise ValueError("Community source dimensions do not match the stated PPI")
    width, height = min(width, image.width), min(height, image.height)
    x, y = (image.width - width) // 2, (image.height - height) // 2
    return image.crop((x, y, x + width, y + height))


def coords(*values):
    return " ".join(f"{value * MM:.6f}" for value in values)


def marks(slots):
    # Short, separated marks keep ink out of each card's trim rectangle.
    commands = ["0.45 G 0.28 w"]
    x_edges = {x + dx for x, _ in slots for dx in (0, CARD_WIDTH)}
    y_edges = {y + dy for _, y in slots for dy in (0, CARD_HEIGHT)}
    for x in sorted(x_edges):
        for y, direction in [(PAGE_HEIGHT - BOTTOM, 1), (min(y for _, y in slots), -1)]:
            commands.append(f"{coords(x, y + direction)} m {coords(x, y + 4 * direction)} l S")
    for y in sorted(y_edges):
        right = max(x for x, _ in slots) + CARD_WIDTH
        commands.append(f"{coords(LEFT - 4, y)} m {coords(LEFT - 1, y)} l S")
        commands.append(f"{coords(right + 1, y)} m {coords(right + 4, y)} l S")
    commands += ["0 G 0.5 w", f"{coords(LEFT, 7)} m {coords(LEFT + 50, 7)} l S",
                 f"{coords(LEFT, 6)} m {coords(LEFT, 8)} l S",
                 f"{coords(LEFT + 50, 6)} m {coords(LEFT + 50, 8)} l S",
                 f"BT /F1 7 Tf {coords(LEFT + 53, 6)} Td (50 mm / 100%) Tj ET"]
    return "\n".join(commands)


def make_pdf(items):
    objects = [b"", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    images = {}
    cards = []
    pages = []

    def add(data):
        objects.append(data.encode("ascii") if isinstance(data, str) else data)
        return len(objects)

    def stream(data, extra=""):
        return add(f"<< /Length {len(data)} {extra} >>\nstream\n".encode()
                   + data + b"\nendstream")

    for key, image, copies in items:
        if key not in images:
            if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
                rgba = image.convert("RGBA")
                rgb = Image.new("RGB", image.size, "white")
                rgb.paste(rgba, mask=rgba.getchannel("A"))
            else:
                rgb = image.convert("RGB")
            images[key] = stream(zlib.compress(rgb.tobytes(), 4),
                f"/Type /XObject /Subtype /Image /Width {rgb.width} /Height {rgb.height} "
                "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode")
        cards.extend([images[key]] * copies)

    if not cards:
        raise ValueError("No card faces to print")
    for start in range(0, len(cards), 9):
        slots, operators = [], []
        page_cards = cards[start:start + 9]
        for index, image_id in enumerate(page_cards):
            x = LEFT + (index % 3) * (CARD_WIDTH + GAP)
            y = PAGE_HEIGHT - BOTTOM - CARD_HEIGHT - (index // 3) * (CARD_HEIGHT + GAP)
            slots.append((x, y))
            operators.append(f"q {coords(CARD_WIDTH)} 0 0 {coords(CARD_HEIGHT, x, y)} cm /I{image_id} Do Q")
        content = stream(("\n".join(operators) + "\n" + marks(slots)).encode())
        resources = " ".join(f"/I{i} {i} 0 R" for i in sorted(set(page_cards)))
        pages.append(add(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {coords(PAGE_WIDTH, PAGE_HEIGHT)}] "
                         f"/Resources << /XObject << {resources} >> /Font << /F1 3 0 R >> >> "
                         f"/Contents {content} 0 R >>"))
    kids = " ".join(f"{page} 0 R" for page in pages)
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R /ViewerPreferences << /PrintScaling /None >> >>"
    objects[1] = f"<< /Type /Pages /Count {len(pages)} /Kids [{kids}] >>".encode()
    pdf = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, data in enumerate(objects, 1):
        offsets.append(len(pdf))
        pdf.extend(f"{index} 0 obj\n".encode() + data + b"\nendobj\n")
    start = len(pdf)
    pdf.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode())
    pdf.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode())
    return bytes(pdf)
