"""Shell execution in Pyodide: bashlex AST + Python builtins (Laika).

Expects globals: laika_read_file, laika_write_file, laika_mkdir, laika_list_files,
laika_http_request, laika_delete_file (async).

bashlex: https://github.com/idank/bashlex
"""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any, Dict, List, Optional

import bashlex




def nk(node: Any) -> str:
    """bashlex 新版将多数 AST 节点实现为 class `node`，用 .kind 区分语义类型。"""
    k = getattr(node, "kind", None)
    if k is not None and str(k):
        return str(k)
    nm = type(node).__name__
    if nm.endswith("Node"):
        return nm[:-4].lower()
    return nm.lower()


MAX_CAT = 8 * 1024 * 1024
MAX_GREP = 50_000
MAX_SLEEP_S = 10.0


class _Ses:
    __slots__ = ("cwd", "env", "lx")

    def __init__(self) -> None:
        self.cwd = "/"
        self.env = {
            "PWD": "/",
            "OLDPWD": "/",
            "HOME": "/",
            "USER": "laika",
            "PATH": "/bin:/usr/bin",
            "LANG": "C.UTF-8",
        }
        self.lx = 0


_sess: Optional[_Ses] = None


def sess() -> _Ses:
    global _sess
    if _sess is None:
        _sess = _Ses()
    return _sess


async def laika_reset_shell_session() -> None:
    global _sess
    _sess = _Ses()


class IO:
    def __init__(self, stdin_text: str = "", capture_stdout: bool = False) -> None:
        self.inp = stdin_text or ""
        self.cap = capture_stdout
        self._chunks: List[str] = []

    def o(self, s: str = "", nl: bool = False) -> None:
        chunk = s + ("\n" if nl else "")
        self._chunks.append(chunk) if self.cap else None
        if not self.cap:
            print(chunk, end="", flush=True)

    def e(self, msg: str) -> None:
        import sys as _sys

        print(msg, file=_sys.stderr, flush=True)

    def text_out(self) -> str:
        return "".join(self._chunks)


def vrel(v: str) -> str:
    return "." if v in ("/", ".") else v.strip("/")


def ws_path_join(cwd: str, seg: str) -> str:
    base = [] if cwd in ("/", ".") else [x for x in cwd.strip("/").split("/") if x]
    for p in seg.split("/"):
        if not p or p == ".":
            continue
        if p == "..":
            if base:
                base.pop()
        else:
            base.append(p)
    return "/" if not base else "/" + "/".join(base)


async def ws_abspath(st: _Ses, p: str) -> str:
    return ws_path_join("/", p.strip("/")) if p.startswith("/") else ws_path_join(st.cwd, p)


async def ew(w: Any, st: _Ses) -> str:
    ps = getattr(w, "parts", None)
    if not ps:
        return w.word
    b0 = w.pos[0]
    raw, last = w.word, 0
    chunks: List[str] = []
    for p in sorted(ps, key=lambda x: x.pos[0]):
        a, ee = p.pos
        i0, i1 = a - b0, ee - b0
        if i0 > last:
            i0_adj = i0
            if nk(p) == "parameter" and str(getattr(p, "value", "")) == "?" and i0_adj > last and raw[i0_adj - 1] == "$":
                i0_adj -= 1
            chunks.append(raw[last:i0_adj])
        chunks.append(await _ep(p, st))
        last = i1
    if last < len(raw):
        chunks.append(raw[last:])
    return "".join(chunks)


async def _ep(p: Any, st: _Ses) -> str:
    t = nk(p)
    if t == "parameter":
        pv = getattr(p, "value", None)
        if str(pv) == "?":
            return str(st.lx)
        return str(st.env.get(str(pv), ""))
    if t == "commandsubstitution":
        io = IO("", True)
        await run_ast(p.command, st, io)
        return io.text_out().rstrip("\n")
    return ""


class PlainW:
    __slots__ = ("word", "parts", "pos")

    def __init__(self, t: str) -> None:
        self.word = t
        self.parts: List[Any] = []
        self.pos = (0, len(t))


