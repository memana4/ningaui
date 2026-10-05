#!/usr/bin/env python3
"""Assemble the per-browser bundles and the bookmarklet bundle.

One source tree, three targets: two extension manifests, and one self-contained classic
script that runs the same core in an ordinary page as a bookmarklet.

Everything in core/ is engine-agnostic: the loop, the tools, the action queue, the store,
the model adapters, the background host and the panel. The only per-target differences
are the manifest (and, for Chrome, the offscreen keepalive document); the bookmarklet
supplies a page-context shim host (bookmarklet/shim.js) instead of an extension API.

The extension build asserts the cross-browser rules instead of trusting them, because a
manifest that is wrong for its engine fails in ways that look like code bugs. The
bookmarklet bundler is deliberately strict for the same reason: it refuses to build on
any module syntax it does not recognise, so the bundle cannot silently diverge from the
sources it claims to contain.
"""

import base64, gzip, json, re, shutil, subprocess, sys, zipfile
from html import escape as html_escape
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent
CORE = ROOT / "core"
PLATFORM = ROOT / "platform"
BOOKMARKLET = ROOT / "bookmarklet"
ASSETS = ROOT / "assets"
DIST = ROOT / "dist"
VERSION = "0.6.0"


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
    zip_path = ROOT / f"ningaui-{target}-{VERSION}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for name in files:
            z.write(out / name, name)
    print(f"ok   {target}: {len(files)} files -> dist/{target} and {zip_path.name}")
    return zip_path


# ------------------------------------------------------------------ bookmarklet --

# Modules in dependency order; every import must point at an earlier entry.
BUNDLE_MODULES = ["api.js", "store.js", "policy.js", "actions.js", "tools.js", "agent.js", "model.js", "bg.js"]

IMPORT_RE = re.compile(r'^import \{ (.+) \} from "\./([\w.-]+)";$')
EXPORT_RE = re.compile(r"^export (async function|function|const) (\w+)\b")

# Percent-encoding set for the bookmarklet URL. Everything a URL parser or an HTML
# attribute would treat specially (spaces, &, #, %, quotes, braces, <, >) is encoded.
URL_SAFE = "-_.~!$'()*+,;=:@/?"


def transform_module(name: str, source: str) -> tuple[list[str], list[str]]:
    """Rewrite one ES module into classic-script lines. Unrecognised syntax fails the build."""
    lines: list[str] = []
    exports: list[str] = []
    for line in source.splitlines():
        if line.startswith("import "):
            m = IMPORT_RE.match(line)
            if not m:
                raise SystemExit(f"FAIL bookmarklet: unrecognised import in core/{name}:\n  {line}")
            names = m.group(1)
            dep = re.sub(r"\W", "_", m.group(2))
            lines.append(f"const {{ {names} }} = __m_{dep};")
            continue
        m = EXPORT_RE.match(line)
        if m:
            exports.append(m.group(2))
            lines.append(line[len("export "):])
            continue
        if re.match(r"\s*export\b", line):
            raise SystemExit(f"FAIL bookmarklet: unrecognised export form in core/{name}:\n  {line}")
        lines.append(line)
    if name in ("bg.js", "panel.js"):
        if exports:
            raise SystemExit(f"FAIL bookmarklet: core/{name} must not export anything")
    elif not exports:
        raise SystemExit(f"FAIL bookmarklet: core/{name} exports nothing — wrong file?")
    return lines, exports


def wrap_module(name: str, lines: list[str], exports: list[str]) -> str:
    stem = re.sub(r"\W", "_", name)
    body = "\n".join(lines)
    tail = f"\nreturn {{ {', '.join(exports)} }};" if exports else ""
    return f"const __m_{stem} = (() => {{\n{body}{tail}\n}})();"


def minify_js(js: str) -> str:
    """Drop blank lines and whole-line comments; keep indentation.

    Indentation stays because multi-line template literals (the mount CSS, the panel
    markup) are whitespace-carrying; mangling them is how bookmarklet builds break.
    """
    kept = [line.rstrip() for line in js.splitlines() if line.strip() and not line.strip().startswith("//")]
    return "\n".join(kept) + "\n"


