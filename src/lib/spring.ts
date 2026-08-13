// A minimal spring engine implementing Apple's fluid-interface principles:
// - springs, not CSS transitions, for anything touchable (interruptible, velocity-aware)
// - damping ratio + response time instead of fixed durations
// - velocity handoff between gesture and animation (1:1 drag → spring)
// Dependency-free; drives transform/opacity via rAF.
export interface SpringConfig {
  /** 1.0 = critically damped (no overshoot). <1 = bouncy. */
  damping: number;
  /** Approximate settle time in seconds; lower = snappier. */
  response: number;
}

export const springCritical: SpringConfig = { damping: 1.0, response: 0.3 };
export const springSnappy: SpringConfig = { damping: 1.0, response: 0.2 };
export const springMomentum: SpringConfig = { damping: 0.8, response: 0.3 };
// Non-gestural surfaces should settle without ornamental bounce. Momentum is
// reserved for interactions that actually inherit a release velocity.
export const springModal: SpringConfig = { damping: 1.0, response: 0.28 };

export class Spring {
  private x: number;
  private v = 0;
  private target: number;
  private cfg: SpringConfig;
  private raf = 0;
  private lastT = 0;
  private onUpdate: (x: number) => void;
  private onSettled?: () => void;

  constructor(
    x0: number,
    target: number,
    cfg: SpringConfig,
    onUpdate: (x: number) => void,
    onSettled?: () => void
  ) {
    this.x = x0;
    this.target = target;
    this.cfg = cfg;
    this.onUpdate = onUpdate;
    this.onSettled = onSettled;
  }

  get value(): number {
    return this.x;
  }

  /** 1:1 direct write during a gesture (bypasses animation). */
  set(x: number): void {
    this.x = x;
    this.onUpdate(x);
  }

  /** Re-target from the current value, optionally carrying gesture velocity. */
  retarget(target: number, velocity?: number, cfg?: SpringConfig): void {
    if (cfg) this.cfg = cfg;
    if (velocity !== undefined) this.v = velocity;
    this.target = target;
    if (prefersReducedMotion()) {
      this.v = 0;
      this.x = target;
      this.onUpdate(target);
      this.stop();
      this.onSettled?.();
      return;
    }
    this.lastT = 0;
    this.start();
  }

  stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private start(): void {
    this.stop();
    this.lastT = 0;
    this.raf = requestAnimationFrame(this.step);
  }

  private step = (t: number): void => {
    const dt = Math.min((t - (this.lastT || t)) / 1000, 1 / 30);
    this.lastT = t;
    // mass-spring-damper with unit mass: x'' = -ω²(x−target) − 2ζωx'
    const omega = (2 * Math.PI) / this.cfg.response;
    const zeta = this.cfg.damping;
    const a = -omega * omega * (this.x - this.target) - 2 * zeta * omega * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
    this.onUpdate(this.x);

    const eps = 0.0005;
    if (Math.abs(this.x - this.target) < eps && Math.abs(this.v) < eps * 20) {
      this.x = this.target;
      this.v = 0;
      this.onUpdate(this.x);
      this.stop();
      this.onSettled?.();
      return;
    }
    this.raf = requestAnimationFrame(this.step);
  };
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}
