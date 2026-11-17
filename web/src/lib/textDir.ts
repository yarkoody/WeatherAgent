// Hebrew, Arabic, Syriac, Thaana, NKo and their presentation forms.
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/gu
const LETTER = /\p{L}/gu

/**
 * "rtl" when a right-to-left script makes up at least a third of the letters, else undefined (no attribute, so
 * English renders exactly as before). Not dir="auto": that follows the first strong character, and a Hebrew
 * answer that opens with an English hub name ("**Chicago** ...") would then lay out left to right.
 */
export function textDir(text: string | null | undefined): 'rtl' | undefined {
  if (!text) return undefined
  const rtl = text.match(RTL)?.length ?? 0
  if (rtl === 0) return undefined
  const letters = text.match(LETTER)?.length ?? 0
  return rtl * 3 >= letters ? 'rtl' : undefined
}
