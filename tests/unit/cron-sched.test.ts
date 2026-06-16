/**
 * Tests unitaires — Cron scheduler de secours (setInterval + garde dedup)
 *
 * Couvre la logique extraite de radar-bc-bot.js bloc PLANIFICATION CRON :
 *   - _makeHourKey()       → clé YYYY-MM-DDTHH UTC
 *   - _triggerHourlyBC()   → dédup + garde _scanningBC + appel runGlobalScanBC
 *
 * SCHED-1  makeHourKey format
 * SCHED-2  makeHourKey unicité horaire UTC
 * SCHED-3  makeHourKey changement d'heure UTC
 * SCHED-4  triggerHourlyBC — premier déclenchement OK
 * SCHED-5  triggerHourlyBC — double déclenchement même heure → bloqué
 * SCHED-6  triggerHourlyBC — heure différente → laissé passer
 * SCHED-7  triggerHourlyBC — scan en cours → skipped (log SCHED)
 * SCHED-8  triggerHourlyBC — scan terminé, heure suivante → déclenché
 * SCHED-9  triggerHourlyBC — clé mise à jour avant appel runGlobalScanBC
 * SCHED-10 triggerHourlyBC — source transmise à runGlobalScanBC
 * SCHED-11 triggerHourlyBC source=cron et cron-interval → dedup partagée
 * SCHED-12 heartbeat UTC minute !== 0 → pas de trigger
 * SCHED-13 heartbeat UTC minute === 0 → trigger
 * SCHED-14 heartbeat deux fois à minute===0 même heure → un seul trigger
 * SCHED-15 log messages présents (SCHED tags)
 */

// ────────────────────────────────────────────────────────────────────────────
// Fonctions miroir extraites du bot
// ────────────────────────────────────────────────────────────────────────────

function makeHourKey(now: Date): string {
  return now.getUTCFullYear() + "-"
    + String(now.getUTCMonth() + 1).padStart(2, "0") + "-"
    + String(now.getUTCDate()).padStart(2, "0") + "T"
    + String(now.getUTCHours()).padStart(2, "0");
}

interface SchedState {
  lastScheduledBcHourKey: string;
  scanningBC: boolean;
  logs: string[];
  triggered: Array<{ source: string }>;
}

function makeSched(): SchedState {
  return { lastScheduledBcHourKey: "", scanningBC: false, logs: [], triggered: [] };
}

function triggerHourlyBC(
  source: string,
  now: Date,
  state: SchedState
): void {
  const key = makeHourKey(now);
  if (state.lastScheduledBcHourKey === key) {
    state.logs.push("[SCHED] hourly BC already triggered for hour=" + key + " source=" + source);
    return;
  }
  if (state.scanningBC) {
    state.logs.push("[SCHED] skipped because scan already running hour=" + key + " source=" + source);
    return;
  }
  state.lastScheduledBcHourKey = key;
  state.logs.push("[SCHED] hourly BC trigger hour=" + key + " source=" + source);
  state.triggered.push({ source });
}

