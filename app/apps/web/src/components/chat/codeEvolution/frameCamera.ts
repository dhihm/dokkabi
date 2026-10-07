/** Latest-only presentation updates. No callbacks survive cancellation. */
export function frameCamera<T>(publish: (value: T) => void) {
  let frame: number | null = null;
  let pending: { value: T } | null = null;
  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    pending = null;
  };
  const flush = () => {
    const last = pending;
    cancel();
    if (last !== null) publish(last.value);
  };
  return {
    queue(value: T) {
      pending = { value };
      if (frame === null) frame = requestAnimationFrame(flush);
    },
    flush,
    cancel,
  };
}
