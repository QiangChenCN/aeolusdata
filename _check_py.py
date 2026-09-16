import ast
for f in ["server.py", "dashboard/standard/grade_standards.py"]:
    ast.parse(open(f, encoding="utf-8").read())
    print("OK", f)
print("PY_SYNTAX_OK")
