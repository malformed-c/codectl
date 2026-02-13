import z from "zod"

const codePlanSchema = z.object({
  codePlan: z.array(
    z.object({
      apiVersion: z.string(),
      kind: z.string(),
      metadata: z.object({ description: z.string() }),
      spec: z.object({ // TODO separate spec in its own schema
        resources: z.array(z.object({
          path: z.string(),
          ensure: z.object({
            imports: z.array(z.string()).optional(),
            functions: z.array(z.object({
              name: z.string(),
              state: z.enum(["present", "absent"]),
              streamID: z.string().optional() // TODO refine type to be required when state is present
            }))
          })
        }))
      })
    })
  )
})

export type CodePlan = z.infer<typeof codePlanSchema>
