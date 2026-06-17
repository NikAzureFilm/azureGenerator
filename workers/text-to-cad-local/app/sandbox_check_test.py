import unittest

from app.sandbox_check import SandboxViolation, check_source, find_violations


# Mirrors real generated build123d code (plus benign stdlib usage that the
# pre-check must keep allowing: os.path, math, typing, open() for reading).
ALLOWED_BUILD123D_SOURCE = """
import math
import os
from typing import Optional

from build123d import Axis, Box, Part


def gen_step():
    size = math.sqrt(900)
    label_path = os.path.join("labels", "box.txt")
    main_body = Box(size, 30, 12)
    vertical_edges = main_body.edges().filter_by(Axis.Z)
    main_body = Part(main_body).fillet(6.0, vertical_edges)
    return main_body
"""


class SandboxCheckTest(unittest.TestCase):
    def test_allowed_build123d_source_passes(self):
        self.assertEqual(find_violations(ALLOWED_BUILD123D_SOURCE), [])
        check_source(ALLOWED_BUILD123D_SOURCE)  # must not raise

    def test_plain_open_for_reading_is_allowed(self):
        source = 'data = open("params.txt").read()\nother = open("p.txt", "r")\n'
        self.assertEqual(find_violations(source), [])

    def test_import_subprocess_rejected(self):
        with self.assertRaises(SandboxViolation):
            check_source("import subprocess\n")

    def test_import_from_denied_module_rejected(self):
        self.assertTrue(find_violations("from urllib import request\n"))
        self.assertTrue(find_violations("from socket import socket\n"))
        self.assertTrue(find_violations("import urllib.request\n"))

    def test_os_system_call_rejected(self):
        with self.assertRaises(SandboxViolation):
            check_source('import os\nos.system("dir")\n')

    def test_from_os_import_system_rejected(self):
        self.assertTrue(find_violations("from os import system\n"))
        self.assertTrue(find_violations("from os import remove\n"))
        # Importing harmless os names stays allowed.
        self.assertEqual(find_violations("from os import path\n"), [])

    def test_os_exec_and_spawn_family_rejected(self):
        self.assertTrue(find_violations('import os\nos.execv("/bin/sh", [])\n'))
        self.assertTrue(find_violations('import os\nos.spawnl(0, "x")\n'))
        self.assertTrue(find_violations('import os\nos.remove("a")\n'))
        self.assertTrue(find_violations("import os\nos.kill(1, 9)\n"))

    def test_dynamic_code_execution_rejected(self):
        self.assertTrue(find_violations('eval("1+1")\n'))
        self.assertTrue(find_violations('exec("x = 1")\n'))
        self.assertTrue(find_violations('__import__("subprocess")\n'))
        self.assertTrue(find_violations('compile("x", "<s>", "exec")\n'))

    def test_open_with_write_mode_rejected(self):
        self.assertTrue(find_violations('open("out.txt", "w")\n'))
        self.assertTrue(find_violations('open("out.txt", mode="a")\n'))
        self.assertTrue(find_violations('open("out.txt", "r+")\n'))
        self.assertTrue(find_violations('open("out.bin", "xb")\n'))

    def test_open_with_dynamic_mode_is_allowed(self):
        # When in doubt, allow.
        self.assertEqual(find_violations('m = "r"\nopen("f.txt", m)\n'), [])

    def test_unparseable_source_is_allowed_so_runner_reports_syntax_error(self):
        self.assertEqual(find_violations("def gen_step(:\n"), [])


if __name__ == "__main__":
    unittest.main()
