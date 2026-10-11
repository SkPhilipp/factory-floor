const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function barState(item, phase, nowMs) {
  const start = item.started_at ? Date.parse(item.started_at) : NaN;
  const total = Number(phase.timeout_s) * 1000;
  if (!Number.isFinite(start) || !(total > 0)) return { pct: 0, hot: false };
  const used = (nowMs - start) / total;
  const pct = Number.isFinite(used) ? clamp(used, 0, 1) * 100 : 0;
  return { pct, hot: pct >= 80 };
}

export function tally(items) {
  return {
    merged: items.filter((i) => i.status === "merged").length,
    failed: items.filter((i) => i.status === "failed").length,
    retried: items.filter((i) => i.strikes > 0 && i.status !== "failed").length,
  };
}

export function orbit(angles, dx, dy) {
  return {
    rotateX: clamp(angles.rotateX - dy * 0.3, 20, 80),
    rotateY: clamp(angles.rotateY + dx * 0.3, -45, 45),
  };
}

export function cardHref(item) {
  return item.thread_url || item.issue_url;
}

export function cardModel(item, phase, nowMs) {
  const classes = ["card", item.status === "running" ? "held" : item.status];
  if (item.strikes > 0) classes.push("strikes");
  return {
    classes,
    href: cardHref(item),
    dots: Array.from({ length: 5 }, (_, n) => n < item.strikes),
    bar: barState(item, phase, nowMs),
    defect: item.defect ?? null,
  };
}

// Per phase: one seat per configured seat (running items take them), the rest queue.
export function buildModel(state, nowMs) {
  return state.phases.map((phase) => {
    const here = state.items.filter((i) => i.phase === phase.id);
    const running = here.filter((i) => i.status === "running");
    const seatCount = Math.max(0, phase.seats | 0);
    const seats = Array.from({ length: seatCount }, (_, n) => ({
      on: !phase.agent ? true : Boolean(running[n]),
      green: !phase.agent,
      card: running[n] ? { item: running[n], model: cardModel(running[n], phase, nowMs) } : null,
    }));
    const queue = here
      .filter((i) => i.status !== "running" || running.indexOf(i) >= seatCount)
      .map((i) => ({ item: i, model: cardModel(i, phase, nowMs) }));
    return { phase, seats, queue };
  });
}

// Slot id: phase plus a seat index, or the queue when seatIndex is null.
export function slotOf(phaseId, seatIndex) {
  return seatIndex === null ? phaseId + "/queue" : phaseId + "/seat/" + seatIndex;
}

// Slot id of every item in a model, keyed by item number.
export function slotsOf(model) {
  const out = new Map();
  for (const col of model) {
    col.seats.forEach((s, n) => s.card && out.set(s.card.item.number, slotOf(col.phase.id, n)));
    col.queue.forEach((e) => out.set(e.item.number, slotOf(col.phase.id, null)));
  }
  return out;
}

// Pure DOM plan: per column in model order, its seats (with card number or null) and queue numbers.
export function layout(model) {
  return model.map((col) => ({
    id: col.phase.id,
    seats: col.seats.map((s, index) => ({ index, card: s.card ? s.card.item.number : null })),
    queue: col.queue.map((e) => e.item.number),
  }));
}

