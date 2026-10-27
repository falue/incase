import { autoArrange, type ArrangeResult } from './arrange'
import type { Project } from './model'

// Runs the arrangement off the main thread so the UI stays responsive and can abort it.
const worker = self as unknown as Worker
worker.onmessage = (e: MessageEvent<{ project: Project; even: boolean }>) => {
  const { project, even } = e.data
  const failed = autoArrange(project, even)
  const result: ArrangeResult = { failed, placements: project.items.map(({ id, x, y, rot }) => ({ id, x, y, rot })) }
  worker.postMessage(result)
}
