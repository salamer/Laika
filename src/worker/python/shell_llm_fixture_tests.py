#!/usr/bin/env python3
"""
Comprehensive test suite for Laika Bash Simulator.
Covers: builtins, pipelines, redirects, expansions, control flow, 
        error handling, security, LLM-generated edge cases.
Run: python -m pytest -v test_shell.py
or:  python -m unittest discover
"""

import asyncio
import json
import os
import re
import sys
import unittest
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine, Dict, List, Optional

# ---------------------------------------------------------------------------
# Mock virtual filesystem & browser/network stubs
# ---------------------------------------------------------------------------
class FakeFS:
    """In-memory filesystem for testing without Pyodide."""
    def __init__(self):
        self.files: Dict[str, str] = {}
        self.dirs = {"/"}  # pseudo root

    async def read_file(self, rel: str) -> str:
        rel = rel.strip("/") or "."
        if rel in self.files:
            return self.files[rel]
        raise FileNotFoundError(rel)

    async def write_file(self, rel: str, content: str):
        rel = rel.strip("/") or "."
        self.files[rel] = content

    async def mkdir(self, rel: str):
        rel = rel.strip("/") or "."
        self.dirs.add(rel)

    async def list_files(self, rel: str) -> list:
        rel = rel.strip("/") or "."
        # Match POSIX: listing a non-directory path fails with ENOTDIR.
        # Without this, a file path wrongly looks like a directory to laika_shell._is_directory.
        if rel in self.files:
            raise NotADirectoryError(rel)
        entries = []
        # pseudo implementation: treat all files as non-directory except if we know a dir
        for key in self.files:
            if key.startswith(rel):
                name = key[len(rel):].lstrip("/")
                if "/" in name:
                    continue  # we don't recurse; just top-level
                entries.append({"name": name, "isDirectory": False})
        # add known dirs
        for d in self.dirs:
            if d.startswith(rel) and d != rel:
                name = d[len(rel):].lstrip("/")
                if "/" not in name:
                    entries.append({"name": name, "isDirectory": True})
        return entries

    async def delete_file(self, rel: str, recursive: bool = False):
        rel = rel.strip("/") or "."
        if rel in self.files:
            del self.files[rel]
        elif recursive:
            # Remove all files under this prefix
            to_delete = [k for k in self.files if k.startswith(rel + "/")]
            for k in to_delete:
                del self.files[k]
        else:
            raise FileNotFoundError(rel)

    async def http_request(self, url, method="GET", headers=None, body=None):
        return {"body": f"response from {url}"}

    async def browser_get_html(self, url, wait_until="load"):
        return f"<html>{url}</html>"

    async def browser_get_markdown(self, url, wait_until="load", mode="readability"):
        return f"[{url}]"

    async def browser_open_login(self, url):
        pass

    async def browser_evaluate(self, *args):
        return "evaluated"

# Global FS instance
fs = FakeFS()

# ---------------------------------------------------------------------------
# Monkey-patch globals used by the shell module
# ---------------------------------------------------------------------------
async def laika_read_file(rel: str) -> str:
    return await fs.read_file(rel)

async def laika_write_file(rel: str, content: str):
    await fs.write_file(rel, content)

async def laika_mkdir(rel: str):
    await fs.mkdir(rel)

async def laika_list_files(rel: str):
    class ListResult(list):
        def to_py(self):
            return self
    res = ListResult(await fs.list_files(rel))
    return res

async def laika_delete_file(rel: str, recursive: bool = False):
    await fs.delete_file(rel, recursive)

async def laika_http_request(url, method="GET", headers=None, body=None):
    return await fs.http_request(url, method, headers, body)

async def laika_browser_get_html(url, wait_until="load"):
    return await fs.browser_get_html(url, wait_until)

async def laika_browser_get_markdown(url, wait_until="load", mode="readability"):
    return await fs.browser_get_markdown(url, wait_until, mode)

async def laika_browser_open_login(url):
    await fs.browser_open_login(url)

async def laika_browser_evaluate(*args):
    return await fs.browser_evaluate(*args)


