import { AppError } from '../utils/errors'

let generation = 0
let activeOperations = 0
let restorePending = false
const drainedWaiters = new Set<() => void>()

export function captureRestoreGeneration(): number {
  return generation
}

export function restoreLifecycleState(): Readonly<{
  generation: number
  activeOperations: number
  restorePending: boolean
}> {
  return { generation, activeOperations, restorePending }
}

/** Admit one operation that must finish before an exclusive restore can replace the DB. */
export function admitRestoreProtectedOperation(): () => void {
  if (restorePending) {
    throw new AppError('CONFLICT', 'الاستعادة قيد التنفيذ. انتظر حتى تكتمل ثم أعد المحاولة')
  }
  activeOperations += 1
  let released = false
  return () => {
    if (released) return
    released = true
    activeOperations -= 1
    if (activeOperations === 0) {
      for (const resolve of drainedWaiters) resolve()
      drainedWaiters.clear()
    }
  }
}

/** Close admission and drain operations admitted in the current DB epoch. */
export async function acquireRestoreExclusivity(
  expectedGeneration: number,
  timeoutMs = 30_000
): Promise<() => void> {
  if (restorePending || generation !== expectedGeneration) {
    throw new AppError('CONFLICT', 'تعارضت عملية الاستعادة مع تغيير آخر في دورة حياة قاعدة البيانات')
  }

  restorePending = true
  generation += 1
  try {
    if (activeOperations > 0) {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const onDrained = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          drainedWaiters.delete(onDrained)
          reject(new AppError('CONFLICT', 'تعذر بدء الاستعادة لأن عملية أخرى لم تنته بعد'))
        }, timeoutMs)
        timer.unref?.()
        drainedWaiters.add(onDrained)
      })
    }
  } catch (error) {
    restorePending = false
    generation += 1
    throw error
  }

  let released = false
  return () => {
    if (released) return
    released = true
    restorePending = false
    generation += 1
  }
}
