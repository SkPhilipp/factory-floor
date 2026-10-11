const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function barState(item, phase, nowMs) {
  if (!item.started_at) return { pct: 0, hot: false };
  const used = (nowMs - Date.parse(item.started_at)) / (phase.timeout_s * 1000);
  const pct = clamp(used, 0, 1) * 100;
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
    const seats = Array.from({ length: phase.seats }, (_, n) => ({
      on: !phase.agent ? true : Boolean(running[n]),
      green: !phase.agent,
      card: running[n] ? { item: running[n], model: cardModel(running[n], phase, nowMs) } : null,
    }));
    const queue = here
      .filter((i) => i.status !== "running")
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

  const paint = (el, m) => {
    el.className = m.classes.join(" ");
    el.href = m.href;
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
    const dots = document.createElement("span");
    dots.className = "dots";
    dots.innerHTML = '<i class="dot"></i>'.repeat(5);
    const bar = document.createElement("span");
    bar.className = "bar";
    bar.appendChild(document.createElement("u"));
    el.append(b, " " + item.title, dots, bar);
    return el;
  };

  const render = (state) => {
    const model = buildModel(state, Date.now());
    if (!scene.children.length) {
      for (const col of model) {
        const sec = document.createElement("section");
        sec.className = "column";
        sec.id = "col-" + col.phase.id;
        sec.innerHTML = "<h3></h3>";
        sec.firstChild.textContent = col.phase.title;
        scene.appendChild(sec);
      }
    }
    model.forEach((col, c) => {
      const sec = scene.children[c];
      sec.querySelectorAll(".seat, .queue").forEach((n) => n.remove());
      const queue = document.createElement("div");
      queue.className = "queue";
      const place = (entry, parent) => {
        const { item, model: m } = entry;
        let el = cards.get(item.number);
        if (!el) cards.set(item.number, (el = makeCard(item)));
        const key = item.phase + "/" + item.status;
        if (keys.get(item.number) !== key || !el.className) paint(el, m);
        else paint(el, m);
        keys.set(item.number, key);
        parent.appendChild(el);
      };
      for (const s of col.seats) {
        const seat = document.createElement("div");
        seat.className = "seat" + (s.card || s.on ? "" : " spare");
        seat.innerHTML = '<span class="light"></span><div class="pad"></div>';
        seat.firstChild.className = "light" + (s.green ? " green" : "") + (s.on ? " on" : "");
        sec.appendChild(seat);
        if (s.card) place(s.card, seat);
      }
      col.queue.forEach((e) => place(e, queue));
      sec.appendChild(queue);
    });
    const t = tally(state.items);
    tallyEl.innerHTML = `Throughput: <span>${t.merged} merged</span>, <span>${t.retried} retried</span>, <span>${t.failed} failed</span>`;
  };

  const load = () =>
    fetch("state.json", { cache: "no-store" })
      .then((r) => r.json())
      .then(render)
      .catch(() => {});
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
