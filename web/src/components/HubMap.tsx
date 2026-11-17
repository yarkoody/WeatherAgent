// Scores tab map: the 15 hubs on an offline US states map (us-atlas TopoJSON bundled; no tile service).
// Dot color = the hub's top hazard, dot size = bad-year lost days, faint ring = the model's local-hazard area
// (a 1,000 sq mi circle: scoring.reference_area_sq_mi), drawn in map units so it scales with the projection and zoom.
import { MinusIcon, PlusIcon, RotateCcwIcon } from 'lucide-react'
import { useEffect, useState, type KeyboardEvent } from 'react'
import { ComposableMap, Geographies, Geography, Marker, ZoomableGroup, useMapContext } from 'react-simple-maps'
import states from 'us-atlas/states-10m.json'
import { HAZARD_ICON, HazardIcon } from '@/components/HazardIcon'
import { Button } from '@/components/ui/button'
import { FAMILIES, FAMILY_COLOR, FAMILY_LABEL, fmt, shortHubName } from '@/lib/format'
import type { Hub, ScoreRow } from '@/lib/types'

const WIDTH = 975
const HEIGHT = 610
/** Radius of the model's 1,000 sq mi reference area: sqrt(1000 / pi) miles. */
export const RING_MILES = Math.sqrt(1000 / Math.PI) // ≈ 17.8
const MILES_PER_DEGREE_LAT = 69.05
const HOME = { center: [-96, 38] as [number, number], zoom: 1 }
const MIN_ZOOM = 1
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

export function HubMap({ hubs, rows, selected, onSelect }: { hubs: Hub[]; rows: ScoreRow[]; selected: string | null; onSelect: (id: string) => void }) {
  const [view, setView] = useState(HOME)
  const [hover, setHover] = useState<string | null>(null)
  const byId = new Map(rows.map((r) => [r.hub_id, r]))
  const maxBad = Math.max(1, ...rows.map((r) => r.bad_year_days))
  // Dots keep their on-screen size while the map zooms (the ring, in map units, grows with it).
  const k = view.zoom
  // Zoom buttons zoom toward the selected hub when there is one.
  const focus = hubs.find((h) => h.id === selected)
  const zoomBy = (f: number) =>
    setView((v) => ({ center: focus ? [focus.lon, focus.lat] : v.center, zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * f)) }))
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
    <section aria-label="Hub map" className="glass relative overflow-hidden rounded-3xl">
      <ComposableMap projection="geoAlbersUsa" projectionConfig={{ scale: 1250 }} width={WIDTH} height={HEIGHT} className="block h-auto w-full" role="group" aria-label="Map of the 15 hubs">
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
                  className="fill-foreground/[0.06] stroke-background outline-none"
                  strokeWidth={0.75}
                  vectorEffect="non-scaling-stroke"
                />
              ))
            }
          </Geographies>
          {hubs.map((h) => {
            const r = byId.get(h.id)
            const driver = r?.top_driver
            const color = driver ? FAMILY_COLOR[driver] : 'var(--muted-foreground)'
            const active = selected === h.id
            const shown = active || hover === h.id
            const dot = 4 + 7 * Math.sqrt((r?.bad_year_days ?? 0) / maxBad) // area follows bad-year days
            const label = `${shortHubName(h.name)}: biggest risk ${driver ? FAMILY_LABEL[driver].toLowerCase() : 'unknown'}, ${fmt(r?.bad_year_days)} lost operating days in a bad year`
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
                  <circle
                    className="hub-dot"
                    r={dot}
                    fill="currentColor"
                    stroke={active ? 'var(--foreground)' : 'var(--background)'}
                    strokeWidth={active ? 2.5 : 1.5}
                  />
                  {shown && (
                    <g data-hub-label pointerEvents="none">
                      <rect x={-12} y={-dot - 30} width={24} height={24} rx={12} fill="var(--background)" stroke="currentColor" strokeWidth={1.25} />
                      {driver && <MapIcon hazard={driver} y={-dot - 25} />}
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

      <div className="absolute top-3 right-3 flex flex-col gap-1" role="group" aria-label="Map zoom">
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

      <div className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
        <ul aria-label="Biggest risk colors" className="flex flex-wrap gap-x-3 gap-y-1">
          {FAMILIES.map((f) => (
            <li key={f} className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: FAMILY_COLOR[f] }} aria-hidden="true" />
              <HazardIcon hazard={f} className="size-3.5" />
              {FAMILY_LABEL[f]}
            </li>
          ))}
        </ul>
        <p className="mt-1.5">Dot color: the hub's biggest risk. Dot size: lost operating days in a bad year.</p>
        <p className="mt-0.5">Ring: area whose local floods, tornadoes, wind and hail count toward the hub.</p>
        <p className="mt-0.5">Drag to move. Zoom with the buttons, a pinch, or Ctrl/⌘ + scroll. Select a hub to open its breakdown.</p>
      </div>
    </section>
  )
}
