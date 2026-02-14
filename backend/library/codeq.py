#!/usr/bin/python
from ansible.module_utils.basic import AnsibleModule
import os
import sys
import httpx

def resolve_stream(stream_id, stream_url):
    if not stream_url:
        raise ValueError("CODECTL_STREAM_URL not set")

    url = f"{stream_url}/stream/{stream_id}"
    response = httpx.get(url)
    if response.status_code == 200:
        return response.json().get("content")
    else:
        raise Exception(f"Failed to resolve stream {stream_id}: {response.status_code}")

def run_module():
    module_args = dict(
        path=dict(type='str', required=True),
        imports=dict(type='list', elements='str', required=False, default=[]),
        functions=dict(type='list', elements='dict', required=False, default=[]),
    )

    module = AnsibleModule(
        argument_spec=module_args,
        supports_check_mode=True
    )

    path = module.params['path']
    _, ext = os.path.splitext(path)

    stream_url = os.environ.get("CODECTL_STREAM_URL")

    functions = []
    for f in module.params['functions']:
        f_copy = f.copy()
        if f.get('streamID') and f.get('state') == 'present':
            try:
                content = resolve_stream(f['streamID'], stream_url)
                f_copy['content'] = content
            except Exception as e:
                module.fail_json(msg=f"Error resolving streamID {f['streamID']}: {str(e)}")
        functions.append(f_copy)

    if ext == '.py':
        sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
        from codeq.py_codemod import apply_codemods

        try:
            apply_codemods(path, module.params['imports'], functions)
            module.exit_json(changed=True, path=path)
        except Exception as e:
            module.fail_json(msg=str(e))

    elif ext in ['.ts', '.js']:
        # Placeholder for jscodeshift
        # Example: subprocess.run(["bun", "run", "frontend/codemod.ts", path, ...])
        module.exit_json(changed=False, msg="JSCodeshift placeholder - not yet implemented for " + path)

    else:
        module.fail_json(msg=f"Unsupported file extension: {ext}")

if __name__ == '__main__':
    run_module()
