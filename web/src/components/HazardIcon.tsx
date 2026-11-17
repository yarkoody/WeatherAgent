import { CloudLightning, CloudRainWind, Snowflake, Waves, type LucideIcon } from 'lucide-react'
import { FAMILY_COLOR } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Family } from '@/lib/types'

/**
 * One icon per hazard family. Lucide has no hurricane glyph; CloudRainWind (wind-driven rain) is the closest
 * distinct one (Tornado would name a different event, and CloudLightning is severe storm).
 */
export const HAZARD_ICON: Record<Family, LucideIcon> = {
  winter: Snowflake,
  flood: Waves,
  hurricane: CloudRainWind,
  severe_storm: CloudLightning,
}

/** Decorative unless `label` is given. Tinted with the family's chart color unless `tinted` is false. */
export function HazardIcon({ hazard, label, className, tinted = true }: { hazard: Family; label?: string; className?: string; tinted?: boolean }) {
  const Icon = HAZARD_ICON[hazard]
  return (
    <Icon
      className={cn('inline-block size-4 shrink-0 align-[-0.15em]', className)}
      style={tinted ? { color: FAMILY_COLOR[hazard] } : undefined}
      strokeWidth={2}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
    />
  )
}