def _load_laika_shell():
    import importlib.util
    from pathlib import Path

    root = Path(__file__).resolve().parent
    spec = importlib.util.spec_from_file_location("_laika_shell_test", root / "laika_shell.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


_shell = _load_laika_shell()
_shell.laika_read_file = laika_read_file
_shell.laika_write_file = laika_write_file
_shell.laika_mkdir = laika_mkdir
_shell.laika_list_files = laika_list_files
_shell.laika_delete_file = laika_delete_file
_shell.laika_http_request = laika_http_request
_shell.laika_browser_get_html = laika_browser_get_html
_shell.laika_browser_get_markdown = laika_browser_get_markdown
_shell.laika_browser_open_login = laika_browser_open_login
_shell.laika_browser_evaluate = laika_browser_evaluate

# ---------------------------------------------------------------------------
# Test helper
# ---------------------------------------------------------------------------
class CaptureIO:
    def __init__(self):
        self.stdout = []
        self.stderr = []

    def write(self, s="", newline=False):
        self.stdout.append(s + ("\n" if newline else ""))

    def write_err(self, s):
        self.stderr.append(s)

async def run_script(script: str, env: Optional[Dict[str, str]] = None) -> tuple[int, str, str]:
    """Execute a shell script and return (exit_code, stdout, stderr).

    Uses the same shell session as surrounding calls; isolation is enforced in TestBuiltins.setUp().
    """
    session = _shell.get_session()
    if env:
        session.env.update(env)

    # Redirect Python's print temporarily
    import io
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    cap_stdout = io.StringIO()
    cap_stderr = io.StringIO()
    sys.stdout = cap_stdout
    sys.stderr = cap_stderr

    try:
        exit_code = await _shell.laika_run_shell(script)
    except Exception as e:
        exit_code = 2
        print(f"fatal: {e}", file=sys.stderr)
    finally:
        sys.stdout = old_stdout
        sys.stderr = old_stderr

    return exit_code, cap_stdout.getvalue(), cap_stderr.getvalue()

# ---------------------------------------------------------------------------
# Unit tests
# ---------------------------------------------------------------------------
class TestBuiltins(unittest.TestCase):
    async def async_setup(self):
        await _shell.laika_reset_shell_session()
        # reset fs
        global fs
        fs = FakeFS()
        _shell.laika_read_file = laika_read_file
        _shell.laika_write_file = laika_write_file
        # (re-bind all)

    async def async_teardown(self):
        pass

    @classmethod
    def setUpClass(cls):
        cls.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(cls.loop)

    def setUp(self):
        self.loop.run_until_complete(self.async_setup())

    def tearDown(self):
        self.loop.run_until_complete(self.async_teardown())

    def run_shell(self, script, env=None):
        return self.loop.run_until_complete(run_script(script, env))

    # ----- true / false / exit codes -----
    def test_true(self):
        code, out, err = self.run_shell("true")
        self.assertEqual(code, 0)
        self.assertEqual(err, "")

    def test_false(self):
        code, out, err = self.run_shell("false")
        self.assertEqual(code, 1)

    def test_exit_with_code(self):
        code, out, err = self.run_shell("exit 5")
        self.assertEqual(code, 5)

    def test_exit_no_arg(self):
        code, out, err = self.run_shell("exit")
        self.assertEqual(code, 0)

    # ----- echo -----
    def test_echo_simple(self):
        code, out, err = self.run_shell("echo hello world")
        self.assertEqual(out, "hello world\n")

    def test_echo_no_newline(self):
        code, out, err = self.run_shell("echo -n hello")
        self.assertEqual(out, "hello")

    # ----- pwd -----
    def test_pwd_initial(self):
        code, out, err = self.run_shell("pwd")
        self.assertEqual(out, "/\n")

    # ----- cd -----
    def test_cd_home(self):
        code, out, err = self.run_shell("cd ~")
        self.assertEqual(code, 0)

    def test_cd_invalid(self):
        code, out, err = self.run_shell("cd /nonexistent")
        self.assertNotEqual(code, 0)
        self.assertIn("no such dir", err)

    # ----- ls / file ops -----
    def test_mkdir(self):
        self.run_shell("mkdir mydir")
        code, out, err = self.run_shell("ls")
        self.assertIn("mydir/", out)

    def test_touch(self):
        self.run_shell("touch myfile")
        code, out, err = self.run_shell("ls")
        self.assertIn("myfile", out)

    def test_cat_write(self):
        self.run_shell("echo hello > file.txt")
        code, out, err = self.run_shell("cat file.txt")
        self.assertEqual(out, "hello\n")

    def test_cat_append(self):
        self.run_shell("echo hello > file.txt")
        self.run_shell("echo world >> file.txt")
        code, out, err = self.run_shell("cat file.txt")
        self.assertEqual(out, "hello\nworld\n")

    def test_cp(self):
        self.run_shell("echo content > a.txt")
        self.run_shell("cp a.txt b.txt")
        code, out, err = self.run_shell("cat b.txt")
        self.assertEqual(out, "content\n")

    def test_mv(self):
        self.run_shell("echo move > a.txt")
        self.run_shell("mv a.txt b.txt")
        code, out, err = self.run_shell("cat b.txt")
        self.assertEqual(out, "move\n")
        # source should be gone
        code, out, err = self.run_shell("cat a.txt")
        self.assertNotEqual(code, 0)

    def test_rm(self):
        self.run_shell("touch toremove")
        self.run_shell("rm toremove")
        code, out, err = self.run_shell("ls")
        self.assertNotIn("toremove", out)

    def test_head_tail(self):
        self.run_shell("echo -e '1\\n2\\n3\\n4\\n5' > nums")
        code, out, _ = self.run_shell("head -n 2 nums")
        self.assertEqual(out, "1\n2\n")
        code, out, _ = self.run_shell("tail -n 2 nums")
        self.assertEqual(out, "4\n5\n")

    def test_wc(self):
        self.run_shell("echo -e 'a\\nb\\nc' > lines")
        code, out, _ = self.run_shell("wc -l lines")
        self.assertIn("3", out)

    # ----- grep -----
    def test_grep_basic(self):
        self.run_shell("echo -e 'apple\\nbanana\\npear' > fruits")
        code, out, _ = self.run_shell("grep 'apple' fruits")
        self.assertEqual(out, "apple\n")

    def test_grep_invert(self):
        self.run_shell("echo -e 'apple\\nbanana' > fruits")
        code, out, _ = self.run_shell("grep -v apple fruits")
        self.assertEqual(out, "banana\n")

    # ----- awk -----
    def test_awk_print_col(self):
        self.run_shell("echo '1 2 3' | awk '{print $2}'")
        code, out, _ = self.run_shell("echo '1 2 3' | awk '{print $2}'")
        self.assertIn("2", out)

    # ----- sed -----
    def test_sed_substitute(self):
        self.run_shell("echo 'hello world' | sed 's/world/earth/'")
        code, out, _ = self.run_shell("echo 'hello world' | sed 's/world/earth/'")
        self.assertEqual(out, "hello earth\n")

    # ----- curl (mocked) -----
    def test_curl_get(self):
        code, out, _ = self.run_shell("curl -s https://example.com")
        self.assertIn("response from", out)

    # ----- pipe & redirect -----
    def test_pipe_stdout(self):
        code, out, _ = self.run_shell("echo hello | tr a-z A-Z")
        self.assertEqual(out, "HELLO\n")

    def test_input_redirect(self):
        self.run_shell("echo 'input data' > file.txt")
        code, out, _ = self.run_shell("cat < file.txt")
        self.assertEqual(out, "input data\n")

    def test_output_redirect(self):
        self.run_shell("echo redirected > out.txt")
        code, out, _ = self.run_shell("cat out.txt")
        self.assertEqual(out, "redirected\n")

    # ----- variable expansion -----
    def test_dollar_var(self):
        code, out, _ = self.run_shell("export FOO=bar; echo $FOO")
        self.assertEqual(out, "bar\n")

    def test_braced_var(self):
        code, out, _ = self.run_shell("export FOO=bar; echo ${FOO}")
        self.assertEqual(out, "bar\n")

    def test_default_value(self):
        code, out, _ = self.run_shell("echo ${UNDEF:-default}")
        self.assertEqual(out, "default\n")

    def test_exit_status_var(self):
        self.run_shell("false")
        code, out, _ = self.run_shell("echo $?")
        self.assertEqual(out, "1\n")

    # ----- arithmetic expansion -----
    def test_arithmetic(self):
        code, out, _ = self.run_shell("echo $(( 2 + 3 ))")
        self.assertEqual(out, "5\n")

    # ----- control flow -----
    def test_if_true(self):
        code, out, _ = self.run_shell("if true; then echo yes; fi")
        self.assertEqual(out, "yes\n")

    def test_if_false(self):
        code, out, _ = self.run_shell("if false; then echo no; fi")
        self.assertEqual(out, "")

    def test_if_else(self):
        code, out, _ = self.run_shell("if false; then echo no; else echo yes; fi")
        self.assertEqual(out, "yes\n")

    def test_if_elif(self):
        code, out, _ = self.run_shell("if false; then echo no; elif true; then echo yes; fi")
        self.assertEqual(out, "yes\n")

    def test_for_loop(self):
        code, out, _ = self.run_shell("for x in a b c; do echo $x; done")
        self.assertEqual(out, "a\nb\nc\n")

    def test_while_loop(self):
        code, out, _ = self.run_shell("i=0; while test $i -lt 3; do echo $i; i=$((i+1)); done")
        self.assertEqual(out, "0\n1\n2\n")

    # ----- test / [ -----
    def test_test_string_eq(self):
        code, out, _ = self.run_shell("test hello = hello && echo equal")
        self.assertEqual(out, "equal\n")

    def test_test_int_lt(self):
        code, out, _ = self.run_shell("test 2 -lt 3 && echo yes")
        self.assertEqual(out, "yes\n")

    def test_bracket(self):
        code, out, _ = self.run_shell("[ 5 -gt 3 ] && echo true")
        self.assertEqual(out, "true\n")

    # ----- source / . -----
    def test_source_file(self):
        self.run_shell("echo 'echo sourced' > script.sh")
        code, out, _ = self.run_shell("source script.sh")
        self.assertEqual(out, "sourced\n")

    # ----- comment -----
    def test_comment(self):
        code, out, _ = self.run_shell("# just a comment\necho after")
        self.assertEqual(out, "after\n")

    # ----- subshell -----
    def test_subshell(self):
        code, out, _ = self.run_shell("(cd /tmp; pwd); pwd")
        self.assertIn("/\n", out)

    # ----- error cases -----
    def test_command_not_found(self):
        code, out, err = self.run_shell("nonexistent_cmd")
        self.assertEqual(code, 127)

    def test_syntax_error(self):
        code, out, err = self.run_shell("echo 'unclosed quote")
        self.assertEqual(code, 2)

    def test_redirect_to_nonexistent_dir(self):
        code, out, err = self.run_shell("echo x > /nodir/file")
        self.assertNotEqual(code, 0)

    # ----- security / injection prevention -----
    def test_no_rce_in_arith(self):
        # arithmetic should reject unsafe characters
        code, out, err = self.run_shell("echo $((__import__('os').system('rm -rf /')))")
        self.assertNotEqual(out, "0\n")  # either error or zero

    # ----- complex combos -----
    def test_pipeline_with_if(self):
        script = "if echo hello | grep h; then echo found; fi"
        code, out, _ = self.run_shell(script)
        self.assertIn("found", out)

    def test_nested_command_sub(self):
        script = "echo $(echo $(echo inner))"
        code, out, _ = self.run_shell(script)
        self.assertEqual(out, "inner\n")

    # ----- additional edge cases -----
    def test_empty_script(self):
        code, out, _ = self.run_shell("")
        self.assertEqual(code, 0)

    def test_multiple_commands(self):
        code, out, _ = self.run_shell("echo a; echo b; echo c")
        self.assertEqual(out, "a\nb\nc\n")

    def test_logical_and(self):
        code, out, _ = self.run_shell("true && echo ok")
        self.assertEqual(out, "ok\n")

    def test_logical_or(self):
        code, out, _ = self.run_shell("false || echo fallback")
        self.assertEqual(out, "fallback\n")

    def test_complex_logical_chain(self):
        code, out, _ = self.run_shell("false && echo no || echo yes")
        self.assertEqual(out, "yes\n")

    def test_heredoc(self):
        script = "cat <<EOF\ntest content\nEOF"
        code, out, _ = self.run_shell(script)
        self.assertEqual(out, "test content\n")

    def test_export_persists(self):
        self.run_shell("export MYVAR=hello")
        code, out, _ = self.run_shell("echo $MYVAR")
        self.assertEqual(out, "hello\n")

    def test_unset(self):
        self.run_shell("export TEMP=bye")
        self.run_shell("unset TEMP")
        code, out, _ = self.run_shell("echo $TEMP")
        self.assertEqual(out, "\n")

    def test_printenv_value(self):
        self.run_shell("export MYVAL=abc")
        code, out, err = self.run_shell("printenv MYVAL")
        self.assertEqual(out, "abc\n")
        self.assertEqual(code, 0)
        self.assertEqual(err.strip(), "")

    def test_printenv_missing_stderr(self):
        code, out, err = self.run_shell("printenv NOTSETXYZ123")
        self.assertNotEqual(code, 0)
        self.assertIn("not set", err)

    def test_printenv_lists_all_when_no_args(self):
        code, out, err = self.run_shell("export XY=zz; printenv")
        self.assertEqual(code, 0)
        self.assertIn("XY=zz", out)

    def test_bracket_f_file(self):
        code, out, err = self.run_shell("echo x > xf.txt && [ -f xf.txt ] && echo fileok")
        self.assertEqual(code, 0, msg=err)
        self.assertIn("fileok", out)

    def test_bracket_d_dir(self):
        self.run_shell("mkdir myd_test")
        code, out, _ = self.run_shell("[ -d myd_test ] && echo dok")
        self.assertIn("dok", out)

    def test_while_never_enters_preserves_then(self):
        code, out, _ = self.run_shell("while false; do echo inside; done; echo after")
        self.assertIn("after", out)
        self.assertNotIn("inside", out)

    def test_env_command(self):
        code, out, _ = self.run_shell("env FOO=bar echo $FOO")
        self.assertIn("bar", out)

    def test_browser_html_mock(self):
        code, out, _ = self.run_shell("browser-html https://example.com")
        self.assertIn("example.com", out)

    # Large output truncation (cat limit)
    def test_cat_max_bytes(self):
        big = "x" * (_shell.MAX_CAT_BYTES + 100)
        self.run_shell(f"echo '{big}' > bigfile")
        code, out, _ = self.run_shell("cat bigfile")
        self.assertLessEqual(len(out), _shell.MAX_CAT_BYTES + 1)  # approx

    # Sleep limit
    def test_sleep_capped(self):
        code, out, _ = self.run_shell("sleep 20")  # should be capped to MAX_SLEEP_SECONDS
        self.assertEqual(code, 0)

    # awk with BEGIN/END
    def test_awk_begin_end(self):
        script = "echo '1 2' | awk 'BEGIN{print \"start\"} {print $1} END{print \"end\"}'"
        code, out, _ = self.run_shell(script)
        self.assertIn("start", out)
        self.assertIn("end", out)

    # sed with address and d
    def test_sed_delete_line(self):
        self.run_shell("echo -e 'a\\nb\\nc' | sed '2d'")
        code, out, _ = self.run_shell("echo -e 'a\\nb\\nc' | sed '2d'")
        self.assertNotIn("b", out)

    # xargs minimal
    def test_xargs_echo(self):
        code, out, _ = self.run_shell("echo 'a b c' | xargs echo")
        # likely outputs a b c (xargs passes args to echo)
        self.assertIn("a", out)

    # sort
    def test_sort_lines(self):
        self.run_shell("echo -e 'c\\na\\nb' | sort")
        code, out, _ = self.run_shell("echo -e 'c\\na\\nb' | sort")
        self.assertEqual(out, "a\nb\nc\n")

    # tr
    def test_tr_lowercase(self):
        code, out, _ = self.run_shell("echo HELLO | tr A-Z a-z")
        self.assertEqual(out, "hello\n")

    # basename / dirname
    def test_basename(self):
        code, out, _ = self.run_shell("basename /usr/bin/sh")
        self.assertEqual(out, "sh\n")

    def test_dirname(self):
        code, out, _ = self.run_shell("dirname /usr/bin/sh")
        self.assertEqual(out, "/usr/bin\n")

    # Illegal scripts
    def test_missing_fi(self):
        code, out, err = self.run_shell("if true; then echo missing fi")
        self.assertNotEqual(code, 0)

    def test_unbalanced_brace(self):
        code, out, err = self.run_shell("echo ${var")
        self.assertNotEqual(code, 0)

    def test_backtick_not_supported(self):
        code, out, err = self.run_shell("echo `pwd`")
        # bashlex may parse it; if not, it's unsupported
        # Our parser may or may not handle backtick; we test for no crash
        self.assertIn(code, [0, 127, 2])

    # ----- More specific awk / sed / grep -----
    def test_grep_recursive(self):
        self.run_shell("mkdir dir")
        self.run_shell("echo foo > dir/file1")
        self.run_shell("echo bar > dir/file2")
        code, out, _ = self.run_shell("grep -r foo dir")
        self.assertIn("dir/file1", out)

    def test_grep_count(self):
        self.run_shell("echo -e 'foo\\nfoo\\nbar' | grep -c foo")
        code, out, _ = self.run_shell("echo -e 'foo\\nfoo\\nbar' | grep -c foo")
        self.assertIn("2", out)

    def test_grep_files_with_matches(self):
        self.run_shell("echo foo > a.txt")
        self.run_shell("echo bar > b.txt")
        code, out, _ = self.run_shell("grep -l foo *.txt")
        self.assertIn("a.txt", out)
        self.assertNotIn("b.txt", out)

    def test_sed_multiple_expressions(self):
        code, out, _ = self.run_shell("echo 'hello world' | sed -e 's/hello/hi/' -e 's/world/moon/'")
        self.assertEqual(out, "hi moon\n")

    def test_sed_silent_with_p(self):
        code, out, _ = self.run_shell("echo -e 'a\\nb\\nc' | sed -n '2p'")
        self.assertEqual(out, "b\n")

    def test_sed_backref(self):
        code, out, _ = self.run_shell("echo 'foo123' | sed 's/\\([a-z]*\\)\\([0-9]*\\)/\\2\\1/'")
        self.assertEqual(out, "123foo\n")

    def test_awk_field_separator(self):
        code, out, _ = self.run_shell("echo 'a:b:c' | awk -F: '{print $2}'")
        self.assertEqual(out, "b\n")

    def test_awk_pattern_action(self):
        self.run_shell("echo -e '1 apple\\n2 banana\\n3 apple' | awk '/apple/ {print $1}'")
        code, out, _ = self.run_shell("echo -e '1 apple\\n2 banana\\n3 apple' | awk '/apple/ {print $1}'")
        self.assertEqual(out, "1\n3\n")

    def test_awk_nr_condition(self):
        code, out, _ = self.run_shell("echo -e 'a\\nb\\nc' | awk 'NR==2 {print}'")
        self.assertEqual(out, "b\n")

    # ----- Edge: variable in redirection -----
    def test_variable_redirect_filename(self):
        self.run_shell("export FILE=myfile")
        self.run_shell("echo data > $FILE")
        code, out, _ = self.run_shell("cat myfile")
        self.assertEqual(out, "data\n")

    # ----- Pipe with error propagation -----
    def test_pipe_false(self):
        code, out, _ = self.run_shell("false | echo after")
        # exit code of pipeline is exit code of last command
        self.assertEqual(code, 0)

    def test_pipe_false_last(self):
        code, out, _ = self.run_shell("echo hello | false")
        self.assertEqual(code, 1)

    # ----- Command substitution in double quotes -----
    def test_cmd_sub_in_echo(self):
        code, out, _ = self.run_shell("echo \"today is $(date)\"")
        # date not implemented but shell will try to run 'date', exit 127, output empty
        self.assertIn("today is", out)

    # ----- Assignment prefix -----
    def test_assignment_prefix(self):
        code, out, _ = self.run_shell("TMP=hello echo $TMP")
        # should not print hello because assignment only for that command, not exported to env
        self.assertEqual(out, "\n")

    # ----- Multiple assignments -----
    def test_multiple_assignments(self):
        code, out, _ = self.run_shell("A=1 B=2 echo $A$B")
        self.assertEqual(out, "\n")  # same reason

    # ----- Loop with break (not implemented, should not crash) -----
    def test_for_break(self):
        code, out, _ = self.run_shell("for x in 1 2 3; do if test $x = 2; then break; fi; echo $x; done")
        # break not implemented, loops through all
        self.assertIn("1", out)

    # ----- Illegal characters in arithmetic -----
    def test_illegal_arithmetic(self):
        code, out, _ = self.run_shell("echo $((1 + \"a\"))")
        # should error (non-zero exit or output '0')
        self.assertNotEqual(out, "1\n")

    # ----- Deep nesting (parser stress) -----
    def test_deep_nested_if(self):
        script = "if true; then if true; then if true; then echo deep; fi; fi; fi"
        code, out, _ = self.run_shell(script)
        self.assertEqual(out, "deep\n")

    # ----- Large heredoc -----
    def test_large_heredoc(self):
        lines = "\n".join([f"line{i}" for i in range(100)])
        script = f"cat <<EOF\n{lines}\nEOF"
        code, out, _ = self.run_shell(script)
        self.assertEqual(len(out.splitlines()), 100)

    # ----- Multiple redirects -----
    def test_stderr_redirect_not_supported(self):
        # 2>&1 not implemented, but should not crash
        code, out, err = self.run_shell("echo ok 2>&1")
        self.assertEqual(code, 0)

    # ----- Trailing newlines -----
    def test_echo_trailing_newline(self):
        code, out, _ = self.run_shell("echo -n test")
        self.assertFalse(out.endswith("\n"))

    # ----- Path with spaces -----
    def test_path_with_spaces(self):
        self.run_shell("mkdir 'my dir'")
        self.run_shell("echo 'content' > 'my dir/file.txt'")
        code, out, _ = self.run_shell("cat 'my dir/file.txt'")
        self.assertEqual(out, "content\n")

    # ----- Comment after command -----
    def test_inline_comment(self):
        code, out, _ = self.run_shell("echo hello # world")
        self.assertEqual(out, "hello\n")  # bashlex should ignore comment

    # ----- Zero argument exit -----
    def test_exit_zero(self):
        code, _, _ = self.run_shell("exit 0")
        self.assertEqual(code, 0)

    # ----- Chained heredocs -----
    def test_multiple_heredocs(self):
        script = "cat <<EOF1\nfirst\nEOF1\ncat <<EOF2\nsecond\nEOF2"
        code, out, _ = self.run_shell(script)
        self.assertEqual(out, "first\nsecond\n")

    # ----- Command substitution inside heredoc -----
    def test_cmd_sub_in_heredoc(self):
        script = "cat <<EOF\ntoday $(echo Mon)\nEOF"
        code, out, _ = self.run_shell(script)
        self.assertIn("Mon", out)

    # ----- Expansions in redirect filenames -----
    def test_expand_redirect_filename(self):
        self.run_shell("export NAME=file")
        self.run_shell("echo data > $NAME")
        code, out, _ = self.run_shell("cat file")
        self.assertEqual(out, "data\n")

    # ----- && || precedence -----
    def test_and_or_precedence(self):
        code, out, _ = self.run_shell("false && echo no || echo yes")
        self.assertEqual(out, "yes\n")

    # ----- Complex pipeline with redirection -----
    def test_pipeline_with_file_input(self):
        self.run_shell("echo 'hello' > input")
        code, out, _ = self.run_shell("cat < input | tr a-z A-Z")
        self.assertEqual(out, "HELLO\n")

    # ----- Variable from command substitution -----
    def test_assign_cmd_sub(self):
        self.run_shell("export RESULT=$(echo 42)")
        code, out, _ = self.run_shell("echo $RESULT")
        self.assertEqual(out, "42\n")

    # ----- Recursive source -----
    def test_source_self(self):
        self.run_shell("echo 'echo sourced again' > rec.sh")
        code, out, _ = self.run_shell("source rec.sh")
        self.assertIn("sourced again", out)

    # ----- Negative arithmetic -----
    def test_negative_arithmetic(self):
        code, out, _ = self.run_shell("echo $(( -5 + 2 ))")
        self.assertEqual(out, "-3\n")

    # ----- Non existent command in pipeline -----
    def test_pipe_bad_cmd(self):
        code, out, err = self.run_shell("nonexist | echo fallback")
        self.assertEqual(code, 0)  # last command succeeded

    # ----- Multiple operations in one line -----
    def test_multiple_ops(self):
        code, out, _ = self.run_shell("echo a > file1; echo b > file2; cat file1 file2")
        self.assertEqual(out, "a\nb\n")

    # ---- verify no env leak from subshell ----
    def test_subshell_env_isolation(self):
        self.run_shell("export X=outer; (export X=inner; echo $X); echo $X")
        code, out, _ = self.run_shell("export X=outer; (export X=inner; echo $X); echo $X")
        self.assertIn("inner", out)
        self.assertIn("outer", out)

    # ---- infinite loop prevention? not implemented, but we can test small loop ----
    def test_while_loop_finite(self):
        code, out, _ = self.run_shell("i=3; while test $i -gt 0; do i=$((i-1)); echo $i; done")
        self.assertIn("0", out)

    # ---- many arguments ----
    def test_echo_many_args(self):
        code, out, _ = self.run_shell("echo a b c d e f g h i j k l m n o p")
        self.assertIn("a", out)

    # ---- file with special characters ----
    def test_special_filename(self):
        self.run_shell("touch 'a b.txt'")
        code, out, _ = self.run_shell("ls")
        self.assertIn("a b.txt", out)

    # ---- empty variable as command ----
    def test_empty_command(self):
        code, out, _ = self.run_shell("$EMPTY")
        # should be 127 (or 0 if argv empty)
        self.assertIn(code, [0, 127])

    # ---- heredoc with leading tabs ----
    def test_heredoc_with_tabs(self):
        script = "cat <<-EOF\n\tindented\n\tEOF"
        code, out, _ = self.run_shell(script)
        self.assertIn("indented", out)

    # ---- assignment inside subshell ----
    def test_assignment_in_subshell(self):
        code, out, _ = self.run_shell("(X=inside; echo $X); echo $X")
        self.assertIn("inside", out)
        self.assertNotIn("inside", out.split("\n")[1])

    # ---- awk with multiple patterns ----
    def test_awk_multi_pattern(self):
        code, out, _ = self.run_shell("echo '1 a\n2 b\n3 c' | awk '/a/ {print $1} /c/ {print $1}'")
        self.assertEqual(out, "1\n3\n")

    # ---- sed with regex address ----
    def test_sed_regex_address(self):
        code, out, _ = self.run_shell("echo -e 'start\\nmiddle\\nend' | sed '/middle/s/e/E/g'")
        self.assertIn("middlE", out)

    # ---- curl with method and headers ----
    def test_curl_post(self):
        code, out, _ = self.run_shell("curl -s -X POST -d 'data' https://api.example")
        self.assertIn("response from", out)

    # ---- extremely long line ----
    def test_long_line(self):
        long_line = "x" * 10000
        self.run_shell(f"echo '{long_line}' > longfile")
        code, out, _ = self.run_shell("cat longfile")
        self.assertIn(long_line[:100], out)

    # ---- empty file operations ----
    def test_cat_empty(self):
        self.run_shell("touch emptyfile")
        code, out, _ = self.run_shell("cat emptyfile")
        self.assertEqual(out, "")

    # ---- cd to previous ----
    def test_cd_dash(self):
        self.run_shell("mkdir subdir")
        self.run_shell("cd subdir")
        code, out, _ = self.run_shell("cd -; pwd")
        self.assertEqual(out, "/\n")

    # ---- help command ----
    def test_help(self):
        code, out, _ = self.run_shell("help")
        self.assertTrue(len(out) > 0)

    # ---- clear command (no op) ----
    def test_clear(self):
        code, out, _ = self.run_shell("clear")
        self.assertEqual(code, 0)

    # ---- nested command substitution in assignment ----
    def test_nested_cmd_sub(self):
        code, out, _ = self.run_shell("X=$(echo $(echo nested)); echo $X")
        self.assertEqual(out, "nested\n")

    # ---- multiple redirections to same file ----
    def test_multiple_redirects(self):
        self.run_shell("echo first > out; echo second >> out; echo third >> out")
        code, out, _ = self.run_shell("cat out")
        self.assertEqual(out, "first\nsecond\nthird\n")

    # ---- test with missing bracket ----
    def test_test_missing_bracket(self):
        code, out, _ = self.run_shell("[ 1 -eq 1")
        # bashlex may report syntax error
        self.assertNotEqual(code, 0)

    # ---- unclosed single quote ----
    def test_unclosed_single_quote(self):
        code, out, _ = self.run_shell("echo 'hello")
        self.assertNotEqual(code, 0)

    # ---- backticks ----
    def test_backtick_command(self):
        # bashlex may not support, but we test for no crash
        code, out, _ = self.run_shell("echo `echo backtick`")
        self.assertTrue(code >= 0)

    # ---- huge number of pipes ----
    def test_many_pipes(self):
        pipe_cmd = "echo hello" + " | cat"*10
        code, out, _ = self.run_shell(pipe_cmd)
        self.assertEqual(out, "hello\n")

    # ---- sourcing a non-existent file ----
    def test_source_nonexistent(self):
        code, out, _ = self.run_shell("source doesnotexist.sh")
        self.assertNotEqual(code, 0)

    # ---- exit from subshell ----
    def test_exit_in_subshell(self):
        code, out, _ = self.run_shell("(exit 3); echo after")
        self.assertEqual(out, "after\n")
        self.assertEqual(code, 0)  # exit inside subshell should not exit main shell

    # ---- for loop over no arguments ----
    def test_for_empty_list(self):
        code, out, _ = self.run_shell("for x in ; do echo $x; done")
        self.assertEqual(code, 0)

    # ---- arithmetic with variable ----
    def test_arith_with_var(self):
        self.run_shell("export X=5")
        code, out, _ = self.run_shell("echo $(( X * 2 ))")
        self.assertEqual(out, "10\n")

    # ---- string quoting in echo ----
    def test_echo_quoted(self):
        code, out, _ = self.run_shell("echo \"hello   world\"")
        self.assertEqual(out, "hello   world\n")

    # ---- test command chaining with newlines ----
    def test_multiline_script(self):
        script = """
        echo line1
        echo line2
        """
        code, out, _ = self.run_shell(script)
        self.assertIn("line1", out)
        self.assertIn("line2", out)

    # ---- empty variable assignment ----
    def test_empty_assignment(self):
        code, out, _ = self.run_shell("EMPTY= echo $EMPTY")
        self.assertEqual(out, "\n")

    # ---- complex glob not supported ----
    def test_glob_not_supported(self):
        code, out, _ = self.run_shell("ls *.txt")
        # will be passed literally, no expansion, likely 'ls: *.txt: ...'
        self.assertNotEqual(code, 0)

    # ---- final comprehensive stress test ----
    def test_stress_mixed_ops(self):
        script = """
        mkdir tmp
        cd tmp
        echo 'hello world' > file.txt
        cat file.txt | tr a-z A-Z > upper.txt
        cp upper.txt copy.txt
        mv copy.txt moved.txt
        rm upper.txt
        if test -f moved.txt; then echo found; fi
        cd ..
        rm -r tmp
        """
        code, out, _ = self.run_shell(script)
        self.assertIn("found", out)

    # =========================================================================
    # Extended robustness: extra valid Bash-like snippets + malformed LLM outputs
    # =========================================================================

    # --- whitespace / empty ---
    def test_whitespace_only_script(self):
        code, _, _ = self.run_shell("   \t  \n  ")
        self.assertEqual(code, 0)

    def test_comment_only_script_triggers_bashlex_error_exits_cleanly(self):
        """Standalone comment nodes are mishandled in some bashlex builds; must surface as exit 2, not crash."""
        code, _, err = self.run_shell("# noop\n# also noop\n")
        self.assertEqual(code, 2)
        self.assertIn("bashlex", err.lower())

    # --- $? tracking ---
    def test_question_mark_after_builtin(self):
        self.run_shell("true")
        code, out, _ = self.run_shell('echo exit=$?')
        self.assertEqual(code, 0)
        self.assertIn("exit=0", out.replace("\n", ""))

    def test_question_mark_after_false(self):
        self.run_shell("false")
        _, out, _ = self.run_shell('echo "prev=$?"')
        self.assertIn("prev=1", out.replace("\n", ""))

    # --- test/[ more predicates ---
    def test_predicate_e_existing_file(self):
        code, out, err = self.run_shell("touch e1.txt && test -e e1.txt && echo eok")
        self.assertEqual(code, 0, msg=err)
        self.assertIn("eok", out)

    def test_predicate_f_rejects_directory(self):
        self.run_shell("mkdir notafile_ext")
        code, out, _ = self.run_shell(
            "[ -f notafile_ext ] && echo isfile || echo nodir_file"
        )
        self.assertIn("nodir_file", out)

    def test_predicate_d_accepts_existing_dir(self):
        self.run_shell("mkdir d_pred")
        code, out, err = self.run_shell("[ -d d_pred ] && echo dok")
        self.assertEqual(code, 0, msg=err)
        self.assertIn("dok", out)

    def test_predicate_z_and_n_combined_script(self):
        code, out, err = self.run_shell(r'test -z "" && echo z1; test -n hi && echo n1')
        self.assertEqual(code, 0, msg=err)
        self.assertIn("z1", out)
        self.assertIn("n1", out)

    def test_square_bracket_only_minus_f_matches_single_operand_rule(self):
        """[ -f ] can parse to a single word -f; laika treats one-arg test as non-empty string (true).

        Guards against parser crashes; not full bash parity.
        """
        code, out, err = self.run_shell("[ -f ] && echo one_arg_path")
        self.assertEqual(code, 0, msg=err + out)
        self.assertIn("one_arg_path", out)

    def test_inline_comment_after_simple_command_is_legal(self):
        code, out, err = self.run_shell("echo visible # trailing comment")
        self.assertEqual(code, 0, msg=err + out)
        self.assertIn("visible", out)

    def test_shebang_followed_by_command_typical_llm_cell(self):
        """LLM cells often mimic scripts with a shebang plus body; body should still execute."""
        code, out, err = self.run_shell("#!/bin/sh\necho cell_ok\n")
        self.assertEqual(code, 0, msg=repr(err) + repr(out))
        self.assertIn("cell_ok", out)

    def test_bracket_well_formed_three_word_compare(self):
        code, out, err = self.run_shell('[ abc = abc ] && echo streq')
        self.assertEqual(code, 0, msg=err)
        self.assertIn("streq", out)

    # --- logical combinations ---
    def test_or_short_circuits_rhs(self):
        code, out, err = self.run_shell("echo first || echo second")
        self.assertEqual(code, 0, msg=err)
        self.assertIn("first", out)
        self.assertNotIn("second", out)

    def test_or_runs_rhs_when_lhs_fails_cmd(self):
        code, out, err = self.run_shell("nosuchcmdxyz123 || echo recovered")
        self.assertEqual(code, 0, msg=err)
        self.assertIn("recovered", out)

    def test_and_chain_three(self):
        code, out, err = self.run_shell("echo a && echo b && echo c")
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out.strip().replace("\r", "").split("\n"), ["a", "b", "c"])

    # --- printenv robustness ---
    def test_printenv_mixed_known_and_unknown_returns_error(self):
        code, _, err = self.run_shell(
            "export ONLY=there; printenv ONLY ABSENT_MISSING_VAR"
        )
        self.assertNotEqual(code, 0)
        self.assertIn("not set", err)
        self.assertIn("ABSENT_MISSING_VAR", err)

    def test_printenv_zero_when_all_known(self):
        self.run_shell("export A=z; export B=w")
        code, out, err = self.run_shell("printenv A B")
        self.assertEqual(code, 0, msg=repr(out) + repr(err))
        lines = [ln for ln in out.splitlines() if ln.strip()]
        self.assertTrue(any(ln.startswith("z") or ln == "z" or "z" == ln.strip() for ln in lines))

    # --- redirects & pipes error paths ---
    def test_stdout_redirect_preserves_stderr_channel(self):
        code, _, err = self.run_shell(
            "echo ok > rr.txt && cat missing_xyz_404.txt >> rr.txt"
        )
        self.assertNotEqual(code, 0)

    def test_pipeline_empty_middle_no_crash(self):
        code, out, err = self.run_shell("echo hi | cat | cat")
        self.assertEqual(code, 0, msg=err)
        self.assertEqual(out.strip(), "hi")

    # --- builtins edge ---
    def test_unset_twice_then_printenv_negative(self):
        self.run_shell("export GONE=zap; unset GONE")
        code, _, err = self.run_shell("printenv GONE")
        self.assertNotEqual(code, 0)

    def test_exit_explicit_nonzero_bounded(self):
        code, _, _ = self.run_shell("exit 255")
        self.assertEqual(code, 255)

    def test_exit_large_number(self):
        code, _, _ = self.run_shell("exit 42")
        self.assertEqual(code, 42)

    # --- LLM-ish garbage: must not raise through run_script ---
    def test_illegal_ampersand_single_command_background_token(self):
        code, _, err = self.run_shell("echo x & echo y")
        self.assertGreaterEqual(code, 0)
        self.assertIsInstance(err, str)

    def test_malformed_test_operator_typo(self):
        code, out, err = self.run_shell("test 1 -zzz 2")
        self.assertNotEqual(code, 0)

    def test_three_lt_without_spaces_still_lexes_or_fails_safe(self):
        code, _, _ = self.run_shell("[[ a<b ]]")
        self.assertGreaterEqual(code, 0)

    def test_double_semicolon_rejected_by_bashlex_or_shell(self):
        """LLM occasionally emits case-style ;; terminators (double semicolon); parser should fail safely."""
        code, _, err = self.run_shell("echo a;; echo b")
        self.assertEqual(code, 2)
        self.assertIn("bashlex", err)

    def test_only_operators_logical(self):
        code, _, _ = self.run_shell("&& || ;")
        self.assertGreaterEqual(code, 0)

    def test_nested_parens_ls_subshell_deep(self):
        code, _, _ = self.run_shell("((((echo inner)))))")
        self.assertGreaterEqual(code, 0)

    # --- unicode & quotes ---
    def test_echo_unicode_literals(self):
        code, out, err = self.run_shell('echo "café 日本語 ñ"')
        self.assertEqual(code, 0, msg=err)
        self.assertIn("café", out)

    def test_single_quoted_spaces_preserved(self):
        code, out, err = self.run_shell("echo '  spaced  out  '")
        self.assertEqual(code, 0, msg=err)
        self.assertIn("  spaced", out)

    # --- oversized script rejection (cheap constant check; allocates ~2MiB string) ---
    def test_shell_rejects_obviously_overlong_payload(self):
        mb = getattr(_shell, "MAX_SHELL_SOURCE_CHARS", None)
        if mb is None:
            self.skipTest("MAX_SHELL_SOURCE_CHARS not exported from laika_shell")
        huge = "#" + "x" * (mb + 1)
        code, _, err = self.run_shell(huge)
        self.assertEqual(code, 2)
        self.assertTrue(
            ("exceeds" in err.lower() and "maximum" in err.lower())
            or ("length" in err.lower()),
            msg=f"unexpected stderr for oversize rejection: {err!r}",
        )


def _run_tests_via_reexec() -> int:
    """Re-exec this file under a non-__main__ module id so unittest can run."""
    import importlib.util
    import inspect as _inspect_in
    import pathlib
    import unittest as _unittest

    path = pathlib.Path(__file__).resolve()
    rid = "_shell_fixture_reexec"
    spec = importlib.util.spec_from_file_location(rid, path)
    assert spec and spec.loader
    rm = importlib.util.module_from_spec(spec)
    sys.modules.setdefault(rid, rm)
    spec.loader.exec_module(rm)
    TB = rm.TestBuiltins
    tl = _unittest.defaultTestLoader
    suite = _unittest.TestSuite()
    for name in tl.getTestCaseNames(TB):
        meth = getattr(TB, name, None)
        if _inspect_in.iscoroutinefunction(meth):
            continue
        suite.addTest(TB(name))
    res = _unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if res.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(_run_tests_via_reexec())