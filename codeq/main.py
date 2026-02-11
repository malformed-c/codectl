from pprint import pp
from textwrap import dedent, indent, wrap
from typing import Any

from tree_sitter import Language, Node, Parser, Query, QueryCursor, Tree
import tree_sitter_python as tspython

PY_LANGUAGE = Language(tspython.language())

parser = Parser(PY_LANGUAGE)

source = dedent(
    '''
                def foo(bar: bool):
                    """It's so cool function that I want to write a very long
                    Docstring about it, It's cool, efficient and work just like magic
                    """
                    if bar:
                        baz()

                def baz() -> bool:
                    """
                    Very
                    Cool
                    Function
                    """
                    pass

                def get_user(id: int) -> dict:
                    """Gets user"""
                    if id == 0:
                        pp(id)

                    return {"id": id}

                @protected
                @imaginary
                def set_user(data: dict[str, Any]):
                    pass
                    """Should create user"""

                @app.route("/login")
                @limiter.limit("5/minute")
                def login():
                    """Auth user"""
            '''
)

tree = parser.parse(
    bytes(
        source,
        "utf8",
    )
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
    _funcs_query: Query

    _classes_query_string = dedent(
        """
        (class_definition
            name: (identifier) @class.name
        ) @class.node
        """
    )
    _classes_query: Query

    tree: Tree
    source_bytes: bytearray

    def __init__(self, tree: Tree, source: str) -> None:
        self.tree = tree
        self.source_bytes = bytearray(source.encode())

        self._funcs_query = Query(PY_LANGUAGE, self._funcs_query_string)
        self._classes_query = Query(PY_LANGUAGE, self._classes_query_string)

    def file_map(self) -> list[str]:
        # TODO: Add classes
        result_map = ["<File WIP>"]

        qcur = QueryCursor(self._funcs_query)

        matches = qcur.matches(self.tree.root_node)

        signatures: list[str] = []
        functions_data: dict[str, Any] = {}

        for match in matches:
            # match: tuple(pattern_index, captures_dict)
            # captures_dict: {'func.name': [node], 'func.params': [node], ...}
            captures = match[1]

            func_node = captures["func.node"][0]

            node_id = func_node.id

            if node_id not in functions_data:
                decorators = []
                if "func.decorated_node" in captures:
                    parent = captures["func.decorated_node"][0]
                    for child in parent.children:
                        if child.type == "decorator":
                            decorators.append(child.text.decode().strip())

                functions_data[node_id] = {
                    "name": captures["func.name"][0].text.decode(),
                    "params": captures["func.params"][0].text.decode(),
                    "ret": (
                        captures["func.return_type"][0].text.decode()
                        if "func.return_type" in captures
                        else ""
                    ),
                    "doc": (
                        captures["func.docstring"][0].text.decode().strip("\"' ")
                        if "func.docstring" in captures
                        else ""
                    ),
                    "decs": decorators,
                }

        for fd in functions_data.values():
            deco_prefix = " ".join(fd["decs"]) + " " if fd["decs"] else ""
            doc_suffix = f"  # {' '.join(fd['doc'].split())[:50]}" if fd["doc"] else ""
            ret_suffix = f" -> {fd['ret']}" if fd["ret"] else ""

            result_map.append(
                f"{deco_prefix}def {fd['name']}{fd['params']}{ret_suffix}{doc_suffix}"
            )

        return result_map

    def retrieve(self, kind: str, target: str, what: str) -> str:
        """
        kind: "func" or "class"
        target: identificator
        what: "node", "body", "logic" or "docstring"
        """
        # TODO: Refactor DRY
        query = self._funcs_query if kind == "func" else self._classes_query

        qcur = QueryCursor(query)
        matches = qcur.matches(self.tree.root_node)

        for match in matches:
            captures = match[1]
            name_node = captures[f"{kind}.name"][0]

            if name_node.text.decode() == target:
                if what == "node":
                    target_node = captures.get(
                        f"{kind}.decorated_node", captures.get(f"{kind}.node")
                    )[0]

                elif what == "logic":
                    body_node = captures.get(f"{kind}.body")[0]
                    if f"{kind}.doc_node" in captures:
                        start = captures[f"{kind}.doc_node"][0].end_byte

                    else:
                        start = body_node.start_byte

                    return (
                        self.source_bytes[start : body_node.end_byte].decode().strip()
                    )

                else:
                    target_node = captures.get(
                        f"{kind}.{what}", captures.get(f"{kind}.node")
                    )[0]

                return self.source_bytes[
                    target_node.start_byte : target_node.end_byte
                ].decode()

        return None

    def replace(self, kind: str, target: str, what: str, new_text: str) -> None:
        query = self._funcs_query if kind == "func" else self._classes_query

        qcur = QueryCursor(query)
        matches = qcur.matches(self.tree.root_node)

        for match in matches:
            captures = match[1]
            name_node = captures[f"{kind}.name"][0]

            if name_node.text.decode() != target:
                continue

            capture_name = f"{kind}.{what}"

            if capture_name not in captures:
                if what == "logic" and f"{kind}.body" in captures:
                    capture_name = f"{kind}.body"

                else:
                    # TODO: Support adding nodes
                    available = [capture.split(".")[1] for capture in captures.keys()]
                    if "body" in available:
                        available.append("logic")

                    raise Exception(
                        f"Target found, but {what} is missing and adding it is unsupported\nAvailable captures: {available}"
                    )

            target_node = captures[capture_name][0]

            indent_level = captures[capture_name][0].start_point[1]

            prepared_text = indent(
                dedent(new_text).strip(), " " * indent_level
            ).lstrip()

            new_bytes = prepared_text.encode()
            start, end = target_node.start_byte, target_node.end_byte

            self.source_bytes[start:end] = new_bytes

            self.tree = parser.parse(self.source_bytes)

            return


codeq = Codeq(tree, source)

print("File map:")
for sig in codeq.file_map():
    pp(sig)

# pp("--- RETRIEVED CODE ---")
# print(codeq.retrieve("func", "foo", "logic"))
# print(codeq.retrieve("func", "baz", "logic"))
# print(codeq.retrieve("func", "get_user", "logic"))
# print(codeq.retrieve("func", "set_user", "logic"))
# pp("--- EDITING CODE ---")
# codeq.replace(
#     "func",
#     "get_user",
#     "body",
#     dedent(
#         """
#     if id == 1:
#         pp(id)

#     return {"id": id}
#     """
#     ),
# )
# codeq.replace(
#     "func",
#     "set_user",
#     "body",
#     dedent(
#         """
#     if data:
#         pp(data)

#     return
#     """
#     ),
# )
# print(codeq.retrieve("func", "get_user", "logic"))
# print()
# print(codeq.retrieve("func", "set_user", "logic"))

# print(codeq.source_bytes.decode())

print("Retrieving code only")
print(codeq.retrieve("func", "set_user", "logic"))
print("\nEditing")
codeq.replace(
    "func",
    "set_user",
    "body",
    dedent(
        """
        if data:
            pp(data)

        return
        """
    ),
)
print("Retrieving node")
print(codeq.retrieve("func", "set_user", "node"))
print(codeq.retrieve("func", "login", "node"))
