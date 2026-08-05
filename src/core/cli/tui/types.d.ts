export interface Key {
  /**
   * Special name: 'up', 'down', 'space', 'return', 'escape', 'backspace',
   * or a single character ('a', '1', ...).
   */
  name?: string
  /** Raw character(s): used for printable text input in `text` mode. */
  sequence?: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
}

/**
 * The chrome every prompt carries above its body, shared by all three
 * prompt kinds in both their spec (caller-facing) and state (reducer-
 * facing) forms.
 *
 * Six interfaces used to declare `title` and `hint` independently. The
 * position indicator (LLP 0135 #progress) has to reach all six, so they
 * derive from one base instead: a field added here renders everywhere, and
 * cannot drift between the kinds.
 */
export interface PromptChrome {
  /**
   * The bold headline: the question being asked. Omitted only when the
   * caller has already printed the headline on the lines above the
   * prompt (the returning gate's summary block); an omitted title
   * renders no line, not a blank one.
   */
  title?: string
  /** The dim key-help line under the title; each kind has a default. */
  hint?: string
  /**
   * Optional position line rendered dim *above* the title, e.g.
   * `Step 2 of 3 · Choose what to collect`. Deliberately not folded into
   * `title`: keeping it a separate field is what lets the renderer give it
   * its own line and its own styling, and lets the non-TUI fallbacks print
   * a plain-text form of the same text. Omitted whenever the caller cannot
   * state a position honestly, and an omitted field changes no output.
   */
  progress?: string
  /**
   * Optional context lines rendered verbatim between the title and the
   * hint (LLP 0190): the wizard's defaults gates list what they are about
   * to accept here, one entry per line, instead of cramming the list into
   * the title. Rendered inside the frame so `clearOnResolve` erases the
   * list with the prompt. Callers own any indentation. An omitted field
   * changes no output.
   */
  items?: string[]
  /**
   * Opt-in back-navigation (LLP 0191): escape settles the prompt as
   * `backed` (the runtime throws `PromptBackRequestedError`) instead of
   * cancelling, and the default hint reads `esc back`. Ctrl+C cancels
   * regardless. Only the wizard's step prompts set this; everywhere else
   * escape keeps meaning cancel.
   */
  allowBack?: boolean
}

export interface MultiselectOption {
  value: string | number
  label: string
  summary?: string
  checked: boolean
  /** Read-only row: shown but not toggleable by space or select-all. */
  disabled?: boolean
}

export interface MultiselectState extends PromptChrome {
  kind: 'multiselect'
  options: MultiselectOption[]
  /**
   * Row index under the pointer. Ranges over `0..options.length`
   * inclusive: `options.length` addresses the Submit row rendered below
   * the options, which confirms on space as well as enter.
   */
  cursor: number
  bounds?: { min?: number, max?: number }
  status: 'active' | 'resolved' | 'cancelled' | 'backed'
  error?: string
}

export interface SelectOption {
  value: string | number
  label: string
  summary?: string
}

export interface SelectState extends PromptChrome {
  kind: 'select'
  options: SelectOption[]
  cursor: number
  status: 'active' | 'resolved' | 'cancelled' | 'backed'
}

export interface TextState extends PromptChrome {
  kind: 'text'
  default?: string
  value: string
  mask: boolean
  validate?: (v: string) => string | null
  status: 'active' | 'resolved' | 'cancelled' | 'backed'
  error?: string
}

export type State = MultiselectState | SelectState | TextState

export interface MultiSelectOption {
  value: string | number
  label: string
  summary?: string
  checked?: boolean
  /** Read-only row: shown but not toggleable by space or select-all. */
  disabled?: boolean
}

export interface MultiSelectSpec extends PromptChrome {
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

export interface SelectSpec extends PromptChrome {
  options: SelectSpecOption[]
  default?: string | number
  stdin?: NodeJS.ReadableStream
  stdout?: NodeJS.WritableStream
  env?: NodeJS.ProcessEnv
  clearOnResolve?: boolean
}

export interface TextSpec extends PromptChrome {
  default?: string
  validate?: (v: string) => string | null
  mask?: boolean
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
