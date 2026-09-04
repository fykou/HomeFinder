#!/usr/bin/env node
// Scrapes a FINN.no favorite list into boliger.html, a self-contained
// comparison page rendered from template.html.
//
// Two-step, because only the list itself is behind login:
//   1. favorite list -> ad ids + list-only status ("Deaktivert"), via Playwright
//      with a persistent browser profile (log in once using --login).
//   2. each ad page  -> full details, via plain fetch. Ad pages are public.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const PROFILE_DIR = path.join(HERE, '.browser-profile')
const CONFIG_PATH = path.join(HERE, 'config.json')
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

// ---------------------------------------------------------------- config

async function loadConfig() {
  const defaults = {
    listId: null,
    sharedLists: [],
    outFile: 'boliger.html',
    // Artifact publishing supplies its own <html> wrapper; anywhere else needs
    // a full document.
    standalone: false,
  }
  if (!existsSync(CONFIG_PATH)) return defaults
  return { ...defaults, ...JSON.parse(await readFile(CONFIG_PATH, 'utf8')) }
}

// A shared list is identified by the token in /sharedfavoritelist/<token>;
// accept a whole pasted URL just as readily as the bare token.
const sharedToken = (value) => value.trim().replace(/^.*\/sharedfavoritelist\//, '').replace(/[?#].*$/, '')

function listsFrom(config) {
  const lists = []
  const own = opt('list', config.listId)
  if (own) lists.push({ id: own, shared: false })

  const extra = opt('shared', null)
  const shared = extra ? extra.split(',') : config.sharedLists
  for (const value of shared) if (value) lists.push({ id: sharedToken(value), shared: true })

  return lists
}

// ---------------------------------------------------------------- step 1: list

async function launchContext({ headless }) {
  const { chromium } = await import('playwright')
  const options = { headless, viewport: { width: 1400, height: 1000 }, locale: 'nb-NO', userAgent: UA }
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, options)
  } catch (err) {
    if (/Executable doesn't exist|is not found/.test(err.message)) {
      throw new Error(`Playwright has no browser installed. Run: npx playwright install chromium\n\n${err.message}`)
    }
    throw err
  }
}

const AD_LINK = 'a[href^="/4"]'

async function login(listId) {
  const ctx = await launchContext({ headless: false })
  const page = ctx.pages()[0] ?? (await ctx.newPage())
  await page.goto(`https://www.finn.no/favoritelist?favListId=${listId}`)
  console.error('Log in to FINN in the browser window. Waiting for the list to load...')

  const ok = await page
    .waitForSelector(AD_LINK, { timeout: 5 * 60_000 })
    .then(() => true)
    .catch(() => false)
  await page.waitForTimeout(1500)
  await ctx.close()

  if (!ok) throw new Error('Timed out before the favorite list loaded. The session was not stored.')
  console.error(`Session stored in ${PROFILE_DIR}. Re-run without --login.`)
}

// Shared lists live behind login too, so both kinds go through the same
// browser session; they only differ in URL shape.
const listUrl = (list) =>
  list.shared
    ? `https://www.finn.no/sharedfavoritelist/${list.id}`
    : `https://www.finn.no/favoritelist?favListId=${list.id}`

async function scrapeOne(page, list) {
  await page.goto(listUrl(list), { waitUntil: 'domcontentloaded' })
  if (page.url().includes('/auth/login')) throw new Error('Not logged in. Run once with --login.')

  // The list is client-rendered; wait for the ads rather than for the ad and
  // beacon traffic to go quiet, which on FINN can take longer than the page.
  await page.waitForSelector(AD_LINK, { timeout: 30_000 }).catch(() => {})

  // Each favorite is an <a href="/<adId>">; "Deaktivert" is shown on the card
  // and nowhere on the ad page itself, so it has to be read here.
  return page.evaluate(() => {
    const links = [...document.querySelectorAll('a[href]')].filter((a) => /^\/\d+$/.test(a.getAttribute('href')))
    return links.map((a) => {
      const card = a.closest('article, li') ?? a.parentElement?.parentElement
      const text = card?.innerText ?? ''
      return {
        id: a.getAttribute('href').slice(1),
        listTitle: (a.innerText || '').trim(),
        deactivated: /Deaktivert|Inaktiv/i.test(text),
        changed: (text.match(/Endret:\s*([^\n]+)/) ?? [])[1] ?? null,
      }
    })
  })
}

