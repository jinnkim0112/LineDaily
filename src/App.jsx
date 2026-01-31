import { useEffect, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import './App.css'

const WORLD_SIZE = 10000
const TILE_SIZE = 512
const STROKE_WIDTH = 3
const MIN_POINT_DIST = 2
const RDP_EPSILON = 1.5
const DEVICE_ID_KEY = 'linedaily_device_id'
const DAILY_BOX_SIZE = 100
const DAILY_REGION_KEY = 'linedaily_daily_region'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY
const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null

function getDeviceId() {
  if (typeof window === 'undefined') return 'unknown'
  const existing = localStorage.getItem(DEVICE_ID_KEY)
  if (existing) return existing
  const id = crypto.randomUUID()
  localStorage.setItem(DEVICE_ID_KEY, id)
  return id
}

function distance(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return Math.hypot(dx, dy)
}

function perpendicularDistance(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x
  const dy = lineEnd.y - lineStart.y
  if (dx === 0 && dy === 0) return distance(point, lineStart)
  const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (dx * dx + dy * dy)
  const proj = {
    x: lineStart.x + t * dx,
    y: lineStart.y + t * dy,
  }
  return distance(point, proj)
}

function rdpSimplify(points, epsilon) {
  if (points.length <= 2) return points
  let maxDist = 0
  let index = 0
  const end = points.length - 1
  for (let i = 1; i < end; i += 1) {
    const d = perpendicularDistance(points[i], points[0], points[end])
    if (d > maxDist) {
      maxDist = d
      index = i
    }
  }
  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, index + 1), epsilon)
    const right = rdpSimplify(points.slice(index), epsilon)
    return left.slice(0, -1).concat(right)
  }
  return [points[0], points[end]]
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function tileKey(tx, ty) {
  return `${tx},${ty}`
}

function getTodayKey() {
  return new Date().toLocaleDateString('en-CA')
}

function loadDailyRegion() {
  if (typeof window === 'undefined') return null
  const raw = localStorage.getItem(DAILY_REGION_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.date === getTodayKey() && parsed?.region) {
      return parsed.region
    }
  } catch {
    return null
  }
  return null
}

function saveDailyRegion(region) {
  if (typeof window === 'undefined') return
  const payload = { date: getTodayKey(), region }
  localStorage.setItem(DAILY_REGION_KEY, JSON.stringify(payload))
}

