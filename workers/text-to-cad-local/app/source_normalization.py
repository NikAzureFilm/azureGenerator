from __future__ import annotations

import re


PRIMITIVE_PART_CLASSES = ("Box", "Cylinder", "Cone", "Sphere", "Torus", "Wedge")
PRIMITIVE_TOPOLOGY_METHODS = ("fillet", "chamfer")


def normalize_build123d_source(source: str) -> str:
    # LLMs often infer SortBy.X/Y/Z from natural language, but build123d uses
    # Axis.X/Y/Z for coordinate sorting.
    source = re.sub(r"\bSortBy\.(X|Y|Z)\b", r"Axis.\1", source)
    return _wrap_primitive_topology_edits(source)


def _wrap_primitive_topology_edits(source: str) -> str:
    primitive_names = "|".join(PRIMITIVE_PART_CLASSES)
    topology_methods = "|".join(PRIMITIVE_TOPOLOGY_METHODS)
    primitive_assignment_pattern = re.compile(
        rf"^\s*([A-Za-z_]\w*)\s*=\s*(?:build123d\.)?(?:{primitive_names})\s*\("
    )
    topology_edit_pattern = re.compile(
        rf"^(\s*)([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\.({topology_methods})\((.*)\)(\s*(?:#.*)?)$"
    )
    primitive_variables: set[str] = set()
    wrapped_primitive_topology_edit = False
    normalized_lines: list[str] = []

    for line in source.splitlines():
        primitive_assignment = primitive_assignment_pattern.match(line)
        if primitive_assignment:
            primitive_variables.add(primitive_assignment.group(1))

        topology_edit = topology_edit_pattern.match(line)
        if not topology_edit:
            normalized_lines.append(line)
            continue

        indent, target, receiver, method, args, suffix = topology_edit.groups()
        if target != receiver or receiver not in primitive_variables:
            normalized_lines.append(line)
            continue

        wrapped_primitive_topology_edit = True
        primitive_variables.discard(receiver)
        normalized_lines.append(
            f"{indent}{target} = Part({receiver}).{method}({args}){suffix}"
        )

    normalized = "\n".join(normalized_lines)
    if wrapped_primitive_topology_edit:
        return _ensure_part_import(normalized)
    return normalized


def _ensure_part_import(source: str) -> str:
    if re.search(r"\bfrom\s+build123d\s+import\s+\*", source):
        return source

    single_line_import_pattern = re.compile(r"^from\s+build123d\s+import\s+([^\n]+)$", re.M)
    single_line_import = single_line_import_pattern.search(source)
    if not single_line_import:
        return f"from build123d import Part\n{source}"

    imported_names = [name.strip() for name in single_line_import.group(1).split(",")]
    if "Part" in imported_names:
        return source

    return single_line_import_pattern.sub(
        f"from build123d import {', '.join([*imported_names, 'Part'])}",
        source,
        count=1,
    )
