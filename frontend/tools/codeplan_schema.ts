import type { ToolDefinition } from '../tool'
import { ok } from '../tool'
import type { ToolHandler } from '../orchestrator'

/**
 * JSON Schema representation of the CodePlan format.
 * Derived from codeplan.schema.ts — update both if the schema changes.
 */
const CODEPLAN_SCHEMA = {
  type: 'object',
  required: ['codePlan'],
  properties: {
    codePlan: {
      type: 'array',
      minItems: 1,
      description: 'Ordered list of plan items. Each item is either a CodeEdit or Ansible resource.',
      items: {
        oneOf: [
          {
            title: 'Ansible',
            description: 'Run Ansible tasks on a host. Use for file creation, package install, service management, system config.',
            type: 'object',
            required: ['apiVersion', 'kind', 'metadata', 'spec'],
            properties: {
              apiVersion: { const: 'codectl/v1' },
              kind:       { const: 'Ansible' },
              metadata: {
                type: 'object',
                required: ['description'],
                properties: {
                  description: { type: 'string' },
                  order:       { type: 'integer', description: 'Execution order hint. Lower runs first.' },
                },
              },
              spec: {
                type: 'object',
                required: ['tasks'],
                properties: {
                  hosts: {
                    description: 'Target host(s). Defaults to "localhost".',
                    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                    default: 'localhost',
                  },
                  tasks: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      required: ['name', 'module', 'args'],
                      properties: {
                        name:   { type: 'string', description: 'Human-readable task name.' },
                        module: { type: 'string', description: 'Fully-qualified Ansible module name, e.g. "ansible.builtin.copy", "ansible.builtin.apt".' },
                        args:   { type: 'object', description: 'Module arguments passed verbatim.' },
                        when:   { type: 'string', description: 'Optional Ansible `when` condition.' },
                        notify: { type: 'string', description: 'Optional handler name to notify.' },
                      },
                    },
                  },
                  handlers: {
                    type: 'array',
                    description: 'Optional Ansible handlers (triggered via notify).',
                    items: {
                      type: 'object',
                      required: ['name', 'module', 'args'],
                      properties: {
                        name:   { type: 'string' },
                        module: { type: 'string' },
                        args:   { type: 'object' },
                      },
                    },
                  },
                },
              },
            },
          },
          {
            title: 'CodeEdit',
            description: 'Edit TypeScript/JavaScript source files by ensuring imports and functions are present or absent.',
            type: 'object',
            required: ['apiVersion', 'kind', 'metadata', 'spec'],
            properties: {
              apiVersion: { const: 'codectl/v1' },
              kind:       { const: 'CodeEdit' },
              metadata: {
                type: 'object',
                required: ['description'],
                properties: {
                  description: { type: 'string' },
                  order:       { type: 'integer' },
                },
              },
              spec: {
                type: 'object',
                required: ['resources'],
                properties: {
                  resources: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      required: ['path', 'ensure'],
                      properties: {
                        path: { type: 'string', description: 'File path to edit.' },
                        ensure: {
                          type: 'object',
                          properties: {
                            imports: {
                              type: 'array',
                              items: { type: 'string' },
                              description: 'Import statements to ensure are present.',
                            },
                            functions: {
                              type: 'array',
                              description: 'Functions to ensure are present or absent.',
                              items: {
                                oneOf: [
                                  {
                                    type: 'object',
                                    required: ['name', 'state', 'streamID'],
                                    properties: {
                                      name:     { type: 'string' },
                                      state:    { const: 'present' },
                                      streamID: { type: 'string', description: 'Stream ID for lazy body generation.' },
                                    },
                                  },
                                  {
                                    type: 'object',
                                    required: ['name', 'state'],
                                    properties: {
                                      name:  { type: 'string' },
                                      state: { const: 'absent' },
                                    },
                                  },
                                ],
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    },
  },
}

const EXAMPLE = {
  codePlan: [
    {
      apiVersion: 'codectl/v1',
      kind: 'Ansible',
      metadata: { description: 'Install curl', order: 1 },
      spec: {
        hosts: 'localhost',
        tasks: [
          { name: 'Install curl', module: 'ansible.builtin.apt', args: { name: 'curl', state: 'present' } },
        ],
      },
    },
  ],
}

export const CodePlanSchemaTool: ToolDefinition = {
  name: 'codeplan_schema',
  description:
    'Return the JSON Schema for the CodePlan format used by validate_plan and run_plan. ' +
    'Call this before writing a plan if you are unsure of the required structure.',
  parameters: {
    type: 'object',
    properties: {
      include_example: {
        type: 'boolean',
        description: 'If true, include a minimal valid example alongside the schema.',
      },
    },
  },
}

export function createCodePlanSchemaHandler(): ToolHandler {
  return async (args) => {
    const includeExample = Boolean(args.include_example)
    return ok({
      schema: CODEPLAN_SCHEMA,
      ...(includeExample ? { example: EXAMPLE } : {}),
    })
  }
}
