// Scores tab map: the 15 hubs on an offline US states map (us-atlas TopoJSON bundled; no tile service).
// Dot color = the hub's top hazard, dot size = bad-year lost days, faint ring = the model's local-hazard area
// (a 1,000 sq mi circle: scoring.reference_area_sq_mi), drawn in map units so it scales with the projection and zoom.
import { MinusIcon, PlusIcon, RotateCcwIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { useReducedMotion } from '@/lib/motion'
import { ComposableMap, Geographies, Geography, Marker, ZoomableGroup, useMapContext } from 'react-simple-maps'
import states from 'us-atlas/states-10m.json'
import { HAZARD_ICON, HazardIcon } from '@/components/HazardIcon'
import { Button } from '@/components/ui/button'
import { FAMILIES, FAMILY_COLOR, FAMILY_LABEL, compact, fmt, hasPeople, shortHubName } from '@/lib/format'
import type { Hub, ScoreRow } from '@/lib/types'

type ColorMode = 'risk' | 'people'

/** One-hue scale for people impact: from a light tint (fewest people-days) to the full accent (most). */
export function impactColor(value: number, min: number, max: number): string {
  const t = max > min ? (value - min) / (max - min) : 1
  return `color-mix(in oklab, var(--color-isobar) ${Math.round(30 + 70 * t)}%, var(--map-land))`
}

const WIDTH = 975
const HEIGHT = 610
/** Radius of the model's 1,000 sq mi reference area: sqrt(1000 / pi) miles. */
export const RING_MILES = Math.sqrt(1000 / Math.PI) // ≈ 17.8
const MILES_PER_DEGREE_LAT = 69.05
const HOME = { center: [-96, 38] as [number, number], zoom: 1 }
const MIN_ZOOM = 1
/** The zoom used when the table asks the map to show a hub: close enough to see its ring, still regional. */
const FOCUS_ZOOM = 3
const MAX_ZOOM = 8

/** Wheel zooms only with Ctrl/⌘ (trackpad pinch sends ctrlKey), so the page still scrolls over the map. */
export function zoomFilter(e: Event): boolean {
  if (e.type === 'wheel') return (e as WheelEvent).ctrlKey || (e as WheelEvent).metaKey
  return !(e as MouseEvent).button
}

/** Pixel radius (map units) of RING_MILES around a point, from the projection itself. */
export function ringRadius(project: (p: [number, number]) => [number, number] | null, lon: number, lat: number): number {
  const a = project([lon, lat])
  const b = project([lon, lat + RING_MILES / MILES_PER_DEGREE_LAT])
  return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : 0
}

/** The hazard's Lucide icon as a nested SVG (HazardIcon is for HTML text). */
function MapIcon({ hazard, y }: { hazard: keyof typeof HAZARD_ICON; y: number }) {
  const Icon = HAZARD_ICON[hazard]
  return <Icon x={-7} y={y} width={14} height={14} color={FAMILY_COLOR[hazard]} strokeWidth={2.25} aria-hidden="true" />
}

function Ring({ hub }: { hub: Hub }) {
  const { projection } = useMapContext()
  const r = ringRadius((p) => projection(p) as [number, number] | null, hub.lon, hub.lat)
  return <circle data-ring r={r} fill="currentColor" fillOpacity={0.07} stroke="currentColor" strokeOpacity={0.35} strokeWidth={0.75} vectorEffect="non-scaling-stroke" />
}

export function HubMap({
  hubs,
  rows,
  selected,
  onSelect,
  onClose,
  panel,
  panelTitle,
  focusRequest,
}: {
  /** Table → map: center and zoom on this hub and pulse its dot once (a new `n` repeats it). */
  focusRequest?: { id: string; n: number } | null
  hubs: Hub[]
  rows: ScoreRow[]
  selected: string | null
  onSelect: (id: string) => void
  /** Closes the hub panel; focus then returns to that hub's dot. */
  onClose?: () => void
  /** The selected hub's detail, docked inside the map frame (right side; a bottom sheet on phones). */
  panel?: ReactNode
  panelTitle?: string
}) {
  const wide = useMediaQuery('(min-width: 640px)')
  const open = Boolean(panel)
  const closeButton = useRef<HTMLButtonElement>(null)
  const lastSelected = useRef<string | null>(null)
  // Focus moves into the panel when a hub opens it (or swaps it).
  useEffect(() => {
    if (open && selected) {
      lastSelected.current = selected
      closeButton.current?.focus({ preventScroll: true })
    }
  }, [open, selected])
  const close = () => {
    const id = lastSelected.current
    onClose?.()
    // Back to the hub dot that opened the panel.
    requestAnimationFrame(() => document.querySelector<SVGGElement>(`[data-hub="${id}"]`)?.focus())
  }
  const [view, setView] = useState(HOME)
  const [hover, setHover] = useState<string | null>(null)
  const byId = new Map(rows.map((r) => [r.hub_id, r]))
  const maxBad = Math.max(1, ...rows.map((r) => r.bad_year_days))
  // Color by: the hub's biggest risk (hazard colors, size = bad-year days) or people impact
  // (one-hue scale by people-days, size = people served). People data may be missing on older backends.
  const [mode, setMode] = useState<ColorMode>('risk')
  const peopleKnown = rows.some(hasPeople)
  const people = mode === 'people' && peopleKnown
  const peopleDays = rows.filter(hasPeople).map((r) => r.people_days_m!)
  const [minPd, maxPd] = [Math.min(...peopleDays), Math.max(...peopleDays)]
  const maxServed = Math.max(1, ...rows.filter(hasPeople).map((r) => r.people_served!))
  // Dots keep their on-screen size while the map zooms (the ring, in map units, grows with it).
  const k = view.zoom
  // Zoom buttons zoom toward the selected hub when there is one.
  const focus = hubs.find((h) => h.id === selected)
  const zoomBy = (f: number) =>
    setView((v) => ({ center: focus ? [focus.lon, focus.lat] : v.center, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * f)) }))
  // A request from the table: center on the hub at a moderate zoom and pulse its dot once (no pulse under reduced motion).
  const reduced = useReducedMotion()
  const [pulse, setPulse] = useState<{ id: string; n: number } | null>(null)
  useEffect(() => {
    if (!focusRequest) return
    const hub = hubs.find((h) => h.id === focusRequest.id)
    if (!hub) return
    setView((v) => ({ center: [hub.lon, hub.lat], zoom: Math.max(v.zoom, FOCUS_ZOOM) }))
    if (!reduced) setPulse(focusRequest)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.n])
  // Selecting a hub while zoomed in brings it into view.
  useEffect(() => {
    if (focus) setView((v) => (v.zoom > 1 ? { ...v, center: [focus.lon, focus.lat] } : v))
  }, [focus])
  const key = (id: string) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onSelect(id)
    }
  }

  return (
    <section
      aria-label="Hub map"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          close()
        }
      }}
    >
      <div data-testid="map-frame" className="glass relative h-[50vh] min-h-[420px] overflow-hidden rounded-3xl sm:h-[60vh]">
      {/* The map shrinks beside the panel (desktop) or above the sheet (phone), so every hub stays reachable. */}
      <div
        data-testid="map-layer"
        className="absolute inset-0 transition-[right,bottom] duration-300 ease-out motion-reduce:transition-none"
        style={open ? (wide ? { right: 'min(424px, 46%)' } : { bottom: '58%' }) : undefined}
      >
      <ComposableMap projection="geoAlbersUsa" projectionConfig={{ scale: 1250 }} width={WIDTH} height={HEIGHT} className="block h-full w-full" role="group" aria-label="Map of the 15 hubs">
        <ZoomableGroup
          center={view.center}
          zoom={view.zoom}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          filterZoomEvent={zoomFilter}
          onMoveEnd={(p) => p.coordinates && p.zoom && setView({ center: p.coordinates, zoom: p.zoom })}
        >
          <Geographies geography={states as unknown as string}>
            {({ geographies }) =>
              geographies.map((geo) => (
                <Geography
                  key={geo.rsmKey}
                  geography={geo}
                  tabIndex={-1}
                  data-state
                  className="outline-none"
                  fill="var(--map-land)"
                  stroke="var(--map-border)"
                  strokeWidth={0.75}
                  vectorEffect="non-scaling-stroke"
                />
              ))
            }
          </Geographies>
          {hubs.map((h) => {
            const r = byId.get(h.id)
            const driver = r?.top_driver
            const withPeople = people && r !== undefined && hasPeople(r)
            const color = people
              ? withPeople
                ? impactColor(r!.people_days_m!, minPd, maxPd)
                : 'var(--muted-foreground)'
              : driver
                ? FAMILY_COLOR[driver]
                : 'var(--muted-foreground)'
            const active = selected === h.id
            const shown = active || hover === h.id
            // Dot area follows bad-year days (risk) or people served (people impact).
            const dot = people ? 4 + 7 * Math.sqrt((withPeople ? r!.people_served! : 0) / maxServed) : 4 + 7 * Math.sqrt((r?.bad_year_days ?? 0) / maxBad)
            const label = people
              ? `${shortHubName(h.name)}: ${withPeople ? `${fmt(r!.people_days_m)} million people-days a year, ${compact(r!.people_served)} people served (metro estimate)` : 'people impact not available'}`
              : `${shortHubName(h.name)}: biggest risk ${driver ? FAMILY_LABEL[driver].toLowerCase() : 'unknown'}, ${fmt(r?.bad_year_days)} lost operating days in a bad year`
            return (
              <Marker
                key={h.id}
                coordinates={[h.lon, h.lat]}
                data-hub={h.id}
                data-selected={active}
                role="button"
                tabIndex={0}
                aria-label={label}
                aria-pressed={active}
                onClick={() => onSelect(h.id)}
                onKeyDown={key(h.id)}
                onMouseEnter={() => setHover(h.id)}
                onMouseLeave={() => setHover((v) => (v === h.id ? null : v))}
                onFocus={() => setHover(h.id)}
                onBlur={() => setHover((v) => (v === h.id ? null : v))}
                className="cursor-pointer outline-none [&:focus-visible_.hub-dot]:stroke-ring"
                style={{ color }}
              >
                <Ring hub={h} />
                <g transform={`scale(${1 / k})`}>
                  {pulse?.id === h.id && (
                    <circle
                      key={pulse.n}
                      data-pulse
                      r={dot}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={3}
                      className="hub-pulse"
                      onAnimationEnd={() => setPulse(null)}
                    />
                  )}
                  <circle
                    className="hub-dot"
                    r={dot}
                    fill="currentColor"
                    stroke={active ? 'var(--foreground)' : 'var(--background)'}
                    strokeWidth={active ? 2.5 : 1.5}
                  />
                  {shown && (
                    <g data-hub-label pointerEvents="none">
                      {!people && <rect x={-12} y={-dot - 30} width={24} height={24} rx={12} fill="var(--background)" stroke="currentColor" strokeWidth={1.25} />}
                      {driver && !people && <MapIcon hazard={driver} y={-dot - 25} />}
                      <text y={dot + 15} textAnchor="middle" fontSize={12} fontWeight={600} fill="var(--foreground)" stroke="var(--background)" strokeWidth={3} paintOrder="stroke">
                        {shortHubName(h.name)}
                      </text>
                    </g>
                  )}
                </g>
              </Marker>
            )
          })}
        </ZoomableGroup>
      </ComposableMap>
      </div>

      <div className="absolute top-3 left-3 z-10 flex flex-col gap-1" role="group" aria-label="Map zoom">
        <Button variant="outline" size="icon-sm" className="bg-background/85" aria-label="Zoom in" onClick={() => zoomBy(1.6)} disabled={view.zoom >= MAX_ZOOM}>
          <PlusIcon />
        </Button>
        <Button variant="outline" size="icon-sm" className="bg-background/85" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.6)} disabled={view.zoom <= MIN_ZOOM}>
          <MinusIcon />
        </Button>
        <Button variant="outline" size="icon-sm" className="bg-background/85" aria-label="Reset map" onClick={() => setView(HOME)}>
          <RotateCcwIcon />
        </Button>
      </div>

      {open && (
        <div
          role="dialog"
          aria-modal="false"
          aria-label={panelTitle ?? 'Hub breakdown'}
          data-testid="map-panel"
          className="absolute z-20 overflow-y-auto overscroll-contain rounded-3xl max-sm:inset-x-2 max-sm:bottom-2 max-sm:h-[calc(58%-0.5rem)] sm:top-3 sm:right-3 sm:bottom-3 sm:w-[min(400px,calc(46%-1.5rem))]"
        >
          <div className="sticky top-0 z-10 -mb-12 flex justify-end p-2.5">
            <Button ref={closeButton} variant="outline" size="icon-sm" className="bg-background/90" aria-label="Close hub breakdown" onClick={close}>
              <XIcon />
            </Button>
          </div>
          {panel}
        </div>
      )}
      </div>

      {/* Legend under the map: one row of hazard keys and what dots and rings mean (wraps on phones), then the hint. */}
      <div data-testid="map-legend" className="mt-2.5 px-1 text-xs leading-relaxed text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div role="group" aria-label="Color by" className="inline-flex items-center gap-1.5">
            <span>Color by</span>
            <span className="inline-flex rounded-lg bg-foreground/5 p-0.5">
              {(['risk', 'people'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  disabled={m === 'people' && !peopleKnown}
                  onClick={() => setMode(m)}
                  className={`rounded-md px-2 py-0.5 disabled:cursor-not-allowed disabled:opacity-50 ${mode === m ? 'bg-background font-medium text-foreground shadow-sm' : 'hover:text-foreground'}`}
                >
                  {m === 'risk' ? 'Biggest risk' : 'People impact'}
                </button>
              ))}
            </span>
          </div>
          {people ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-foreground" data-testid="impact-scale">
                <span className="tabular-nums">{fmt(minPd)}</span>
                <span
                  className="h-2 w-24 rounded-full"
                  style={{ background: `linear-gradient(to right, ${impactColor(minPd, minPd, maxPd)}, ${impactColor(maxPd, minPd, maxPd)})` }}
                  aria-hidden="true"
                />
                <span className="tabular-nums">{fmt(maxPd)}</span>
                <span className="text-muted-foreground">million people-days a year</span>
              </span>
              <p>
                Dot color: people-days (if the hub is disrupted: people it serves, metro estimate, × lost days a year) · Dot size: people served (metro population, an estimate, not
                the hub's customers) · Ring: 18-mile local-hazard area
              </p>
            </>
          ) : (
            <>
              <ul aria-label="Biggest risk colors" className="flex flex-wrap items-center gap-x-3 gap-y-1">
                {FAMILIES.map((f) => (
                  <li key={f} className="inline-flex items-center gap-1.5 text-foreground">
                    <span className="size-2.5 rounded-full" style={{ background: FAMILY_COLOR[f] }} aria-hidden="true" />
                    <HazardIcon hazard={f} className="size-3.5" />
                    {FAMILY_LABEL[f]}
                  </li>
                ))}
              </ul>
              <p title="The ring is a 1,000 sq mi circle around the hub">
                Dot color: biggest risk · Dot size: lost operating days in a bad year · Ring: 18-mile local-hazard area (local floods, tornadoes, wind and
                hail count toward the hub)
              </p>
            </>
          )}
        </div>
        <p className="mt-1 text-[0.7rem] text-muted-foreground/80">
          Drag to move; zoom with the buttons, a pinch, or Ctrl/⌘ + scroll.{!peopleKnown && ' People impact appears when the scores include it.'}
        </p>
      </div>
    </section>
  )
}