async def asn_env(nodes: List[Any], st: _Ses) -> Dict[str, str]:
    m = dict(st.env)
    for a in nodes:
        eq = str(a.word).find("=")
        if eq < 1:
            continue
        k, rhs = str(a.word)[:eq], str(a.word)[eq + 1 :]
        br = _Ses()
        br.cwd, br.env, br.lx = st.cwd, m, st.lx
        m[k] = await ew(PlainW(rhs), br)
    return m


async def words(ws: List[Any], st: _Ses) -> List[str]:
    return [await ew(x, st) for x in ws]


async def run_ast(node: Any, st: _Ses, io: IO, loc: Optional[Dict[str, str]] = None) -> int:
    k = nk(node)
    if k == "command":
        wr, reds, asn = [], [], []
        try:
            for p in node.parts:
                qt = nk(p)
                if qt == "redirect":
                    reds.append(p)
                elif qt == "word":
                    wr.append(p)
                elif qt == "assignment":
                    asn.append(p)
                elif qt == "compound":
                    raise ValueError("nested compound unsupported")
                else:
                    raise ValueError(qt)
        except ValueError as ex:
            io.e(f"parse: {ex}")
            st.lx = 2
            return 2
        bk = dict(st.env)
        try:
            if asn:
                st.env = await asn_env(asn, st)
            if loc:
                st.env.update(loc)
            stdin = io.inp or ""
            out_path, out_app = None, False
            for rd in reds:
                typ = rd.type
                pt = getattr(rd, "output", None)
                ph = await ew(pt, st) if pt else ""
                if typ == "<":
                    stdin = await laika_read_file(vrel(await ws_abspath(st, ph)))
                elif typ == ">":
                    out_path, out_app = ph, False
                elif typ == ">>":
                    out_path, out_app = ph, True
            sub_io = IO(stdin, io.cap or (out_path is not None))
            argv = await words(wr, st)
            if not argv:
                st.lx = 0
                if out_path:
                    await wfile(st, "", out_path, out_app)
                return 0
            ex = await dispatch(argv[0], argv, st, sub_io)
            txt = sub_io.text_out()
            if out_path:
                await wfile(st, txt, out_path, out_app)
            elif io.cap:
                io.o(txt)
            st.lx = ex
            return ex
        finally:
            if asn:
                st.env = bk
    if k == "list":
        return await list_run(node.parts, st, io)
    if k == "pipeline":
        return await pipe_run(node, st)
    if k == "compound" and node.list and nk(node.list[0]) == "if":
        return await if_run(node.list[0], st, io)
    io.e(f"unsupported: {k}")
    st.lx = 2
    return 2


async def wfile(st: _Ses, text: str, path: str, append: bool) -> None:
    rel = vrel(await ws_abspath(st, path))
    old = ""
    try:
        old = await laika_read_file(rel)
    except Exception:
        pass
    await laika_write_file(rel, old + text if append else text)


async def list_run(parts: List[Any], st: _Ses, io: IO) -> int:
    i, skip, acc = 0, False, st.lx
    while i < len(parts):
        el = parts[i]
        i += 1
        if nk(el) == "operator":
            op = el.op
            if op == ";":
                skip = False
            elif op == "&&":
                skip = acc != 0
            elif op == "||":
                skip = acc == 0
            else:
                io.e(f"operator {op} unsupported")
                acc = st.lx = 2
            continue
        if not skip:
            acc = await run_ast(el, st, io)
    st.lx = acc
    return acc


async def pipe_run(pn: Any, st: _Ses) -> int:
    cmds = [x for x in pn.parts if nk(x) == "command"]
    if not cmds:
        return 2
    data = ""
    for j, cc in enumerate(cmds):
        last = j == len(cmds) - 1
        sub = IO(data if j else "", not last)
        ex = await run_ast(cc, st, sub)
        if last:
            st.lx = ex
            return ex
        data = sub.text_out()
    return st.lx


