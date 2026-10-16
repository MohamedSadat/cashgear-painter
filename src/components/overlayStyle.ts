// The look of the overlay's handles, shared by the selection and path editing overlays. Sizes are
// in screen pixels.

export const ACCENT = '#0ea5e9'

// Fingers need bigger handles than mice.
const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
export const ANCHOR_SIZE = coarsePointer ? 18 : 9
// Extra grip around small round handles.
export const HANDLE_GRIP = coarsePointer ? 16 : 8
