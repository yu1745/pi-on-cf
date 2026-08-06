/**
 * Ambient types for `html-to-text` (v10).
 *
 * v10's package.json exports map omits the `types` condition and ships no
 * .d.ts in lib/, so TypeScript can't resolve types for it (v9 did ship
 * them). Rather than downgrade — the `convert` API is identical and v10
 * fixes bugs — we declare just the surface this project uses.
 */

declare module 'html-to-text' {
  interface HtmlToTextSelectorOptions {
    hideLinkHrefIfSameAsText?: boolean
    ignoreHref?: boolean
    [key: string]: unknown
  }

  interface HtmlToTextSelector {
    selector: string
    options?: HtmlToTextSelectorOptions
    /** 'block' | 'inline' | 'skip' | custom formatter name. */
    format?: string
  }

  interface HtmlToTextLimits {
    maxInputLength?: number
    maxBaseElements?: number
    maxChildNodes?: number
    [key: string]: unknown
  }

  interface HtmlToTextOptions {
    /** Column width for hard wrapping. `false` disables wrapping. */
    wordwrap?: number | false
    limits?: HtmlToTextLimits
    selectors?: HtmlToTextSelector[]
    preserveNewlines?: boolean
    decodeEntities?: boolean
    [key: string]: unknown
  }

  export function convert(html: string, options?: HtmlToTextOptions): string
}
