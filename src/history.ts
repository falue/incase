/** Undo/redo over JSON snapshots; changes within `idle` ms (typing, dragging) merge into one step. */
export class History {
  private undoStack: string[] = []
  private redoStack: string[] = []
  private pending: (() => string) | null = null
  private timer = 0

  constructor(private committed: string, private limit = 200, private idle = 400) {}

  get canUndo() {
    return this.undoStack.length > 0 || this.pending !== null
  }

  get canRedo() {
    return this.redoStack.length > 0
  }

  /** Call after every change; `snapshot` is read once the changes settle. */
  record(snapshot: () => string) {
    this.pending = snapshot
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.idle)
  }

  undo(): string | null {
    this.flush()
    return this.step(this.undoStack, this.redoStack)
  }

  redo(): string | null {
    this.flush()
    return this.step(this.redoStack, this.undoStack)
  }

  private step(from: string[], to: string[]) {
    const state = from.pop()
    if (state === undefined) return null
    to.push(this.committed)
    this.committed = state
    return state
  }

  private flush() {
    clearTimeout(this.timer)
    const now = this.pending?.()
    this.pending = null
    if (now === undefined || now === this.committed) return
    this.undoStack.push(this.committed)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.committed = now
    this.redoStack.length = 0
  }
}
