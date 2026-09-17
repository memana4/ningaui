#!/usr/bin/env python3
"""Assemble the per-browser bundles.

One source tree, two manifests. Everything in core/ is engine-agnostic: the loop, the
tools, the proposal queue, the store, the model adapters, the background host and the
panel. The only thing that differs per target is the manifest and, for Chrome, the
offscreen keepalive document.

The build asserts the cross-browser rules instead of trusting them, because a manifest
that is wrong for its engine fails in ways that look like code bugs.
"""

import json, shutil, sys, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CORE = ROOT / "core"
PLATFORM = ROOT / "platform"
DIST = ROOT / "dist"
VERSION = "0.4.0"


def validate(target: str, manifest: dict) -> list[str]:
    """Return a list of problems. Each one is a way the bundle would break in that engine."""
    problems = []
    bg = manifest.get("background", {})

    if target == "chrome":
        if "service_worker" not in bg:
            problems.append("chrome: background.service_worker is required (MV3 Chrome has no event pages)")
        if bg.get("type") != "module":
            problems.append("chrome: background.type must be module to use ES imports")
        if "side_panel" not in manifest:
            problems.append("chrome: side_panel is the panel surface")
        if "browser_specific_settings" in manifest:
            problems.append("chrome: browser_specific_settings is a Firefox key and breaks store review")
        if "offscreen" not in manifest.get("permissions", []):
            problems.append("chrome: offscreen permission is needed for the keepalive document")
        if "bg.js" not in (bg.get("service_worker") or ""):
            problems.append("chrome: background must point at bg.js")
    else:
        if "scripts" not in bg:
            problems.append("firefox: background.scripts is required — Firefox MV3 runs an event page, not a service worker")
        if "service_worker" in bg:
            problems.append("firefox: Firefox rejects the service_worker background key")
        if "sidebar_action" not in manifest:
            problems.append("firefox: sidebar_action is the panel surface (there is no sidePanel API)")
        gecko = manifest.get("browser_specific_settings", {}).get("gecko", {})
        if not gecko.get("id"):
            problems.append("firefox: browser_specific_settings.gecko.id is required for a stable install id")
        if "data_collection_permissions" not in gecko:
            problems.append("firefox: gecko.data_collection_permissions is required for new submissions")
        for bad in ("offscreen", "sidePanel"):
            if bad in manifest.get("permissions", []):
                problems.append(f"firefox: {bad} is not a Firefox permission")
        if "bg.js" not in bg.get("scripts", []):
            problems.append("firefox: background.scripts must include bg.js")

    # every referenced document must exist in the bundle sources
    refs = [manifest.get("side_panel", {}).get("default_path"),
            manifest.get("sidebar_action", {}).get("default_panel"),
            bg.get("service_worker"), *(bg.get("scripts") or []),
            *(manifest.get("icons") or {}).values(),
            *((manifest.get("action") or {}).get("default_icon") or {}).values()]
    for ref in [r for r in refs if r]:
        if not isinstance(ref, str):
            continue
        if not (CORE / ref).exists() and not (PLATFORM / target / ref).exists():
            problems.append(f"{target}: manifest references {ref}, which does not exist")
    return problems


def build(target: str) -> Path:
    manifest_path = PLATFORM / target / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["version"] = VERSION

    problems = validate(target, manifest)
    if problems:
        print(f"FAIL {target}")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)

    out = DIST / target
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)

    for src in sorted(CORE.iterdir()):
        shutil.copy2(src, out / src.name) if src.is_file() else shutil.copytree(src, out / src.name)
    for src in sorted((PLATFORM / target).iterdir()):
        shutil.copy2(src, out / src.name) if src.is_file() else shutil.copytree(src, out / src.name)
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    files = sorted(str(p.relative_to(out)) for p in out.rglob("*") if p.is_file())
    zip_path = ROOT / f"kowari-{target}-{VERSION}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for name in files:
            z.write(out / name, name)
    print(f"ok   {target}: {len(files)} files -> dist/{target} and {zip_path.name}")
    return zip_path


if __name__ == "__main__":
    for t in ("chrome", "firefox"):
        build(t)
    print("\nboth bundles validate")