async def if_run(fn: Any, st: _Ses, io: IO) -> int:
    pp = fn.parts
    if len(pp) < 4 or getattr(pp[0], "word", "") != "if" or getattr(pp[2], "word", "") != "then":
        io.e("if: malformed")
        return 2
    cond, bod = pp[1], pp[3]
    c = await list_run(cond.parts, st, IO(io.inp, io.cap))
    if c != 0:
        # Bash: failed condition means the `if` construct still exits 0 (branch skipped).
        st.lx = 0
        return 0
    b = await list_run(bod.parts, st, io)
    st.lx = b
    return b


async def dispatch(cmd: str, argv: List[str], st: _Ses, io: IO) -> int:
    async def lf(rel: str) -> List[Dict]:
        xs = await laika_list_files(rel)
        return xs.to_py() if hasattr(xs, "to_py") else list(xs)

    async def chkdir(pv: str) -> bool:
        try:
            await lf(vrel(pv))
            return True
        except Exception:
            return False

    if cmd == "help":
        io.o(
            "Laika bash (bashlex→Python): cd pwd ls mkdir touch mv cp rm cat head tail wc grep awk sed curl echo export env sleep;",
            nl=True,
        )
        io.o("; && || | < > >> $(…) assignments; unsupported nodes error.", nl=True)
        return 0
    if cmd in ("true", "clear"):
        return 0
    if cmd == "false":
        return 1
    if cmd == "sleep":
        sec = float(argv[1]) if len(argv) > 1 else 0
        await asyncio.sleep(min(MAX_SLEEP_S, max(sec, 0)))
        return 0 if sec >= 0 else 1

    if cmd == "export":
        if len(argv) == 1:
            for k in sorted(st.env.keys()):
                io.o(f'export {k}={sh_quote(st.env[k])}', nl=True)
            return 0
        for w in argv[1:]:
            if "=" not in w:
                st.env.setdefault(w, "")
            else:
                j = w.index("=")
                st.env[w[:j]] = w[j + 1 :]
        return 0
    if cmd == "unset":
        for k in argv[1:]:
            st.env.pop(k, None)
        return 0
    if cmd == "pwd":
        io.o("/", nl=True) if st.cwd == "/" else io.o(st.cwd, nl=True)
        return 0
    if cmd == "cd":
        tg = argv[1] if len(argv) > 1 else st.env.get("HOME", "/")
        nx = st.env.get("OLDPWD", "/") if tg == "-" else ws_path_join(st.cwd, tg)
        if not await chkdir(nx):
            io.e(f"cd: {tg}: no such dir")
            return 1
        st.env["OLDPWD"] = st.cwd
        st.cwd = nx
        st.env["PWD"] = st.cwd
        return 0
    if cmd == "env" or cmd == "printenv":
        if cmd == "printenv" and len(argv) > 1:
            v = st.env.get(argv[1])
            if v is None:
                io.e("not set")
                return 1
            io.o(v, nl=True)
            return 0
        for k in sorted(st.env.keys()):
            io.o(f"{k}={st.env[k]}", nl=True)
        return 0
    if cmd == "echo":
        i = 1
        if len(argv) > i and argv[i] == "-n":
            i += 1
            io.o(" ".join(argv[i:]))
            return 0
        io.o(" ".join(argv[i:]), nl=True)
        return 0

    if cmd == "ls":
        showa = longg = False
        ps: List[str] = []
        for a in argv[1:]:
            if a.startswith("-") and len(a) > 1:
                showa = showa or ("a" in a[1:])
                longg = longg or ("l" in a[1:])
            else:
                ps.append(a)
        if not ps:
            ps = ["."]
        ex = 0
        for p in ps:
            rel = vrel(await ws_abspath(st, p))
            try:
                rows = await lf(rel)
            except Exception:
                ex = 1
                io.e(f"ls: {p}")
                continue
            rows = sorted(rows, key=lambda r: r["name"])
            rows = rows if showa else [r for r in rows if not str(r["name"]).startswith(".")]
            if len(ps) > 1:
                io.o(f"{p}:", nl=True)
            for r in rows:
                d = "/" if r.get("isDirectory") else ""
                if longg:
                    io.o(f"{r.get('size',0)}\t{r.get('modified',0)}\t{r['name']}{d}", nl=True)
                else:
                    io.o(f"{r['name']}{d}", nl=True)
        return ex

    async def rf(rel: str) -> str:
        s = await laika_read_file(rel)
        return s[:MAX_CAT]

    if cmd == "cat":
        if len(argv) == 1:
            io.o(io.inp)
            return 0
        ex = 0
        for f in argv[1:]:
            try:
                io.o(await rf(vrel(await ws_abspath(st, f))))
            except Exception:
                ex = 1
                io.e(f"cat: {f}")
        return ex

    if cmd in ("head", "tail"):
        n = 10
        i = 1
        if len(argv) > i and argv[i] == "-n" and len(argv) > i + 1:
            n = int(argv[i + 1])
            i += 2
        fn = argv[i] if len(argv) > i else None
        data = io.inp if fn is None else await rf(vrel(await ws_abspath(st, fn)))
        lines = data.split("\n")
        if cmd == "head":
            out = "\n".join(lines[:n]) + ("\n" if lines else "")
        else:
            body = lines[:-1] if lines and lines[-1] == "" else lines
            out = "\n".join(body[-n:]) + ("\n" if body else "")
        io.o(out)
        return 0

    if cmd == "mkdir":
        ex = 0
        for p in argv[1:]:
            if p == "-p":
                continue
            try:
                await laika_mkdir(vrel(await ws_abspath(st, p)))
            except Exception:
                ex = 1
        return ex

    if cmd == "touch":
        ex = 0
        for p in argv[1:]:
            rel = vrel(await ws_abspath(st, p))
            try:
                await rf(rel)
            except Exception:
                try:
                    await laika_write_file(rel, "")
                except Exception:
                    ex = 1
        return ex

    if cmd == "mv":
        if len(argv) < 3:
            return 1
        srel = vrel(await ws_abspath(st, argv[1]))
        drel = vrel(await ws_abspath(st, argv[2]))
        try:
            body = await laika_read_file(srel)
        except Exception:
            io.e("mv: missing file")
            return 1
        dest = drel
        try:
            await laika_list_files(drel)
            base = argv[1].rstrip("/").split("/")[-1]
            dest = vrel(await ws_abspath(st, argv[2].rstrip("/") + "/" + base))
        except Exception:
            pass
        try:
            await laika_write_file(dest, body)
            await laika_delete_file(srel, False)
        except Exception:
            return 1
        return 0

    if cmd == "cp":
        if len(argv) < 3:
            return 1
        rec = "-r" in argv or "-R" in argv
        xs = [a for a in argv[1:] if a not in ("-r", "-R")]
        dst = vrel(await ws_abspath(st, xs[-1]))
        ex = 0
        try:
            await lf(dst)
            d_isdir = True
        except Exception:
            d_isdir = False
        for s in xs[:-1]:
            srel = vrel(await ws_abspath(st, s))
            try:
                body = await laika_read_file(srel)
                target = dst
                if d_isdir or len(xs) > 2:
                    target = dst + "/" + s.split("/")[-1]
                await laika_write_file(target, body)
            except Exception:
                if not rec:
                    ex = 1
                    io.e(f"cp: dir needs -r: {s}")
                else:
                    ex = 1
        return ex

    if cmd == "rm":
        rf_ = any(x in argv for x in ("-r", "-R", "-rf", "-fr"))
        xs = [a for a in argv[1:] if a not in ("-r", "-R", "-f", "-rf", "-fr") and not a.startswith("-")]
        ex = 0
        for p in xs:
            rel = vrel(await ws_abspath(st, p))
            try:
                await laika_delete_file(rel, rf_)
            except Exception:
                ex = 1
                io.e(f"rm: {p}")
        return ex

    if cmd == "rmdir":
        ex = 0
        for p in argv[1:]:
            rel = vrel(await ws_abspath(st, p))
            try:
                if await lf(rel):
                    io.e(f"rmdir: not empty {p}")
                    ex = 1
                    continue
                await laika_delete_file(rel)
            except Exception:
                ex = 1
        return ex

    if cmd == "wc":
        modes = "-l" in argv
        fs = [a for a in argv[1:] if not a.startswith("-")]
        total = 0
        ex = 0
        if not fs:
            data = io.inp
            n = _count_lines(data)
            io.o(f"{n}", nl=True)
            return 0
        for f in fs:
            try:
                data = await rf(vrel(await ws_abspath(st, f)))
                n = _count_lines(data)
                total += n
                io.o(f"{n}\t{f}", nl=True)
            except Exception:
                ex = 1
        if modes and len(fs) > 1:
            io.o(f"{total}\ttotal", nl=True)
        return ex

    if cmd == "grep":
        ign = "-i" in argv
        rest = [a for a in argv[1:] if a != "-i"]
        if len(rest) < 1:
            io.e("grep: missing pattern")
            return 2
        pat = rest[0]
        fn = rest[1] if len(rest) > 1 else None
        flags = re.I if ign else 0
        try:
            cre = re.compile(pat, flags)
        except re.error as er:
            io.e(str(er))
            return 2
        if fn is None:
            data = io.inp or ""
        else:
            try:
                data = await rf(vrel(await ws_abspath(st, fn)))
            except Exception:
                return 2
        hit = 0
        for i, line in enumerate(data.split("\n")):
            if i > MAX_GREP:
                break
            if cre.search(line):
                io.o(line, nl=True)
                hit += 1
        return 0 if hit else 1

    if cmd == "awk":
        return await run_awk(argv, st, io)
    if cmd == "sed":
        return await run_sed(argv, st, io)
    if cmd == "curl":
        return await run_curl(argv, st, io)
    return 127