async function scrapeLists(lists) {
  const ctx = await launchContext({ headless: !flag('headed') })
  const page = ctx.pages()[0] ?? (await ctx.newPage())

  const byId = new Map()
  try {
    for (const list of lists) {
      const items = await scrapeOne(page, list)
      console.error(`  ${listUrl(list)} -> ${items.length} ads`)
      // An ad in two lists keeps its first entry; a "Deaktivert" badge from
      // any list wins, since it is a fact about the ad rather than the list.
      for (const item of items) {
        const seen = byId.get(item.id)
        byId.set(item.id, seen ? { ...seen, deactivated: seen.deactivated || item.deactivated } : item)
      }
    }
  } finally {
    await ctx.close()
  }

  if (!byId.size) throw new Error('The lists loaded but contained no ads.')
  return [...byId.values()]
}

// ---------------------------------------------------------------- step 2: ads

const clean = (s) =>
  s == null
    ? null
    : s
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;| /g, ' ')
        .replace(/​/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&#x27;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim() || null

// First number only, so a range ("1 - 2") does not fuse into 12. Norwegian
// decimal commas and negative values (Fellesformue can be negative) survive.
const num = (s) => {
  if (s == null) return null
  const m = String(s)
    .replace(/[\s ]/g, '')
    .match(/-?\d+(?:,\d+)?/)
  return m ? Number(m[0].replace(',', '.')) : null
}

// <div data-testid="X"><dt>Label</dt><dd>Value</dd></div>. The <dt> body is
// matched without dots so it cannot run past its own closing tag and pair the
// testid with a later field's <dd>.
const dd = (html, testid) => {
  const m = html.match(new RegExp(`data-testid="${testid}"[^>]*>\\s*<dt[^>]*>[^<]*</dt>\\s*<dd[^>]*>(.*?)</dd>`, 's'))
  return clean(m?.[1])
}

// FINN ships an ad-targeting blob of {"key":..,"value":[..]} pairs. Its
// normalised facility list is the only structured elevator signal on the page.
// Returns null when the blob is absent, so "not stated" stays distinguishable
// from "empty".
const targeting = (html, key) => {
  const m = html.match(new RegExp(`"${key}","value":\\[(.*?)\\]`, 's'))
  if (!m) return null
  try {
    return JSON.parse(`[${m[1]}]`)
  } catch {
    return null
  }
}

// Open houses live in repeated <div data-testid="viewings-N"> blocks. The
// visible text only carries "06. september", so the start timestamp is taken
// from the .ics link, which is absolute UTC.
function parseViewings(html) {
  const out = []
  for (const block of html.matchAll(/data-testid="viewings-(\d+)"[^>]*>(.*?)(?=<div data-testid="viewings-\d+"|<a href="https)/gs)) {
    const chunk = block[2]
    const stamp = chunk.match(/iCalendarFrom=(\d{8})T(\d{6})Z/)
    const times = clean(chunk.match(/class="font-bold[^"]*"[^>]*>(.*?)<\/div>/s)?.[1])
    const dateLabel = clean(chunk.match(/class="capitalize-first"[^>]*>(.*?)<\/div>/s)?.[1])
    const [from, to] = (times ?? '').split(/\s*[-–]\s*/)

    let startsAt = null
    if (stamp) {
      const [, d, t] = stamp
      startsAt = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`
    }
    if (!startsAt && !dateLabel) continue
    out.push({ startsAt, dateLabel, from: from || null, to: to || null })
  }
  // The page ships the viewings block twice (mobile and desktop layouts).
  const seen = new Set()
  return out.filter((v) => {
    const key = `${v.startsAt}|${v.from}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Coordinates and the static map thumbnail live in the Next.js flight payload,
// where quotes are backslash-escaped and & is written as &.
function position(html, id) {
  const point = html.match(/\\"lat\\",(-?\d+\.\d+),\\"lng\\",(-?\d+\.\d+)/)
  const mapImage = html.match(/mapImage\\",\\"(https:\/\/maptiles[^"]+?)\\"/)?.[1]?.replaceAll('\\u0026', '&')
  if (!point) return { lat: null, lng: null, mapImage: null, mapUrl: null }

  const [, lat, lng] = point
  return {
    lat: Number(lat),
    lng: Number(lng),
    mapImage: mapImage ?? null,
    mapUrl: `https://www.finn.no/map?adId=${id}&lat=${lat}&lon=${lng}&zoom=15&showPin=true`,
  }
}

function parseAd(html, id) {
  const meta = (p) => clean(html.match(new RegExp(`<meta property="og:${p}" content="(.*?)"`, 's'))?.[1])
  const facilities = targeting(html, 'facilities')
  const title = meta('title')
  const description = meta('description')
  const hasElevator = facilities ? facilities.includes('Heis') : null

  // og:description is truncated at ~150 chars, so the elevator cross-check has
  // to read the rendered "Om boligen" prose instead.
  const prose = clean(html.match(/data-testid="about-property"[^>]*>(.*?)<\/section>/s)?.[1]) ?? ''

  const priceBlock = html.match(/data-testid="pricing-incicative-price"[^>]*>(.*?)<\/div>/s)?.[1]

  return {
    id,
    url: `https://www.finn.no/realestate/homes/ad.html?finnkode=${id}`,
    title,
    area: clean(html.match(/data-testid="local-area-name"[^>]*>(.*?)<\/div>/s)?.[1]),
    address: clean(html.match(/data-testid="object-address"[^>]*>(.*?)<\/span>/s)?.[1]),

    prisantydning: num(clean(priceBlock)?.replace(/^Prisantydning/, '')),
    totalpris: num(dd(html, 'pricing-total-price')),
    omkostninger: num(dd(html, 'pricing-registration-charge')),
    felleskostnader: num(dd(html, 'pricing-common-monthly-cost')),
    fellesgjeld: num(dd(html, 'pricing-joint-debt')),
    fellesformue: num(dd(html, 'pricing-collective-assets')),
    formuesverdi: num(dd(html, 'pricing-tax-value')),

    boligtype: dd(html, 'info-property-type'),
    eieform: dd(html, 'info-ownership-type'),
    soverom: num(dd(html, 'info-bedrooms')),
    rom: num(dd(html, 'info-rooms')),
    bruksarealInternt: num(dd(html, 'info-usable-i-area')),
    bruksareal: num(dd(html, 'info-usable-area')),
    bruksarealEksternt: num(dd(html, 'info-usable-e-area')),
    balkongTerrasse: num(dd(html, 'info-open-area')),
    etasje: dd(html, 'info-floor'),
    byggear: num(dd(html, 'info-construction-year')),
    // Half the ads render the grade as text, the other half only as an SVG
    // whose grade lives in aria-label.
    energimerking: dd(html, 'energy-label') ?? clean(html.match(/aria-label="Energimerke ([^"]+)"/)?.[1]),

    heis: hasElevator,
    // Some ads describe an elevator in prose without tagging the facility.
    heisNevntITekst: hasElevator === false && /\bheis\w*/i.test(`${title ?? ''} ${prose}`),
    fasiliteter: facilities ?? [],

    visninger: parseViewings(html),
    visningNote: clean(html.match(/data-testid="viewings-default"[^>]*>(.*?)<\/span>/s)?.[1]),
    ...position(html, id),

    description,
    image: meta('image'),
    // Every gallery image, as CDN paths; widths are chosen at render time.
    imagePaths: targeting(html, 'images') ?? [],
  }
}

async function fetchAd(id, tries = 3) {
  const url = `https://www.finn.no/realestate/homes/ad.html?finnkode=${id}`
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'nb-NO,nb;q=0.9',
        },
        signal: AbortSignal.timeout(25_000),
      })
      // A withdrawn or renumbered ad will never succeed; only server-side and
      // rate-limit failures are worth another request.
      if (res.status >= 400 && res.status < 500 && res.status !== 429) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return parseAd(await res.text(), id)
    } catch (err) {
      if (err.fatal || attempt >= tries) throw new Error(`ad ${id}: ${err.message}`)
      await new Promise((r) => setTimeout(r, 600 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250)))
    }
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    }),
  )
  return out
}

// ----------------------------------------------------------------- output

const perM2 = (ad) => (ad.totalpris && ad.bruksarealInternt ? Math.round(ad.totalpris / ad.bruksarealInternt) : null)
// finncdn serves any width off the same path; og:image is the 1280w variant.
const atWidth = (ad, width) => ad.image?.replace(/\/dynamic\/\d+w\//, `/dynamic/${width}w/`) ?? null
const gallery = (ad, width) => (ad.imagePaths ?? []).map((p) => `https://images.finncdn.no/dynamic/${width}w/${p}`)

// Only what the page actually renders, so the embedded JSON stays small.
const forPage = (ad) => ({
  id: ad.id,
  url: ad.url,
  title: ad.title,
  address: ad.address,
  area: ad.area,
  totalpris: ad.totalpris,
  prisantydning: ad.prisantydning,
  omkostninger: ad.omkostninger,
  felleskostnader: ad.felleskostnader,
  fellesgjeld: ad.fellesgjeld,
  eieform: ad.eieform,
  soverom: ad.soverom,
  rom: ad.rom,
  bruksarealInternt: ad.bruksarealInternt,
  etasje: ad.etasje,
  byggear: ad.byggear,
  energimerking: ad.energimerking,
  heis: ad.heis,
  heisNevntITekst: ad.heisNevntITekst,
  fasiliteter: ad.fasiliteter,
  visninger: ad.visninger,
  visningNote: ad.visningNote,
  description: ad.description,
  deactivated: Boolean(ad.deactivated),
  lat: ad.lat,
  lng: ad.lng,
  mapImage: ad.mapImage,
  mapUrl: ad.mapUrl,
  image: atWidth(ad, 1280),
  thumb: atWidth(ad, 240),
  thumbLarge: atWidth(ad, 640),
  gallery: gallery(ad, 1280),
  galleryThumbs: gallery(ad, 240),
})

// The template is authored as artifact body content: no doctype, no <html>.
// Hosting it anywhere else needs a real document around it, with the charset
// early enough to count and the head material actually in <head>.
function wrapDocument(html) {
  const bodyStart = html.indexOf('<div class="wrap">')
  if (bodyStart < 0) throw new Error('template.html no longer starts its body with <div class="wrap">')
  return [
    '<!doctype html>',
    '<html lang="nb">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // The template carries its own charset for the artifact case; the wrapper
    // has already emitted one here.
    html.slice(0, bodyStart).trim().replace(/^<meta charset="utf-8">\s*/i, ''),
    '</head>',
    '<body>',
    html.slice(bodyStart).trim(),
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

async function renderHtml(ads, meta, { standalone }) {
  const template = await readFile(path.join(HERE, 'template.html'), 'utf8')
  // A literal </script> or <!-- in the payload would break out of the host
  // script tag; < is valid inside a JSON string and kills both.
  const json = JSON.stringify(ads.map(forPage)).replaceAll('<', '\\u003c')
  const page = template.replace('/*__DATA__*/ []', json).replace('/*__META__*/ {}', JSON.stringify(meta))
  return standalone ? wrapDocument(page) : page
}

// ---------------------------------------------------------------- main

async function main() {
  const config = await loadConfig()
  const lists = listsFrom(config)
  if (!lists.length) {
    throw new Error('No lists configured. Pass --list <id> or --shared <token>, or set them in config.json.')
  }

  if (flag('login')) return login(lists.find((l) => !l.shared)?.id ?? lists[0].id)

  // --ids skips the login step entirely, for re-running against known ads.
  // Status only exists on the list page, so it can be supplied alongside it.
  const idsArg = opt('ids', null)
  const dead = new Set((opt('deactivated', '') || '').split(',').map((s) => s.trim()).filter(Boolean))
  const listItems = idsArg
    ? idsArg.split(',').map((id) => ({ id: id.trim(), deactivated: dead.has(id.trim()) }))
    : await scrapeLists(lists)
  console.error(`${listItems.length} ads across ${lists.length} list(s)`)

  const scrapedAt = new Date().toISOString().slice(0, 10)
  // One unreachable ad must not cost the whole run; failures are collected and
  // reported instead.
  const failures = []
  const fetched = await mapLimit(listItems, 4, async (item) => {
    try {
      return { ...(await fetchAd(item.id)), ...item, scrapedAt }
    } catch (err) {
      failures.push(err.message)
      return null
    }
  })
  const details = fetched.filter(Boolean)

  for (const f of failures) console.error(`  skipped: ${f}`)
  if (!details.length) throw new Error('Every ad failed to load; leaving the existing page untouched.')
  if (failures.length > listItems.length / 2) {
    throw new Error(`${failures.length} of ${listItems.length} ads failed; refusing to overwrite the page with a partial list.`)
  }

  if (flag('json')) {
    console.log(JSON.stringify(details, null, 2))
    return
  }

  const outPath = path.isAbsolute(config.outFile) ? config.outFile : path.join(ROOT, config.outFile)
  await mkdir(path.dirname(outPath), { recursive: true })
  // Write-then-rename, so an interrupted run cannot leave a half-written page.
  const tmpPath = `${outPath}.tmp`
  const meta = {
    updated: scrapedAt,
    count: details.length,
    lists: lists.map((list) => ({ ...list, url: listUrl(list) })),
  }
  const standalone = flag('standalone') || Boolean(config.standalone)
  await writeFile(tmpPath, await renderHtml(details, meta, { standalone }), 'utf8')
  await rename(tmpPath, outPath)

  console.error(`Wrote ${details.length} ads to ${outPath}${failures.length ? ` (${failures.length} skipped)` : ''}`)
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
