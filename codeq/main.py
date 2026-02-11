from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from textwrap import dedent, indent, wrap
from typing import TypeAlias

from tree_sitter import Language, Node, Parser, Query, QueryCursor, Tree
import tree_sitter_python as tspython

PY_LANGUAGE = Language(tspython.language())
parser = Parser(PY_LANGUAGE)

CaptureMap: TypeAlias = dict[str, list[Node]]


class CodeqError(Exception):
    """Base exception for Codeq errors."""


class TargetNotFoundError(CodeqError):
    """Raised when a requested function/class target does not exist."""


class MissingCaptureError(CodeqError):
    """Raised when a target exists, but the requested capture is unavailable."""


class CodeKind(StrEnum):
    FUNC = "func"
    CLASS = "class"

    @classmethod
    def parse(cls, value: "str | CodeKind") -> "CodeKind":
        if isinstance(value, cls):
            return value

        try:
            return cls(value)

        except ValueError as exc:
            raise ValueError(f"Unsupported kind: {value!r}") from exc


class CodePart(StrEnum):
    NODE = "node"
    BODY = "body"
    LOGIC = "logic"
    DOCSTRING = "docstring"
    PARAMS = "params"
    RETURN_TYPE = "return_type"
    SUPERCLASSES = "superclasses"

    @classmethod
    def parse(cls, value: "str | CodePart") -> "CodePart":
        if isinstance(value, cls):
            return value

        try:
            return cls(value)

        except ValueError as exc:
            raise ValueError(f"Unsupported part: {value!r}") from exc


class ResourceKind(StrEnum):
    FUNCTION = "Function"
    CLASS = "Class"


@dataclass(frozen=True)
class ObjectMeta:
    name: str
    offset: int


@dataclass(frozen=True)
class FunctionSpec:
    params: str
    return_type: str
    docstring: str
    decorators: list[str]


@dataclass(frozen=True)
class ClassSpec:
    superclasses: str
    docstring: str


@dataclass(frozen=True)
class CodeqObject:
    api_version: str
    kind: ResourceKind
    metadata: ObjectMeta
    spec: FunctionSpec | ClassSpec


@dataclass(frozen=True)
class FunctionMapEntry:
    start: int
    name: str
    params: str
    return_type: str
    docstring: str
    decorators: list[str]

    def signature(self) -> str:
        deco_prefix = " ".join(self.decorators) + " " if self.decorators else ""
        ret_suffix = f" -> {self.return_type}" if self.return_type else ""
        doc_suffix = (
            f"  # {' '.join(self.docstring.split())[:50]}" if self.docstring else ""
        )

        return f"{deco_prefix}def {self.name}{self.params}{ret_suffix}{doc_suffix}"

    def to_resource(self) -> CodeqObject:
        return CodeqObject(
            api_version="codeq/v1",
            kind=ResourceKind.FUNCTION,
            metadata=ObjectMeta(name=self.name, offset=self.start),
            spec=FunctionSpec(
                params=self.params,
                return_type=self.return_type,
                docstring=self.docstring,
                decorators=self.decorators,
            ),
        )


@dataclass(frozen=True)
class ClassMapEntry:
    start: int
    name: str
    superclasses: str
    docstring: str

    def signature(self) -> str:
        sig = f"class {self.name}{self.superclasses}:"
        if self.docstring:
            sig += f"  # {' '.join(self.docstring.split())[:50]}"

        return sig

    def to_resource(self) -> CodeqObject:
        return CodeqObject(
            api_version="codeq/v1",
            kind=ResourceKind.CLASS,
            metadata=ObjectMeta(name=self.name, offset=self.start),
            spec=ClassSpec(
                superclasses=self.superclasses,
                docstring=self.docstring,
            ),
        )


