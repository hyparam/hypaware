export interface Key {
  /**
   * Special name: 'up', 'down', 'space', 'return', 'escape', 'backspace',
   * or a single character ('a', '1', ...).
   */
  name?: string
  /**
   * Raw character(s): used for printable text input in `text` mode and the
   * y/n chars in `confirm` mode.
   */
  sequence?: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
}

export interface MultiselectOption {
  value: string | number
  label: string
  summary?: string
  checked: boolean
}

export interface MultiselectState {
  kind: 'multiselect'
  title: string
  hint?: string
  options: MultiselectOption[]
  cursor: number
  bounds?: { min?: number, max?: number }
  status: 'active' | 'resolved' | 'cancelled'
  error?: string
}

export interface SelectOption {
  value: string | number
  label: string
  summary?: string
}

export interface SelectState {
  kind: 'select'
  title: string
  hint?: string
  options: SelectOption[]
  cursor: number
  status: 'active' | 'resolved' | 'cancelled'
}

export interface TextState {
  kind: 'text'
  title: string
  hint?: string
  default?: string
  value: string
  mask: boolean
  validate?: (v: string) => string | null
  status: 'active' | 'resolved' | 'cancelled'
  error?: string
}

export interface ConfirmState {
  kind: 'confirm'
  title: string
  hint?: string
  default: boolean
  /** Set when resolved. */
  value?: boolean
  status: 'active' | 'resolved' | 'cancelled'
}

export type State = MultiselectState | SelectState | TextState | ConfirmState

export interface MultiSelectOption {
  value: string | number
  label: string
  summary?: string
  checked?: boolean
}

export interface MultiSelectSpec {
  title: string
  hint?: string
  options: MultiSelectOption[]
  bounds?: { min?: number, max?: number }
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
  env?: NodeJS.ProcessEnv
  clearOnResolve?: boolean
}

export interface SelectSpecOption {
  value: string | number
  label: string
  summary?: string
}

export interface SelectSpec {
  title: string
  hint?: string
  options: SelectSpecOption[]
  default?: string | number
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
  env?: NodeJS.ProcessEnv
  clearOnResolve?: boolean
}

export interface TextSpec {
  title: string
  hint?: string
  default?: string
  validate?: (v: string) => string | null
  mask?: boolean
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
  env?: NodeJS.ProcessEnv
  clearOnResolve?: boolean
}

export interface ConfirmSpec {
  title: string
  hint?: string
  default?: boolean
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
  env?: NodeJS.ProcessEnv
  clearOnResolve?: boolean
}

export interface RenderOpts {
  color: boolean
}

export interface RunOpts {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  env?: NodeJS.ProcessEnv
  /**
   * Erase the prompt's frame from the terminal when it settles (resolve or
   * cancel) so the next prompt redraws in its place instead of stacking
   * below it.
   */
  clearOnResolve?: boolean
}
