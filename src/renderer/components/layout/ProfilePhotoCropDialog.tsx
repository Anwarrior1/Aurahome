import { useCallback, useState, type ReactElement } from 'react'
import Cropper, { type Area, type Point } from 'react-easy-crop'
import 'react-easy-crop/react-easy-crop.css'
import { Button, ErrorNote, Modal } from '@renderer/components/ui'
import { call, ApiError } from '@renderer/lib/api'

const INITIAL_CROP: Point = { x: 0, y: 0 }
const INITIAL_ZOOM = 1
const MIN_ZOOM = 1
const MAX_ZOOM = 3
/** Preferred normalized output — a square the circular mask crops
 *  from (item "FINAL PROFILE IMAGE"). */
const OUTPUT_SIZE = 512

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('تعذر تحميل الصورة'))
    img.src = src
  })
}

/**
 * Draws exactly the region the user cropped onto an output canvas —
 * never the whole original image, never stretched (draw source/dest
 * both come straight from croppedAreaPixels, which react-easy-crop
 * computes in the ORIGINAL image's own pixel coordinates). Small
 * source crops are not upscaled past their own size ("do not
 * unnecessarily upscale very small images"); large ones are capped at
 * OUTPUT_SIZE. Chromium's own image decoder already applies EXIF
 * orientation before this ever runs, so no separate orientation
 * handling is needed here.
 */
async function renderCroppedSquare(imageDataUrl: string, area: Area): Promise<string> {
  const image = await loadImageElement(imageDataUrl)
  const outputSize = Math.min(OUTPUT_SIZE, Math.round(area.width))
  const canvas = document.createElement('canvas')
  canvas.width = outputSize
  canvas.height = outputSize
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas غير مدعوم')
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, outputSize, outputSize)
  return canvas.toDataURL('image/jpeg', 0.92)
}

/**
 * Profile-photo crop/position editor (item "PROFILE PHOTO CROP /
 * POSITION EDITOR"). Mounted only while `imageDataUrl` is non-null —
 * nothing here touches disk or the DB until "حفظ" is pressed; "إلغاء"
 * simply unmounts, leaving the existing photo (if any) untouched.
 */
export function ProfilePhotoCropDialog({
  imageDataUrl,
  onCancel,
  onSaved
}: {
  imageDataUrl: string
  onCancel: () => void
  onSaved: () => void
}): ReactElement {
  const [crop, setCrop] = useState<Point>(INITIAL_CROP)
  const [zoom, setZoom] = useState(INITIAL_ZOOM)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()

  const onCropComplete = useCallback((_croppedArea: Area, areaPixels: Area) => {
    setCroppedAreaPixels(areaPixels)
  }, [])

  function reset(): void {
    setCrop(INITIAL_CROP)
    setZoom(INITIAL_ZOOM)
  }

  async function save(): Promise<void> {
    if (!croppedAreaPixels) return
    setSaving(true)
    setError(undefined)
    try {
      const outputDataUrl = await renderCroppedSquare(imageDataUrl, croppedAreaPixels)
      await call('profile', 'setPhoto', { dataUrl: outputDataUrl })
      onSaved()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'تعذر حفظ الصورة الشخصية')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      title="تعديل الصورة الشخصية"
      onClose={onCancel}
      footer={
        <>
          <Button onClick={() => void save()} disabled={saving || !croppedAreaPixels}>
            حفظ
          </Button>
          <Button variant="ghost" onClick={reset} disabled={saving}>
            إعادة ضبط
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            إلغاء
          </Button>
        </>
      }
    >
      <div className="crop-dialog">
        <div className="crop-dialog__stage">
          <Cropper
            image={imageDataUrl}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape="round"
            showGrid={false}
            minZoom={MIN_ZOOM}
            maxZoom={MAX_ZOOM}
            restrictPosition
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={onCropComplete}
          />
        </div>
        <label className="crop-dialog__zoom">
          <span>تكبير</span>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            disabled={saving}
          />
        </label>
        <ErrorNote>{error}</ErrorNote>
      </div>
    </Modal>
  )
}