class Codeq:
    _funcs_query_string = dedent(
        """
        (decorated_definition
            (decorator) @func.decorator
            definition: (function_definition
                name: (identifier) @func.name
                parameters: (parameters) @func.params
                return_type: (type)? @func.return_type
                body: (block
                    . (expression_statement (string) @func.docstring)? @func.doc_node
                ) @func.body
            ) @func.node
        ) @func.decorated_node

        (function_definition
            name: (identifier) @func.name
            parameters: (parameters) @func.params
            return_type: (type)? @func.return_type
            body: (block
                . (expression_statement (string) @func.docstring)? @func.doc_node
            ) @func.body
        ) @func.node
        """
    )

    _classes_query_string = dedent(
        """
        (class_definition
            name: (identifier) @class.name
            superclasses: (argument_list)? @class.superclasses
            body: (block
                . (expression_statement (string) @class.docstring)? @class.doc_node
            ) @class.body
        ) @class.node
        """
    )

    _file_path: str = "<FILE>"

    def __init__(self, tree: Tree, source: str) -> None:
        self.tree = tree
        self.source_bytes = bytearray(source.encode())

        self._funcs_query = Query(PY_LANGUAGE, self._funcs_query_string)
        self._classes_query = Query(PY_LANGUAGE, self._classes_query_string)

    @classmethod
    def from_source(cls, source: str) -> "Codeq":
        tree = parser.parse(source.encode())

        return cls(tree, source)

    @classmethod
    def from_file(cls, file_path: str | Path) -> "Codeq":
        source = Path(file_path).read_text("utf-8")

        cls._file_path = str(Path(file_path).relative_to(Path.cwd()))

        return cls.from_source(source)

    def file_map(self) -> list[str]:
        mapped_items: list[tuple[int, str]] = [
            (entry.start, entry.signature()) for entry in self._map_functions()
        ]
        mapped_items.extend(
            (entry.start, entry.signature()) for entry in self._map_classes()
        )

        return [
            *(item for _, item in sorted(mapped_items, key=lambda pair: pair[0])),
        ]

    def objects(self) -> list[CodeqObject]:
        resources: list[CodeqObject] = [
            entry.to_resource() for entry in self._map_functions()
        ]
        resources.extend(entry.to_resource() for entry in self._map_classes())

        return sorted(resources, key=lambda resource: resource.metadata.offset)

    def _query_for(self, kind: CodeKind) -> Query:
        match kind:
            case CodeKind.FUNC:
                return self._funcs_query

            case CodeKind.CLASS:
                return self._classes_query

    def _matches(self, kind: CodeKind) -> list[tuple[int, CaptureMap]]:
        qcur = QueryCursor(self._query_for(kind))

        return list(qcur.matches(self.tree.root_node))

    def _map_functions(self) -> list[FunctionMapEntry]:
        entries_by_id: dict[int, FunctionMapEntry] = {}

        for _, captures in self._matches(CodeKind.FUNC):
            func_node = captures["func.node"][0]

            if func_node.id in entries_by_id:

                continue

            decorators: list[str] = []
            decorated_node = captures.get("func.decorated_node")
            if decorated_node:
                for child in decorated_node[0].children:
                    if child.type == "decorator":
                        decorators.append(child.text.decode().strip())

            entries_by_id[func_node.id] = FunctionMapEntry(
                start=func_node.start_byte,
                name=captures["func.name"][0].text.decode(),
                params=captures["func.params"][0].text.decode(),
                return_type=(
                    captures["func.return_type"][0].text.decode()
                    if "func.return_type" in captures
                    else ""
                ),
                docstring=(
                    wrap(captures["func.docstring"][0].text.decode().strip("\"' "), max_lines=1)
                    if "func.docstring" in captures
                    else ""
                ),
                decorators=decorators,
            )

        return list(entries_by_id.values())

    def _map_classes(self) -> list[ClassMapEntry]:
        entries: list[ClassMapEntry] = []

        for _, captures in self._matches(CodeKind.CLASS):
            class_node = captures["class.node"][0]

            entries.append(
                ClassMapEntry(
                    start=class_node.start_byte,
                    name=captures["class.name"][0].text.decode(),
                    superclasses=(
                        captures["class.superclasses"][0].text.decode()
                        if "class.superclasses" in captures
                        else ""
                    ),
                    docstring=(
                        captures["class.docstring"][0].text.decode().strip("\"' ")
                        if "class.docstring" in captures
                        else ""
                    ),
                )
            )

        return entries

    def retrieve(
        self,
        kind: str | CodeKind,
        target: str,
        what: str | CodePart,
    ) -> str | None:
        code_kind = CodeKind.parse(kind)
        code_part = CodePart.parse(what)

        for _, captures in self._matches(code_kind):
            name_node = captures[f"{code_kind.value}.name"][0]

            if name_node.text.decode() != target:

                continue

            match code_part:
                case CodePart.NODE:
                    node = captures.get(
                        f"{code_kind.value}.decorated_node",
                        captures.get(f"{code_kind.value}.node"),
                    )
                    if not node:

                        return None

                    target_node = node[0]

                    return self._decode_node(target_node)

                case CodePart.LOGIC:
                    body_nodes = captures.get(f"{code_kind.value}.body")
                    if not body_nodes:

                        return None

                    body_node = body_nodes[0]
                    start = body_node.start_byte
                    doc_nodes = captures.get(f"{code_kind.value}.doc_node")
                    if doc_nodes:
                        start = doc_nodes[0].end_byte

                    return (
                        self.source_bytes[start : body_node.end_byte].decode().strip()
                    )

                case _:
                    captured = captures.get(
                        f"{code_kind.value}.{code_part.value}",
                        captures.get(f"{code_kind.value}.node"),
                    )
                    if not captured:

                        return None

                    return self._decode_node(captured[0])

        return None

    def replace(
        self,
        kind: str | CodeKind,
        target: str,
        what: str | CodePart,
        new_text: str,
    ) -> None:
        code_kind = CodeKind.parse(kind)
        code_part = CodePart.parse(what)

        for _, captures in self._matches(code_kind):
            name_node = captures[f"{code_kind.value}.name"][0]

            if name_node.text.decode() != target:

                continue

            start, end, indent_level = self._replacement_bounds(
                code_kind, code_part, captures
            )
            prepared_text = indent(
                dedent(new_text).strip(), " " * indent_level
            ).lstrip()

            self.source_bytes[start:end] = prepared_text.encode()

            self.tree = parser.parse(self.source_bytes)

            return

        raise TargetNotFoundError(f"{code_kind.value} '{target}' not found")

    def _replacement_bounds(
        self,
        code_kind: CodeKind,
        code_part: CodePart,
        captures: CaptureMap,
    ) -> tuple[int, int, int]:
        match code_part:
            case CodePart.LOGIC:
                body_nodes = captures.get(f"{code_kind.value}.body")
                if not body_nodes:

                    raise MissingCaptureError(
                        f"Target found, but {code_part.value} is missing"
                    )

                body_node = body_nodes[0]
                start = body_node.start_byte
                end = body_node.end_byte

                doc_nodes = captures.get(f"{code_kind.value}.doc_node")
                if doc_nodes:
                    start = doc_nodes[0].end_byte

                return start, end, body_node.start_point[1] + 4

            case _:
                capture_name = f"{code_kind.value}.{code_part.value}"
                target_nodes = captures.get(capture_name)
                if not target_nodes:
                    available = [capture.split(".")[1] for capture in captures]
                    if "body" in available:
                        available.append("logic")

                    raise MissingCaptureError(
                        f"Target found, but {code_part.value} is missing and adding it is unsupported\n"
                        f"Available captures: {available}"
                    )

                target_node = target_nodes[0]

                return (
                    target_node.start_byte,
                    target_node.end_byte,
                    target_node.start_point[1],
                )

    def _decode_node(self, node: Node) -> str:
        return self.source_bytes[node.start_byte : node.end_byte].decode()


if __name__ == "__main__":
    source = dedent(
        '''
        class Example:
            """Simple example class"""

            @api.path(/protected)
            def baz():
                pass

        @protected
        @api.path(/protected)
        @ratelimit(50)
        def foo(bar: bool) -> bool:
            """It's so cool function"""
            if bar:
                return True

            return False
        '''
    )

    codeq = Codeq.from_source(source)

    print(codeq.retrieve(CodeKind.FUNC, "baz", CodePart.NODE))
    codeq.replace(CodeKind.FUNC, "baz", CodePart.LOGIC, "print()")
    print(codeq.retrieve(CodeKind.FUNC, "baz", CodePart.NODE))