function App() {
  const canvasRef = useRef(null)
  const tilesRef = useRef(new Map())
  const loadedTilesRef = useRef(new Set())
  const loadingTilesRef = useRef(new Set())
  const viewRef = useRef({ x: 0, y: 0, scale: 1 })
  const rafRef = useRef(null)
  const pointerRef = useRef({ drawing: false, panning: false, last: null })
  const currentStrokeRef = useRef(null)
  const deviceIdRef = useRef(getDeviceId())
  const loadTimerRef = useRef(null)
  const [mode, setMode] = useState('draw')
  const [zoom, setZoom] = useState(1)
  const [realtimeEnabled] = useState(Boolean(supabase))
  const dailyRegionRef = useRef(loadDailyRegion())

  const requestRender = () => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      render()
    })
  }

  const scheduleVisibleLoad = () => {
    if (!supabase) return
    if (loadTimerRef.current) return
    loadTimerRef.current = setTimeout(() => {
      loadTimerRef.current = null
      loadVisibleTiles()
    }, 150)
  }

  const resizeCanvas = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { clientWidth, clientHeight } = canvas
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.floor(clientWidth * dpr)
    canvas.height = Math.floor(clientHeight * dpr)

    if (viewRef.current.initialized !== true) {
      viewRef.current.x = WORLD_SIZE / 2 - clientWidth / 2
      viewRef.current.y = WORLD_SIZE / 2 - clientHeight / 2
      viewRef.current.scale = 1
      viewRef.current.initialized = true
      setZoom(1)
    }

    clampView()
    requestRender()
  }

  const getTile = (tx, ty) => {
    const key = tileKey(tx, ty)
    let tile = tilesRef.current.get(key)
    if (!tile) {
      const tileCanvas = document.createElement('canvas')
      tileCanvas.width = TILE_SIZE
      tileCanvas.height = TILE_SIZE
      tile = {
        key,
        tx,
        ty,
        canvas: tileCanvas,
        ctx: tileCanvas.getContext('2d'),
        strokes: [],
        strokeIds: new Set(),
        dirty: true,
      }
      tilesRef.current.set(key, tile)
    }
    return tile
  }

  const addStrokeToTiles = (stroke, tileCoords) => {
    tileCoords.forEach(({ tx, ty }) => {
      const tile = getTile(tx, ty)
      if (stroke.strokeId && tile.strokeIds.has(stroke.strokeId)) return
      tile.strokes.push(stroke)
      if (stroke.strokeId) tile.strokeIds.add(stroke.strokeId)
      tile.dirty = true
    })
  }

  const addStroke = (stroke) => {
    const xs = stroke.points.map((p) => p.x)
    const ys = stroke.points.map((p) => p.y)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const maxX = Math.max(...xs)
    const maxY = Math.max(...ys)

    const startX = Math.floor(minX / TILE_SIZE)
    const startY = Math.floor(minY / TILE_SIZE)
    const endX = Math.floor(maxX / TILE_SIZE)
    const endY = Math.floor(maxY / TILE_SIZE)

    const coords = []
    for (let ty = startY; ty <= endY; ty += 1) {
      for (let tx = startX; tx <= endX; tx += 1) {
        if (tx < 0 || ty < 0 || tx * TILE_SIZE >= WORLD_SIZE || ty * TILE_SIZE >= WORLD_SIZE) continue
        coords.push({ tx, ty })
      }
    }

    addStrokeToTiles(stroke, coords)
    return coords
  }

  const renderTile = (tile) => {
    if (!tile.dirty) return
    const ctx = tile.ctx
    ctx.clearRect(0, 0, TILE_SIZE, TILE_SIZE)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, TILE_SIZE, TILE_SIZE)
    ctx.clip()
    ctx.translate(-tile.tx * TILE_SIZE, -tile.ty * TILE_SIZE)

    tile.strokes.forEach((stroke) => {
      ctx.strokeStyle = stroke.color
      ctx.lineWidth = stroke.width
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      stroke.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y)
        else ctx.lineTo(point.x, point.y)
      })
      ctx.stroke()
    })

    ctx.restore()
    tile.dirty = false
  }

  const render = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1
    const width = canvas.width / dpr
    const height = canvas.height / dpr
    refreshDailyRegion()

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)

    const view = viewRef.current
    const viewWidthWorld = width / view.scale
    const viewHeightWorld = height / view.scale

    const startX = Math.floor(view.x / TILE_SIZE)
    const startY = Math.floor(view.y / TILE_SIZE)
    const endX = Math.floor((view.x + viewWidthWorld) / TILE_SIZE)
    const endY = Math.floor((view.y + viewHeightWorld) / TILE_SIZE)

    for (let ty = startY; ty <= endY; ty += 1) {
      for (let tx = startX; tx <= endX; tx += 1) {
        if (tx < 0 || ty < 0 || tx * TILE_SIZE >= WORLD_SIZE || ty * TILE_SIZE >= WORLD_SIZE) continue
        const tile = getTile(tx, ty)
        renderTile(tile)
        const screenX = (tx * TILE_SIZE - view.x) * view.scale
        const screenY = (ty * TILE_SIZE - view.y) * view.scale
        const screenSize = TILE_SIZE * view.scale
        ctx.drawImage(tile.canvas, screenX, screenY, screenSize, screenSize)
      }
    }

    // World grid every 1000px (drawn in world space to avoid shimmer)
    const gridStep = 1000
    const gridStartX = Math.floor(view.x / gridStep) * gridStep
    const gridStartY = Math.floor(view.y / gridStep) * gridStep
    const gridEndX = view.x + viewWidthWorld
    const gridEndY = view.y + viewHeightWorld

    ctx.save()
    ctx.translate(-view.x * view.scale, -view.y * view.scale)
    ctx.scale(view.scale, view.scale)
    ctx.strokeStyle = 'rgba(0,0,0,0.16)'
    ctx.lineWidth = 1 / view.scale
    ctx.beginPath()
    for (let x = gridStartX; x <= gridEndX; x += gridStep) {
      const snappedX = Math.round(x) + 0.5
      ctx.moveTo(snappedX, gridStartY)
      ctx.lineTo(snappedX, gridEndY)
    }
    for (let y = gridStartY; y <= gridEndY; y += gridStep) {
      const snappedY = Math.round(y) + 0.5
      ctx.moveTo(gridStartX, snappedY)
      ctx.lineTo(gridEndX, snappedY)
    }
    ctx.stroke()
    ctx.restore()

    ctx.strokeStyle = 'rgba(0,0,0,0.12)'
    ctx.lineWidth = 1
    ctx.strokeRect(
      -view.x * view.scale,
      -view.y * view.scale,
      WORLD_SIZE * view.scale,
      WORLD_SIZE * view.scale,
    )

    // Debug: center coordinates overlay
    const centerWorld = {
      x: view.x + viewWidthWorld / 2,
      y: view.y + viewHeightWorld / 2,
    }
    const centerLabel = `Center: ${centerWorld.x.toFixed(1)}, ${centerWorld.y.toFixed(1)}`
    ctx.font = '12px "Space Grotesk", "Segoe UI", sans-serif'
    const paddingX = 10
    const paddingY = 6
    const textWidth = ctx.measureText(centerLabel).width
    const boxWidth = textWidth + paddingX * 2
    const boxHeight = 20
    const boxX = width - boxWidth - 12
    const boxY = 12
    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight)
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.fillText(centerLabel, boxX + paddingX, boxY + boxHeight / 2)

    const current = currentStrokeRef.current
    if (current && current.points.length > 0) {
      ctx.strokeStyle = current.color
      ctx.lineWidth = current.width * view.scale
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      current.points.forEach((point, index) => {
        const screenX = (point.x - view.x) * view.scale
        const screenY = (point.y - view.y) * view.scale
        if (index === 0) ctx.moveTo(screenX, screenY)
        else ctx.lineTo(screenX, screenY)
      })
      ctx.stroke()
    }

    const dailyRegion = dailyRegionRef.current
    if (dailyRegion) {
      const regionX = (dailyRegion.x - view.x) * view.scale
      const regionY = (dailyRegion.y - view.y) * view.scale
      const regionSize = DAILY_BOX_SIZE * view.scale
      ctx.save()
      ctx.fillStyle = 'rgba(0,0,0,0.2)'
      ctx.fillRect(0, 0, width, height)
      ctx.clearRect(regionX, regionY, regionSize, regionSize)
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'
      ctx.lineWidth = 1
      ctx.strokeRect(
        regionX + 0.5,
        regionY + 0.5,
        Math.max(0, regionSize - 1),
        Math.max(0, regionSize - 1),
      )
      ctx.restore()
    }

    scheduleVisibleLoad()
  }

  const screenToWorld = (point) => {
    const view = viewRef.current
    return {
      x: point.x / view.scale + view.x,
      y: point.y / view.scale + view.y,
    }
  }

  const getCanvasPoint = (event) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const nativeEvent = event.nativeEvent ?? event
    let x = nativeEvent?.offsetX
    let y = nativeEvent?.offsetY
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const clientX = nativeEvent?.clientX ?? event.clientX
      const clientY = nativeEvent?.clientY ?? event.clientY
      x = clientX - rect.left
      y = clientY - rect.top
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 }
    return { x, y }
  }

  const refreshDailyRegion = () => {
    const stored = loadDailyRegion()
    if (!stored && dailyRegionRef.current) {
      dailyRegionRef.current = null
    }
    if (stored && !dailyRegionRef.current) {
      dailyRegionRef.current = stored
    }
  }

  const setDailyRegionFromPoint = (worldPoint) => {
    const baseX = Math.floor(worldPoint.x / DAILY_BOX_SIZE) * DAILY_BOX_SIZE
    const baseY = Math.floor(worldPoint.y / DAILY_BOX_SIZE) * DAILY_BOX_SIZE
    const region = {
      x: clamp(baseX, 0, WORLD_SIZE - DAILY_BOX_SIZE),
      y: clamp(baseY, 0, WORLD_SIZE - DAILY_BOX_SIZE),
    }
    dailyRegionRef.current = region
    saveDailyRegion(region)
    requestRender()
    return region
  }

  const isPointInRegion = (point, region) => {
    if (!region) return true
    return (
      point.x >= region.x &&
      point.y >= region.y &&
      point.x <= region.x + DAILY_BOX_SIZE &&
      point.y <= region.y + DAILY_BOX_SIZE
    )
  }

  const clampView = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const view = viewRef.current
    const dpr = window.devicePixelRatio || 1
    const width = canvas.width / dpr
    const height = canvas.height / dpr
    const viewWidthWorld = width / view.scale
    const viewHeightWorld = height / view.scale
    const maxX = Math.max(0, WORLD_SIZE - viewWidthWorld)
    const maxY = Math.max(0, WORLD_SIZE - viewHeightWorld)
    view.x = clamp(view.x, 0, maxX)
    view.y = clamp(view.y, 0, maxY)
  }

  const handlePointerDown = (event) => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.setPointerCapture(event.pointerId)
    const isPan = mode === 'pan' || event.button === 1 || event.button === 2
    const point = getCanvasPoint(event)
    refreshDailyRegion()

    if (isPan) {
      pointerRef.current = { panning: true, drawing: false, last: point }
      return
    }

    const worldPoint = screenToWorld(point)
    let region = dailyRegionRef.current
    if (!region) {
      region = setDailyRegionFromPoint(worldPoint)
    }
    if (!isPointInRegion(worldPoint, region)) return
    currentStrokeRef.current = {
      strokeId: crypto.randomUUID(),
      userId: deviceIdRef.current,
      color: '#000000',
      width: STROKE_WIDTH,
      points: [worldPoint],
    }
    pointerRef.current = { drawing: true, panning: false, last: worldPoint }
  }

  const handlePointerMove = (event) => {
    if (!pointerRef.current.drawing && !pointerRef.current.panning) return
    const point = getCanvasPoint(event)

    if (pointerRef.current.panning) {
      const view = viewRef.current
      const deltaX = point.x - pointerRef.current.last.x
      const deltaY = point.y - pointerRef.current.last.y
      view.x -= deltaX / view.scale
      view.y -= deltaY / view.scale
      clampView()
      pointerRef.current.last = point
      requestRender()
      return
    }

    const worldPoint = screenToWorld(point)
    if (!isPointInRegion(worldPoint, dailyRegionRef.current)) return
    const stroke = currentStrokeRef.current
    if (!stroke) return
    const lastPoint = stroke.points[stroke.points.length - 1]
    if (distance(lastPoint, worldPoint) < MIN_POINT_DIST) return
    stroke.points.push(worldPoint)
    pointerRef.current.last = worldPoint
    requestRender()
  }

  const saveStrokeToSupabase = async (stroke, tileCoords) => {
    if (!supabase) return
    const rows = tileCoords.map(({ tx, ty }) => ({
      stroke_id: stroke.strokeId,
      user_id: stroke.userId,
      points: stroke.points,
      color: stroke.color,
      width: stroke.width,
      tile_x: tx,
      tile_y: ty,
      created_at: new Date().toISOString(),
    }))
    const { error } = await supabase.from('strokes').insert(rows)
    if (error) {
      console.error('Supabase insert failed', error)
    }
  }

  const handlePointerUp = () => {
    if (pointerRef.current.drawing) {
      const stroke = currentStrokeRef.current
      if (stroke && stroke.points.length >= 2) {
        const simplified = rdpSimplify(stroke.points, RDP_EPSILON)
        stroke.points = simplified
        const coords = addStroke(stroke)
        saveStrokeToSupabase(stroke, coords)
      }
    }
    pointerRef.current = { drawing: false, panning: false, last: null }
    currentStrokeRef.current = null
    requestRender()
  }

  const handleWheel = (event) => {
    event.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
    refreshDailyRegion()
    const view = viewRef.current
    const delta = -event.deltaY
    const scaleFactor = delta > 0 ? 1.1 : 0.9
    const nextScale = clamp(view.scale * scaleFactor, 0.3, 4)

    const pointer = getCanvasPoint(event)
    const before = screenToWorld(pointer)
    view.scale = nextScale
    const after = screenToWorld(pointer)
    view.x += before.x - after.x
    view.y += before.y - after.y

    clampView()
    setZoom(nextScale)
    requestRender()
  }

  const loadVisibleTiles = async () => {
    if (!supabase) return
    const canvas = canvasRef.current
    if (!canvas) return
    const view = viewRef.current
    const dpr = window.devicePixelRatio || 1
    const width = canvas.width / dpr
    const height = canvas.height / dpr
    const viewWidthWorld = width / view.scale
    const viewHeightWorld = height / view.scale

    const startX = Math.floor(view.x / TILE_SIZE)
    const startY = Math.floor(view.y / TILE_SIZE)
    const endX = Math.floor((view.x + viewWidthWorld) / TILE_SIZE)
    const endY = Math.floor((view.y + viewHeightWorld) / TILE_SIZE)

    const keysToLoad = []
    for (let ty = startY; ty <= endY; ty += 1) {
      for (let tx = startX; tx <= endX; tx += 1) {
        if (tx < 0 || ty < 0 || tx * TILE_SIZE >= WORLD_SIZE || ty * TILE_SIZE >= WORLD_SIZE) continue
        const key = tileKey(tx, ty)
        if (!loadedTilesRef.current.has(key) && !loadingTilesRef.current.has(key)) {
          loadingTilesRef.current.add(key)
          keysToLoad.push({ tx, ty })
        }
      }
    }

    if (keysToLoad.length === 0) return

    const batches = []
    const batchSize = 20
    for (let i = 0; i < keysToLoad.length; i += batchSize) {
      batches.push(keysToLoad.slice(i, i + batchSize))
    }

    for (const batch of batches) {
      const filters = batch
        .map(({ tx, ty }) => `and(tile_x.eq.${tx},tile_y.eq.${ty})`)
        .join(",")
      const { data, error } = await supabase
        .from("strokes")
        .select("stroke_id,user_id,points,color,width,tile_x,tile_y")
        .or(filters)

      if (error) {
        console.error("Supabase fetch failed", error)
        batch.forEach(({ tx, ty }) => loadingTilesRef.current.delete(tileKey(tx, ty)))
        continue
      }

      data.forEach((row) => {
        const stroke = {
          strokeId: row.stroke_id,
          userId: row.user_id,
          points: row.points,
          color: '#000000',
          width: row.width,
        }
        addStrokeToTiles(stroke, [{ tx: row.tile_x, ty: row.tile_y }])
      })

      batch.forEach(({ tx, ty }) => {
        const key = tileKey(tx, ty)
        loadingTilesRef.current.delete(key)
        loadedTilesRef.current.add(key)
      })
    }

    requestRender()
  }

  useEffect(() => {
    resizeCanvas()
    window.addEventListener('resize', resizeCanvas)
    return () => window.removeEventListener('resize', resizeCanvas)
  }, [])

  useEffect(() => {
    requestRender()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const onWheel = (event) => handleWheel(event)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    if (!supabase) return undefined

    const channel = supabase
      .channel('strokes-inserts')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'strokes' },
        (payload) => {
          const row = payload.new
          const stroke = {
            strokeId: row.stroke_id,
            userId: row.user_id,
            points: row.points,
            color: '#000000',
            width: row.width,
          }
          addStrokeToTiles(stroke, [{ tx: row.tile_x, ty: row.tile_y }])
          requestRender()
        },
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  return (
    <div className="app">
      <header className="toolbar">
        <div className="title">Line Daily</div>
        <div className="actions">
          <button type="button" className={mode === 'draw' ? 'active' : ''} onClick={() => setMode('draw')}>
            Draw
          </button>
          <button type="button" className={mode === 'pan' ? 'active' : ''} onClick={() => setMode('pan')}>
            Pan
          </button>
        </div>
        <div className="meta">
          <span>Zoom {zoom.toFixed(2)}x</span>
          <span>Device {deviceIdRef.current.slice(0, 8)}</span>
          <span>{realtimeEnabled ? 'Realtime on' : 'Realtime off'}</span>
        </div>
      </header>
      <canvas
        ref={canvasRef}
        className="canvas"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onContextMenu={(event) => event.preventDefault()}
      />
      <footer className="hint">
        {mode === 'draw' ? 'Draw on the shared 10k x 10k canvas. Switch to Pan to move.' : 'Pan mode: drag to move. Wheel to zoom.'}
      </footer>
    </div>
  )
}

export default App
