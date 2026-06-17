"""AST-based pre-execution check for LLM-generated build123d source.

The worker executes model code produced by an LLM. Before spawning the runner
subprocess, the cleaned source is parsed with ``ast`` and rejected if it uses
obviously dangerous capabilities (process spawning, networking, file deletion,
dynamic code execution, writing files).

The denylist is deliberately narrow so legitimate generated code keeps working:
``import os`` (for ``os.path``), ``math``, ``numpy``, ``typing`` and all
``build123d`` imports stay allowed. When in doubt, allow — the runner already
executes in a separate subprocess with a timeout.
"""

from __future__ import annotations

import ast


DENIED_IMPORT_ROOTS = frozenset(
    {
        "subprocess",
        "socket",
        "ctypes",
        "shutil",
        "urllib",
        "http",
        "requests",
        "ftplib",
        "pickle",
        "importlib",
        "multiprocessing",
        "signal",
    }
)

# os attributes that may not be called (or imported via ``from os import ...``).
DENIED_OS_NAMES = frozenset({"system", "popen", "remove", "unlink", "rmdir", "kill"})
DENIED_OS_PREFIXES = ("exec", "spawn")

DENIED_BUILTIN_CALLS = frozenset({"eval", "exec", "__import__", "compile"})

WRITE_MODE_CHARS = ("w", "a", "x", "+")


class SandboxViolation(Exception):
    """Raised when generated source uses a denied capability."""


def _is_denied_os_name(name: str) -> bool:
    return name in DENIED_OS_NAMES or name.startswith(DENIED_OS_PREFIXES)


def _open_mode_is_write(call: ast.Call) -> bool:
    mode_node: ast.expr | None = None
    if len(call.args) >= 2:
        mode_node = call.args[1]
    else:
        for keyword in call.keywords:
            if keyword.arg == "mode":
                mode_node = keyword.value
                break
    if mode_node is None:
        # No mode argument means read mode.
        return False
    if isinstance(mode_node, ast.Constant) and isinstance(mode_node.value, str):
        return any(char in mode_node.value for char in WRITE_MODE_CHARS)
    # Dynamic / non-literal mode: when in doubt, allow.
    return False


def find_violations(source: str) -> list[str]:
    """Return human-readable violations found in ``source`` (empty if clean)."""
    try:
        tree = ast.parse(source)
    except SyntaxError:
        # Unparseable source cannot execute either; let the runner subprocess
        # report the real SyntaxError with line context.
        return []

    violations: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                root = alias.name.split(".")[0]
                if root in DENIED_IMPORT_ROOTS:
                    violations.append(f"import of '{alias.name}' is not allowed")
        elif isinstance(node, ast.ImportFrom):
            root = (node.module or "").split(".")[0]
            if root in DENIED_IMPORT_ROOTS:
                violations.append(f"import from '{node.module}' is not allowed")
            elif root == "os":
                for alias in node.names:
                    if _is_denied_os_name(alias.name):
                        violations.append(
                            f"import of 'os.{alias.name}' is not allowed"
                        )
        elif isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name):
                if func.id in DENIED_BUILTIN_CALLS:
                    violations.append(f"call to {func.id}() is not allowed")
                elif func.id == "open" and _open_mode_is_write(node):
                    violations.append(
                        "call to open() with a write/append mode is not allowed"
                    )
            elif (
                isinstance(func, ast.Attribute)
                and isinstance(func.value, ast.Name)
                and func.value.id == "os"
                and _is_denied_os_name(func.attr)
            ):
                violations.append(f"call to os.{func.attr}() is not allowed")
    return violations


def check_source(source: str) -> None:
    """Raise :class:`SandboxViolation` if ``source`` uses denied capabilities."""
    violations = find_violations(source)
    if violations:
        raise SandboxViolation(
            "sandbox rejected generated code: " + "; ".join(violations)
        )
