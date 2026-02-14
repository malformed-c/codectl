#!/usr/bin/python
from ansible.module_utils.basic import AnsibleModule
import sys
import os

# Add the parent directory of library to sys.path so we can import codeq
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

try:
    from codeq.py_codemod import apply_codemods
except ImportError:
    # Fallback for when it's ran in a way where above doesn't work
    apply_codemods = None

def run_module():
    module_args = dict(
        path=dict(type='str', required=True),
        imports=dict(type='list', elements='str', required=False, default=[]),
        functions=dict(type='list', elements='dict', required=False, default=[]),
    )

    result = dict(
        changed=False,
        path='',
        message=''
    )

    module = AnsibleModule(
        argument_spec=module_args,
        supports_check_mode=True
    )

    if apply_codemods is None:
        module.fail_json(msg="Could not import codeq.py_codemod. Make sure PYTHONPATH is set correctly.")

    path = module.params['path']
    imports = module.params['imports']
    functions = module.params['functions']

    if module.check_mode:
        module.exit_json(**result)

    try:
        apply_codemods(path, imports, functions)
        result['changed'] = True # For simplicity, we assume change. Real LibCST could check if code changed.
        result['path'] = path
        module.exit_json(**result)
    except Exception as e:
        module.fail_json(msg=str(e))

if __name__ == '__main__':
    run_module()
