#!/usr/bin/env python3
# MIT License
#
# Copyright (c) 2026 the BhopalMLS authors, IISER Bhopal
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
# associated documentation files (the "Software"), to deal in the Software without restriction,
# including without limitation the rights to use, copy, modify, merge, publish, distribute,
# sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions: the above copyright notice and this
# permission notice shall be included in all copies or substantial portions of the Software.
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
"""Download BhopalMLS v1.0 from LiDAVerse straight to disk, with checksum verification.

The dataset page downloads into browser memory, which fails for the 23 GB benchmark files. This
script logs in to LiDAVerse with your account, streams each file to disk, checks it, and puts it at
its release path (README.md, benchmark/..., npz/..., metadata/..., tools/...).

  python3 bhopalmls_download.py --list
  python3 bhopalmls_download.py --release international                     # docs + sample (0.5 GB)
  python3 bhopalmls_download.py --release international --files benchmark   # the paper's two H5 (46 GB)
  python3 bhopalmls_download.py --release international --files all --out /data/BhopalMLS

--release   india: absolute coordinates, for users in India only (National Geospatial Policy 2022);
            international: the same data with the absolute offset withheld, for everyone else.
--files     docs, sample, benchmark, npz, metadata, tools, all, or release paths such as
            npz/Bhopal_6.npz (default: docs sample).

You need a LiDAVerse account (sign up at https://lidaverse.com). The licence is CC BY-NC-SA 4.0 with
terms of access (LICENSE.md). Python 3.8 or later, standard library only.

Security: the password is read with getpass (hidden, never an argument, never stored or printed);
the login token stays in memory and is only sent to superadmin.lidaverse.com over verified HTTPS;
redirects are refused; file names from the server are ignored (every file goes to its known release
path, and zip entries that would land outside it are refused); every file is checked against SHA-256
before it is kept, and a failed file is set aside as *.bad, never put in place. The international
checksums are built into this script; the India checksums are not (they are only for users in
India), so for --release india the script first fetches SHA256SUMS from the India release with your
login and checks everything against it. Downloads write to *.part and resume when the server allows.
"""
import argparse
import getpass
import hashlib
import json
import re
import shutil
import ssl
import sys
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

API = "https://superadmin.lidaverse.com/api"
HOST = "superadmin.lidaverse.com"
CHUNK = 1 << 20
MAX_UNKNOWN_MEMBER = 64 << 20  # cap for a zip entry whose size is not known in advance (largest real: 1.4 MB)

# LiDAVerse file label -> release path ("/" at the end: a folder, delivered as a zip)
LABELS = {
    "README.md (data card)": "README.md",
    "LICENSE.md": "LICENSE.md",
    "SHA256SUMS": "SHA256SUMS",
    "Sample: 24 scenes": "sample/bhopalmls_sample_v2.tar.gz",
    "Benchmark v9 (62 classes)": "benchmark/bhopal_scene_v9_normals_rgb.h5",
    "Benchmark v10 (68 classes)": "benchmark/bhopal_scene_v10_train_1234_val_56_test_78.h5",
    **{f"Path {n}: labelled": f"npz/Bhopal_{n}.npz" for n in range(1, 9)},
    **{f"Path {n}: unlabelled + moving": f"npz/Bhopal_{n}_Unlabelled.npz" for n in range(1, 9)},
    "Metadata (class tables, splits, scene cuts)": "metadata/",
    "Tools (Python)": "tools/",
}
GROUPS = {
    "docs": ["README.md", "LICENSE.md", "SHA256SUMS"],
    "sample": ["sample/bhopalmls_sample_v2.tar.gz"],
    "benchmark": [p for p in LABELS.values() if p.startswith("benchmark/")],
    "npz": [p for p in LABELS.values() if p.startswith("npz/")],
    "metadata": ["metadata/"],
    "tools": ["tools/"],
}
GROUPS["all"] = list(LABELS.values())