function heartbeatTick(now: Date, state: SchedState): void {
  state.logs.push("[SCHED] heartbeat utc=" + now.toISOString().slice(0, 16));
  if (now.getUTCMinutes() === 0) {
    triggerHourlyBC("cron-interval", now, state);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function utc(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
}

// ────────────────────────────────────────────────────────────────────────────
// SCHED-1 : makeHourKey format
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-1 makeHourKey — format YYYY-MM-DDTHH", () => {
  it("retourne le bon format pour une date UTC standard", () => {
    const key = makeHourKey(utc(2025, 6, 15, 9));
    expect(key).toBe("2025-06-15T09");
  });

  it("padde le mois et le jour à 2 chiffres", () => {
    const key = makeHourKey(utc(2025, 1, 5, 0));
    expect(key).toBe("2025-01-05T00");
  });

  it("padde l'heure à 2 chiffres", () => {
    const key = makeHourKey(utc(2025, 12, 31, 8));
    expect(key).toBe("2025-12-31T08");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-2 : makeHourKey unicité dans la même heure
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-2 makeHourKey — même clé pour toutes les minutes d'une heure", () => {
  it("minute 0 et minute 59 de la même heure UTC → même clé", () => {
    const k1 = makeHourKey(utc(2025, 6, 15, 14, 0));
    const k2 = makeHourKey(utc(2025, 6, 15, 14, 59));
    expect(k1).toBe(k2);
  });

  it("minutes différentes dans la même heure → même clé", () => {
    const k1 = makeHourKey(utc(2025, 6, 15, 14, 23));
    const k2 = makeHourKey(utc(2025, 6, 15, 14, 47));
    expect(k1).toBe(k2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-3 : makeHourKey changement d'heure UTC
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-3 makeHourKey — changement d'heure UTC → clé différente", () => {
  it("14h59 et 15h00 UTC → clés différentes", () => {
    const k1 = makeHourKey(utc(2025, 6, 15, 14, 59));
    const k2 = makeHourKey(utc(2025, 6, 15, 15, 0));
    expect(k1).not.toBe(k2);
    expect(k2).toBe("2025-06-15T15");
  });

  it("23h59 et 00h00 du lendemain → clés différentes", () => {
    const k1 = makeHourKey(utc(2025, 6, 15, 23, 59));
    const k2 = makeHourKey(utc(2025, 6, 16, 0, 0));
    expect(k1).not.toBe(k2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-4 : premier déclenchement OK
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-4 triggerHourlyBC — premier appel déclenche le scan", () => {
  it("ajoute un déclenchement et met à jour lastKey", () => {
    const state = makeSched();
    const now = utc(2025, 6, 15, 15);
    triggerHourlyBC("cron", now, state);
    expect(state.triggered).toHaveLength(1);
    expect(state.lastScheduledBcHourKey).toBe("2025-06-15T15");
  });

  it("log [SCHED] hourly BC trigger", () => {
    const state = makeSched();
    triggerHourlyBC("cron", utc(2025, 6, 15, 15), state);
    expect(state.logs.some(l => l.includes("[SCHED] hourly BC trigger"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-5 : double déclenchement même heure → bloqué
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-5 triggerHourlyBC — double appel même heure UTC → bloqué", () => {
  it("deuxième appel ne déclenche pas de scan", () => {
    const state = makeSched();
    const now = utc(2025, 6, 15, 15);
    triggerHourlyBC("cron", now, state);
    triggerHourlyBC("cron-interval", now, state);
    expect(state.triggered).toHaveLength(1);
  });

  it("log 'already triggered'", () => {
    const state = makeSched();
    const now = utc(2025, 6, 15, 15);
    triggerHourlyBC("cron", now, state);
    triggerHourlyBC("cron", now, state);
    expect(state.logs.some(l => l.includes("already triggered"))).toBe(true);
  });

  it("trois appels → un seul déclenchement", () => {
    const state = makeSched();
    const now = utc(2025, 6, 15, 15);
    triggerHourlyBC("cron", now, state);
    triggerHourlyBC("cron-interval", now, state);
    triggerHourlyBC("cron", now, state);
    expect(state.triggered).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-6 : heure différente → laissé passer
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-6 triggerHourlyBC — heure différente → nouveau déclenchement", () => {
  it("15h puis 16h → deux déclenchements", () => {
    const state = makeSched();
    triggerHourlyBC("cron", utc(2025, 6, 15, 15), state);
    triggerHourlyBC("cron", utc(2025, 6, 15, 16), state);
    expect(state.triggered).toHaveLength(2);
  });

  it("lastKey est mis à jour à chaque nouvelle heure", () => {
    const state = makeSched();
    triggerHourlyBC("cron", utc(2025, 6, 15, 15), state);
    expect(state.lastScheduledBcHourKey).toBe("2025-06-15T15");
    triggerHourlyBC("cron", utc(2025, 6, 15, 16), state);
    expect(state.lastScheduledBcHourKey).toBe("2025-06-15T16");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-7 : scan en cours → skipped
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-7 triggerHourlyBC — scan en cours → skipped", () => {
  it("scanningBC=true bloque le déclenchement", () => {
    const state = makeSched();
    state.scanningBC = true;
    triggerHourlyBC("cron", utc(2025, 6, 15, 15), state);
    expect(state.triggered).toHaveLength(0);
  });

  it("log 'skipped because scan already running'", () => {
    const state = makeSched();
    state.scanningBC = true;
    triggerHourlyBC("cron", utc(2025, 6, 15, 15), state);
    expect(state.logs.some(l => l.includes("skipped because scan already running"))).toBe(true);
  });

  it("lastKey n'est pas mis à jour si scan en cours", () => {
    const state = makeSched();
    state.scanningBC = true;
    triggerHourlyBC("cron", utc(2025, 6, 15, 15), state);
    expect(state.lastScheduledBcHourKey).toBe("");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-8 : scan terminé, heure suivante → déclenché
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-8 triggerHourlyBC — scan terminé, heure suivante → déclenché", () => {
  it("après fin de scan (scanningBC=false), l'heure suivante est déclenchée", () => {
    const state = makeSched();
    // Déclenchement normal à 15h
    triggerHourlyBC("cron", utc(2025, 6, 15, 15), state);
    // Simulation scan long bloquant à 16h
    state.scanningBC = true;
    triggerHourlyBC("cron", utc(2025, 6, 15, 16), state);
    expect(state.triggered).toHaveLength(1);
    // Fin de scan
    state.scanningBC = false;
    // Retry 16h via setInterval
    triggerHourlyBC("cron-interval", utc(2025, 6, 15, 16), state);
    expect(state.triggered).toHaveLength(2);
    expect(state.lastScheduledBcHourKey).toBe("2025-06-15T16");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-9 : lastKey mis à jour avant appel runGlobalScanBC
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-9 triggerHourlyBC — lastKey mis à jour avant le déclenchement", () => {
  it("après trigger, lastKey est déjà la nouvelle clé", () => {
    const state = makeSched();
    const now = utc(2025, 6, 15, 17);
    triggerHourlyBC("cron", now, state);
    // La clé doit être settée même si runGlobalScanBC était asynchrone
    expect(state.lastScheduledBcHourKey).toBe("2025-06-15T17");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-10 : source transmise
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-10 triggerHourlyBC — source transmise", () => {
  it("source=cron transmise au scan", () => {
    const state = makeSched();
    triggerHourlyBC("cron", utc(2025, 6, 15, 15), state);
    expect(state.triggered[0]!.source).toBe("cron");
  });

  it("source=cron-interval transmise au scan", () => {
    const state = makeSched();
    triggerHourlyBC("cron-interval", utc(2025, 6, 15, 15), state);
    expect(state.triggered[0]!.source).toBe("cron-interval");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-11 : dédup partagée entre cron et cron-interval
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-11 triggerHourlyBC — dédup partagée cron + cron-interval", () => {
  it("cron déclenche à 15h, cron-interval bloqué à 15h", () => {
    const state = makeSched();
    const now = utc(2025, 6, 15, 15);
    triggerHourlyBC("cron", now, state);
    triggerHourlyBC("cron-interval", now, state);
    expect(state.triggered).toHaveLength(1);
    expect(state.triggered[0]!.source).toBe("cron");
  });

  it("cron-interval déclenche à 15h, cron bloqué à 15h", () => {
    const state = makeSched();
    const now = utc(2025, 6, 15, 15);
    triggerHourlyBC("cron-interval", now, state);
    triggerHourlyBC("cron", now, state);
    expect(state.triggered).toHaveLength(1);
    expect(state.triggered[0]!.source).toBe("cron-interval");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-12 : heartbeat minute !== 0 → pas de trigger
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-12 heartbeat — minute !== 0 → pas de trigger", () => {
  it("minute=1 → pas de déclenchement", () => {
    const state = makeSched();
    heartbeatTick(utc(2025, 6, 15, 15, 1), state);
    expect(state.triggered).toHaveLength(0);
  });

  it("minute=30 → pas de déclenchement", () => {
    const state = makeSched();
    heartbeatTick(utc(2025, 6, 15, 15, 30), state);
    expect(state.triggered).toHaveLength(0);
  });

  it("minute=59 → pas de déclenchement", () => {
    const state = makeSched();
    heartbeatTick(utc(2025, 6, 15, 15, 59), state);
    expect(state.triggered).toHaveLength(0);
  });

  it("heartbeat logue toujours [SCHED] heartbeat", () => {
    const state = makeSched();
    heartbeatTick(utc(2025, 6, 15, 15, 30), state);
    expect(state.logs.some(l => l.includes("[SCHED] heartbeat"))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-13 : heartbeat minute === 0 → trigger
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-13 heartbeat — minute === 0 → trigger", () => {
  it("minute=0 → déclenchement", () => {
    const state = makeSched();
    heartbeatTick(utc(2025, 6, 15, 15, 0), state);
    expect(state.triggered).toHaveLength(1);
    expect(state.triggered[0]!.source).toBe("cron-interval");
  });

  it("heartbeat à 00h00 UTC → déclenchement", () => {
    const state = makeSched();
    heartbeatTick(utc(2025, 6, 16, 0, 0), state);
    expect(state.triggered).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-14 : deux ticks à minute===0 même heure → un seul trigger
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-14 heartbeat — deux ticks minute===0 même heure → un seul trigger", () => {
  it("simule deux ticks à 15:00 UTC (ex: retard de boucle)", () => {
    const state = makeSched();
    const now = utc(2025, 6, 15, 15, 0);
    heartbeatTick(now, state);
    heartbeatTick(now, state);
    expect(state.triggered).toHaveLength(1);
    expect(state.logs.filter(l => l.includes("[SCHED] heartbeat"))).toHaveLength(2);
    expect(state.logs.filter(l => l.includes("already triggered"))).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SCHED-15 : log messages — présence des tags SCHED
// ────────────────────────────────────────────────────────────────────────────
describe("SCHED-15 log messages — tags [SCHED] présents", () => {
  it("trigger → log contient 'hourly BC trigger'", () => {
    const state = makeSched();
    triggerHourlyBC("cron", utc(2025, 6, 15, 15), state);
    expect(state.logs[0]).toMatch(/\[SCHED\] hourly BC trigger hour=2025-06-15T15 source=cron/);
  });

  it("dédup → log contient 'already triggered for hour='", () => {
    const state = makeSched();
    const now = utc(2025, 6, 15, 15);
    triggerHourlyBC("cron", now, state);
    triggerHourlyBC("cron-interval", now, state);
    const dedupLog = state.logs.find(l => l.includes("already triggered"));
    expect(dedupLog).toMatch(/hour=2025-06-15T15/);
    expect(dedupLog).toMatch(/source=cron-interval/);
  });

  it("scan running → log contient 'skipped because scan already running'", () => {
    const state = makeSched();
    state.scanningBC = true;
    triggerHourlyBC("cron", utc(2025, 6, 15, 15), state);
    expect(state.logs[0]).toMatch(/\[SCHED\] skipped because scan already running hour=2025-06-15T15/);
  });

  it("heartbeat → log contient 'utc=' et heure ISO", () => {
    const state = makeSched();
    heartbeatTick(utc(2025, 6, 15, 14, 30), state);
    expect(state.logs[0]).toMatch(/\[SCHED\] heartbeat utc=2025-06-15T14:30/);
  });
});

export {};
