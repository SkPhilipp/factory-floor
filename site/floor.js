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

function main() {
  const scene = document.querySelector(".scene");
  const tallyEl = document.querySelector(".tally");
  const cards = new Map();
  const keys = new Map();
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

  const columns = [];
  const build = (model) => {
    for (const col of model) {
      const sec = document.createElement("section");
      sec.className = "column";
      sec.id = "col-" + col.phase.id;
      const h = document.createElement("h3");
      h.textContent = col.phase.title;
      sec.appendChild(h);
      const seats = col.seats.map(() => {
        const seat = document.createElement("div");
        seat.innerHTML = '<span class="light"></span><div class="pad"></div>';
        sec.appendChild(seat);
        return seat;
      });
      const queue = document.createElement("div");
      queue.className = "queue";
      sec.appendChild(queue);
      scene.appendChild(sec);
      columns.push({ seats, queue });
    }
  };

  const render = (state) => {
    const model = buildModel(state, Date.now());
    if (!columns.length) build(model);
    const live = new Set();
    model.forEach((col, c) => {
      const { seats, queue } = columns[c];
      const place = (entry, parent) => {
        const { item, model: m } = entry;
        live.add(item.number);
        let el = cards.get(item.number);
        if (!el) cards.set(item.number, (el = makeCard(item)));
        paint(el, m, item);
        const key = item.phase + "/" + item.status;
        if (keys.get(item.number) !== key || el.parentNode !== parent) parent.appendChild(el);
        keys.set(item.number, key);
      };
      col.seats.forEach((s, n) => {
        if (!seats[n]) return;
        seats[n].className = "seat" + (s.card || s.on ? "" : " spare");
        seats[n].firstChild.className = "light" + (s.green ? " green" : "") + (s.on ? " on" : "");
        if (s.card) place(s.card, seats[n]);
      });
      col.queue.forEach((e) => place(e, queue));
    });
    for (const [number, el] of cards) {
      if (live.has(number)) continue;
      el.remove();
      cards.delete(number);
      keys.delete(number);
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