# BEGIN GENERATED (make_download_script.py from hosting/files_international.tsv; do not edit by hand)
RELEASES = {
    'india': {
        'dataset': 13,
        'note': 'absolute coordinates (UTM 43N); for users in India only',
        'files': None,  # checksums fetched from the India release after login
    },
    'international': {
        'dataset': 14,
        'note': 'absolute offset withheld; for users outside India (and anyone)',
        'files': {
            'LICENSE.md': (2519, '70d80296260b69714f6c9f1af22f0d18392553fd08fa199ca6a910fa5d9c640b'),
            'README.md': (11364, 'a79953495796204777c298e17ee4f32e319110d831bc5030b40c18f2c52a85c8'),
            'SHA256SUMS': (3412, '04dfe60d3aca0e653772ff4cc8dd3e52a3c8fce36fad74e59d2a57325b49c957'),
            'benchmark/bhopal_scene_v10_train_1234_val_56_test_78.h5': (23390018810, '0e9e3cceffa2ac674c82f897b0c2a4701e1cab3da8e45d4662a9a8851f34ebd9'),
            'benchmark/bhopal_scene_v9_normals_rgb.h5': (22999648721, 'de6425b868d4eea13a47201b47c332f8eaf1c11df62fee4c417fe7466eea50e3'),
            'metadata/BhopalMLS_62class_colour_mapping.txt': (8942, '0893258021f0f1c6b268fc0bd9a9b1181d0d3d1dbc91ce24f28e223e75b23dd5'),
            'metadata/BhopalMLS_71class_colour_mapping.txt': (8015, 'e100e107390b574f21317ea178be8a3204cf353eeabc8d1b3dd4a6cfbbc090fd'),
            'metadata/Bhopal_class_mapping_V13.csv': (1459, '9a7669e4945f5ca2da91004430501c899f93498a33465b9ed54eebd78cd610e3'),
            'metadata/Bhopal_class_mapping_V13_TRAINING.csv': (1480, '5afef7343e91deee7199a33047adbca104a6c99797725054ab8406a3621a9b60'),
            'metadata/Bhopal_class_mapping_V13_TRAINING_v10h5.csv': (1630, 'c5e3abb0203fa107ac36e7527b36b50d040720614bd6854b95137652ffad6555'),
            'metadata/README_CLASS_MAPPINGS.md': (4933, '1b5e7f5db3ddf6edfe55448a181d3f9e0b89594d40c3c854b851c2b95ad501ac'),
            'metadata/label_codes.json': (28603, '03d535cbfa9fa9217317e1098b6694976b2a26a2126fe153fb53cc7f7667571e'),
            'metadata/scene_division.zip': (1434498, '9dae93e4077a93691b63e479ccb4d16cf5957bd07e34d5229671872db011b955'),
            'metadata/splits.json': (131972, 'a802a12dea9bbd4af75b26fe45f48e16f726e940a1a5888a6eec07593126ac9a'),
            'npz/Bhopal_1.npz': (6445032676, '28ff394746a2200b5f5797ee02b3dc2bc5eed992b6ddf63f71bbffb90cf95853'),
            'npz/Bhopal_1_Unlabelled.npz': (367758896, 'c59dff8c1e8ab34a1874ee34ed3d99baa4dee959c6fa60b0df47e7d3ce4e9706'),
            'npz/Bhopal_2.npz': (9848463862, '56011bce852665433fce566209f002e97553c554eda23b6fe6260f4bcdd55a2d'),
            'npz/Bhopal_2_Unlabelled.npz': (445295381, '4bd04dee18443c125bc6b5675886fb0a916d9acf9d424c5cf7ced45e29d1ba35'),
            'npz/Bhopal_3.npz': (4490290836, '45d7b8f3ed12507ff37f4c7b3f501709a94d25ced7005dcbef550a7fcf3e5501'),
            'npz/Bhopal_3_Unlabelled.npz': (201458998, 'a5e8fde5702c7412374b17a3bfe797c2eae35ad1582116c3c5c53613648f86e1'),
            'npz/Bhopal_4.npz': (7458459312, 'ffe8fbce20865c5df39a6e5d43328c355fa05e0d320d49211cfa72f32117611b'),
            'npz/Bhopal_4_Unlabelled.npz': (562207321, '923ec61b52b65c956834f8808cac2d112f768ba986088f41481df1c28e196994'),
            'npz/Bhopal_5.npz': (6450605652, 'f52aaf478036c7df63fa07a2bf561b4921259bf3b83111775bffa963f591ceb9'),
            'npz/Bhopal_5_Unlabelled.npz': (221000417, '7a58a5c51311684c25a3cf37f74fd0556f286545c175b10fa07d88e2c4cd67c0'),
            'npz/Bhopal_6.npz': (3599245280, '762612da97bf9590c960c6155850ef5e37667a736260f70d1e6a8e3a7e276b68'),
            'npz/Bhopal_6_Unlabelled.npz': (115839877, '58ab51943bda419b9d6eef7db2548bc9bf739b4672d1d6b18f1629843d40ac85'),
            'npz/Bhopal_7.npz': (4910332559, 'cbe03be5a006daafe3891666ba48dfcf0368ff5000621d7f12b5aba400e2510d'),
            'npz/Bhopal_7_Unlabelled.npz': (168353488, '8fb0830029bb65e40ce5edbe1110603e44201011a59c0465c4ba5634561fe295'),
            'npz/Bhopal_8.npz': (3799530348, 'dbf8891493ac25105d512ca65df6c2212cc5b197fa0d6acebd2ae26314157179'),
            'npz/Bhopal_8_Unlabelled.npz': (214284240, 'f58b7c54f3ae0175064383972d5e5c61955c712ae8c40e4be04ba02df3c3c638'),
            'sample/bhopalmls_sample_v2.tar.gz': (529858418, 'a9a8a073f405668d07145d6fe946fe30baf4be229cabb6d78dc22e95891e1796'),
            'tools/README.md': (4258, 'd1ad512f3080fbbf2b70722bff2ec08441fcedc29b9f795f12ef2a34b5adcf7e'),
            'tools/bhopal_h5_dataset.py': (14788, '263183716df492abdd8e963c0312ffb5464c162ab90387df1152fe8bd3ca7575'),
            'tools/convert_npz.py': (10429, '50e9089050b1d4f94ab7045a2bc6af71a7475f61eba501f9fce830fd97da9fa5'),
            'tools/reference/19b_create_scene_V10_dataset.py': (72133, '43d5c4a9fd5be318aec4e18ca865a84bb19b90f5f776e85c4f27285af81397b3'),
            'tools/reference/19b_create_scene_V9_dataset.py': (61164, '620a6349a44274a342f5d89671632cb501aae563ca8b50144bad860135a664d1'),
            'tools/reference/README.md': (2099, '14f82db6694d7f4925551be7f0b7a2fce25ca9704a801bb6e1f5739bd301a623'),
        },
    },
}
# END GENERATED


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, f"refused redirect to {newurl}", headers, fp)


