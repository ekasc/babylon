export interface DrawerGestureState {
  startX: number;
  startY: number;
  armed: boolean;
  active: boolean;
  pointerId: number;
}

export function emptyDrawerGesture(): DrawerGestureState {
  return { startX: 0, startY: 0, armed: false, active: false, pointerId: -1 };
}

/** Hover events and moves from a different pointer must never start a drawer drag. */
export function canTrackDrawerMove(
  state: DrawerGestureState,
  event: { pointerId: number; pointerType: string; buttons: number }
): boolean {
  if (!state.armed || state.pointerId !== event.pointerId) return false;
  return event.pointerType !== "mouse" || (event.buttons & 1) !== 0;
}
