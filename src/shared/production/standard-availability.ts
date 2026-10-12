/** BL-04: availability is derived from the authoritative ready quantity only — never stored, never editable. */
export function standardProductAvailability(readyMicro: number): 'متوفر' | 'غير متوفر' {
  return readyMicro > 0 ? 'متوفر' : 'غير متوفر'
}
