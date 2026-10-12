import {
  createContext, useCallback, useContext, useMemo, useState,
  type PropsWithChildren, type ReactElement
} from 'react'
import { todayIso, shiftDateIso } from '@renderer/lib/format'

interface SelectedDateContextValue {
  selectedDateIso: string
  isToday: boolean
  goPreviousDay: () => void
  goNextDay: () => void
  goToday: () => void
  setSelectedDateIso: (iso: string) => void
}

const SelectedDateContext = createContext<SelectedDateContextValue | undefined>(undefined)

/**
 * The global operational "working day" shown in the headbar (item 14).
 * Deliberately in-memory only, not persisted to localStorage or the
 * database: it always starts at the real system date on every launch,
 * so a session left on a backdated day can never silently carry that
 * backdating into a future, unrelated session. Within one session the
 * user may browse to another day, and the value is exposed to forms
 * that default a new record's date to "today" (item 15) — it never
 * overrides a date the user explicitly typed, and it never touches
 * report screens that already have their own explicit date filters.
 */
export function SelectedDateProvider({ children }: PropsWithChildren): ReactElement {
  const [selectedDateIso, setSelectedDateIso] = useState(() => todayIso())

  const goPreviousDay = useCallback(() => setSelectedDateIso((d) => shiftDateIso(d, -1)), [])
  const goNextDay = useCallback(() => setSelectedDateIso((d) => shiftDateIso(d, 1)), [])
  const goToday = useCallback(() => setSelectedDateIso(todayIso()), [])
  const isToday = useMemo(() => selectedDateIso === todayIso(), [selectedDateIso])

  return (
    <SelectedDateContext.Provider
      value={{ selectedDateIso, isToday, goPreviousDay, goNextDay, goToday, setSelectedDateIso }}
    >
      {children}
    </SelectedDateContext.Provider>
  )
}

export function useSelectedDate(): SelectedDateContextValue {
  const ctx = useContext(SelectedDateContext)
  if (!ctx) throw new Error('useSelectedDate must be used within SelectedDateProvider')
  return ctx
}