OPENER = urllib.request.build_opener(
    urllib.request.HTTPSHandler(context=ssl.create_default_context()), NoRedirect)


def request(url, token=None, data=None, headers=None, timeout=60):
    if not url.startswith(f"https://{HOST}/"):
        sys.exit(f"refusing to contact {url}: only https://{HOST}/ is allowed")
    h = {"Accept": "application/json", "User-Agent": "bhopalmls-download/1.0"}
    if data is not None:
        data = json.dumps(data).encode()
        h["Content-Type"] = "application/json"
    if token:
        h["Authorization"] = f"Bearer {token}"
    h.update(headers or {})
    return OPENER.open(urllib.request.Request(url, data=data, headers=h), timeout=timeout)


def login(email):
    password = getpass.getpass(f"LiDAVerse password for {email}: ")
    try:
        with request(f"{API}/auth/login", data={"email": email, "password": password}) as r:
            body = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"login failed (HTTP {e.code}); check the email and password")
    finally:
        del password
    token = (body.get("data") or {}).get("token")
    if not body.get("success") or not token:
        sys.exit(f"login failed: {body.get('message', 'no token returned')}")
    return token


def logout(token):
    try:
        request(f"{API}/auth/logout", token=token, data={}, timeout=15).close()
    except (urllib.error.URLError, OSError):
        pass


def site_files(dataset, token):
    with request(f"{API}/datasets/{dataset}", token=token) as r:
        files = json.load(r)["data"]["files"]
    return {LABELS[f["file_label"]]: f for f in files if f.get("file_label") in LABELS}


def india_checksums(files, token):
    """SHA256SUMS of the India release, fetched with the user's login (never shipped in this script)."""
    f = files.get("SHA256SUMS")
    if not f or not f.get("can_download"):
        sys.exit("this account cannot download the India release here (users in India only)")
    with request(f["download_endpoint"], token=token, headers={"Accept": "*/*"}) as r:
        text = r.read(1 << 20).decode("utf-8")
    table = {}
    for line in text.splitlines():
        m = re.fullmatch(r"([0-9a-f]{64}) [ *](\S.*)", line.strip())
        if m:
            table[m.group(2)] = (None, m.group(1))
    if len(table) < 30:
        sys.exit("the India SHA256SUMS looks wrong; stopping")
    return table, text


