// The dev server must proxy every backend route, or a feature works in production and 404s in `npm run dev`.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { API_PREFIXES } from '../lib/apiPrefixes'
import viteConfig from '../../vite.config?raw'

describe('vite dev proxy', () => {
  it('covers every route in app/api.py', () => {
    const api = readFileSync(resolve(process.cwd(), '../app/api.py'), 'utf8') // vitest runs from web/
    const routes = [...api.matchAll(/@app\.(?:get|post|put|patch|delete)\("([^"]+)"/g)].map((m) => m[1])
    expect(routes).toEqual(expect.arrayContaining(['/chat', '/chat/json', '/what-if', '/second-opinion/rerun']))
    expect(viteConfig).toContain('proxy: Object.fromEntries(API_PREFIXES.map(')
    for (const r of routes) expect(API_PREFIXES.some((p) => r === p || r.startsWith(`${p}/`)), r).toBe(true)
  })
})