function main() {
  const scene = document.querySelector(".scene");
  const tallyEl = document.querySelector(".tally");
  const cards = new Map();
  let angles = { rotateX: 50, rotateY: 0 };

  const errEl = document.createElement("p");
  errEl.className = "load-error";
  errEl.hidden = true;
  scene.before(errEl);

  const paint = (el, m, item) => {
    el.className = m.classes.join(" ");
    el.href = m.href;
    el.querySelector(".title").textContent = " " + item.title;
    el.querySelectorAll(".dot").forEach((d, n) => d.classList.toggle("filled", m.dots[n]));
    const bar = el.querySelector(".bar");
    bar.classList.toggle("hot", m.bar.hot);
    bar.firstChild.style.width = m.bar.pct + "%";
    let defect = el.querySelector(".defect");
    if (m.defect !== null) {
      if (!defect) {
        defect = document.createElement("span");
        defect.className = "defect";
        el.appendChild(defect);
      }
      defect.textContent = m.defect;
    } else if (defect) defect.remove();
  };

  const makeCard = (item) => {
    const el = document.createElement("a");
    const b = document.createElement("b");
    b.textContent = "#" + item.number;
    const title = document.createElement("span");
    title.className = "title";
    const dots = document.createElement("span");
    dots.className = "dots";
    dots.innerHTML = '<i class="dot"></i>'.repeat(5);
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.appendChild(document.createElement("u"));
    el.append(b, title, dots, bar);
    return el;
  };

  const columns = new Map();
  const slots = new Map();
  const ensureColumn = (phase) => {
    let col = columns.get(phase.id);
    if (!col) {
      const sec = document.createElement("section");
      sec.className = "column";
      sec.id = "col-" + phase.id;
      const h = document.createElement("h3");
      sec.appendChild(h);
      const queue = document.createElement("div");
      queue.className = "queue";
      sec.appendChild(queue);
      scene.appendChild(sec);
      columns.set(phase.id, (col = { sec, h, queue, seats: [] }));
    }
    col.h.textContent = phase.title;
    return col;
  };
  const ensureSeats = (col, count) => {
    while (col.seats.length < count) {
      const seat = document.createElement("div");
      seat.innerHTML = '<span class="light"></span><div class="pad"></div>';
      col.queue.before(seat);
      col.seats.push(seat);
    }
  };

  const render = (state) => {
    const model = buildModel(state, Date.now());
    const live = new Set();
    const plan = layout(model);
    const shown = new Set(plan.map((p) => p.id));
    for (const [id, c] of columns) c.sec.hidden = !shown.has(id);
    model.forEach((colModel, ci) => {
      const col = ensureColumn(colModel.phase);
      col.sec.hidden = false;
      if (scene.children[ci] !== col.sec) scene.insertBefore(col.sec, scene.children[ci] || null);
      ensureSeats(col, colModel.seats.length);
      const { seats, queue } = col;
      const place = (entry, parent, slot) => {
        const { item, model: m } = entry;
        live.add(item.number);
        let el = cards.get(item.number);
        if (!el) cards.set(item.number, (el = makeCard(item)));
        paint(el, m, item);
        if (slots.get(item.number) !== slot) parent.appendChild(el);
        slots.set(item.number, slot);
      };
      seats.forEach((seat, n) => {
        const s = colModel.seats[n];
        if (!s) {
          seat.className = "seat spare";
          seat.hidden = true;
          return;
        }
        seat.hidden = false;
        seat.className = "seat" + (s.card || s.on ? "" : " spare");
        seat.firstChild.className = "light" + (s.green ? " green" : "") + (s.on ? " on" : "");
        if (s.card) place(s.card, seat, slotOf(colModel.phase.id, n));
      });
      colModel.queue.forEach((e) => place(e, queue, slotOf(colModel.phase.id, null)));
      const want = plan[ci].queue;
      const have = Array.from(queue.children, (el) => Number(el.querySelector("b").textContent.slice(1)));
      if (want.join() !== have.join()) want.forEach((n) => queue.appendChild(cards.get(n)));
    });
    for (const [number, el] of cards) {
      if (live.has(number)) continue;
      el.remove();
      cards.delete(number);
      slots.delete(number);
    }
    const t = tally(state.items);
    tallyEl.innerHTML = `Throughput: <span>${t.merged} merged</span>, <span>${t.retried} retried</span>, <span>${t.failed} failed</span>`;
  };

  const load = () =>
    fetch("state.json", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((state) => {
        render(state);
        errEl.hidden = true;
      })
      .catch((e) => {
        errEl.textContent = "Could not load state.json: " + e.message;
        errEl.hidden = false;
      });
  load();
  setInterval(load, 30000);

  const apply = () => {
    scene.style.transform = `rotateX(${angles.rotateX}deg) rotateY(${angles.rotateY}deg)`;
  };
  let last = null;
  scene.addEventListener("pointerdown", (e) => {
    last = e;
    scene.setPointerCapture?.(e.pointerId);
  });
  scene.addEventListener("pointermove", (e) => {
    if (!last) return;
    angles = orbit(angles, e.clientX - last.clientX, e.clientY - last.clientY);
    last = e;
    apply();
  });
  const end = () => (last = null);
  scene.addEventListener("pointerup", end);
  scene.addEventListener("pointercancel", end);
}

if (typeof document !== "undefined") main();