def safe_target(root, rel):
    target = (root / rel).resolve()
    if root.resolve() not in target.parents:
        sys.exit(f"refusing to write outside {root}: {rel}")
    return target


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(CHUNK * 8), b""):
            h.update(block)
    return h.hexdigest()


def fetch(url, token, part, size):
    """Stream url into part, continuing an existing part file when the server allows it."""
    have = part.stat().st_size if part.exists() else 0
    headers = {"Accept": "*/*"}
    if have and (size is None or have < size):
        headers["Range"] = f"bytes={have}-"
    with request(url, token=token, headers=headers, timeout=120) as r:
        if have and r.status != 206:
            have = 0  # the server sent the whole file again: start over
        total = size or (have + int(r.headers.get("Content-Length") or 0)) or None
        got, t0, shown = have, time.time(), 0.0
        with open(part, "ab" if have else "wb") as fh:
            while True:
                block = r.read(CHUNK)
                if not block:
                    break
                fh.write(block)
                got += len(block)
                now = time.time()
                if now - shown > 1:
                    rate = (got - have) / max(now - t0, 1e-6)
                    pct = f"{100 * got / total:5.1f}%" if total else ""
                    eta = f" ETA {int((total - got) / rate)}s" if total and rate > 0 else ""
                    print(f"\r   {got / 1e9:7.2f} GB {pct} {rate / 1e6:6.1f} MB/s{eta}   ", end="", file=sys.stderr)
                    shown = now
    print(file=sys.stderr)


def get_file(rel, f, token, root, table):
    size, want = table[rel]
    size = size or f.get("file_size_bytes")
    target = safe_target(root, rel)
    if target.exists() and (size is None or target.stat().st_size == size) and sha256(target) == want:
        print(f"   {rel}: already here and verified")
        return True
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_name(target.name + ".part")
    if not (part.exists() and size and part.stat().st_size == size):
        fetch(f["download_endpoint"], token, part, size)
    if (size and part.stat().st_size != size) or sha256(part) != want:
        bad = target.with_name(target.name + ".bad")
        part.replace(bad)
        print(f"   {rel}: CHECKSUM FAILED, kept as {bad.name}; run again to retry")
        return False
    part.replace(target)
    print(f"   {rel}: OK (sha256 verified)")
    return True


def get_folder(rel, f, token, root, table):
    folder = rel.rstrip("/")
    members = {p: v for p, v in table.items() if p.startswith(folder + "/")}
    zpath = safe_target(root, folder + ".zip.part")
    zpath.parent.mkdir(parents=True, exist_ok=True)
    if zpath.exists():
        zpath.unlink()  # built on the fly by the NAS: never resumable
    fetch(f["download_endpoint"], token, zpath, None)
    ok, unexpected = True, 0
    with zipfile.ZipFile(zpath) as z:
        for info in z.infolist():
            name = PurePosixPath(info.filename)
            if info.is_dir():
                continue
            if name.is_absolute() or ".." in name.parts:
                sys.exit(f"refusing unsafe path in {folder}.zip: {info.filename}")
            # the NAS may put the folder itself, or a parent, at the top of the zip
            parts = name.parts[name.parts.index(folder):] if folder in name.parts else (folder,) + name.parts
            member = str(PurePosixPath(*parts))
            if member not in members:
                unexpected += 1
                continue
            size, want = members.pop(member)
            # checked before unpacking, so an oversized entry is never expanded
            if (size is not None and info.file_size != size) or info.file_size > MAX_UNKNOWN_MEMBER:
                print(f"   {member}: unexpected size in the zip ({info.file_size}), not unpacked")
                ok = False
                continue
            target = safe_target(root, member)
            target.parent.mkdir(parents=True, exist_ok=True)
            tmp = target.with_name(target.name + ".part")
            with z.open(info) as src, open(tmp, "wb") as dst:
                shutil.copyfileobj(src, dst, CHUNK)
            if sha256(tmp) != want:
                tmp.replace(target.with_name(target.name + ".bad"))
                print(f"   {member}: CHECKSUM FAILED")
                ok = False
            else:
                tmp.replace(target)
    zpath.unlink()
    if unexpected:
        print(f"   {folder}.zip: skipped {unexpected} unexpected entr{'y' if unexpected == 1 else 'ies'}")
    for missing in members:
        print(f"   {missing}: missing from {folder}.zip")
        ok = False
    print(f"   {rel}: {'OK (every file sha256 verified)' if ok else 'PROBLEMS, see above'}")
    return ok


