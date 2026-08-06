export interface RenderOptions {
  /** The reports tree: holds `<slug>.md` files, optional `<slug>/` section dirs, and `assets/`. */
  dir: string
  /**
   * Overwrite the command-owned assets from the shipped copies. Default true.
   * Never covers `assets/theme.css`, which is the user's (LLP 0193 #theme-layer).
   */
  refreshAssets?: boolean
}

export interface RenderResult {
  reports: number
  slugs: string[]
}

export interface LandingStat {
  /** The figure's authored markup, e.g. `9.01<small>B</small>`. Rendered as-is. */
  valueHtml: string
  /** The same figure flattened to text, e.g. "9.01B". */
  value: string
  /** The metric's own label, used verbatim: rewriting it would be writing copy. */
  label: string
  /** "crit" | "warn" | "good", or "" for a neutral figure. */
  judgment: string
}

export interface LandingCard {
  href: string
  kicker: string
  title: string
  stats: LandingStat[]
  go: string
}
