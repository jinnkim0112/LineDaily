import { useEffect, useRef, useState } from 'react'
import { createClient } from '@supabase/supabase-js'
import './App.css'

const WORLD_SIZE = 10000
const TILE_SIZE = 512
const STROKE_WIDTH = 3
const MIN_POINT_DIST = 2
const RDP_EPSILON = 1.5
const DEVICE_ID_KEY = 'linedaily_device_id'

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

function distancePointToSegment(point, lineStart, lineEnd) {
  const dx = lineEnd.x - lineStart.x
  const dy = lineEnd.y - lineStart.y
  if (dx === 0 && dy === 0) return distance(point, lineStart)
  let t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (dx * dx + dy * dy)
  t = clamp(t, 0, 1)
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


function App() {
  const canvasRef = useRef(null)
  const tilesRef = useRef(new Map())
  const loadedTilesRef = useRef(new Set())
  const loadingTilesRef = useRef(new Set())
  const viewRef = useRef({ x: 0, y: 0, scale: 1 })
  const rafRef = useRef(null)
  const pointerRef = useRef({ drawing: false, panning: false, erasing: false, last: null })
  const currentStrokeRef = useRef(null)
  const deviceIdRef = useRef(getDeviceId())
  const loadTimerRef = useRef(null)
  const deleteInFlightRef = useRef(new Set())
  const toolDockRef = useRef(null)
  const dragRef = useRef({ active: false, offsetX: 0, offsetY: 0 })
  const cursorRef = useRef({ active: false, x: 0, y: 0 })
  const copyTimeoutRef = useRef(null)
  const undoStackRef = useRef([])
  const redoStackRef = useRef([])
  const strokeHistoryRef = useRef(new Map())
  const pendingDeleteRef = useRef(new Set())
  const locallyDeletedRef = useRef(new Set())
  const [mode, setMode] = useState('draw')
  const [zoom, setZoom] = useState(1)
  const [centerLabel, setCenterLabel] = useState('Center 0.0, 0.0')
  const [realtimeEnabled] = useState(Boolean(supabase))
  const [toolPos, setToolPos] = useState({ x: 16, y: 16 })
  const [drawColor, setDrawColor] = useState('#111111')
  const [drawSize, setDrawSize] = useState(3)
  const [eraseSize, setEraseSize] = useState(18)
  const [isPointerDown, setIsPointerDown] = useState(false)
  const [colorCopied, setColorCopied] = useState(false)
  const colorOptions = ['#111111', '#2b2b2b', '#5a5a5a', '#8a8a8a', '#c0392b', '#e67e22', '#f1c40f', '#27ae60', '#2980b9', '#8e44ad']

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

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)

    const view = viewRef.current
    const viewWidthWorld = width / view.scale
    const viewHeightWorld = height / view.scale
    const centerWorld = {
      x: view.x + viewWidthWorld / 2,
      y: view.y + viewHeightWorld / 2,
    }

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

    const nextCenter = `Center ${centerWorld.x.toFixed(1)}, ${centerWorld.y.toFixed(1)}`
    if (nextCenter !== centerLabel) {
      setCenterLabel(nextCenter)
    }

    if (cursorRef.current.active && (mode === 'draw' || mode === 'erase')) {
      const radius = (mode === 'draw' ? drawSize : eraseSize) / 2 * view.scale
      ctx.save()
      ctx.beginPath()
      ctx.arc(cursorRef.current.x, cursorRef.current.y, radius, 0, Math.PI * 2)
      ctx.strokeStyle = mode === 'draw' ? drawColor : 'rgba(0,0,0,0.65)'
      ctx.lineWidth = 1
      ctx.stroke()
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

  const removeStrokeById = (strokeId) => {
    let removed = false
    tilesRef.current.forEach((tile) => {
      if (!tile.strokeIds.has(strokeId)) return
      const nextStrokes = tile.strokes.filter((stroke) => stroke.strokeId !== strokeId)
      if (nextStrokes.length === tile.strokes.length) return
      tile.strokes = nextStrokes
      tile.strokeIds.delete(strokeId)
      tile.dirty = true
      removed = true
    })
    if (removed) requestRender()
  }

  const deleteStrokeFromSupabase = async (strokeId, attempt = 0) => {
    if (!supabase) return
    if (deleteInFlightRef.current.has(strokeId)) return
    deleteInFlightRef.current.add(strokeId)
    const { error } = await supabase.from('strokes').delete().eq('stroke_id', strokeId)
    if (error) {
      console.error('Supabase delete failed (check RLS delete policy)', error)
      if (attempt < 2) {
        const delay = 500 * (attempt + 1)
        setTimeout(() => {
          deleteInFlightRef.current.delete(strokeId)
          deleteStrokeFromSupabase(strokeId, attempt + 1)
        }, delay)
        return
      }
    }
    deleteInFlightRef.current.delete(strokeId)
  }

  const handleUndo = () => {
    const lastStrokeId = undoStackRef.current.pop()
    if (!lastStrokeId) return
    const entry = strokeHistoryRef.current.get(lastStrokeId)
    if (!entry) return
    locallyDeletedRef.current.add(lastStrokeId)
    removeStrokeById(lastStrokeId)
    if (supabase) {
      pendingDeleteRef.current.add(lastStrokeId)
    }
    deleteStrokeFromSupabase(lastStrokeId)
    strokeHistoryRef.current.delete(lastStrokeId)
    redoStackRef.current.push(entry)
    if (redoStackRef.current.length > 50) {
      redoStackRef.current.shift()
    }
    console.log('went back to', lastStrokeId)
  }

  const handleRedo = () => {
    const entry = redoStackRef.current.pop()
    if (!entry) return
    const { stroke, tileCoords } = entry
    locallyDeletedRef.current.delete(stroke.strokeId)
    addStrokeToTiles(stroke, tileCoords)
    saveStrokeToSupabase(stroke, tileCoords)
    strokeHistoryRef.current.set(stroke.strokeId, entry)
    undoStackRef.current.push(stroke.strokeId)
    if (undoStackRef.current.length > 50) {
      undoStackRef.current.shift()
    }
    console.log('went front to', stroke.strokeId)
    requestRender()
  }

  const hitTestStroke = (stroke, point, radius) => {
    if (!stroke.points || stroke.points.length === 0) return false
    if (stroke.points.length === 1) {
      return distance(stroke.points[0], point) <= radius
    }
    for (let i = 0; i < stroke.points.length - 1; i += 1) {
      const a = stroke.points[i]
      const b = stroke.points[i + 1]
      const d = distancePointToSegment(point, a, b)
      if (d <= radius) return true
    }
    return false
  }

  const eraseAtPoint = (worldPoint) => {
    const view = viewRef.current
    const worldRadius = (eraseSize / 2) / view.scale
    const minX = Math.floor((worldPoint.x - worldRadius) / TILE_SIZE)
    const minY = Math.floor((worldPoint.y - worldRadius) / TILE_SIZE)
    const maxX = Math.floor((worldPoint.x + worldRadius) / TILE_SIZE)
    const maxY = Math.floor((worldPoint.y + worldRadius) / TILE_SIZE)
    const visited = new Set()
    const toDelete = []
    for (let ty = minY; ty <= maxY; ty += 1) {
      for (let tx = minX; tx <= maxX; tx += 1) {
        const tile = tilesRef.current.get(tileKey(tx, ty))
        if (!tile) continue
        tile.strokes.forEach((stroke) => {
          if (!stroke.strokeId || visited.has(stroke.strokeId)) return
          visited.add(stroke.strokeId)
          const radius = worldRadius + (stroke.width ?? STROKE_WIDTH) / 2
          if (hitTestStroke(stroke, worldPoint, radius)) {
            toDelete.push(stroke.strokeId)
          }
        })
      }
    }
    toDelete.forEach((strokeId) => {
      removeStrokeById(strokeId)
      deleteStrokeFromSupabase(strokeId)
    })
  }

  const handlePointerDown = (event) => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (document.activeElement !== canvas) {
      canvas.focus()
    }
    canvas.setPointerCapture(event.pointerId)
    setIsPointerDown(true)
    const isPan = mode === 'pan' || event.button === 1 || event.button === 2
    const point = getCanvasPoint(event)
    cursorRef.current = { active: true, x: point.x, y: point.y }
    if (isPan) {
      pointerRef.current = { panning: true, drawing: false, erasing: false, last: point }
      return
    }

    if (mode === 'erase') {
      const worldPoint = screenToWorld(point)
      pointerRef.current = { panning: false, drawing: false, erasing: true, last: worldPoint }
      eraseAtPoint(worldPoint)
      return
    }

    const worldPoint = screenToWorld(point)
    currentStrokeRef.current = {
      strokeId: crypto.randomUUID(),
      userId: deviceIdRef.current,
      color: drawColor,
      width: drawSize,
      points: [worldPoint],
    }
    pointerRef.current = { drawing: true, panning: false, erasing: false, last: worldPoint }
  }

  const handlePointerMove = (event) => {
    const point = getCanvasPoint(event)
    cursorRef.current = { active: true, x: point.x, y: point.y }
    requestRender()
    if (!pointerRef.current.drawing && !pointerRef.current.panning && !pointerRef.current.erasing) return

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
    if (pointerRef.current.erasing) {
      pointerRef.current.last = worldPoint
      eraseAtPoint(worldPoint)
      return
    }
    const stroke = currentStrokeRef.current
    if (!stroke) return
    const lastPoint = stroke.points[stroke.points.length - 1]
    if (distance(lastPoint, worldPoint) < MIN_POINT_DIST) return
    stroke.points.push(worldPoint)
    pointerRef.current.last = worldPoint
    requestRender()
  }

  const handleCanvasKeyDown = (event) => {
    if (event.metaKey || event.ctrlKey) {
      const key = event.key.toLowerCase()
      if (key === 'z') {
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) {
          handleRedo()
        } else {
          handleUndo()
        }
      }
      return
    }
    if (event.altKey) return
    const key = event.key.toLowerCase()
    if (key === 'd' || key === 'b') {
      event.preventDefault()
      setMode('draw')
      return
    }
    if (key === 'e') {
      event.preventDefault()
      setMode('erase')
      return
    }
    if (key === 'p' || key === 'x') {
      event.preventDefault()
      setMode('pan')
    }
  }

  useEffect(() => {
    const handleGlobalKeyDown = (event) => {
      if (!event.ctrlKey && !event.metaKey) return
      if (event.key.toLowerCase() !== 'z') return
      if (event.defaultPrevented) return
      const target = event.target
      const tagName = target?.tagName
      if (tagName === 'INPUT' || tagName === 'TEXTAREA' || target?.isContentEditable) return
      event.preventDefault()
      if (event.shiftKey) {
        handleRedo()
      } else {
        handleUndo()
      }
    }
    window.addEventListener('keydown', handleGlobalKeyDown)
    return () => window.removeEventListener('keydown', handleGlobalKeyDown)
  }, [])

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
        if (stroke.strokeId && stroke.userId === deviceIdRef.current) {
          undoStackRef.current.push(stroke.strokeId)
          if (undoStackRef.current.length > 50) {
            undoStackRef.current.shift()
          }
          redoStackRef.current.length = 0
          const entry = { stroke: { ...stroke }, tileCoords: coords }
          strokeHistoryRef.current.set(stroke.strokeId, entry)
          console.log('draw id', stroke.strokeId)
        }
      }
    }
    pointerRef.current = { drawing: false, panning: false, erasing: false, last: null }
    setIsPointerDown(false)
    currentStrokeRef.current = null
    requestRender()
  }

  const handlePointerLeave = () => {
    cursorRef.current = { active: false, x: 0, y: 0 }
    setIsPointerDown(false)
    handlePointerUp()
  }

  const handleWheel = (event) => {
    event.preventDefault()
    const canvas = canvasRef.current
    if (!canvas) return
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
        if (locallyDeletedRef.current.has(row.stroke_id)) return
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
    requestRender()
  }, [mode, drawColor, drawSize, eraseSize])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const onWheel = (event) => handleWheel(event)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  useEffect(() => {
    const handleMove = (event) => {
      if (!dragRef.current.active) return
      const dock = toolDockRef.current
      const width = dock?.offsetWidth ?? 0
      const height = dock?.offsetHeight ?? 0
      const maxX = Math.max(12, window.innerWidth - width - 12)
      const maxY = Math.max(12, window.innerHeight - height - 12)
      const nextX = clamp(event.clientX - dragRef.current.offsetX, 12, maxX)
      const nextY = clamp(event.clientY - dragRef.current.offsetY, 12, maxY)
      setToolPos({ x: nextX, y: nextY })
    }
    const handleUp = () => {
      dragRef.current.active = false
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
    }
  }, [])

  const handleToolDragStart = (event) => {
    if (event.button !== 0) return
    const dock = toolDockRef.current
    if (!dock) return
    const rect = dock.getBoundingClientRect()
    dragRef.current = {
      active: true,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
  }

  const handleCopyColor = async () => {
    const color = drawColor.toUpperCase()
    const markCopied = () => {
      setColorCopied(true)
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current)
      }
      copyTimeoutRef.current = setTimeout(() => {
        setColorCopied(false)
      }, 1200)
    }

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(color)
        markCopied()
        return
      }
    } catch (error) {
      // fall back to the legacy copy flow
    }

    const textarea = document.createElement('textarea')
    textarea.value = color
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const success = document.execCommand('copy')
    document.body.removeChild(textarea)
    if (success) {
      markCopied()
    }
  }

  useEffect(() => {
    if (!supabase) return undefined

    const channel = supabase
      .channel('strokes-inserts')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'strokes' },
        (payload) => {
          const row = payload.new
          if (locallyDeletedRef.current.has(row.stroke_id)) return
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
        .on(
          'postgres_changes',
          { event: 'DELETE', schema: 'public', table: 'strokes' },
        (payload) => {
          const row = payload.old
          if (!row?.stroke_id) return
          if (pendingDeleteRef.current.has(row.stroke_id)) {
            pendingDeleteRef.current.delete(row.stroke_id)
            locallyDeletedRef.current.delete(row.stroke_id)
            return
          }
          locallyDeletedRef.current.delete(row.stroke_id)
          removeStrokeById(row.stroke_id)
            const index = undoStackRef.current.lastIndexOf(row.stroke_id)
            if (index >= 0) {
              undoStackRef.current.splice(index, 1)
            }
            strokeHistoryRef.current.delete(row.stroke_id)
            redoStackRef.current = redoStackRef.current.filter((entry) => entry.stroke.strokeId !== row.stroke_id)
          },
        )
        .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current)
      }
    }
  }, [])

  return (
    <div className="app">
      <div
        className="tool-dock"
        ref={toolDockRef}
        style={{ left: toolPos.x, top: toolPos.y }}
      >
        <div className="tool-row">
          <button type="button" className="tool-drag" onPointerDown={handleToolDragStart} aria-label="Drag tools">
            ⋮⋮
          </button>
          <div className="tool-actions">
            <button
              type="button"
              className={mode === 'draw' ? 'active' : ''}
              onClick={() => setMode('draw')}
              title="Draw (D/B)"
            >
              Draw
            </button>
            <button
              type="button"
              className={mode === 'erase' ? 'active' : ''}
              onClick={() => setMode('erase')}
              title="Erase (E)"
            >
              Erase
            </button>
            <button
              type="button"
              className={mode === 'pan' ? 'active' : ''}
              onClick={() => setMode('pan')}
              title="Pan (P/X)"
            >
              Pan
            </button>
          </div>
        </div>
        <div className="tool-options">
          {mode === 'draw' && (
            <>
              <label className="tool-option">
                <span>Size</span>
                <input
                  type="range"
                  min="1"
                  max="24"
                  value={drawSize}
                  onChange={(event) => setDrawSize(Number(event.target.value))}
                />
              </label>
              <label className="tool-option">
                <span>Color</span>
                <input type="color" value={drawColor} onChange={(event) => setDrawColor(event.target.value)} />
              </label>
            </>
          )}
          {mode === 'erase' && (
            <label className="tool-option">
              <span>Size</span>
              <input
                type="range"
                min="4"
                max="48"
                value={eraseSize}
                onChange={(event) => setEraseSize(Number(event.target.value))}
              />
            </label>
          )}
        </div>
        {mode === 'draw' && (
          <div className="tool-palette" role="radiogroup" aria-label="Draw color palette">
            <div className="palette-swatches">
              {colorOptions.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`swatch ${drawColor === color ? 'active' : ''}`}
                  style={{ backgroundColor: color }}
                  onClick={() => setDrawColor(color)}
                  role="radio"
                  aria-checked={drawColor === color}
                  aria-label={`Color ${color}`}
                />
              ))}
            </div>
            <button
              type="button"
              className={`current-color ${colorCopied ? 'copied' : ''}`}
              onClick={handleCopyColor}
              aria-label={`Copy current color ${drawColor.toUpperCase()}`}
            >
              <span className="current-color-chip" style={{ backgroundColor: drawColor }} />
              <span className="current-color-text">{colorCopied ? 'Copied' : drawColor.toUpperCase()}</span>
            </button>
          </div>
        )}
      </div>
      <div className="meta-panel">
        <span>Zoom {zoom.toFixed(2)}x</span>
        <span>{centerLabel}</span>
        <span>Device {deviceIdRef.current.slice(0, 8)}</span>
      </div>
      <canvas
        ref={canvasRef}
        className={`canvas ${mode === 'pan' ? (isPointerDown ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-brush'}`}
        tabIndex={0}
        onKeyDown={handleCanvasKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onContextMenu={(event) => event.preventDefault()}
      />
      <footer className="hint">
        {mode === 'draw' && 'Draw on the shared 10k x 10k canvas. Switch to Pan to move.'}
        {mode === 'erase' && 'Erase mode: draw over a stroke to remove it.'}
        {mode === 'pan' && 'Pan mode: drag to move. Wheel to zoom.'}
      </footer>
    </div>
  )
}

export default App
