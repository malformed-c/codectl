import libcst as cst
from typing import List, Optional, Tuple
from pathlib import Path
import sys

class SignatureExtractor(cst.CSTVisitor):
    def __init__(self):
        self.items = []
        self.current_class = None

    def visit_ClassDef(self, node: cst.ClassDef) -> Optional[bool]:
        name = node.name.value
        bases = []
        for b in node.bases:
            bases.append(self._get_full_name(b.value))

        bases_str = f"({', '.join(bases)})" if bases else ""

        docstring = self._get_docstring(node.body)
        sig = f"class {name}{bases_str}:"
        if docstring:
            sig += f"  # {docstring[:50]}"

        self.items.append(sig)
        old_class = self.current_class
        self.current_class = name
        return True

    def leave_ClassDef(self, node: cst.ClassDef) -> None:
        self.current_class = None

    def visit_FunctionDef(self, node: cst.FunctionDef) -> Optional[bool]:
        decorators = []
        for deco in node.decorators:
            decorators.append(f"@{self._get_full_name(deco.decorator)}")

        flat_decos = " ".join(decorators) + " " if decorators else ""
        name = node.name.value
        params = self._get_params(node.params)
        ret = ""
        if node.returns:
            ret = f" -> {self._get_full_name(node.returns.annotation)}"

        docstring = self._get_docstring(node.body)
        doc_suffix = f"  # {docstring[:50]}" if docstring else ""

        indent = "    " if self.current_class else ""
        sig = f"{indent}{flat_decos}def {name}{params}{ret}{doc_suffix}"
        self.items.append(sig)
        return False

    def _get_full_name(self, node: cst.CSTNode) -> str:
        if isinstance(node, cst.Name):
            return node.value
        if isinstance(node, cst.Attribute):
            return f"{self._get_full_name(node.value)}.{node.attr.value}"
        if isinstance(node, cst.Call):
            return f"{self._get_full_name(node.func)}(...)"
        if isinstance(node, cst.Subscript):
            return f"{self._get_full_name(node.value)}[...] "
        return "..."

    def _get_params(self, node: cst.Parameters) -> str:
        parts = []
        for p in node.params:
            parts.append(p.name.value)
        return f"({', '.join(parts)})"

    def _get_docstring(self, body: cst.IndentedBlock) -> Optional[str]:
        if not body.body:
            return None
        first_stmt = body.body[0]
        if isinstance(first_stmt, cst.SimpleStatementLine):
            if not first_stmt.body:
                return None
            expr = first_stmt.body[0]
            if isinstance(expr, cst.Expr) and isinstance(expr.value, (cst.SimpleString, cst.ConcatenatedString)):
                val = expr.value.evaluated_value
                if val:
                    return val.strip().replace("\n", " ")
        return None

def get_file_map(file_path: str) -> List[str]:
    path = Path(file_path)
    if not path.exists():
        return []

    code = path.read_text()
    try:
        tree = cst.parse_module(code)
    except Exception:
        return [f"# Error parsing {file_path}"]

    visitor = SignatureExtractor()
    tree.visit(visitor)

    result = []
    for i, item in enumerate(visitor.items):
        if i > 0 and not item.startswith("    "):
             result.append("---")
        result.append(item)
    return result

class ComprehensiveTransformer(cst.CSTTransformer):
    def __init__(self, imports: List[str], functions: List[dict]):
        self.imports_to_add = imports
        self.funcs_to_change = {f['name']: f for f in functions}
        self.processed_funcs = set()
        self.existing_imports = set()

    def visit_Import(self, node: cst.Import) -> None:
        self.existing_imports.add(cst.Module(body=[cst.SimpleStatementLine(body=[node])]).code.strip())

    def visit_ImportFrom(self, node: cst.ImportFrom) -> None:
        self.existing_imports.add(cst.Module(body=[cst.SimpleStatementLine(body=[node])]).code.strip())

    def leave_FunctionDef(self, original_node: cst.FunctionDef, updated_node: cst.FunctionDef):
        name = original_node.name.value
        if name in self.funcs_to_change:
            spec = self.funcs_to_change[name]
            self.processed_funcs.add(name)
            if spec['state'] == 'absent':
                return cst.RemoveFromParent()
            else:
                new_node = cst.parse_module(spec['content']).body[0]
                return new_node
        return updated_node

    def leave_Module(self, original_node: cst.Module, updated_node: cst.Module) -> cst.Module:
        new_body = list(updated_node.body)

        # Add missing functions
        for name, spec in self.funcs_to_change.items():
            if name not in self.processed_funcs and spec['state'] == 'present':
                new_node = cst.parse_module(spec['content']).body[0]
                new_body.append(new_node)

        # Add imports at the top (after any possible docstring/shebang)
        insertion_index = 0
        if new_body and isinstance(new_body[0], cst.SimpleStatementLine):
             stmt = new_body[0].body[0]
             if isinstance(stmt, cst.Expr) and isinstance(stmt.value, (cst.SimpleString, cst.ConcatenatedString)):
                 insertion_index = 1

        for imp_str in reversed(self.imports_to_add):
            if imp_str not in self.existing_imports:
                imp_node = cst.parse_module(imp_str).body[0]
                new_body.insert(insertion_index, imp_node)

        return updated_node.with_changes(body=new_body)

def apply_codemods(file_path: str, imports: List[str] = None, functions: List[dict] = None):
    path = Path(file_path)
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("")

    code = path.read_text()
    tree = cst.parse_module(code)
    transformer = ComprehensiveTransformer(imports or [], functions or [])
    new_tree = tree.visit(transformer)
    path.write_text(new_tree.code)