def _count_lines(data: str) -> int:
    if not data:
        return 0
    return len(data.split("\n")) - (1 if data.endswith("\n") else 0)


def sh_quote(v: str) -> str:
    return v if re.match(r"^[\w@%+=:,./-]+$", v) else "'" + v.replace("'", "'\\''") + "'"


async def run_awk(argv: List[str], st: _Ses, io: IO) -> int:
    # awk [-Fsep] 'prog' [file]
    i = 1
    sep = None
    if len(argv) > i and argv[i] == "-F":
        sep = argv[i + 1]
        i += 2
    if len(argv) <= i:
        return 2
    prog = argv[i]
    i += 1
    fn = argv[i] if len(argv) > i else None
    data = io.inp if fn is None else await laika_read_file(vrel(await ws_abspath(st, fn)))
    lines = data.split("\n")
    if not sep:
        ss = lambda ln: ln.split()
    else:
        ss = lambda ln: ln.split(sep)

    def act_print_fields(ln: str, nr: int, fs: Optional[str]) -> None:
        if "print" not in prog:
            return
        m = re.match(r"^\{([^}]*)\}\s*$", prog.strip())
        if not m:
            io.e("awk: only {print …} subset")
            return
        inner = m.group(1).strip()
        flds = ss(ln) if ln else []
        if inner == "" or inner == "0":
            io.o(ln, nl=True)
            return
        toks = re.split(r"\s*,\s*", inner.replace("print", "").strip())
        out: List[str] = []
        for t in toks:
            t = t.strip()
            if t.startswith("$"):
                idx = t[1:]
                if idx.isdigit():
                    j = int(idx)
                    out.append(flds[j - 1] if 0 < j <= len(flds) else "")
                elif idx == "NF":
                    out.append(str(len(flds)))
                elif idx == "NR":
                    out.append(str(nr))
                else:
                    out.append("")
            else:
                out.append(t.strip("'\""))
        io.o(" ".join(out), nl=True)

    for nr, ln in enumerate(lines, 1):
        if not ln and nr == len(lines):
            break
        pre = None
        if "{" in prog:
            pre, _ = prog.split("{", 1)
        if pre and pre.strip() and not pre.strip().startswith("BEGIN"):
            m2 = re.match(r"^(.+)\s*\{", prog)
            if m2:
                cond = m2.group(1).strip()
                if cond.startswith("/") and cond.endswith("/"):
                    if not re.search(cond[1:-1], ln):
                        continue
                elif cond.startswith("NR"):
                    if not eval_nr(cond, nr):
                        continue
        act_print_fields(ln, nr, sep)
    return 0


