"""Recompute the published accounting from the raw samples and finish scrubbing.

Run after build_public_db.py, on the scrubbed copy only:

    python3 api/fix_public_db.py api/scoop_public.db

The source database records energy as the difference in the strip's cumulative
counter, which only moves in 0.001 kWh steps. Short sessions read as 0 kWh and
the total came out about 8% low. This script integrates the attributed
socket's power over time (trapezoid rule) instead, so every published figure
can be reproduced from the samples next to it. It also replaces the
zero-length accounting periods with each session's first and last sample,
fills in load and peak power, marks sessions that never closed, drops
accounting rows with no samples behind them, and nulls the socket aliases,
which carry hostnames.

Safe to rerun: every value it writes is derived from telemetry_samples.
"""
from __future__ import annotations

import sqlite3
import sys
from datetime import datetime

SOCKETS = range(6)


def ts(s: str) -> float:
    return datetime.fromisoformat(s).timestamp()


def integrate(samples: list[tuple[float, float]]) -> float:
    """Energy in kWh from (unix_seconds, watts) pairs, trapezoid rule."""
    joules = sum((p0 + p1) / 2 * (t1 - t0)
                 for (t0, p0), (t1, p1) in zip(samples, samples[1:]))
    return joules / 3.6e6


def main(path: str) -> None:
    con = sqlite3.connect(path)
    cur = con.cursor()

    # Socket aliases name the machines ("ASRock1 Server", "NUC2 Jump Host").
    cur.execute("UPDATE telemetry_samples SET "
                + ", ".join(f"socket_{i}_alias = NULL" for i in SOCKETS))

    # Sessions that never captured a sample are not measurements.
    cur.execute("""UPDATE sessions SET status = 'no_data'
                   WHERE status IN ('running', 'interrupted')
                     AND NOT EXISTS (SELECT 1 FROM telemetry_samples t
                                     WHERE t.session_id = sessions.session_id)""")
    # Sessions with samples that never closed were never accounted.
    cur.execute("""UPDATE sessions SET status = 'incomplete'
                   WHERE status IN ('running', 'interrupted')""")
    # Accounting rows with no samples behind them are empty placeholders.
    cur.execute("""DELETE FROM carbon_accounting
                   WHERE NOT EXISTS (SELECT 1 FROM telemetry_samples t
                                     WHERE t.session_id = carbon_accounting.session_id)""")

    socket = {sid: idx for sid, idx in
              cur.execute("SELECT server_id, socket_index FROM servers")}

    rows = cur.execute("""SELECT id, session_id, server_id, carbon_intensity_used
                          FROM carbon_accounting""").fetchall()
    for row_id, session_id, server_id, factor in rows:
        col = f"socket_{socket.get(server_id, 0)}_power_w"
        s = cur.execute(f"""SELECT captured_at, {col}, server_load_pct
                            FROM telemetry_samples WHERE session_id = ?
                            AND {col} IS NOT NULL ORDER BY captured_at""",
                        (session_id,)).fetchall()
        if not s:
            continue
        pts = [(ts(t), p) for t, p, _ in s]
        kwh = integrate(pts)
        loads = [l for _, _, l in s if l is not None]
        cur.execute("""UPDATE carbon_accounting SET
                         period_start = ?, period_end = ?,
                         total_energy_kwh = ?, total_co2_kg = ?,
                         avg_load_pct = ?, peak_power_w = ?, samples_count = ?
                       WHERE id = ?""",
                    (s[0][0], s[-1][0], round(kwh, 6), round(kwh * factor, 6),
                     round(sum(loads) / len(loads), 2) if loads else None,
                     max(p for _, p in pts), len(s), row_id))

        # Per load level: each interval counts toward the level it started at.
        levels: dict[float, float] = {}
        for (t0, p0), (t1, p1), (_, _, load) in zip(pts, pts[1:], s):
            levels[load] = levels.get(load, 0.0) + (p0 + p1) / 2 * (t1 - t0) / 3.6e6
        for load, e in levels.items():
            cur.execute("""UPDATE load_level_analysis
                           SET total_energy_kwh = ?, total_co2_kg = ?
                           WHERE session_id = ? AND load_pct = ?""",
                        (round(e, 6), round(e * factor, 6), session_id, load))

    # Session analysis mirrors the accounting row, and its change-vs-previous
    # percentages follow from the corrected energy.
    cur.execute("""UPDATE session_analysis SET
                     total_energy_kwh = a.total_energy_kwh,
                     total_co2_kg     = a.total_co2_kg,
                     co2_per_sample_g = ROUND(a.total_co2_kg * 1000.0
                                              / NULLIF(a.samples_count, 0), 6)
                   FROM carbon_accounting a
                   WHERE a.session_id = session_analysis.session_id""")
    prev = None
    for sid, e, c in cur.execute("""SELECT session_id, total_energy_kwh, total_co2_kg
                                    FROM session_analysis ORDER BY started_at""").fetchall():
        pe = round((e - prev[0]) / prev[0] * 100, 2) if prev and prev[0] else None
        pc = round((c - prev[1]) / prev[1] * 100, 2) if prev and prev[1] else None
        cur.execute("""UPDATE session_analysis SET vs_previous_energy = ?,
                       vs_previous_co2 = ? WHERE session_id = ?""", (pe, pc, sid))
        prev = (e, c)

    con.commit()
    con.execute("VACUUM")
    con.close()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "api/scoop_public.db")
