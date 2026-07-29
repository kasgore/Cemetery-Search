"""Extract the City of Ithaca's cemetery-map spreadsheet into a lot grid.

Source: https://www.ithacami.com/download/9476/cemetery-map.xlsx (public, City
of Ithaca "CEMETERY MAP"). Each sheet is one section of the cemetery; cells
hold lot numbers laid out in their real spatial arrangement (owner-family
names sit in the row beneath each lot row), so a cell's (column, row) is a
faithful relative position — georeferenceable against GPS-tagged memorials.

Output: ithaca-grid.json  [{sheet, lot, col, row}, ...]
Usage: python extract-ithaca-grid.py <xlsx> [out.json]
"""
import json
import re
import sys
import zipfile

LOT_RE = re.compile(r"^(\d{1,4})([A-Z]?)$")


def col_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "cemetery-map.xlsx"
    out_path = sys.argv[2] if len(sys.argv) > 2 else "ithaca-grid.json"
    z = zipfile.ZipFile(src)

    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        raw = z.read("xl/sharedStrings.xml").decode("utf-8", "replace")
        for si in re.findall(r"<si>(.*?)</si>", raw, re.S):
            shared.append("".join(re.findall(r"<t[^>]*>(.*?)</t>", si, re.S)))

    wb = z.read("xl/workbook.xml").decode("utf-8", "replace")
    rels = z.read("xl/_rels/workbook.xml.rels").decode("utf-8", "replace")
    rel_map = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels))
    sheets = re.findall(r'<sheet name="([^"]+)"[^>]*r:id="(rId\d+)"', wb)

    rows = []
    for name, rid in sheets:
        target = rel_map.get(rid, "")
        part = "xl/" + target.lstrip("/")
        if part not in z.namelist():
            continue
        xml = z.read(part).decode("utf-8", "replace")
        sheet_name = name.replace("&amp;", "&").strip()
        for m in re.finditer(r'<c r="([A-Z]+)(\d+)"([^>]*)>(.*?)</c>', xml, re.S):
            col, row, attrs, body = m.groups()
            v = re.search(r"<v>(.*?)</v>", body, re.S)
            if not v:
                continue
            val = v.group(1)
            if 't="s"' in attrs:
                idx = int(val)
                val = shared[idx] if idx < len(shared) else val
            val = val.strip()
            hit = LOT_RE.match(val)
            if not hit:
                continue
            rows.append({
                "sheet": sheet_name,
                "lot": hit.group(1).lstrip("0") or "0",
                "suffix": hit.group(2),
                "col": col_index(col),
                "row": int(row),
            })

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(rows, f)
    per = {}
    for r in rows:
        per[r["sheet"]] = per.get(r["sheet"], 0) + 1
    print(f"wrote {out_path}: {len(rows)} lot cells")
    for s, n in sorted(per.items(), key=lambda x: -x[1]):
        print(f"  {s}: {n}")


if __name__ == "__main__":
    main()
