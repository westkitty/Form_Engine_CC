/**
 * Undo/redo stack of committed commands. Only committed work enters history; in-flight strokes and
 * transforms are rolled back by their own transaction objects when cancelled.
 */
export interface Command {
  label: string;
  /** Approximate retained bytes, used for the memory budget. */
  bytes: number;
  undo(): void;
  redo(): void;
}

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private listeners = new Set<() => void>();
  constructor(public maxBytes = 256 * 1024 * 1024, public maxEntries = 200) {}

  /** Record an already-applied command. Clears the redo branch. */
  push(cmd: Command) {
    this.undoStack.push(cmd);
    this.redoStack = [];
    this.trim();
    this.emit();
  }

  undo(): Command | null {
    const c = this.undoStack.pop();
    if (!c) return null;
    c.undo();
    this.redoStack.push(c);
    this.emit();
    return c;
  }

  redo(): Command | null {
    const c = this.redoStack.pop();
    if (!c) return null;
    c.redo();
    this.undoStack.push(c);
    this.emit();
    return c;
  }

  clear() { this.undoStack = []; this.redoStack = []; this.emit(); }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get bytes() { return [...this.undoStack, ...this.redoStack].reduce((s, c) => s + c.bytes, 0); }
  get entries() { return this.undoStack.map((c) => c.label); }
  get size() { return this.undoStack.length; }
  onChange(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  private trim() {
    while (this.undoStack.length > this.maxEntries || (this.bytes > this.maxBytes && this.undoStack.length > 1)) this.undoStack.shift();
  }
  private emit() { for (const l of this.listeners) l(); }
}