def build_bookmarklet() -> Path:
    # 1. rewrite every core module the bundle contains
    wrapped: list[str] = []
    panel_body = ""
    for name in BUNDLE_MODULES + ["panel.js"]:
        lines, exports = transform_module(name, (CORE / name).read_text(encoding="utf-8"))
        if name == "panel.js":
            panel_body = "\n".join(lines)
        else:
            wrapped.append(f"// ---- core/{name} ----")
            wrapped.append(wrap_module(name, lines, exports))

    # 2. the panel document with its icon inlined: the bundle has no file dependencies
    panel_html = (CORE / "panel.html").read_text(encoding="utf-8")
    if panel_html.count('src="icons/icon-32.png"') != 1:
        raise SystemExit("FAIL bookmarklet: expected exactly one icon reference in core/panel.html")
    icon_png = ASSETS / "ningaui-32.png"
    if not icon_png.exists():
        raise SystemExit("FAIL bookmarklet: assets/ningaui-32.png missing (regenerate with python3 assets/mascot.py)")
    icon = base64.b64encode(icon_png.read_bytes()).decode()
    panel_html = panel_html.replace('src="icons/icon-32.png"', f'src="data:image/png;base64,{icon}"')

    shim = (BOOKMARKLET / "shim.js").read_text(encoding="utf-8")
    mount = (BOOKMARKLET / "mount.js").read_text(encoding="utf-8")

    # 3. assemble: shim first (pickHost must see it before any core module runs), then the
    #    core, then the UI. A second execution toggles the panel instead of booting twice.
    parts = [
        f"/* Ningaui {VERSION} bookmarklet bundle — generated from core/ + bookmarklet/ by build.py.",
        "   Edit the sources and rebuild; do not edit this file. Install page: install.html. */",
        "(function () {",
        '"use strict";',
        "const prior = globalThis.__NINGAUI__;",
        "if (prior && prior.booted) { try { prior.toggle && prior.toggle(); } catch (_) {} return; }",
        shim,
        "const __ningaui_host = createNingauiHost({ localStorage: globalThis.localStorage });",
        "globalThis.__NINGAUI__ = {",
        "  host: __ningaui_host,",
        "  booted: true,",
        "  toggle: () => {},",
        "  send: (message, callback) => __ningaui_host.__send(message, callback),",
        "};",
        *wrapped,
        f"const __NINGAUI_PANEL_HTML__ = {json.dumps(panel_html, ensure_ascii=False)};",
        mount,
        "function __ningaui_panel() {",
        "if (__ningaui_panel.done) return;",
        "__ningaui_panel.done = true;",
        panel_body,
        "}",
        'if (typeof document !== "undefined" && document.body) {',
        "  try {",
        "    ningauiMount();",
        "    __ningaui_panel();",
        "    globalThis.__NINGAUI__.toggle = ningauiToggle;",
        "  } catch (err) {",
        '    console.error("[ningaui] bookmarklet UI failed to mount:", err);',
        "  }",
        "}",
        "})();",
    ]
    bundle = minify_js("\n".join(parts))

    # 4. write, then syntax-check the artifact itself where node is available
    out_dir = DIST / "bookmarklet"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)
    js_path = out_dir / "ningaui-bookmarklet.js"
    js_path.write_text(bundle, encoding="utf-8")

    node = shutil.which("node")
    if node:
        check = subprocess.run([node, "--check", str(js_path)], capture_output=True, text=True)
        if check.returncode != 0:
            raise SystemExit(f"FAIL bookmarklet: bundle fails node --check:\n{check.stderr}")

    # 5. pack: gzip + base64 + a small async loader. Firefox truncates bookmarks over
    #    ~64 kB, and the raw bundle percent-encodes well past that, so the installable form
    #    is packed; the readable bundle above stays for tests, inspection and the sources.
    payload = base64.b64encode(gzip.compress(bundle.encode("utf-8"), 9, mtime=0)).decode()
    loader = (
        "(async()=>{if(globalThis.__ningaui_loading)return;globalThis.__ningaui_loading=true;"
        f'try{{const b="{payload}";'
        "const a=atob(b),u=new Uint8Array(a.length);"
        "for(let i=0;i<a.length;i++)u[i]=a.charCodeAt(i);"
        "const t=await new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'))).text();"
        "globalThis.__ningaui_loading=false;"
        "(new Function(t))();"
        '}catch(e){globalThis.__ningaui_loading=false;console.error("[ningaui] bookmarklet failed:",e);}})();'
    )
    url = "javascript:" + quote(loader, safe=URL_SAFE)
    if len(url) >= 63_000:
        raise SystemExit(f"FAIL bookmarklet: packed URL is {len(url)} bytes — over the ~64 kB Firefox bookmark limit — shrink the bundle")

    # 6. the standalone install page embeds the packed URL (works from file:// and Pages)
    url_file = out_dir / "ningaui-bookmarklet.url.txt"
    url_file.write_text(url + "\n", encoding="utf-8")
    template = (BOOKMARKLET / "install.template.html").read_text(encoding="utf-8")
    install = (template
               .replace("{{BOOKMARKLET_URL}}", html_escape(url, quote=True))
               .replace("{{ICON_B64}}", icon)
               .replace("{{VERSION}}", VERSION)
               .replace("{{SIZE_KB}}", str(round(len(url) / 1024))))
    (out_dir / "install.html").write_text(install, encoding="utf-8")

    # 7. a zip, same as the extensions, so releases stay uniform
    zip_path = ROOT / f"ningaui-bookmarklet-{VERSION}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(js_path, "ningaui-bookmarklet.js")
        z.write(url_file, "ningaui-bookmarklet.url.txt")
        z.write(out_dir / "install.html", "install.html")

    print(f"ok   bookmarklet: {len(bundle) // 1024} kB readable bundle -> dist/bookmarklet and {zip_path.name}")
    print(f"     install URL: {len(url)} bytes packed ({len(url) // 1024} kB) — under Firefox's ~64 kB bookmark limit")
    return zip_path


if __name__ == "__main__":
    for t in ("chrome", "firefox"):
        build(t)
    build_bookmarklet()
    print("\nall bundles validate")
