import z from "zod"

// ---
// Shared
// ---

const metaSchema = z.object({
  description: z.string(),
  /** Optional ordering hint - items run lowest-first */
  order: z.number().int().optional(),
})

// ---
// CodeEdit - handled by Bun / Codeq
// ---

const functionEnsureSchema = z.discriminatedUnion("state", [
  z.object({
    name: z.string(),
    state: z.literal("present"),
    /** Stream ID for lazy body generation via model */
    streamID: z.string(),
  }),
  z.object({
    name: z.string(),
    state: z.literal("absent"),
  }),
])

const resourceSchema = z.object({
  path: z.string(),
  ensure: z.object({
    imports: z.array(z.string()).optional(),
    functions: z.array(functionEnsureSchema).optional(),
  }),
})

const codeEditSchema = z.object({
  apiVersion: z.literal("codectl/v1"),
  kind: z.literal("CodeEdit"),
  metadata: metaSchema,
  spec: z.object({
    resources: z.array(resourceSchema).min(1),
  }),
})

// ---
// Ansible - handled by Python backend
// ---

/**
 * A single Ansible task. `module` is the fully-qualified module name
 * (e.g. "ansible.builtin.apt", "community.general.pip_package_info").
 * `args` is passed verbatim as the module arguments.
 */
const ansibleTaskSchema = z.object({
  name: z.string(),
  module: z.string(),
  args: z.record(z.string(), z.unknown()),
  /** Run only when this condition is truthy (passed as Ansible `when`) */
  when: z.string().optional(),
  /** Notify a handler by name */
  notify: z.string().optional(),
})

const ansibleHandlerSchema = z.object({
  name: z.string(),
  module: z.string(),
  args: z.record(z.string(), z.unknown()),
})

const ansibleSchema = z.object({
  apiVersion: z.literal("codectl/v1"),
  kind: z.literal("Ansible"),
  metadata: metaSchema,
  spec: z.object({
    hosts: z.union([z.string(), z.array(z.string())]).default("localhost"),
    tasks: z.array(ansibleTaskSchema).min(1),
    handlers: z.array(ansibleHandlerSchema).optional(),
  }),
})

// ---
// Unified CodePlan
// ---

const planItemSchema = z.discriminatedUnion("kind", [
  codeEditSchema,
  ansibleSchema,
])

export const codePlanSchema = z.object({
  codePlan: z.array(planItemSchema).min(1),
})

// ---
// Exported types
// ---

export type CodePlan = z.infer<typeof codePlanSchema>
export type PlanItem = z.infer<typeof planItemSchema>
export type CodeEditItem = z.infer<typeof codeEditSchema>
export type AnsibleItem = z.infer<typeof ansibleSchema>
export type AnsibleTask = z.infer<typeof ansibleTaskSchema>
export type Resource = z.infer<typeof resourceSchema>
export type FunctionEnsure = z.infer<typeof functionEnsureSchema>
