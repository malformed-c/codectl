from textwrap import dedent

import pytest

from codeq.main import AmbiguousTargetError, CodeKind, CodePart, Codeq


def test_file_map_groups_methods_under_class_with_separators() -> None:
    source = dedent(
        '''
        def top_level():
            pass

        class Greeter:
            """Simple greeter"""

            def hello(self):
                pass

            @staticmethod
            def wave():
                pass

        class Empty:
            pass
        '''
    )

    result = Codeq.from_source(source).file_map()

    assert result == [
        "def top_level()",
        "---",
        "class Greeter:  # Simple greeter\n    def hello(self)\n    @staticmethod def wave()",
        "---",
        "class Empty:",
    ]


def test_add_import_inserts_after_docstring_and_existing_imports() -> None:
    source = dedent(
        '''
        """module docs"""

        import os

        def run() -> None:
            pass
        '''
    )

    codeq = Codeq.from_source(source)
    changed = codeq.add_import("from pathlib import Path")

    assert changed is True
    assert codeq.source_bytes.decode() == dedent(
        '''
        """module docs"""

        import os
        from pathlib import Path

        def run() -> None:
            pass
        '''
    )


def test_add_import_noop_on_duplicate_statement() -> None:
    source = "import os\n\n"
    codeq = Codeq.from_source(source)

    changed = codeq.add_import("import os")

    assert changed is False
    assert codeq.source_bytes.decode() == source


def test_add_import_rejects_invalid_statement() -> None:
    codeq = Codeq.from_source("def f():\n    pass\n")

    with pytest.raises(ValueError, match="Unsupported import statement"):
        codeq.add_import("print('x')")

    with pytest.raises(ValueError, match="cannot be empty"):
        codeq.add_import("   ")


def test_retrieve_raises_on_ambiguous_function_and_method_name() -> None:
    source = dedent(
        """
        def run():
            return "top"

        class Worker:
            def run(self):
                return "method"
        """
    )

    codeq = Codeq.from_source(source)

    with pytest.raises(AmbiguousTargetError, match="Ambiguous func target 'run'"):
        codeq.retrieve(CodeKind.FUNC, "run", CodePart.NODE)


def test_retrieve_supports_fully_qualified_method_name() -> None:
    source = dedent(
        """
        def run():
            return "top"

        class Worker:
            def run(self):
                return "method"
        """
    )

    codeq = Codeq.from_source(source)

    method_node = codeq.retrieve(CodeKind.FUNC, "Worker.run", CodePart.NODE)

    assert method_node is not None
    assert method_node.startswith("def run(self)")


def test_replace_supports_fully_qualified_method_name() -> None:
    source = dedent(
        """
        class Worker:
            def run(self):
                return "method"
        """
    )

    codeq = Codeq.from_source(source)
    codeq.replace(CodeKind.FUNC, "Worker.run", CodePart.LOGIC, 'return "updated"')

    updated = codeq.retrieve(CodeKind.FUNC, "Worker.run", CodePart.LOGIC)

    assert updated == 'return "updated"'
