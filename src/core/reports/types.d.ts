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