def eval_nr(cond: str, nr: int) -> bool:
    m = re.match(r"NR\s*(<=|>=|<|>|==)\s*(\d+)", cond.replace(" ", ""))
    if not m:
        return True
    op, kk = m.group(1), int(m.group(2))
    if op == "<=":
        return nr <= kk
    if op == ">=":
        return nr >= kk
    if op == "<":
        return nr < kk
    if op == ">":
        return nr > kk
    return nr == kk


async def run_sed(argv: List[str], st: _Ses, io: IO) -> int:
    if len(argv) < 2:
        return 2
    prog = argv[1]
    fn = argv[2] if len(argv) > 2 else None
    data = io.inp if fn is None else await laika_read_file(vrel(await ws_abspath(st, fn)))
    lines = data.split("\n")
    out_lines: List[str] = []

    ms = re.match(r"s/([^/]*)/([^/]*)/(g)?", prog)
    if ms:
        old, nw, gg = ms.group(1), ms.group(2), ms.group(3)
        ct = 0 if gg else 1
        try:
            pat = re.compile(re.escape(old))
        except re.error as er:
            io.e(str(er))
            return 2
        for ln in lines:
            out_lines.append(pat.sub(nw, ln, count=ct))
    elif prog.isdigit():
        n_ln = int(prog)
        body = lines[:-1] if lines and lines[-1] == "" else lines
        for j, ln in enumerate(body, 1):
            if j == n_ln:
                out_lines.append(ln)
    else:
        io.e("sed: unsupported script")
        return 2

    io.o("\n".join(out_lines) + ("\n" if out_lines else ""))
    return 0


