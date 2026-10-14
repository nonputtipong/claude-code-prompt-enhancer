/** The draft before the last enhancement and the text the box took, for Restore. */
export type Undo = { original: string; enhanced: string }

declare module 'claude-code' {
  interface PluginState {
    'prompt-enhancer': { busy: boolean; frame: number; undo: Undo | null }
  }
}
