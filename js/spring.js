// Apple식 스프링 (damping ratio + response) — 언제든 중단·재목표 가능, 속도를 이어받음
export const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export class Spring {
  constructor({ value = 0, damping = 1, response = 0.4, precision = 0.5, onUpdate = () => {} } = {}) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.damping = damping;
    this.response = response;
    this.precision = precision;
    this.onUpdate = onUpdate;
    this._raf = 0;
    this._waiters = [];
    this._tick = this._tick.bind(this);
  }

  get animating() {
    return this._raf !== 0;
  }

  // 손가락 추적 등 즉시 값 지정 (애니메이션 중단)
  set(value) {
    this.stop();
    this.value = value;
    this.target = value;
    this.velocity = 0;
    this.onUpdate(value);
  }

  // 현재 화면 값에서 출발해 target으로. velocity를 넘기면 제스처 속도를 이어받음
  to(target, { velocity, damping, response } = {}) {
    this._settle(false); // 이전 목표는 '중단됨'으로 처리
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
    if (damping !== undefined) this.damping = damping;
    if (response !== undefined) this.response = response;

    if (reducedMotion()) {
      this.value = target;
      this.velocity = 0;
      this.onUpdate(target);
      return Promise.resolve(true);
    }
    const done = new Promise((resolve) => this._waiters.push(resolve));
    if (!this._raf) {
      this._last = performance.now();
      this._raf = requestAnimationFrame(this._tick);
    }
    return done;
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._settle(false);
  }

  _settle(finished) {
    const waiters = this._waiters;
    this._waiters = [];
    waiters.forEach((resolve) => resolve(finished));
  }

  _tick(now) {
    let dt = Math.min((now - this._last) / 1000, 0.064);
    this._last = now;
    const stiffness = (2 * Math.PI / this.response) ** 2;
    const friction = (4 * Math.PI * this.damping) / this.response;
    const STEP = 1 / 240;
    while (dt > 0) {
      const h = Math.min(STEP, dt);
      const accel = -stiffness * (this.value - this.target) - friction * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
      dt -= h;
    }
    const resting =
      Math.abs(this.value - this.target) < this.precision &&
      Math.abs(this.velocity) < this.precision * 20;
    if (resting) {
      this.value = this.target;
      this.velocity = 0;
      this.onUpdate(this.value);
      this._raf = 0;
      this._settle(true);
      return;
    }
    this.onUpdate(this.value);
    this._raf = requestAnimationFrame(this._tick);
  }
}

// 최근 100ms 포인터 이력으로 손 뗄 때의 속도(px/s) 계산
export class VelocityTracker {
  constructor() { this.samples = []; }
  reset() { this.samples = []; }
  add(pos, t = performance.now()) {
    this.samples.push({ pos, t });
    while (this.samples.length > 2 && t - this.samples[0].t > 100) this.samples.shift();
  }
  velocity() {
    const s = this.samples;
    if (s.length < 2) return 0;
    const last = s[s.length - 1];
    if (performance.now() - last.t > 100) return 0; // 멈춘 채로 손을 뗌
    const first = s[0];
    const dt = (last.t - first.t) / 1000;
    return dt > 0 ? (last.pos - first.pos) / dt : 0;
  }
}

// Apple 샘플 코드의 모멘텀 투영 (스크롤 감속과 동일한 감각)
export function project(velocity, decelerationRate = 0.998) {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

// 경계 밖으로 끌수록 점점 덜 따라오는 고무줄 저항
export function rubberband(overshoot, dimension, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

// 의미 있는 순간에만 짧은 햅틱
export function haptic(pattern = 8) {
  try { navigator.vibrate?.(pattern); } catch { /* 미지원 */ }
}
