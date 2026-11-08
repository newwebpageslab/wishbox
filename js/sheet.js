// 바텀 시트: 1:1 드래그, 속도 이어받기, 모멘텀 투영, 고무줄 저항, 언제든 다시 잡기 가능
// 안드로이드 뒤로가기 버튼으로도 닫힘 (history 연동)
import { Spring, VelocityTracker, project, rubberband, reducedMotion } from './spring.js';

const stack = [];
const SLOP = 8; // 방향 확정 전 허용 이동량(px)

window.addEventListener('popstate', () => {
  const top = stack[stack.length - 1];
  if (top && !top.closing) top._dismiss();
});

export function openSheetCount() {
  return stack.length;
}

export class Sheet {
  constructor({ title = '', className = '', onClose } = {}) {
    this.onClose = onClose;
    this.closing = false;
    this.pendingVelocity = 0;
    this.tracker = new VelocityTracker();

    this.layer = document.createElement('div');
    this.layer.className = 'sheet-layer';
    this.layer.innerHTML = `
      <div class="scrim"></div>
      <div class="sheet ${className}" role="dialog" aria-modal="true" tabindex="-1">
        <div class="sheet-panel">
          <div class="sheet-top">
            <div class="grabber" aria-hidden="true"></div>
            <div class="sheet-header">
              <div class="sheet-left"></div>
              <div class="sheet-title"></div>
              <div class="sheet-right"></div>
            </div>
          </div>
          <div class="sheet-body"></div>
        </div>
      </div>`;
    this.scrim = this.layer.querySelector('.scrim');
    this.el = this.layer.querySelector('.sheet');
    this.top = this.layer.querySelector('.sheet-top');
    this.left = this.layer.querySelector('.sheet-left');
    this.titleEl = this.layer.querySelector('.sheet-title');
    this.right = this.layer.querySelector('.sheet-right');
    this.body = this.layer.querySelector('.sheet-body');
    this.setTitle(title);
    this.el.setAttribute('aria-label', title);

    this.spring = new Spring({ damping: 1, response: 0.38, onUpdate: (y) => this._render(y) });
    this.scrim.addEventListener('click', () => this.close());
    this.layer.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
    });
    this._bindHeaderDrag();
    this._bindBodyDrag();
  }

  setTitle(text) {
    this.titleEl.textContent = text;
  }

  get height() {
    return this.el.offsetHeight || window.innerHeight;
  }

  _render(y) {
    this.y = y;
    this.el.style.transform = `translate3d(0, ${y}px, 0)`;
    const progress = Math.min(1, Math.max(0, 1 - y / this.height));
    this.scrim.style.opacity = String(progress);
  }

  open() {
    const parent = stack[stack.length - 1];
    stack.push(this);
    document.body.appendChild(this.layer);
    document.documentElement.classList.add('sheet-open');
    parent?.layer.classList.add('pushed');
    history.pushState({ sheet: stack.length }, '');

    if (reducedMotion()) {
      this.layer.classList.add('fade-in');
      this._render(0);
    } else {
      this.spring.set(this.height);
      requestAnimationFrame(() => this.spring.to(0, { damping: 1, response: 0.38 }));
    }
    this.el.focus({ preventScroll: true });
    return this;
  }

  // UI에서 닫기 → history.back() → popstate → _dismiss (뒤로가기와 동일 경로)
  close(velocity = 0) {
    if (this._closed) return this._closed; // 이미 닫기 요청됨 (history.back 중복 방지)
    this.pendingVelocity = velocity;
    this._closed = new Promise((resolve) => (this._resolveClosed = resolve));
    if (stack[stack.length - 1] === this) history.back();
    else this._dismiss();
    return this._closed;
  }

  async _dismiss() {
    if (!this._closed) this._closed = new Promise((resolve) => (this._resolveClosed = resolve));
    this.closing = true;
    const index = stack.indexOf(this);
    stack[index - 1]?.layer.classList.remove('pushed');
    this.layer.classList.add('closing');

    let finished;
    if (reducedMotion()) {
      this.layer.classList.add('fade-out');
      await new Promise((r) => setTimeout(r, 200));
      finished = true;
    } else {
      finished = await this.spring.to(this.height, { velocity: this.pendingVelocity, damping: 1, response: 0.34 });
    }
    // 닫히는 도중 사용자가 다시 잡으면 finished=false → 제거하지 않음
    if (!finished && !this.closing) return;
    this._remove();
  }

  _remove() {
    const index = stack.indexOf(this);
    if (index >= 0) stack.splice(index, 1);
    this.layer.remove();
    if (!stack.length) document.documentElement.classList.remove('sheet-open');
    this.onClose?.();
    this._resolveClosed?.();
  }

  // 닫히는 중에 다시 잡으면 되살림 (인터럽트 가능)
  _revive() {
    if (!this.closing) return;
    this.closing = false;
    this.layer.classList.remove('closing');
    stack[stack.indexOf(this) - 1]?.layer.classList.add('pushed');
    history.pushState({ sheet: stack.length }, '');
    this._closed = null;
  }

  _beginDrag(pos) {
    this._revive();
    this.spring.stop();
    this.dragStart = pos;
    this.dragOrigin = this.y ?? 0; // 화면에 보이는 현재 값에서 시작
    this.tracker.reset();
    this.tracker.add(pos);
    this.el.classList.add('dragging');
  }

  _moveDrag(pos) {
    const raw = this.dragOrigin + (pos - this.dragStart);
    const y = raw < 0 ? -rubberband(-raw, this.height) : raw;
    this.spring.set(y);
    this.tracker.add(pos);
  }

  _endDrag() {
    this.el.classList.remove('dragging');
    const v = this.tracker.velocity();
    const projected = this.y + project(v);
    if (projected > this.height * 0.5) {
      this.close(v);
    } else {
      // 던지듯 올렸을 때만 살짝 튕김
      this.spring.to(0, { velocity: v, damping: Math.abs(v) > 300 ? 0.8 : 1, response: 0.32 });
    }
  }

  _bindHeaderDrag() {
    let candidate = null;
    let dragging = false;
    this.top.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      candidate = { id: e.pointerId, y: e.clientY };
      dragging = false;
      // 닫히는 중이면 즉시 잡기 (버튼 탭을 방해하지 않도록 열리는 중엔 이동량 확인 후)
      if (this.closing) {
        dragging = true;
        capture(e.pointerId);
        this._beginDrag(e.clientY);
      }
    });
    const capture = (id) => {
      try { this.top.setPointerCapture(id); } catch { /* 이미 해제된 포인터 */ }
    };
    this.top.addEventListener('pointermove', (e) => {
      if (!candidate || e.pointerId !== candidate.id) return;
      if (!dragging && Math.abs(e.clientY - candidate.y) > SLOP) {
        dragging = true;
        capture(e.pointerId);
        this._beginDrag(candidate.y); // 처음 잡은 지점 기준으로 1:1 추적
      }
      if (dragging) this._moveDrag(e.clientY);
    });
    const end = (e) => {
      if (!candidate || e.pointerId !== candidate.id) return;
      candidate = null;
      if (dragging) { dragging = false; this._endDrag(); }
    };
    this.top.addEventListener('pointerup', end);
    this.top.addEventListener('pointercancel', end);
  }

  // 본문은 맨 위까지 스크롤된 상태에서 아래로 끌 때만 시트를 끌어내림
  _bindBodyDrag() {
    let start = null;
    let dragging = false;
    this.body.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { start = null; return; }
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, scrollTop: this.body.scrollTop };
      dragging = false;
    }, { passive: true });

    this.body.addEventListener('touchmove', (e) => {
      if (!start) return;
      const t = e.touches[0];
      const dy = t.clientY - start.y;
      const dx = t.clientX - start.x;
      if (!dragging) {
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SLOP) { start = null; return; } // 가로 스와이프(사진 넘기기)
        if (dy > SLOP && this.body.scrollTop <= 0 && start.scrollTop <= 0) {
          dragging = true;
          this._beginDrag(start.y);
        } else if (Math.abs(dy) > SLOP) {
          start = null; // 일반 스크롤
          return;
        }
      }
      if (dragging) {
        e.preventDefault();
        this._moveDrag(t.clientY);
      }
    }, { passive: false });

    const end = () => {
      if (dragging) this._endDrag();
      dragging = false;
      start = null;
    };
    this.body.addEventListener('touchend', end);
    this.body.addEventListener('touchcancel', end);
  }
}