async def run_curl(argv: List[str], st: _Ses, io: IO) -> int:
    args = argv[1:]
    silent = "-s" in args
    meth, body, hdrs, outp = "GET", None, {}, None
    i = 0
    ua = ""
    urls: List[str] = []
    while i < len(args):
        a = args[i]
        if a == "-s":
            i += 1
            continue
        if a == "-o" and i + 1 < len(args):
            outp, i = args[i + 1], i + 2
            continue
        if a == "-X" and i + 1 < len(args):
            meth, i = args[i + 1].upper(), i + 2
            continue
        if a == "-d" and i + 1 < len(args):
            body, i = args[i + 1], i + 2
            continue
        if a == "-H" and i + 1 < len(args):
            hh = args[i + 1]
            if ":" in hh:
                k, v = hh.split(":", 1)
                hdrs[k.strip()] = v.strip()
            i += 2
            continue
        if a.startswith("http"):
            urls.append(a)
            i += 1
            continue
        i += 1
    if not urls:
        io.e("curl: missing URL")
        return 2
    url = urls[0]
    try:
        r = await laika_http_request(url, method=meth, headers=hdrs if hdrs else None, body=body)
        blob = r.get("body") if isinstance(r.get("body"), str) else json.dumps(r, ensure_ascii=False)
        if outp:
            await laika_write_file(vrel(await ws_abspath(st, outp)), blob)
            if not silent:
                io.o(f"saved {outp}", nl=True)
        else:
            if not silent:
                io.o(blob, nl=isinstance(blob, str) and blob.endswith("\n"))
    except Exception as e:
        io.e(str(e))
        return 1
    return 0


async def laika_run_shell(src: str) -> int:
    if not src or not src.strip():
        return 0
    st = sess()
    try:
        trees = bashlex.parse(src)
    except Exception as e:
        print(f"bashlex: {e}", file=__import__("sys").stderr, flush=True)
        st.lx = 2
        return 2
    lx = 0
    io = IO()
    for tr in trees:
        lx = await run_ast(tr, st, io)
    return lx
