"""Read-only public API over the SCOOP measurement record.

Serves a scrubbed snapshot of the Data-Center-Carbon-Monitor database: the
measurements, their method and their coverage, with the device identifiers
and location removed. Nothing here writes, and the database ships read-only
alongside the function.
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

DB_PATH = os.path.join(os.path.dirname(__file__), "scoop_public.db")

app = FastAPI(
    title="SCOOP public measurement API",
    version="0.1.0",
    description=(
        "Read-only access to the SCOOP data center instance: energy, emissions "
        "and the method behind each figure. Measurements come from a TP-Link "
        "HS300 metered strip sampling a lab server, integrated to kWh and "
        "multiplied by a grid carbon intensity factor.\n\n"
        "This is prototype data from one server, published to make the IEEE "
        "P7802 reference implementation inspectable. It is not a production "
        "emissions feed."
    ),
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],      # public read-only data
    allow_methods=["GET"],
    allow_headers=["*"],
)


def q(sql: str, params: tuple = ()) -> list[dict]:
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(sql, params)]
    finally:
        con.close()


@app.get("/api/v0/summary", tags=["measurements"])
def summary():
    """Headline totals across every measured interval."""
    t = q("""SELECT
                COUNT(*)                   AS periods,
                SUM(total_energy_kwh)      AS energy_kwh,
                SUM(total_co2_kg)          AS co2_kg,
                SUM(samples_count)         AS samples,
                MIN(period_start)          AS first_period,
                MAX(period_end)            AS last_period
             FROM carbon_accounting""")[0]
    servers = q("SELECT COUNT(*) AS n FROM servers")[0]["n"]
    sessions = q("SELECT COUNT(*) AS n FROM sessions")[0]["n"]
    return {
        "status": "ok",
        "servers": servers,
        "sessions": sessions,
        "measurement_periods": t["periods"],
        "energy_kwh": round(t["energy_kwh"] or 0, 6),
        "co2_kg": round(t["co2_kg"] or 0, 6),
        "samples": t["samples"] or 0,
        "first_period": t["first_period"],
        "last_period": t["last_period"],
        "method": "trapezoid integration of sampled socket power (kWh) x static grid factor (kg/kWh)",
        "note": "Prototype data from a single lab server. Not a production feed.",
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


@app.get("/api/v0/servers", tags=["measurements"])
def servers():
    """Registered servers. Hardware and location identifiers are not published."""
    return {"status": "ok", "servers": q(
        "SELECT server_id, model, socket_index, notes, registered_at FROM servers")}


@app.get("/api/v0/sessions", tags=["measurements"])
def sessions(limit: int = Query(50, ge=1, le=200)):
    """Measurement sessions, newest first, with their analysed totals."""
    return {"status": "ok", "sessions": q("""
        SELECT s.session_id, s.started_at, s.ended_at, s.mode, s.status,
               s.samples_count,
               a.duration_seconds, a.avg_power_w, a.peak_power_w, a.idle_power_w,
               a.total_energy_kwh, a.total_co2_kg, a.carbon_intensity
        FROM sessions s
        LEFT JOIN session_analysis a ON a.session_id = s.session_id
        ORDER BY s.started_at DESC LIMIT ?""", (limit,))}


@app.get("/api/v0/emissions", tags=["measurements"])
def emissions(
    server_id: Optional[str] = Query(None, description="Defaults to every server."),
    limit: int = Query(100, ge=1, le=500),
):
    """Emission figures per measured interval, each with its method and sample count."""
    if server_id:
        rows = q("""SELECT period_start, period_end, server_id, session_id,
                           total_energy_kwh, total_co2_kg, avg_load_pct, peak_power_w,
                           samples_count, carbon_intensity_used, method
                    FROM carbon_accounting WHERE server_id = ?
                    ORDER BY period_start DESC LIMIT ?""", (server_id, limit))
        if not rows:
            raise HTTPException(404, f"No measurements for server_id {server_id!r}")
    else:
        rows = q("""SELECT period_start, period_end, server_id, session_id,
                           total_energy_kwh, total_co2_kg, avg_load_pct, peak_power_w,
                           samples_count, carbon_intensity_used, method
                    FROM carbon_accounting
                    ORDER BY period_start DESC LIMIT ?""", (limit,))
    return {"status": "ok", "count": len(rows), "emissions": rows}


@app.get("/api/v0/load-curve", tags=["measurements"])
def load_curve(session_id: Optional[str] = Query(None)):
    """Power drawn at each load level: the measured relationship, not a model."""
    if session_id:
        rows = q("""SELECT session_id, load_pct, sample_count, avg_power_w,
                           min_power_w, max_power_w, total_energy_kwh, total_co2_kg
                    FROM load_level_analysis WHERE session_id = ?
                    ORDER BY load_pct""", (session_id,))
    else:
        rows = q("""SELECT load_pct,
                           COUNT(*)          AS sessions,
                           SUM(sample_count) AS samples,
                           AVG(avg_power_w)  AS avg_power_w,
                           MIN(min_power_w)  AS min_power_w,
                           MAX(max_power_w)  AS max_power_w
                    FROM load_level_analysis GROUP BY load_pct ORDER BY load_pct""")
    return {"status": "ok", "load_curve": rows}


@app.get("/api/v0/health", tags=["service"])
def health():
    return {"status": "ok", "database": os.path.basename(DB_PATH)}