def wanted_paths(items):
    wanted = []
    for w in items:
        if w in GROUPS:
            paths = GROUPS[w]
        elif w in LABELS.values():
            paths = [w]
        elif w.rstrip("/") + "/" in LABELS.values():
            paths = [w.rstrip("/") + "/"]
        else:
            sys.exit(f"unknown --files entry {w!r}; see --list")
        wanted += [p for p in paths if p not in wanted]
    return wanted


def show_list():
    for name, rel in RELEASES.items():
        print(f"{name} (LiDAVerse dataset {rel['dataset']}): {rel['note']}")
    sizes = RELEASES["international"]["files"]
    print("\n--files groups (sizes of the international release; India sizes differ by up to about 2 %):")
    for g, paths in GROUPS.items():
        if g != "all":
            gb = sum(sizes.get(p, (0,))[0] for p in paths) / 1e9
            print(f"   {g:10s} {gb:7.2f} GB  {', '.join(paths[:3])}{' ...' if len(paths) > 3 else ''}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--release", choices=sorted(RELEASES), help="india or international")
    ap.add_argument("--files", nargs="+", default=["docs", "sample"], metavar="WHAT")
    ap.add_argument("--out", type=Path, help="target folder (default: ./BhopalMLS_<release>)")
    ap.add_argument("--email", help="LiDAVerse account email (asked if not given)")
    ap.add_argument("--list", action="store_true", help="show the release contents and exit")
    a = ap.parse_args()
    if a.list or not a.release:
        show_list()
        if not a.release:
            print("\nchoose a release with --release india|international")
        return

    rel = RELEASES[a.release]
    wanted = wanted_paths(a.files)
    root = (a.out or Path(f"BhopalMLS_{a.release}")).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    print(f"BhopalMLS v1.0, {a.release} release -> {root.resolve()}")
    if a.release == "india":
        print("Note: the India release is for users in India only (National Geospatial Policy 2022).")

    email = a.email or input("LiDAVerse account email: ").strip()
    token = login(email)
    try:
        try:
            files = site_files(rel["dataset"], token)
        except (urllib.error.URLError, OSError, KeyError, ValueError) as e:
            sys.exit(f"could not read the file list from LiDAVerse: {e}")
        if rel["files"] is None:
            table, sums_text = india_checksums(files, token)
        else:
            table, sums_text = rel["files"], None
        need = sum((files.get(p) or {}).get("file_size_bytes") or 0 for p in wanted if not p.endswith("/"))
        free = shutil.disk_usage(root).free
        print(f"{len(wanted)} item(s), {need / 1e9:.2f} GB; {free / 1e9:.1f} GB free")
        if need > free:
            sys.exit("not enough free disk space")
        ok = True
        for p in wanted:
            f = files.get(p)
            print(f"-> {p}")
            if not f:
                print("   not listed on LiDAVerse for this release")
                ok = False
                continue
            if not f.get("can_download"):
                print("   LiDAVerse does not allow this account to download it here"
                      + (" (India release: users in India only)" if a.release == "india" else ""))
                ok = False
                continue
            if p == "SHA256SUMS" and sums_text is not None:
                safe_target(root, p).write_text(sums_text)  # the file every India download was checked against
                print("   SHA256SUMS: saved (fetched first, used for all checks)")
                continue
            try:
                ok &= (get_folder if p.endswith("/") else get_file)(p, f, token, root, table)
            except urllib.error.HTTPError as e:
                print(f"   failed: HTTP {e.code} {e.reason}")
                ok = False
            except (urllib.error.URLError, OSError, zipfile.BadZipFile) as e:
                print(f"   failed: {e}; run the same command again to retry")
                ok = False
    finally:
        logout(token)
        del token
    print("\nDone, all files verified." if ok else "\nFinished with problems (see above).")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\ninterrupted; run the same command again to continue")
