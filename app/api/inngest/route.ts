import { serve } from "inngest/next"
import { inngest } from "../../../inngest/client"
import { processScan } from "../../../inngest/functions/processScan"

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [processScan],
})
