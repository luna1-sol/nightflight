import { clamp } from "./flight-math.ts";
import { VIEW_LIMITS, wrapAngle } from "./view-math.ts";

export class ViewControls {
  canvas: HTMLElement;
  reducedMotion: boolean;
  onChange: (input: boolean) => void;
  tilt = 24;
  targetTilt = 24;
  yaw = 0;
  targetYaw = 0;
  drag: { id: number; x: number; y: number } | null = null;

  constructor(
    canvas: HTMLElement,
    {
      reducedMotion = false,
      onChange = () => {},
    }: { reducedMotion?: boolean; onChange?: (input: boolean) => void } = {},
  ) {
    this.canvas = canvas;
    this.reducedMotion = reducedMotion;
    this.onChange = onChange;
    canvas.addEventListener("pointerdown", (event) => this.beginDrag(event));
    canvas.addEventListener("pointermove", (event) => this.dragTo(event));
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"] as const)
      canvas.addEventListener(type, (event) => this.endDrag(event));
    canvas.addEventListener("dblclick", () => this.reset());
  }
  get isDragging(): boolean {
    return this.drag !== null;
  }
  reset(): void {
    this.tilt = this.targetTilt = 24;
    this.yaw = this.targetYaw = 0;
    this.onChange(false);
  }
  move(dx: number, dy: number): void {
    dx = clamp(Number.isFinite(dx) ? dx : 0, -160, 160);
    dy = clamp(Number.isFinite(dy) ? dy : 0, -160, 160);
    this.targetTilt = clamp(
      this.targetTilt - dy * 0.05,
      VIEW_LIMITS.minTilt,
      VIEW_LIMITS.maxTilt,
    );
    this.targetYaw = wrapAngle(this.targetYaw - dx * 0.055);
    this.onChange(true);
  }
  update(dt: number): boolean {
    const tiltDelta = this.targetTilt - this.tilt,
      yawDelta = wrapAngle(this.targetYaw - this.yaw);
    if (Math.abs(tiltDelta) < 0.003 && Math.abs(yawDelta) < 0.003) {
      const changed =
        this.tilt !== this.targetTilt || this.yaw !== this.targetYaw;
      this.tilt = this.targetTilt;
      this.yaw = this.targetYaw;
      return changed;
    }
    const gain = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 7);
    this.tilt += tiltDelta * gain;
    this.yaw = wrapAngle(this.yaw + yawDelta * gain);
    return true;
  }
  beginDrag(event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0 || this.drag) return;
    this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.classList.add("dragging");
    this.canvas.focus({ preventScroll: true });
    this.onChange(false);
  }
  dragTo(event: PointerEvent): void {
    if (!this.drag || event.pointerId !== this.drag.id) return;
    this.move(event.clientX - this.drag.x, event.clientY - this.drag.y);
    this.drag.x = event.clientX;
    this.drag.y = event.clientY;
  }
  endDrag(event: PointerEvent): void {
    if (this.drag?.id !== event.pointerId) return;
    this.drag = null;
    this.canvas.classList.remove("dragging");
  }
}
