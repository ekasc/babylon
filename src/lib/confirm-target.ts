/**
 * Confirm-before-mutate target capture (I7): the target identity is read
 * BEFORE the confirmation dialog opens, so navigating while the modal is on
 * screen can never retarget the mutation. Returns null when there is no
 * target or the user declines.
 */
export async function captureTargetThen<T>(
  capture: () => string | null,
  confirm: () => Promise<boolean>,
  run: (target: string) => Promise<T>
): Promise<T | null> {
  const target = capture();
  if (!target) return null;
  if (!(await confirm())) return null;
  return run(target);
}
